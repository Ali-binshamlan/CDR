import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { requireUserId } from '@/app/lib/apiAuth';
import { safeErrorResponse } from '@/app/lib/apiError';
import { fetchLatestFinalDecisions, riyadhLocalToUtcIso } from '@/app/lib/dustEvaluation';
import { pickWorstDecision } from '@/app/utils/final-decision-engine';

// يجمع كل استعلامات المشاريع/التنبيهات/أنشطة اليوم/القرارات في نداء واحد
// لصفحة لوحة التحكم الرئيسية. نسخة DCR: غبار فقط، بلا رافعات/حرارة.
export async function GET(request: NextRequest) {
  const auth = await requireUserId(request);
  if ('error' in auth) return auth.error;
  const userId = auth.userId;

  const todayStr = new Date().toLocaleDateString('en-CA');

  // archived_at is null: مشاريع مؤرشفة لا تظهر على لوحة التحكم الرئيسية
  // (الخريطة/الأنشطة الحية/التنبيهات) — projectIds أدناه يشتق من هذا
  // الاستعلام، فيُطبَّق نفس الاستثناء تلقائياً على dustData/decisionsData.
  const { data: projectsData, error: projectsError } = await supabaseAdmin
    .from('projects')
    .select('*')
    .eq('user_id', userId)
    .is('archived_at', null);
  if (projectsError) return NextResponse.json({ error: safeErrorResponse(projectsError, 'dashboard/global projects fetch failed') }, { status: 500 });

  const projectIds = (projectsData || []).map((p: any) => p.id);

  // state != 'CLOSED' يطابق تعريف "غير مغلق" المستخدم في مولّد التنبيهات
  // (alertExists) وباقي مسارات القراءة — لا عمود is_resolved في DCR.
  const { data: alerts, error: alertsError } = await supabaseAdmin
    .from('alerts')
    .select('*, projects!inner(name, city, user_id, archived_at)')
    .neq('state', 'CLOSED')
    .eq('projects.user_id', userId)
    .is('projects.archived_at', null)
    .order('created_at', { ascending: false });
  if (alertsError) return NextResponse.json({ error: safeErrorResponse(alertsError, 'dashboard/global alerts fetch failed') }, { status: 500 });

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
    // جارٍ بالتوازي لنفس المشروع — فمشروع فيه نشاطان جاريان معاً (نشاط آمن
    // + نشاط موقوف إلزامياً) قد يظهر أخضر بالكامل لو صادف ترتيب الصف الآمن
    // أولاً في نتيجة قاعدة البيانات، بصرف النظر عن النشاط الموقوف فعلياً في
    // نفس اللحظة. الإصلاح: تجميع كل الصفوف الجارية لكل مشروع (لا صف واحد)،
    // تقييم كل صف على حدة عبر decideFinal، ثم pickWorstDecision يختار أسوأ
    // قرار — النتيجة الآن مستقلة تماماً عن ترتيب الاستعلام.
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
    // المصدر التشغيلي الوحيد فعلياً"): كان هذا المسار يُعيد حساب decideFinal
    // بمعزل تام عن باقي المسارات (البانر/viewer/التنبيهات) — بمدخلات قد
    // تختلف طفيفاً (توقيت جلب مختلف، aei=null دائماً هنا خلافاً للبانر)،
    // بلا أي decisionId موحَّد يربط النتيجة هنا بما يُعرض في صفحة تفاصيل
    // المشروع لنفس النشاط باللحظة. الآن يقرأ آخر قرار مخزَّن فعلياً في
    // final_decisions (كتبه evaluate/route.ts، نقطة الحساب الوحيدة) بدل
    // إعادة الحساب محلياً — نفس القرار بالضبط في كل الواجهات.
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
