import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { requireViewer } from '@/app/lib/apiAuth';
import { safeErrorResponse } from '@/app/lib/apiError';
import { fetchLatestFinalDecisions, activityDecisionKey, isDustProfileWithinDailyWindow, type DustActivityRow } from '@/app/lib/dustEvaluation';
import { pickWorstDecision } from '@/app/utils/final-decision-engine';

// Unrestricted version of app/api/dashboard/global/route.ts — exact same signature
// ({projects, alerts, dustActivities, decisions, executionWindows,
// liveActivityByProjectId}), but without user_id filtering, built for the monitoring viewer map
// (displays all projects across all users). GlobalDashboard.tsx consumes this route
// with zero modifications to mapPoints construction logic.
export async function GET(request: NextRequest) {
  const auth = await requireViewer(request);
  if ('error' in auth) return auth.error;

  const todayStr = new Date().toLocaleDateString('en-CA');

  const { data: projectsData, error: projectsError } = await supabaseAdmin
    .from('projects')
    .select('*')
    .is('archived_at', null);
  if (projectsError) return NextResponse.json({ error: safeErrorResponse(projectsError, 'viewer/dashboard projects fetch failed') }, { status: 500 });

  const projectIds = (projectsData || []).map((p: { id: string }) => p.id);

  const { data: alerts, error: alertsError } = await supabaseAdmin
    .from('alerts')
    .select('*, projects!inner(name, city, user_id, archived_at)')
    .neq('state', 'CLOSED')
    .is('projects.archived_at', null)
    .order('created_at', { ascending: false });
  if (alertsError) return NextResponse.json({ error: safeErrorResponse(alertsError, 'viewer/dashboard alerts fetch failed') }, { status: 500 });

  let dustData: DustActivityRow[] = [];
  let liveActivityByProjectId: Record<
    string,
    {
      decisionLabelAr: string;
      shortReason: string;
      level: string;
      mandatoryStop: boolean;
      evaluatedAt: string | null;
      readingPm10UgM3: number | null;
      readingWindSpeedKmh: number | null;
      readingRecordedAt: string | null;
    }
  > = {};

  if (projectIds.length > 0) {
    // Bug discovered and fixed (User asked: "3-day activity, is it counted within work hours only?"):
    // eq('planned_date', todayStr) previously excluded activities started on a previous day and
    // extending into today. gte/lte expand the query range; isDustProfileWithinDailyWindow
    // below remains the precise filter.
    const lookbackDateStr = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const dustRes = await supabaseAdmin
      .from('project_dust_profiles')
      .select('*')
      .in('project_id', projectIds)
      .gte('planned_date', lookbackDateStr)
      .lte('planned_date', todayStr)
      .is('archived_at', null);
    dustData = dustRes.data || [];

    // Active status evaluated across ALL currently running activities per project (not just one),
    // coloring the map marker by the worst live decision among all running activities combined.
    //
    // Bug discovered and fixed (External expert review — "System selects first row instead of worst decision"):
    // Previously picked only the "first running activity found" (first row in query result without ORDER BY)
    // ignoring concurrent parallel activities for the same project.
    //
    // work_days_list per project is required to calculate the correct daily window.
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

    // Architectural fix: Now reads latest stored decision in final_decisions (written by evaluate/route.ts)
    // instead of recomputing decideFinal locally in isolation.
    const activityGroupIdByRowId = new Map<string, string>();
    for (const row of dustData) {
      activityGroupIdByRowId.set(String(row.id), row.activity_group_id || `dust-${row.id}`);
    }

    // Security fix: Route serves all projects across all users without user_id filtering,
    // so strict scoping is critical to prevent cross-tenant decision leakage.
    const allTargets = Array.from(runningRowsByProject.entries()).flatMap(([projectId, rows]) =>
      rows.map((row) => ({ projectId, activityGroupId: activityGroupIdByRowId.get(String(row.id))! }))
    );
    const finalDecisionsByGroup = await fetchLatestFinalDecisions(supabaseAdmin, allTargets);

    const liveResults = Array.from(runningRowsByProject.entries()).map(([projectId, rows]) => {
      const decisions = rows
        .map((row) => {
          const d = finalDecisionsByGroup.get(activityDecisionKey(projectId, activityGroupIdByRowId.get(String(row.id))!));
          if (!d) return null;
          return {
            // خطأ مكتشَف ومُصلَح (طلب مستخدم صريح — "اريد فصل تماماً"، سؤال
            // مباشر عن تداخل قراءات الجهاز بين نشاطين): deviceId يُحمَل هنا
            // مع كل مرشح قرار، لا يضيع بعد pickWorstDecision — راجع تعليق
            // readingByProjectId الكامل أدناه للسبب الكامل.
            deviceId: row.device_id ?? null,
            finalDecision: {
              decisionLabelAr: d.decision_label_ar,
              shortReasonAr: d.short_reason_ar ?? '',
              level: d.level as 'GREEN' | 'YELLOW' | 'ORANGE' | 'RED' | 'DARK_RED' | 'BLACK',
              mandatoryStop: d.mandatory_stop,
              pendingConfirmation: d.pending_confirmation,
              operationalDecision: d.operational_decision,
              evaluatedAt: d.evaluated_at as string | null,
            },
          };
        })
        .filter((d): d is NonNullable<typeof d> => !!d);
      if (decisions.length === 0) return null;
      const winner = pickWorstDecision(decisions);
      const worst = winner.finalDecision;
      return {
        projectId,
        deviceId: winner.deviceId,
        decisionLabelAr: worst.decisionLabelAr,
        shortReason: worst.shortReasonAr,
        level: worst.level,
        mandatoryStop: worst.mandatoryStop,
        pendingConfirmation: worst.pendingConfirmation,
        evaluatedAt: worst.evaluatedAt,
      };
    });
    const liveResultsFiltered = liveResults.filter((r): r is NonNullable<typeof r> => !!r);

    // Monitoring authority (viewer) requirement: Needs to see the violation timestamp and actual reading
    // that triggered it. Fetches the closest actual reading from device_readings_history (recorded_at <= evaluatedAt)
    // for each project with live activity.
    //
    // خطأ مكتشَف ومُصلَح (طلب مستخدم صريح — "اريد فصل تماماً"، سؤال مباشر:
    // "لو صار نشاطين بنفس الجهاز... هل هناك تداخل؟"): كان هذا الاستعلام
    // يُصفَّى بـproject_id فقط، بلا device_id — مشروع فيه جهازان (كل واحد
    // مرتبط بنشاط مختلف) كان يعرض قراءة الجهاز الآخر خطأً كـ"القراءة التي
    // أنتجت هذا القرار" لأي من النشاطين. deviceId الفائز (المرفَق أعلاه مع
    // pickWorstDecision) يُستخدَم الآن لتصفية الجهاز الصحيح تحديداً؛ نشاط
    // بلا جهاز مرتبط (deviceId=null) يُستبعَد كلياً من هذا الجلب (لا معنى
    // لقراءة جهاز لنشاط لا يملك جهازاً).
    const readingByProjectId = new Map<string, { pm10UgM3: number | null; windSpeedKmh: number | null; recordedAt: string }>();
    await Promise.all(
      liveResultsFiltered
        .filter((r) => !!r.evaluatedAt && !!r.deviceId)
        .map(async (r) => {
          const { data: readingRows } = await supabaseAdmin
            .from('device_readings_history')
            .select('pm10_ug_m3, wind_speed_kmh, recorded_at')
            .eq('project_id', r.projectId)
            .eq('device_id', r.deviceId as string)
            .lte('recorded_at', r.evaluatedAt as string)
            .order('recorded_at', { ascending: false })
            .limit(1);
          const row = readingRows?.[0];
          if (row) {
            readingByProjectId.set(r.projectId, {
              pm10UgM3: row.pm10_ug_m3 ?? null,
              windSpeedKmh: row.wind_speed_kmh ?? null,
              recordedAt: row.recorded_at,
            });
          }
        })
    );

    liveActivityByProjectId = Object.fromEntries(
      liveResultsFiltered.map((r) => {
        const reading = readingByProjectId.get(r.projectId);
        return [
          r.projectId,
          {
            decisionLabelAr: r.decisionLabelAr,
            shortReason: r.shortReason,
            level: r.level,
            mandatoryStop: r.mandatoryStop,
            evaluatedAt: r.evaluatedAt,
            readingPm10UgM3: reading?.pm10UgM3 ?? null,
            readingWindSpeedKmh: reading?.windSpeedKmh ?? null,
            readingRecordedAt: reading?.recordedAt ?? null,
          },
        ];
      })
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