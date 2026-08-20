import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { requireSuperAdmin, requireViewer } from '@/app/lib/apiAuth';
import { safeErrorResponse } from '@/app/lib/apiError';

/*
 * Fetches all alerts across all projects without `project_id` filtering.
 * Relies on the direct FK between `alerts.project_id` and `projects.id` for `!inner` embedding
 * (unlike `admin/projects` where no direct FK exists between `projects` and `profiles`).
 * Capped at a hard limit of 200 records without pagination at this stage.
 * 
 * Accessible by both Super Admins and Viewers (`requireViewer`), granting read-only permissions for this endpoint.
 * Shared by `app/dashboard/admin/alerts/page.tsx` and `app/dashboard/viewer/alerts/page.tsx`.
 */
export async function GET(request: NextRequest) {
  const adminAuth = await requireSuperAdmin(request);
  /*
   * Auth Check: `requireSuperAdmin` / `requireViewer` return an explicit `role` field ('admin' | 'viewer') upon success.
   * Directly checked to identify caller identity rather than relying on brittle execution fallback order.
   */
  const auth = 'error' in adminAuth ? await requireViewer(request) : adminAuth;
  if ('error' in auth) return auth.error;
  const isViewerCaller = auth.role === 'viewer';

  /*
   * Viewer Role Constraints: Restricts viewer access exclusively to actual regulatory violations (`COMPLIANCE_VIOLATION`) 
   * and their corresponding reading improvement notifications (`PM10_IMPROVED`).
   * Explicit user requirement: If readings improve following a confirmed violation and prior to enforcement shutdown, 
   * viewers must receive an improvement alert alongside the original violation message. 
   * All other alert categories (readiness, activity start, no decision, restrictions, proactive alerts) are hidden from viewers. 
   * Super Admins continue to view all alert categories without filtering.
   *
   * Bug Fix Note: Fixes an issue where `persist_activity_decision_atomic` (see migration 202608110020) omitted 
   * `kind='COMPLIANCE_VIOLATION'` in `decision_alert_outbox`, resulting in empty viewer views despite valid violations. 
   * Filter logic remains unchanged here as the fix was resolved at the data source worker level.
   */
  let alertsQuery = supabaseAdmin
    .from('alerts')
    .select('*, projects!inner(id, name, city, neighborhood, latitude, longitude, project_manager, user_id)')
    .order('created_at', { ascending: false })
    .limit(200);
  if (isViewerCaller) {
    alertsQuery = alertsQuery.in('kind', ['COMPLIANCE_VIOLATION', 'PM10_IMPROVED']);
  }
  const { data: alerts, error: alertsError } = await alertsQuery;
  if (alertsError) return NextResponse.json({ error: safeErrorResponse(alertsError, 'admin/alerts fetch failed') }, { status: 500 });

  /*
   * User-specific Read State Tracking: Utilizes `alert_reads` (matching `dashboard/alerts-list/route.ts`).
   * Explicit user requirement: Enable read/unread status across all alert screens, not just for the project owner view.
   */
  const alertIds = (alerts || []).map((a: { id: string }) => a.id);
  const readAlertIdSet = new Set<string>();
  if (alertIds.length > 0) {
    const { data: reads } = await supabaseAdmin
      .from('alert_reads')
      .select('alert_id')
      .eq('user_id', auth.userId)
      .in('alert_id', alertIds);
    (reads || []).forEach((r: { alert_id: string }) => readAlertIdSet.add(r.alert_id));
  }

  const { data: profiles } = await supabaseAdmin.from('profiles').select('id, username, company_name, phone_number');
  const profileByUserId = new Map(
    (profiles || []).map((p: { id: string; username: string | null; company_name: string | null; phone_number: string | null }) => [p.id, p])
  );

  /*
   * Activity Correlation: Maps string `activity_id` to `project_dust_profiles.id` without a formal DB FK constraint 
   * (consistent with `app/api/alerts/generate/route.ts`).
   * Fetches `regulatory_activity` as the sole source for activity naming following the permanent removal of `activity_type` 
   * (see migration 202608190005).
   */
  const activityIds = [...new Set((alerts || []).map((a: { activity_id: string }) => a.activity_id).filter(Boolean))];
  const { data: dustProfiles } = activityIds.length > 0
    ? await supabaseAdmin.from('project_dust_profiles').select('id, regulatory_activity').in('id', activityIds)
    : { data: [] as { id: string; regulatory_activity: string | null }[] };
  const dustProfileById = new Map((dustProfiles || []).map((p: { id: string; regulatory_activity: string | null }) => [p.id, p]));

  const data = (alerts || []).map((alert: {
    id: string;
    activity_id: string;
    viewer_message?: string | null;
    message: string;
    projects?: { user_id: string; name: string | null; city: string | null; neighborhood: string | null; latitude: number | null; longitude: number | null; project_manager: string | null };
  }) => {
    const owner = profileByUserId.get(alert.projects?.user_id ?? '');
    const dustProfile = dustProfileById.get(alert.activity_id);
    return {
      ...alert,
      /*
       * Viewer Message Fallback: Displays `viewer_message` (official text) instead of technical project-owner messages 
       * when present (`COMPLIANCE_VIOLATION` & `PM10_IMPROVED` via `deriveAlertMessage` in `alert-outbox-worker/route.ts`).
       * Defaults safely to standard `message` if `viewer_message` is absent.
       */
      message: isViewerCaller && alert.viewer_message ? alert.viewer_message : alert.message,
      projectName: alert.projects?.name || null,
      projectCity: alert.projects?.city || null,
      projectNeighborhood: alert.projects?.neighborhood || null,
      projectLatitude: alert.projects?.latitude ?? null,
      projectLongitude: alert.projects?.longitude ?? null,
      projectManager: alert.projects?.project_manager || null,
      ownerUsername: owner?.username || null,
      ownerCompany: owner?.company_name || null,
      ownerPhone: owner?.phone_number || null,
      regulatoryActivity: dustProfile?.regulatory_activity || null,
      isRead: readAlertIdSet.has(alert.id),
    };
  });

  return NextResponse.json({ data });
}