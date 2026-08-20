import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { requireUserId } from '@/app/lib/apiAuth';
import { safeErrorResponse } from '@/app/lib/apiError';
import { fetchLatestFinalDecisions, activityDecisionKey, isDustProfileWithinDailyWindow, type DustActivityRow } from '@/app/lib/dustEvaluation';
import { pickWorstDecision } from '@/app/utils/final-decision-engine';

/*
 * Dashboard Global State Aggregator Endpoint (DCR Spec — Dust Only):
 * Consolidates user project inventory, active/unclosed alerts, scheduled/running dust profiles,
 * and current live operational evaluation states into a single request round-trip.
 *
 * Operational & Concurrency Control Highlights:
 * 1. Multi-Day Dust Lookback: Queries dust profiles starting up to 30 days prior (`gte planned_date`)
 *    to accurately encompass multi-day dust operations spanning into today, while strictly filtering
 *    active execution windows via `isDustProfileWithinDailyWindow`.
 * 2. Multi-Activity Live State Resolution: Groups active dust operations per project and evaluates
 *    pre-calculated operational outcomes from `final_decisions` using `pickWorstDecision` to ensure
 *    map indicator status reflects the most restrictive operational constraint.
 * 3. Composite Key Scope Isolation: Isolates stored evaluation lookups using `(projectId, activityGroupId)`
 *    composite keys, preventing decision cross-contamination across user project boundaries.
 */
export async function GET(request: NextRequest) {
  const auth = await requireUserId(request);
  if ('error' in auth) return auth.error;
  const userId = auth.userId;

  const todayStr = new Date().toLocaleDateString('en-CA');

  /*
   * Retrieve active project inventory for authenticated user
   */
  const { data: projectsData, error: projectsError } = await supabaseAdmin
    .from('projects')
    .select('*')
    .eq('user_id', userId)
    .is('archived_at', null);

  if (projectsError) {
    return NextResponse.json(
      { error: safeErrorResponse(projectsError, 'dashboard/global projects fetch failed') },
      { status: 500 }
    );
  }

  const projectIds = (projectsData || []).map((p: { id: string }) => p.id);

  /*
   * Fetch unclosed operational alerts linked to active user projects
   */
  const { data: alerts, error: alertsError } = await supabaseAdmin
    .from('alerts')
    .select('*, projects!inner(name, city, user_id, archived_at)')
    .neq('state', 'CLOSED')
    .eq('projects.user_id', userId)
    .is('projects.archived_at', null)
    .order('created_at', { ascending: false });

  if (alertsError) {
    return NextResponse.json(
      { error: safeErrorResponse(alertsError, 'dashboard/global alerts fetch failed') },
      { status: 500 }
    );
  }

  let dustData: DustActivityRow[] = [];
  let liveActivityByProjectId: Record<
    string,
    { decisionLabelAr: string; shortReason: string; level: string; mandatoryStop: boolean; pendingConfirmation?: boolean }
  > = {};

  if (projectIds.length > 0) {
    // 30-day window check to capture active multi-day dust profiles initialized in prior days
    const lookbackDateStr = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const dustRes = await supabaseAdmin
      .from('project_dust_profiles')
      .select('*')
      .in('project_id', projectIds)
      .gte('planned_date', lookbackDateStr)
      .lte('planned_date', todayStr)
      .is('archived_at', null);

    dustData = dustRes.data || [];

    const workDaysListByProjectId = new Map<string, string[] | undefined>(
      (projectsData || []).map((p: { id: string; work_days_list?: unknown }) => [
        p.id,
        Array.isArray(p.work_days_list) ? (p.work_days_list as string[]) : undefined,
      ])
    );
    const nowMs = Date.now();
    const runningRowsByProject = new Map<string, DustActivityRow[]>();

    for (const row of dustData) {
      if (!row.project_id) continue;
      if (isDustProfileWithinDailyWindow(row, workDaysListByProjectId.get(row.project_id), nowMs)) {
        const list = runningRowsByProject.get(row.project_id) ?? [];
        list.push(row);
        runningRowsByProject.set(row.project_id, list);
      }
    }

    const activityGroupIdByRowId = new Map<string, string>();
    for (const row of dustData) {
      activityGroupIdByRowId.set(String(row.id), row.activity_group_id || `dust-${row.id}`);
    }

    // Fetch latest evaluated operational decisions using isolated composite keys
    const allTargets = Array.from(runningRowsByProject.entries()).flatMap(([projectId, rows]) =>
      rows.map((row) => ({ projectId, activityGroupId: activityGroupIdByRowId.get(String(row.id))! }))
    );
    const finalDecisionsByGroup = await fetchLatestFinalDecisions(supabaseAdmin, allTargets);

    const liveResults = Array.from(runningRowsByProject.entries()).map(([projectId, rows]) => {
      const decisions = rows
        .map((row) => finalDecisionsByGroup.get(activityDecisionKey(projectId, activityGroupIdByRowId.get(String(row.id))!)))
        .filter((d): d is NonNullable<typeof d> => !!d)
        .map((d) => ({
          finalDecision: {
            decisionLabelAr: d.decision_label_ar,
            shortReasonAr: d.short_reason_ar ?? '',
            level: d.level as 'GREEN' | 'YELLOW' | 'ORANGE' | 'RED' | 'DARK_RED' | 'BLACK',
            mandatoryStop: d.mandatory_stop,
            pendingConfirmation: d.pending_confirmation,
            operationalDecision: d.operational_decision,
          },
        }));

      if (decisions.length === 0) return null;
      const worst = pickWorstDecision(decisions).finalDecision;

      return {
        projectId,
        decisionLabelAr: worst.decisionLabelAr,
        shortReason: worst.shortReasonAr,
        level: worst.level,
        mandatoryStop: worst.mandatoryStop,
        pendingConfirmation: worst.pendingConfirmation,
      };
    });

    liveActivityByProjectId = Object.fromEntries(
      liveResults.filter((r): r is NonNullable<typeof r> => !!r).map((r) => [r.projectId, r])
    );
  }

  return NextResponse.json({
    projects: projectsData || [],
    alerts: alerts || [],
    dustActivities: dustData,
    executionWindows: [],
    liveActivityByProjectId,
  });
}