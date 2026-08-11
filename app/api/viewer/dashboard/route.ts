import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { requireViewer } from '@/app/lib/apiAuth';
import { safeErrorResponse } from '@/app/lib/apiError';
import { fetchLatestFinalDecisions, activityDecisionKey, riyadhLocalToUtcIso, type DustActivityRow } from '@/app/lib/dustEvaluation';
import { pickWorstDecision } from '@/app/utils/final-decision-engine';

// نسخة غير مقيّدة من app/api/dashboard/global/route.ts — نفس الشكل تماماً
// ({projects, alerts, dustActivities, decisions, executionWindows,
// liveActivityByProjectId})، لكن بلا أي فلترة user_id، لخريطة جهة المراقبة
// (تعرض كل المشاريع عبر كل المستخدمين). GlobalDashboard.tsx يستهلك هذا
// المسار بلا أي تعديل على منطق بناء mapPoints (نفس شكل البيانات تماماً).
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
  let decisionsData: Record<string, unknown>[] = [];
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
    const [dustRes, decisionsRes] = await Promise.all([
      supabaseAdmin.from('project_dust_profiles').select('*').in('project_id', projectIds).eq('planned_date', todayStr).is('archived_at', null),
      supabaseAdmin.from('decision_records').select('*').in('project_id', projectIds).order('created_at', { ascending: false }),
    ]);
    dustData = dustRes.data || [];
    decisionsData = decisionsRes.data || [];

    // حالة النشاط الجاري الفعلية — تُحسب لكل الأنشطة الجارية الآن فعلياً
    // (لا نشاط واحد فقط)، لتلوين نقطة الخريطة بأسوأ حالة حية بين كل أنشطة
    // المشروع الجارية معاً.
    //
    // خطأ مكتشَف ومُصلَح (مراجعة كود خبير خارجي — "النظام يختار أول صف بدل
    // أسوأ قرار"): كان يُختار "أول نشاط جارٍ يُعثر عليه" فقط (أول صف في
    // نتيجة الاستعلام، بلا ORDER BY يضمن الترتيب) ويُتجاهَل أي نشاط آخر
    // جارٍ بالتوازي لنفس المشروع — راجع نفس التعليق الكامل في
    // dashboard/global/route.ts للسبب التفصيلي.
    const nowMs = Date.now();
    const runningRowsByProject = new Map<string, DustActivityRow[]>();
    for (const row of dustData) {
      const startIso = riyadhLocalToUtcIso(row.planned_date, row.planned_time);
      if (!startIso) continue;
      const durationHours = Math.max(1, Math.round(row.duration_hours || 1));
      const endMs = new Date(startIso).getTime() + durationHours * 3600000;
      if (!row.project_id) continue;
      if (nowMs >= new Date(startIso).getTime() && nowMs <= endMs) {
        const list = runningRowsByProject.get(row.project_id) ?? [];
        list.push(row);
        runningRowsByProject.set(row.project_id, list);
      }
    }

    // خطأ معماري مكتشَف ومُصلَح (مراجعة كود مدير — "FinalDecisionEngine ليس
    // المصدر التشغيلي الوحيد فعلياً") — راجع نفس التعليق الكامل في
    // dashboard/global/route.ts: يقرأ الآن آخر قرار مخزَّن في final_decisions
    // (كتبه evaluate/route.ts) بدل إعادة حساب decideFinal محلياً بمعزل.
    const activityGroupIdByRowId = new Map<string, string>();
    for (const row of dustData) {
      activityGroupIdByRowId.set(String(row.id), row.activity_group_id || `dust-${row.id}`);
    }
    // خطأ أمني معماري مكتشَف ومُصلَح (القسم 5.7/12.2 من "دليل الإصلاح
    // الجذري لمنظومة مرقاب") — نفس إصلاح dashboard/global/route.ts بالضبط،
    // وأخطر هنا: هذا المسار يعرض كل المشاريع عبر كل المستخدمين معاً بلا أي
    // فلترة user_id (راجع تعليق أعلى الملف)، فخطر خلط قرار مشروع بآخر أعلى.
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
            evaluatedAt: d.evaluated_at as string | null,
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
        evaluatedAt: worst.evaluatedAt,
      };
    });
    const liveResultsFiltered = liveResults.filter((r): r is NonNullable<typeof r> => !!r);

    // طلب صريح من المستخدم — جهة المراقبة (viewer) تحتاج ترى وقت تسجيل
    // المخالفة والقراءة الفعلية التي أنتجتها (لا القراءة الحية الآن، التي
    // قد تختلف تماماً عن لحظة القرار). final_decisions لا يخزّن القراءات
    // الخام نفسها (فقط النص/الرموز المشتقة منها) — نجلب أقرب قراءة فعلية
    // من device_readings_history (recorded_at <= evaluatedAt، الأقرب
    // تنازلياً) لكل مشروع لديه نشاط حي، بمعزل تام عن حساب القرار نفسه (هذا
    // استعلام عرض إضافي فقط، لا يمس أي مسار قرار).
    const readingByProjectId = new Map<string, { pm10UgM3: number | null; windSpeedKmh: number | null; recordedAt: string }>();
    await Promise.all(
      liveResultsFiltered
        .filter((r) => !!r.evaluatedAt)
        .map(async (r) => {
          const { data: readingRows } = await supabaseAdmin
            .from('device_readings_history')
            .select('pm10_ug_m3, wind_speed_kmh, recorded_at')
            .eq('project_id', r.projectId)
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
    decisions: decisionsData,
    executionWindows: [],
    liveActivityByProjectId,
  });
}
