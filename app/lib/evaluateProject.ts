import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import {
  computeDustResults,
  computeDustComplianceResults,
  persistActivityDecisionsAtomic,
  hasDustProfileWindowEnded,
} from '@/app/lib/dustEvaluation';
import { buildSensitiveReceptor, refreshRuleParameters, getActiveParameterVersionIds, withRuleParametersLock } from '@/app/utils/dust-compliance-engine';
import { checkDustActivities } from '@/app/api/alerts/generate/route';

// منطق إعادة تقييم مشروع كامل (DVI + Compliance + FinalDecision) — مُستخرَج
// من app/api/projects/[projectId]/evaluate/route.ts ليُستدعى من مصدرين:
// (أ) POST /evaluate نفسه (بعد requireUserId/verifyProjectOwnership، طلب
// من متصفح مستخدم مسجَّل)، (ب) app/api/cron/provider-pull/route.ts مباشرة
// (استدعاء داخلي من كود خادم موثوق بعد سحب قراءة جديدة بنجاح — لا جلسة
// مستخدم متاحة في سياق الـcron، ولا حاجة لها: projectId هنا مصدره صف
// provider_connections الموجود فعلاً بقاعدة البيانات، لا مدخل عميل).
//
// بلا أي تحقق مصادقة/ملكية هنا عمداً — هذه مسؤولية المستدعي (route.ts
// لطلبات المستخدم، أو التحقق الضمني عبر provider_connections.project_id
// للـcron، الذي لا يقبل أصلاً project_id من أي مدخل خارجي).
export interface EvaluateProjectResult {
  success: boolean;
  persisted: number;
  failedActivityIds?: string[];
  // failedActivityIds المحصورة في تعارض CAS (كود 40001 — راجع تعليق
  // persist_activity_decision_atomic) وحده، بلا أي فشل حقيقي آخر معها.
  // دورة تقييم لاحقة (refresh المستخدم أو الـcron) تحلّها تلقائياً بإعادة
  // قراءة current_dust_decisions/current_dust_compliance_decisions من
  // جديد؛ لا تستحق نفس درجة الخطورة أو نفس معالجة الفشل الحقيقي في route.ts.
  conflictActivityIds?: string[];
  error?: string;
  // جديد (202608160004 — المشكلة 4: "React ما زالت تحسب DVI/AEI وتعرض
  // الحفظ كتقييم رسمي"): خريطة activity_group_id → final_decisions.id
  // لكل نشاط صدر له قرار رسمي فعلياً هذه الدورة تحديداً (لا فقط عدد إجمالي
  // persisted على مستوى المشروع كله) — تسمح للمستدعي (POST /evaluate)
  // بالتحقق من صدور القرار الرسمي لنشاط محدد بدقة، لا نشاط آخر بالمصادفة.
  // فقط الأنشطة التي persistActivityDecisionsAtomic أصدرت لها finalDecisionId
  // فعلياً تظهر هنا (finalDecisionPersisted=true) — نشاط لم يتغيّر قراره
  // (shouldSkipPersist/v_skip_final) لا يظهر، حتى لو كان قراره المخزَّن
  // سابقاً لا يزال صالحاً.
  finalDecisionIdsByActivityGroup?: Record<string, string>;
}

// خطأ مكتشَف ومُصلَح (القسم 10.3 من "دليل الإصلاح الجذري لمنظومة مرقاب" —
// "اجعل سبب الحفظ الحقيقي يمر إلى evaluateProject؛ لا تسجل كل شيء
// user_refresh"): كانت evaluateProject تُمرِّر 'user_refresh' ثابتاً دائماً
// لـpersistActivityDecisionsAtomic بصرف النظر عن المستدعي الفعلي (scheduler
// دوري، حدث جهاز، سحب مزوّد، أو طلب مستخدم حقيقي) — فيفقد dust_evaluations/
// dust_compliance_evaluations.triggered_by أي قيمة تشخيصية حقيقية لتمييز
// مصدر كل قرار مخزَّن. triggeredBy اختياري (افتراضي 'user_refresh' يحافظ
// على التوافق مع كل الاستدعاءات القديمة التي لم تُحدِّث بعد).
//
// خطأ مكتشَف ومُصلَح (مراجعة كود خارجي — "التقييم بحسب وقت المعالجة قد
// يفوّت مخالفة كاملة"، راجع migration 202608110019 الكامل): evaluationAtMs
// اختياري جديد — يُمرَّر من scheduler-worker/route.ts (project_evaluation_jobs.
// evaluation_at، مبني من observed_at الفعلي للقراءة المُحفِّزة في
// telemetry-worker) بدل الاعتماد الضمني على Date.now() الفعلي وقت تنفيذ
// هذا الاستدعاء. نطاق التمرير مقيَّد عمداً لسلسلة computeDustComplianceResults
// → fetchPm10SustainedStatus → computeSustainedPm10Status (استمرار PM10
// فقط) — لا يمس computeDustResults (حداثة الجهاز/DVI) ولا previousDecisionsByGroup/
// RESUME-STABILITY-HOLD في computeDustComplianceResults نفسها، اللذين
// يبقيان يعتمدان "الآن الفعلي" كما كانا (قرار نطاق صريح — محرك حي أوسع
// مبني بنيوياً عبر عشرات الجلسات على افتراض "الآن=وقت التنفيذ" في هاتين
// النقطتين تحديداً، تغييره يتطلب مراجعة/اختبار منفصلين). غياب evaluationAtMs
// (كل الاستدعاءات الأخرى: POST /evaluate، devices/ingest، scheduler-tick
// عبر enqueueEvaluationRetryJob) يعني "قيّم بوقت التنفيذ الفعلي" — سلوك
// مطابق تماماً للسابق قبل هذا التغيير.
export async function evaluateProject(
  projectId: string,
  triggeredBy: string = 'user_refresh',
  evaluationAtMs?: number
): Promise<EvaluateProjectResult> {
  try {
    const { data: project } = await supabaseAdmin
      .from('projects')
      .select('*')
      .eq('id', projectId)
      .maybeSingle();
    if (!project) {
      return { success: false, persisted: 0, error: 'المشروع غير موجود' };
    }
    // خطأ تشغيلي مكتشَف — مراجعة كود خبير خارجي: "المشروع المؤرشف يمكن أن
    // يستمر في Provider pull والتقييم". خط دفاع ثانٍ هنا (بالإضافة لاستبعاد
    // provider-pull/route.ts للاتصالات التابعة لمشروع مؤرشف من استعلامه
    // أصلاً) — evaluateProject تُستدعى أيضاً من مسار push المباشر
    // (devices/ingest/route.ts) الذي لا يمر عبر provider_connections
    // إطلاقاً، فلا يستفيد من ذلك الاستبعاد؛ فشل آمن هنا بدل الاستمرار.
    if (project.archived_at) {
      return { success: true, persisted: 0 };
    }

    // خطأ سباق تزامن حرج مكتشَف ومُصلَح (طلب صريح من المستخدم — "لقطة
    // القواعد قابلة لسباق تزامن، ولقطة المدخلات لا تكفي لإعادة إنتاج القرار
    // تاريخياً"): current/currentVersionIds في ruleParameters.ts متغيّرات
    // module-level مشتركة على مستوى الـprocess بأكمله — evaluateProject
    // تُستدعى من 3 مصادر مستقلة (POST /evaluate، devices/ingest، scheduler-
    // worker) قد تتشابك على نفس الـinstance. بين refreshRuleParameters()
    // ولحظة الاستهلاك الفعلي داخل computeDustResults/computeDustComplianceResults
    // (عدة await من استعلامات DB تتخللها) كانت نافذة سباق حقيقية: دورة
    // تقييم متزامنة أخرى قد تستدعي refreshRuleParameters الخاصة بها وتُغيِّر
    // current/currentVersionIds *قبل* أن تصل هذه الدورة فعلياً لاستهلاكهما
    // — فتُحفَظ rule_parameter_version_snapshot تشير لمعرّفات نسخ لا تطابق
    // فعلياً القيم المستخدَمة في الحساب، بصمة كاذبة تُفشل أي إعادة
    // إنتاج/تدقيق لاحقة. withRuleParametersLock (قفل تسلسلي صريح، async
    // mutex) يضمن أن لا تتشابك دورتا تقييم متزامنتان إطلاقاً من refresh حتى
    // نهاية persist — بلا حاجة لتمرير RuleParameters عبر كل طبقة استدعاء
    // (rulebook.ts/engine.ts/dust-engine تبقى بتوقيعاتها الحالية بلا تغيير).
    type CriticalSectionResult =
      | { earlyReturn: EvaluateProjectResult }
      | {
          evaluationRunId: string | null;
          dustResults: Awaited<ReturnType<typeof computeDustResults>>;
          persistResults: Awaited<ReturnType<typeof persistActivityDecisionsAtomic>>;
        };
    const criticalSection = await withRuleParametersLock<CriticalSectionResult>(async () => {
      // يُحدَّث getRuleParameters() هنا أولاً، قبل computeDustResults (DVI،
      // يستهلك BATCHING_PM10_FILTER_MIN_PERCENT() مباشرة) وcomputeDustComplianceResults
      // كليهما — لا فقط الثاني — حتى لا يُقرأ DVI بقيمة افتراضية/قديمة بينما
      // Compliance يُقرأ بأحدث نسخة منشورة في نفس دورة التقييم الواحدة.
      await refreshRuleParameters(supabaseAdmin);
      // بصمة نسخ rule_parameter_versions.id الفعلية وقت هذه الدورة تحديداً —
      // تُلتقَط هنا مباشرة بعد refresh، ضمن نفس القفل الذي يحمي الاستهلاك
      // الفعلي أدناه بأكمله.
      const activeParameterVersionIds = getActiveParameterVersionIds();

      // القسم 11.2 — Evaluation Run: يربط كل دورة تقييم فعلية بمعرّف واحد،
      // بصرف النظر عن مصدر التحفيز. as_of هو لحظة بداية هذه الدورة تحديداً
      // (لا وقت الحفظ لاحقاً) — يسمح لاحقاً بإعادة إنتاج "ما كانت الحالة عليه
      // وقت هذا التقييم بالضبط" حتى لو تغيّرت البيانات بعده.
      const asOf = new Date().toISOString();
      const { data: runRow } = await supabaseAdmin
        .from('evaluation_runs')
        .insert({ project_id: projectId, trigger_type: normalizeTriggerType(triggeredBy), as_of: asOf, status: 'RUNNING' })
        .select('id')
        .single();
      const evaluationRunId = runRow?.id ?? null;

      const [{ data: dustProfilesRaw }, { data: projectShifts }] = await Promise.all([
        // archived_at is null — نشاط مؤرشَف (راجع DELETE في app/api/activities/
        // route.ts، الأرشفة حلّت محل الحذف الفعلي) يجب ألا يدخل دورة تقييم حية
        // جديدة، رغم بقاء أدلته التاريخية قابلة للقراءة دائماً في مكان آخر.
        supabaseAdmin.from('project_dust_profiles').select('*').eq('project_id', projectId).is('archived_at', null),
        supabaseAdmin.from('project_shifts').select('*').eq('project_id', projectId).order('sort_order', { ascending: true }),
      ]);
      project.shifts = projectShifts || [];

      // خطأ مكتشَف ومُصلَح (المستخدم لاحظ أن نشاطاً تعرضه الواجهة كـ"انتهى
      // النشاط" — planned_date/planned_time/duration_hours انقضت نافذته
      // الزمنية — استمر يستقبل قرارات جديدة في final_decisions): الواجهة
      // (MultiIndicatorActivityBox.tsx) تحسب status==='past' وتُخفي القرار
      // الحي بصرياً فقط، لكن evaluateProject لم يكن يستبعد هذه الصفوف من
      // التقييم الفعلي على الخادم إطلاقاً. hasDustProfileWindowEnded (بخلاف
      // الاسم القديم isDustProfileWindowActive) تحسب نهاية مدى النشاط الكلي
      // عبر أيام العمل الفعلية (لا فترة متصلة بلا انقطاع ليلي — راجع
      // migration 202608110012 وتعليقها الكامل في dustEvaluation.ts) —
      // نشاط 3 أيام بدوام 8 ساعات يبقى مؤهَّلاً للتقييم طوال الأيام الثلاثة،
      // لا يُستبعَد إلا بعد انتهاء آخر يوم عمل فعلياً.
      const workDaysList = Array.isArray(project.work_days_list) ? (project.work_days_list as string[]) : undefined;
      const nowMs = Date.now();
      const dustProfiles = (dustProfilesRaw || []).filter((row) => !hasDustProfileWindowEnded(row, workDaysList, nowMs));

      const dustResults = await computeDustResults(dustProfiles, project, supabaseAdmin);
      if (dustResults.length === 0) {
        await completeEvaluationRun(evaluationRunId, { status: 'SUCCEEDED', activitiesEvaluated: 0, activitiesFailed: 0 });
        return { earlyReturn: { success: true, persisted: 0 } as EvaluateProjectResult };
      }

      const { data: sensitiveReceptorRows, error: sensitiveReceptorsError } = await supabaseAdmin
        .from('sensitive_receptors')
        .select('id, name, receptor_type, lat, lng');
      if (sensitiveReceptorsError) {
        await completeEvaluationRun(evaluationRunId, { status: 'FAILED', error: sensitiveReceptorsError.message });
        return { earlyReturn: { success: false, persisted: 0, error: sensitiveReceptorsError.message } as EvaluateProjectResult };
      }
      const sensitiveReceptors = (sensitiveReceptorRows || []).map(buildSensitiveReceptor);

      const dustComplianceResults = await computeDustComplianceResults(
        dustProfiles || [],
        project,
        dustResults,
        sensitiveReceptors,
        supabaseAdmin,
        true,
        evaluationAtMs
      );

      const persistResults = await persistActivityDecisionsAtomic(
        supabaseAdmin,
        projectId,
        dustResults,
        dustComplianceResults,
        triggeredBy,
        triggeredBy,
        evaluationRunId,
        activeParameterVersionIds
      );

      return { evaluationRunId, dustResults, persistResults };
    });

    if ('earlyReturn' in criticalSection) {
      return criticalSection.earlyReturn;
    }
    const { evaluationRunId, dustResults, persistResults } = criticalSection;

    // جديد (202608160004): يُبنى مرة واحدة هنا، يُرفَق على مساري الإرجاع
    // معاً (فشل جزئي أدناه، ونجاح كامل لاحقاً) — نشاط واحد قد ينجح بينما
    // آخر يفشل في نفس الدورة (فشل جزئي)، فلا يجوز حصر هذه الخريطة على
    // مسار النجاح الكامل فقط.
    const finalDecisionIdsByActivityGroup: Record<string, string> = {};
    for (const r of persistResults) {
      if (r.finalDecisionPersisted && r.finalDecisionId) {
        finalDecisionIdsByActivityGroup[r.activityGroupId] = r.finalDecisionId;
      }
    }

    const allFailedActivityIds = persistResults.filter((r) => r.failed).map((r) => r.activityId);

    // خطأ تشغيلي مكتشَف — مراجعة كود خبير خارجي: "التنبيهات لا تُنشأ مباشرة
    // بعد نجاح حفظ القرار، وقد تخلط قراراً قديماً مع تقييم جديد". قبل هذا،
    // checkDustActivities (مولّد التنبيهات) كان يُستدعى فقط على جدول زمني
    // منفصل تماماً (Cron يومي، أو كل 5 دقائق من المتصفح عبر generate-mine)
    // بمعزل عن لحظة حفظ القرار الفعلية هنا — فقد يقرأ التنبيه قراراً محفوظاً
    // منذ ساعات بينما تغيّرت الحالة الفعلية للتو. الإصلاح: استدعاء
    // checkDustActivities([projectId]) فوراً هنا بعد نجاح الحفظ (لو نجح
    // نشاط واحد على الأقل)، مقيَّداً بهذا المشروع فقط (نفس آلية التصفية
    // المستخدَمة أصلاً في generate-mine/route.ts) — يقرأ حصرياً من
    // current_dust_compliance_decisions/final_decisions المحفوظة للتو (لا
    // إعادة حساب DVI/Compliance من الصفر)، فيغلق الفارق الزمني بين "الحفظ"
    // و"التنبيه" لأجزاء من الثانية بدل يوم كامل أو 5 دقائق. فشل التنبيه لا
    // يُسقِط نجاح الحفظ نفسه (القرار محفوظ فعلاً بغض النظر) — يُسجَّل فقط،
    // نفس مبدأ معالجة الفشل الجزئي في provider-pull/route.ts.
    const persistedCount = dustResults.length - allFailedActivityIds.length;
    if (persistedCount > 0) {
      await checkDustActivities([projectId]).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`evaluateProject: checkDustActivities failed for project ${projectId}:`, message);
      });
    }

    if (allFailedActivityIds.length > 0) {
      const conflictActivityIds = persistResults.filter((r) => r.failed && r.conflict).map((r) => r.activityId);
      const nonConflictFailedActivityIds = persistResults.filter((r) => r.failed && !r.conflict).map((r) => r.activityId);
      await completeEvaluationRun(evaluationRunId, {
        status: nonConflictFailedActivityIds.length > 0 ? 'FAILED' : 'SUCCEEDED',
        activitiesEvaluated: persistedCount,
        activitiesFailed: allFailedActivityIds.length,
        error:
          nonConflictFailedActivityIds.length > 0
            ? 'فشل حفظ سلسلة القرار كاملة لبعض الأنشطة'
            : 'تعارض CAS لبعض الأنشطة — أعد المحاولة',
      });
      return {
        success: false,
        persisted: persistedCount,
        failedActivityIds: nonConflictFailedActivityIds,
        conflictActivityIds,
        error:
          nonConflictFailedActivityIds.length > 0
            ? 'فشل حفظ سلسلة القرار كاملة لبعض الأنشطة'
            : 'تعارض CAS لبعض الأنشطة — أعد المحاولة',
        finalDecisionIdsByActivityGroup,
      };
    }

    // القسم 10.3 — last_successful_project_evaluation_at: يُحدَّث فقط عند
    // نجاح تقييم فعلي كامل (لا مجرد إنشاء المهمة، راجع scheduler-tick/
    // route.ts الذي يحدّث last_heartbeat_at وحده). evaluation_lag_seconds
    // يُشتق لاحقاً من الفارق بين الآن وهذا العمود في endpoint الـheartbeat.
    await supabaseAdmin
      .from('scheduler_heartbeat')
      .update({ last_successful_project_evaluation_at: new Date().toISOString() })
      .eq('id', true);

    await completeEvaluationRun(evaluationRunId, {
      status: 'SUCCEEDED',
      activitiesEvaluated: dustResults.length,
      activitiesFailed: 0,
    });
    return { success: true, persisted: dustResults.length, finalDecisionIdsByActivityGroup };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, persisted: 0, error: message };
  }
}

// خطأ مكتشَف ومُصلَح (مراجعة خبير خارجي — "إن نجح حفظ القراءة لكن فشل
// التقييم بعدها، يُسجَّل خطأ فقط وتبقى الاستجابة للجهاز ناجحة — لا مهمة
// إعادة محاولة مضمونة تربط القراءة بالتقييم الفاشل"): devices/ingest/route.ts
// وcron/provider-pull/route.ts يستدعيان evaluateProject مباشرة (استدعاء
// inline متزامن)، لا عبر طابور project_evaluation_jobs — فشل هذا الاستدعاء
// كان يُسجَّل بـconsole.error فقط، معتمداً ضمنياً على scheduler-tick (كل
// دقيقتين) ليلتقط المشروع لاحقاً بلا أي ضمان صريح ولا تتبع محاولات/أخطاء.
// enqueueEvaluationRetryJob تُستدعى من كلا المسارين عند فشل/رمي evaluateProject
// المباشر — تُدرج مهمة في نفس طابور project_evaluation_jobs الذي يعالجه
// scheduler-worker (claim_evaluation_jobs/fail_evaluation_job، Backoff أُسّي
// حتى DEAD)، فيصبح لكل فشل تقييم بعد قراءة ناجحة مساراً صريحاً ومتتبَّعاً
// للمحاولة مجدداً، لا اعتماداً على "الدورة القادمة قد تلتقطه صدفة".
//
// حادثة إنتاج فعلية (2026-08-09): dedupe_key كان فريداً لكل استدعاء
// (crypto.randomUUID()) رغم اسمه — القيد الفريد الفعلي على الجدول
// (project_id, dedupe_key) لم يكن يمنع أي شيء عملياً. تحت تزاحم مستمر على
// نفس صف القرار (provider-pull كل دقيقة يفشل بتكرار بسبب lock_timeout)،
// كل فشل كان يُنشئ مهمة retry جديدة كلياً، تُضاف فوق التي قبلها ويعالجها
// scheduler-worker لاحقاً كمصدر تزامن إضافي على نفس الصف — حلقة تغذية
// راجعة سلبية تُفاقم التزاحم بدل تخفيفه. الإصلاح: مفتاح مستقر لكل دقيقة
// (نفس مبدأ provider_pull_run_lock بالضبط) — كل فشل ضمن نفس الدقيقة لنفس
// (project_id, triggerType) يصطدم بقيد unique(project_id, dedupe_key)
// فيُرفَض بصمت (PostgREST يُرجع خطأ 23505 في استجابة .insert()، لا استثناء
// يُرمى — لا حاجة لفحصه صراحةً هنا؛ نفس فلسفة "فشل الإدراج لا يُسقط
// الاستدعاء الأصلي" الموثَّقة أدناه أصلاً)، فلا يتراكم أكثر من محاولة
// retry واحدة معلَّقة لكل مشروع في كل دقيقة، بصرف النظر عن عدد مرات الفشل
// الفعلية خلالها.
export async function enqueueEvaluationRetryJob(
  projectId: string,
  // USER_REQUEST (مراجعة كود خارجي — P1، الملاحظة #13: "الواجهة ما زالت
  // تستطيع عرض قرار حي لم يُحفظ بعد في Immutable Audit"): POST /evaluate
  // (evaluate/route.ts) يُستدعى fire-and-forget من الواجهة بعد GET، بلا أي
  // ضمان أن الحفظ سينجح أو يُعاد لاحقاً عند الفشل — إضافة هذا النوع تسمح
  // لذلك المسار بالاستفادة من نفس آلية إعادة المحاولة المضمونة الموجودة
  // أصلاً لـDEVICE_EVENT/PROVIDER_PULL، بدل ترك القرار المعروض للمستخدم بلا
  // أي محاولة توثيق لاحقة مضمونة عند فشل الكتابة الأولى.
  triggerType: 'DEVICE_EVENT' | 'PROVIDER_PULL' | 'USER_REQUEST',
  error: string
): Promise<void> {
  try {
    const minuteBucket = Math.floor(Date.now() / 60_000);
    await supabaseAdmin.from('project_evaluation_jobs').insert({
      project_id: projectId,
      dedupe_key: `retry:${triggerType}:${minuteBucket}`,
      trigger_type: triggerType,
      last_error: error,
    });
  } catch (err) {
    // فشل إنشاء مهمة إعادة المحاولة نفسه لا يجوز أن يُسقِط استجابة الاستدعاء
    // الأصلي (القراءة محفوظة فعلاً بغض النظر) — يُسجَّل فقط. المشروع يبقى
    // مغطى بالحد الأدنى عبر scheduler-tick الدوري حتى لو فشل هذا الإدراج.
    console.error(`enqueueEvaluationRetryJob: فشل إدراج مهمة إعادة محاولة لمشروع ${projectId}:`, err);
  }
}

// trigger_type في evaluation_runs مقيَّد بنفس قيم project_evaluation_jobs
// (SCHEDULED/DEVICE_EVENT/PROVIDER_PULL/USER_REQUEST) — triggeredBy الممرَّر
// فعلياً من مستدعيات evaluateProject نص حر أوسع (مثال: 'user_refresh')
// لأسباب توافقية مع dust_evaluations.triggered_by القديم. هذه الدالة
// تُطابِق النص الحر مع أقرب قيمة مقيَّدة، فشل آمن نحو USER_REQUEST لأي نص
// غير معروف (لا نرمي خطأً يُسقِط حفظ evaluation_runs بأكمله لمجرد نص جديد).
function normalizeTriggerType(triggeredBy: string): 'SCHEDULED' | 'DEVICE_EVENT' | 'PROVIDER_PULL' | 'USER_REQUEST' {
  const value = triggeredBy.toLowerCase();
  if (value.includes('scheduler') || value.includes('scheduled')) return 'SCHEDULED';
  if (value.includes('device') || value.includes('ingest')) return 'DEVICE_EVENT';
  if (value.includes('provider') || value.includes('pull')) return 'PROVIDER_PULL';
  return 'USER_REQUEST';
}

async function completeEvaluationRun(
  evaluationRunId: string | null,
  outcome: { status: 'SUCCEEDED' | 'FAILED'; activitiesEvaluated?: number; activitiesFailed?: number; error?: string }
): Promise<void> {
  if (!evaluationRunId) return;
  try {
    await supabaseAdmin
      .from('evaluation_runs')
      .update({
        status: outcome.status,
        activities_evaluated: outcome.activitiesEvaluated ?? 0,
        activities_failed: outcome.activitiesFailed ?? 0,
        error: outcome.error ?? null,
        completed_at: new Date().toISOString(),
      })
      .eq('id', evaluationRunId);
  } catch (err) {
    console.error('completeEvaluationRun: فشل تحديث evaluation_runs:', err);
  }
}
