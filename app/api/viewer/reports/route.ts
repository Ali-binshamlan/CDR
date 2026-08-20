import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { requireViewer } from '@/app/lib/apiAuth';
import { safeErrorResponse } from '@/app/lib/apiError';
import { toReportDecisionRow, dedupeToLatestPerActivity } from '@/app/lib/finalDecisionStatus';

// Unrestricted version of app/api/dashboard/reports/route.ts — exact same signature
// ({projects, decisions, alerts}, same fromDate/toDate), but without user_id filtering on projects,
// built for the monitoring viewer aggregated report across all projects.
// ReportsView.tsx consumes this route with zero modifications to analysis engine logic.
export async function GET(request: NextRequest) {
  const auth = await requireViewer(request);
  if ('error' in auth) return auth.error;

  const fromDate = request.nextUrl.searchParams.get('fromDate');
  const toDate = request.nextUrl.searchParams.get('toDate');
  if (!fromDate || !toDate) {
    return NextResponse.json({ error: 'fromDate و toDate مطلوبان' }, { status: 400 });
  }

  const { data: dbProjects, error: projectsError } = await supabaseAdmin
    .from('projects')
    .select('id, name')
    .is('archived_at', null);
  if (projectsError) return NextResponse.json({ error: safeErrorResponse(projectsError, 'viewer/reports projects fetch failed') }, { status: 500 });

  const projectIds = (dbProjects || []).map((p: { id: string }) => p.id);
  if (projectIds.length === 0) {
    return NextResponse.json({ projects: dbProjects || [], decisions: [], alerts: [] });
  }

  const endOfDay = new Date(toDate);
  endOfDay.setHours(23, 59, 59, 999);

  // Reports are now built from final_decisions (actual automated decisions) instead
  // of decision_records (deprecated manual decision feature).
  const [decisionsRes, alertsRes] = await Promise.all([
    supabaseAdmin
      .from('final_decisions')
      .select('id, project_id, activity_group_id, operational_decision, mandatory_stop, created_at')
      .in('project_id', projectIds)
      .gte('created_at', new Date(fromDate).toISOString())
      .lte('created_at', endOfDay.toISOString()),
    supabaseAdmin
      .from('alerts')
      .select('id, project_id, kind')
      .in('project_id', projectIds)
      .gte('created_at', new Date(fromDate).toISOString())
      .lte('created_at', endOfDay.toISOString()),
  ]);
  if (decisionsRes.error) return NextResponse.json({ error: safeErrorResponse(decisionsRes.error, 'viewer/reports decisions fetch failed') }, { status: 500 });
  if (alertsRes.error) return NextResponse.json({ error: safeErrorResponse(alertsRes.error, 'viewer/reports alerts fetch failed') }, { status: 500 });

  // dedupeToLatestPerActivity prevents inflating activity counts from periodic re-evaluations
  // of the same running activity.
  const latestPerActivity = dedupeToLatestPerActivity(decisionsRes.data || []);

  return NextResponse.json({
    projects: dbProjects || [],
    decisions: latestPerActivity.map(toReportDecisionRow),
    alerts: alertsRes.data || [],
  });
}