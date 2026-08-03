import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { requireViewer } from '@/app/lib/apiAuth';
import { safeErrorResponse } from '@/app/lib/apiError';
import { fetchLatestFinalDecisions, riyadhLocalToUtcIso } from '@/app/lib/dustEvaluation';
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

  const projectIds = (projectsData || []).map((p: any) => p.id);

  const { data: alerts, error: alertsError } = await supabaseAdmin
    .from('alerts')
    .select('*, projects!inner(name, city, user_id, archived_at)')
    .neq('state', 'CLOSED')
    .is('projects.archived_at', null)
    .order('created_at', { ascending: false });
  if (alertsError) return NextResponse.json({ error: safeErrorResponse(alertsError, 'viewer/dashboard alerts fetch failed') }, { status: 500 });

  let dustData: any[] = [];
  let decisionsData: any[] = [];
  let liveActivityByProjectId: Record<string, { decisionLabelAr: string; shortReason: string; level: string; mandatoryStop: boolean }> = {};

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
    const projectById = new Map((projectsData || []).map((p: any) => [p.id, p]));
    const runningRowsByProject = new Map<string, any[]>();
    for (const row of dustData) {
      const startIso = riyadhLocalToUtcIso(row.planned_date, row.planned_time);
      if (!startIso) continue;
      const durationHours = Math.max(1, Math.round(row.duration_hours || 1));
      const endMs = new Date(startIso).getTime() + durationHours * 3600000;
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
    const allGroupIds = Array.from(new Set(Array.from(runningRowsByProject.values()).flat().map((row) => activityGroupIdByRowId.get(String(row.id))!)));
    const finalDecisionsByGroup = await fetchLatestFinalDecisions(supabaseAdmin, allGroupIds);

    const liveResults = Array.from(runningRowsByProject.entries()).map(([projectId, rows]) => {
      const decisions = rows
        .map((row) => finalDecisionsByGroup.get(activityGroupIdByRowId.get(String(row.id))!))
        .filter((d): d is NonNullable<typeof d> => !!d)
        .map((d) => ({
          finalDecision: {
            decisionLabelAr: d.decision_label_ar,
            shortReasonAr: d.short_reason_ar,
            level: d.level,
            mandatoryStop: d.mandatory_stop,
            pendingConfirmation: d.pending_confirmation,
            operationalDecision: d.operational_decision,
          },
        }));
      if (decisions.length === 0) return null;
      const worst = pickWorstDecision(decisions as any).finalDecision;
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
    decisions: decisionsData,
    executionWindows: [],
    liveActivityByProjectId,
  });
}
