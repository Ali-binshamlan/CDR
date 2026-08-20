import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { requireUserId } from '@/app/lib/apiAuth';
import { safeErrorResponse } from '@/app/lib/apiError';

/*
 * Dashboard Alerts List Aggregator Endpoint:
 * Consolidates user project scopes, triggered alerts, user-specific read receipts (`alert_reads`),
 * and referenced dust activity metadata in a single server round-trip.
 *
 * Operational & Data Scoping Highlights:
 * 1. User Isolation: Restricts project retrieval to non-archived projects belonging to `userId`.
 * 2. Per-User Read Receipts: Resolves `isRead` dynamically using `alert_reads` mapping without
 *    mutating global alert states.
 * 3. Minimal Metadata Projection: Batches lookup for `project_dust_profiles` by referenced activity IDs,
 *    returning lightweight `activityLabels` mapping (`dust:${id}`) for UI translation.
 */
export async function GET(request: NextRequest) {
  const auth = await requireUserId(request);
  if ('error' in auth) return auth.error;
  const userId = auth.userId;

  /*
   * Fetch active projects scope for authenticated user
   */
  const { data: dbProjects, error: projectsError } = await supabaseAdmin
    .from('projects')
    .select('id, name')
    .eq('user_id', userId)
    .is('archived_at', null);

  if (projectsError) {
    return NextResponse.json(
      { error: safeErrorResponse(projectsError, 'dashboard/alerts-list projects fetch failed') },
      { status: 500 }
    );
  }

  const projectIds = (dbProjects || []).map((p: { id: string }) => p.id);
  if (projectIds.length === 0) {
    return NextResponse.json({ projects: dbProjects || [], alerts: [], activityLabels: {} });
  }

  /*
   * Fetch historical alerts across accessible user projects
   */
  const { data: dbAlerts, error: alertsError } = await supabaseAdmin
    .from('alerts')
    .select('*')
    .in('project_id', projectIds)
    .order('created_at', { ascending: false });

  if (alertsError) {
    return NextResponse.json(
      { error: safeErrorResponse(alertsError, 'dashboard/alerts-list alerts fetch failed') },
      { status: 500 }
    );
  }

  /*
   * Resolve user-specific alert read receipts
   */
  const alertIds = (dbAlerts || []).map((a: { id: string }) => a.id);
  const readAlertIds: string[] = [];

  if (alertIds.length > 0) {
    const { data: reads } = await supabaseAdmin
      .from('alert_reads')
      .select('alert_id')
      .eq('user_id', userId)
      .in('alert_id', alertIds);

    (reads || []).forEach((r: { alert_id: string }) => readAlertIds.push(r.alert_id));
  }

  const readAlertIdSet = new Set(readAlertIds);
  const alertsWithReadState = (dbAlerts || []).map((a: { id: string }) => ({
    ...a,
    isRead: readAlertIdSet.has(a.id),
  }));

  /*
   * Batch query referenced dust profile metadata for frontend activity labels
   */
  const dustIds = [
    ...new Set(
      (dbAlerts || [])
        .filter((a: { activity_source: string }) => a.activity_source === 'dust')
        .map((a: { activity_id: string }) => a.activity_id)
    ),
  ];

  const activityLabels: Record<string, { regulatory_activity: string | null }> = {};

  if (dustIds.length > 0) {
    const { data } = await supabaseAdmin
      .from('project_dust_profiles')
      .select('id, regulatory_activity')
      .in('id', dustIds);

    (data || []).forEach((d: { id: string; regulatory_activity: string | null }) => {
      activityLabels[`dust:${d.id}`] = { regulatory_activity: d.regulatory_activity };
    });
  }

  return NextResponse.json({
    projects: dbProjects || [],
    alerts: alertsWithReadState,
    activityLabels,
  });
}