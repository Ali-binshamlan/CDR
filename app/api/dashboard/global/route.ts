import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { requireUserId } from '@/app/lib/apiAuth';
import { safeErrorResponse } from '@/app/lib/apiError';
import { fetchLatestFinalDecisions, activityDecisionKey, isDustProfileWithinDailyWindow, type DustActivityRow } from '@/app/lib/dustEvaluation';
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

  const projectIds = (projectsData || []).map((p: { id: string }) => p.id);

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

  let dustData: DustActivityRow[] = [];
  let decisionsData: Record<string, unknown>[] = [];
  let liveActivityByProjectId: Record<string, { decisionLabelAr: string; shortReason: string; level: string; mandatoryStop: boolean }> = {};

  if (projectIds.length > 0) {
    // خطأ مكتشَف ومُصلَح (المستخدم سأل: "نشاط 3 أيام، هل يُحتسب من وقت
    // العمل فقط؟"): eq('planned_date', todayStr) كان يستبعد كلياً أي نشاط
    // بدأ في يوم سابق ولا يزال ممتداً اليوم (planned_date يبقى تاريخ
    // البداية الثابت، لا يتحدَّث يومياً) — نشاط 3 أيام بدأ أمس لم يكن
    // يظهر إطلاقاً في اليوم الثاني/الثالث. gte('planned_date', حد أدنى
    // معقول للماضي) يوسّع النطاق ليشمل أنشطة بدأت مؤخراً ولا تزال ضمن
    // مدى فعلي محتمل — isDustProfileWithinDailyWindow أدناه هو الفلتر
    // الدقيق الفعلي (يستبعد أي نشاط انتهى مداه فعلياً بصرف النظر عن هذا
    // النطاق الأولي الواسع).
    const lookbackDateStr = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const [dustRes, decisionsRes] = await Promise.all([
      supabaseAdmin
        .from('project_dust_profiles')
        .select('*')
        .in('project_id', projectIds)
        .gte('planned_date', lookbackDateStr)
        .lte('planned_date', todayStr)
        .is('archived_at', null),
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
    // خطأ أمني معماري مكتشَف ومُصلَح (القسم 5.7/12.2 من "دليل الإصلاح
    // الجذري لمنظومة مرقاب" — "العزل بين المشاريع غير مكتمل"): استعلام
    // متعدد المشاريع (كل مشاريع المستخدم معاً) كان يفلتر القرارات المخزَّنة
    // بـactivity_group_id وحده — activity_group_id قيمة حرة من العميل، فلو
    // تطابقت بالصدفة بين مشروعين، كان قرار أحدهما قد "يُخلَط" في نقطة
    // مشروع آخر على هذه الخريطة العامة. المفتاح المركّب (projectId,
    // activityGroupId) يمنع ذلك تماماً على مستوى قراءة النتيجة.
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
    decisions: decisionsData,
    executionWindows: [],
    liveActivityByProjectId,
  });
}
