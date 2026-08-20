import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { requireUserId } from '@/app/lib/apiAuth';
import { safeErrorResponse } from '@/app/lib/apiError';
import { toReportDecisionRow, dedupeToLatestPerActivity } from '@/app/lib/finalDecisionStatus';

/*
 * Dashboard Reports Aggregator Endpoint:
 * Replaces direct client queries in `dashboard/reports/page.tsx` by consolidating 
 * projects, latest activity-level operational decisions, and system alerts for a given date range.
 *
 * Operational Highlights:
 * 1. Single Source of Operational Truth: Queries `final_decisions` directly (where automated engine 
 *    evaluations reside) rather than deprecated manual record tables (`decision_records`).
 * 2. Activity-Level Deduplication: Applies `dedupeToLatestPerActivity` across append-only evaluation 
 *    logs to aggregate unique activities by their latest evaluation state rather than counting raw 
 *    evaluation ticks.
 * 3. Temporal Scope Precision: Sets `toDate` boundaries to the end of the specified calendar day 
 *    (`23:59:59.999`) for comprehensive coverage of the requested interval.
 */
export async function GET(request: NextRequest) {
  const auth = await requireUserId(request);
  if ('error' in auth) return auth.error;
  const userId = auth.userId;

  const fromDate = request.nextUrl.searchParams.get('fromDate');
  const toDate = request.nextUrl.searchParams.get('toDate');
  if (!fromDate || !toDate) {
    return NextResponse.json({ error: 'fromDate و toDate مطلوبان' }, { status: 400 });
  }

  /*
   * Retrieve active project inventory for authenticated user
   */
  const { data: dbProjects, error: projectsError } = await supabaseAdmin
    .from('projects')
    .select('id, name')
    .eq('user_id', userId)
    .is('archived_at', null);

  if (projectsError) {
    return NextResponse.json(
      { error: safeErrorResponse(projectsError, 'dashboard/reports projects fetch failed') },
      { status: 500 }
    );
  }

  const projectIds = (dbProjects || []).map((p: { id: string }) => p.id);
  if (projectIds.length === 0) {
    return NextResponse.json({ projects: dbProjects || [], decisions: [], alerts: [] });
  }

  const endOfDay = new Date(toDate);
  endOfDay.setHours(23, 59, 59, 999);

  /*
   * Concurrent retrieval of automated decisions and system alerts within the temporal window
   */
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

  if (decisionsRes.error) {
    return NextResponse.json(
      { error: safeErrorResponse(decisionsRes.error, 'dashboard/reports decisions fetch failed') },
      { status: 500 }
    );
  }

  if (alertsRes.error) {
    return NextResponse.json(
      { error: safeErrorResponse(alertsRes.error, 'dashboard/reports alerts fetch failed') },
      { status: 500 }
    );
  }

  /*
   * Deduplicate append-only evaluation rows to isolate the most recent state per unique activity
   */
  const latestPerActivity = dedupeToLatestPerActivity(decisionsRes.data || []);

  return NextResponse.json({
    projects: dbProjects || [],
    decisions: latestPerActivity.map(toReportDecisionRow),
    alerts: alertsRes.data || [],
  });
}