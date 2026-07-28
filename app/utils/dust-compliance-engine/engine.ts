// =============================================================
// Riyadh Dust Compliance Engine — Core
// evaluateDustCompliance: الدالة الرئيسية. تستهلك نتيجة DVI الجاهزة
// (قراءة فقط، بلا إعادة حساب)، وتُطبّق تصنيف المشروع + بروتوكول
// الرياح + بوابات الأولوية القصوى (DMP/DVI/تعطل التثبيط) + قواعد
// النشاط التنظيمي، ثم تُصدر قرار امتثال واحد بأولوية واضحة.
// =============================================================

import {
  RULEBOOK_VERSION,
  applyActivityRules,
  classifyProject,
  classifyWind,
  decisionFromRules,
  enhancedSuppressionRule,
  pm10ThresholdRule,
  REGULATORY_ACTIVITY_LABEL_AR,
  DECISION_PRIORITY,
  BATCHING_PM10_FILTER_MIN_PERCENT,
} from './rulebook';
import type {
  DustComplianceContext,
  DustComplianceDecisionCategory,
  DustComplianceResult,
  DustMonitoringObligation,
  DustRiskClass,
  DustRuleHit,
} from './types';

const ENGINE_VERSION = '1.0.0';

const DECISION_LABEL_AR: Record<DustComplianceDecisionCategory, string> = {
  ALLOW: 'مسموح — تشغيل اعتيادي',
  PRECAUTION: 'احتراز — زيادة المراقبة',
  ALLOW_WITH_CONTROLS: 'مسموح مع ضوابط تحكم إضافية',
  FIELD_VERIFICATION_REQUIRED: 'يتطلب تحقق ميداني قبل الاستمرار',
  RESTRICT_ACTIVITY: 'تقييد النشاط',
  STOP_AFFECTED_ACTIVITY: 'إيقاف النشاط المتأثر',
  MANDATORY_STOP: 'إيقاف إلزامي غير قابل للتجاوز',
};

const CONFIDENCE_MIN_FOR_ALLOW = 70;
// القسم الرابع، ثالثاً (الفئة الثانية) — حفظ تسجيلات كاميرات الدخول/الخروج
// لمدة لا تقل عن 90 يوماً.
const CAMERA_RETENTION_MIN_DAYS = 90;

function shortReasonFor(
  decision: DustComplianceDecisionCategory,
  ruleHits: DustRuleHit[],
  resumeHoldApplied: boolean
): string {
  if (resumeHoldApplied) {
    return 'الظروف تحسّنت لكن لم يمضِ وقت كافٍ على استقرارها بعد آخر إيقاف — بانتظار استقرار القراءة (10 دقائق) قبل الاستئناف';
  }
  if (decision === 'ALLOW') return 'لا توجد مخالفات تنظيمية ظاهرة على النشاط الحالي';
  const topRule = ruleHits.find((r) => r.severity === decision);
  return topRule?.messageAr ?? DECISION_LABEL_AR[decision];
}

function buildMonitoringObligations(
  ctx: DustComplianceContext,
  riskClass: DustRiskClass
): { obligations: DustMonitoringObligation[] } {
  const { project } = ctx;
  // الحد الأدنى لعدد محطات الرصد يختلف حسب فئة المشروع — محطتان للفئة
  // الثالثة (مع تحديد مواقعهما حسب وردة الرياح لاحقاً)، ومحطة واحدة للفئة
  // الثانية فقط (القسم الرابع، رابعاً؛ "الاستخراج التنظيمي من المرفق").
  const minStationCount = riskClass === 'CATEGORY_III_HIGH' ? 2 : 1;

  const obligations: DustMonitoringObligation[] = [
    {
      key: 'BASELINE_MONITORING_14_DAYS',
      required: true,
      status:
        project.baselineMonitoringDays === null || project.baselineMonitoringDays === undefined
          ? 'UNKNOWN'
          : project.baselineMonitoringDays >= 14
          ? 'COMPLIANT'
          : 'NON_COMPLIANT',
      descriptionAr: 'رصد أساسي لا يقل عن 14 يوماً على حدود ملكية المشروع قبل بدء الأعمال',
    },
    {
      key: 'MONITORING_STATION_COUNT',
      required: true,
      status:
        project.monitoringStationCount === null || project.monitoringStationCount === undefined
          ? 'UNKNOWN'
          : project.monitoringStationCount >= minStationCount
          ? 'COMPLIANT'
          : 'NON_COMPLIANT',
      descriptionAr: `محطة رصد PM10 واحدة على الأقل للفئة الثانية، ومحطتان على الأقل للفئة الثالثة (المطلوب هنا: ${minStationCount})`,
    },
    {
      key: 'MONITORING_LOGGING_INTERVAL',
      required: true,
      status:
        project.monitoringLoggingIntervalMinutes === null ||
        project.monitoringLoggingIntervalMinutes === undefined
          ? 'UNKNOWN'
          : project.monitoringLoggingIntervalMinutes <= 1
          ? 'COMPLIANT'
          : 'NON_COMPLIANT',
      // القاعدة المعتمدة صراحة في "الاستخراج التنظيمي من المرفق" (القسم 7 +
      // "القواعد النهائية التي يعتمدها مرقاب") هي دقيقة واحدة فقط، وليس
      // دقيقتين رغم ورود "كل دقيقتين" في ملخصات سابقة — المستند نفسه يحذّر
      // من هذا الالتباس صراحة ويعتمد الدقيقة الواحدة كالحد النهائي.
      descriptionAr: 'تسجيل بيانات الرصد كل دقيقة واحدة أو أقل',
    },
    {
      key: 'ANEMOMETER_HEIGHT',
      required: true,
      status:
        project.anemometerHeightM === null || project.anemometerHeightM === undefined
          ? 'UNKNOWN'
          : project.anemometerHeightM >= 2 && project.anemometerHeightM <= 3
          ? 'COMPLIANT'
          : 'NON_COMPLIANT',
      descriptionAr: 'ارتفاع مقياس سرعة الرياح بين 2 و3 أمتار فوق سطح الأرض',
    },
    {
      key: 'ENTRY_EXIT_CAMERAS',
      required: true,
      // الالتزام يتطلب عنصرين معاً (القسم الرابع، ثالثاً): تركيب الكاميرات
      // فعلياً، وحفظ المقاطع 90 يوماً على الأقل — تحقق سابق كان يفحص وجود
      // الكاميرات فقط (boolean) دون التحقق فعلياً من مدة الاحتفاظ المُدخلة.
      status:
        project.entryExitCamerasInstalled === null || project.entryExitCamerasInstalled === undefined
          ? 'UNKNOWN'
          : !project.entryExitCamerasInstalled
          ? 'NON_COMPLIANT'
          : project.cameraRetentionDays === null || project.cameraRetentionDays === undefined
          ? 'UNKNOWN'
          : project.cameraRetentionDays >= CAMERA_RETENTION_MIN_DAYS
          ? 'COMPLIANT'
          : 'NON_COMPLIANT',
      descriptionAr: `كاميرات عند جميع نقاط الدخول والخروج مع حفظ المقاطع ${CAMERA_RETENTION_MIN_DAYS} يوماً على الأقل`,
    },
    {
      key: 'SENSITIVITY_MAP',
      required: true,
      status:
        project.sensitivityMapPrepared === null || project.sensitivityMapPrepared === undefined
          ? 'UNKNOWN'
          : project.sensitivityMapPrepared
          ? 'COMPLIANT'
          : 'NON_COMPLIANT',
      descriptionAr: 'خريطة حساسية بيئية (GIS) مُعدة للفئتين الثانية والثالثة',
    },
  ];

  return { obligations };
}

function calculateComplianceConfidence(ctx: DustComplianceContext, missingCriticalInputs: string[]): number {
  let confidence = ctx.dviConfidenceScore;

  const { project } = ctx;
  if (project.siteAreaM2 === null || project.siteAreaM2 === undefined) confidence -= 8;
  if (project.dailyTruckMovements === null || project.dailyTruckMovements === undefined) confidence -= 4;
  if (project.hasOnsiteCrusher === null || project.hasOnsiteCrusher === undefined) confidence -= 3;
  if (project.hasOnsiteBatchingPlant === null || project.hasOnsiteBatchingPlant === undefined) confidence -= 3;
  if (project.dmpApprovalStatus === 'UNKNOWN') confidence -= 8;
  if (ctx.windSpeedKmh === null || ctx.windSpeedKmh === undefined) confidence -= 15;

  if (ctx.dataSource === 'none') confidence -= 8;
  if (ctx.dataSource === 'onsite' || ctx.dataSource === 'project-station') confidence += 8;

  confidence -= Math.min(20, missingCriticalInputs.length * 2);

  return Math.max(0, Math.min(100, Math.round(confidence)));
}

function confidenceLabelAr(score: number): string {
  if (score >= 90) return 'قرار قوي';
  if (score >= 80) return 'قرار موثوق';
  if (score >= 70) return 'قرار جيد مع مراقبة';
  return 'يحتاج تحقق ميداني';
}

export function evaluateDustCompliance(ctx: DustComplianceContext): DustComplianceResult {
  const { riskClass, reasonAr: riskClassReasonAr } = classifyProject(ctx.project);
  const windBand = classifyWind(ctx.windSpeedKmh);

  const missingCriticalInputs: string[] = [];
  if (ctx.project.siteAreaM2 === null || ctx.project.siteAreaM2 === undefined) {
    missingCriticalInputs.push('مساحة الموقع غير مُدخلة');
  }
  if (ctx.project.dailyTruckMovements === null || ctx.project.dailyTruckMovements === undefined) {
    missingCriticalInputs.push('حركة الشاحنات اليومية غير مُدخلة');
  }
  if (ctx.windSpeedKmh === null || ctx.windSpeedKmh === undefined) {
    missingCriticalInputs.push('سرعة الرياح غير متوفرة');
  }
  if (riskClass === 'UNCLASSIFIED') {
    missingCriticalInputs.push('تصنيف فئة مخاطر المشروع غير مكتمل');
  }
  if (ctx.project.dmpApprovalStatus === 'UNKNOWN') {
    missingCriticalInputs.push('حالة اعتماد خطة إدارة الغبار (DMP) غير مُدخلة');
  }

  const ruleHits: DustRuleHit[] = [];

  // --- بوابات الأولوية القصوى (القسم 9.1-9.3) ---
  // "UNKNOWN" (الحقل لم يُملأ بعد) يختلف عن رفض/عدم اكتمال DMP الفعلي
  // (REJECTED/NOT_STARTED/DRAFT/SUBMITTED): عدم إدخال البيانات لا يجوز أن
  // يُعامَل كمخالفة تنظيمية مؤكدة تستوجب إيقافاً إلزامياً — هذا يوقف كل
  // نشاط في كل مشروع أُنشئ قبل إضافة حقل DMP بلا أي تدخل من المستخدم.
  // بدلاً من ذلك تُضاف إلى missingCriticalInputs أعلاه، فيمنع القرار
  // الأخضر (ALLOW) دون فرض إيقاف إلزامي كاذب على نشاط قد يكون سليماً تماماً.
  const dmpExplicitlyBlocksActivity =
    ctx.activity.isActiveOrPlanned &&
    ctx.project.dmpApprovalStatus !== 'APPROVED' &&
    ctx.project.dmpApprovalStatus !== 'NOT_REQUIRED' &&
    ctx.project.dmpApprovalStatus !== 'UNKNOWN';
  if (dmpExplicitlyBlocksActivity) {
    ruleHits.push(
      {
        code: 'GATE-DMP-001',
        severity: 'MANDATORY_STOP',
        messageAr: 'إيقاف إلزامي: نشاط غبار نشط/مخطط بلا موافقة معتمدة على خطة إدارة الغبار (DMP)',
        actionAr: 'أوقف النشاط حتى تصدر موافقة معتمدة على خطة إدارة الغبار (DMP) من الجهة المختصة',
      }
    );
  }

  if (ctx.dviMandatoryStop) {
    // نستخدم سبب DVI المحدَّد فعلياً (مثال: "PM10 = 1806.8") إن توفّر، بدل
    // نص عام لا يذكر أي رقم أو سبب ملموس — كان هذا يجعل بانر "القرار الموحد"
    // يعرض جملة غامضة رغم أن DVI شخّص السبب الدقيق بالفعل. يبقى نص احتياطي
    // عام فقط لو لم يتوفر dviShortReason (فشل آمن، لا كسر لأي مستهلك حالي).
    //
    // خطأ مكتشَف ومُصلَح: كان النص الاحتياطي يصف القاعدة بـ"لا علاقة له
    // بمخالفة تنظيمية" — تناقض مباشر مع سياق عرضها الفعلي (بقرار MANDATORY_
    // STOP ملزم ضمن "أساس القرار — الامتثال التنظيمي" بالواجهة). الأصل
    // التقني صحيح (القاعدة موروثة من قياس DVI الفيزيائي المباشر لا من
    // مخالفة ضابط تحكم)، لكن الصياغة يجب أن تبقى دائماً بلغة امتثال تنظيمي
    // موحّدة — لا عرض قرارين متنافسين لنفس النشاط.
    ruleHits.push(
      {
        code: 'GATE-DVI-002',
        severity: 'MANDATORY_STOP',
        messageAr:
          ctx.dviShortReason ||
          'إيقاف إلزامي تنظيمي: تجاوز خطر فوري في تركيز الغبار أو انعدام الرؤية بموقع النشاط',
        // الإجراء هنا مختلف جوهرياً عن بقية القواعد: لا يوجد ما "يُصلحه"
        // المقاول في الموقع — الظرف الجوي نفسه هو المانع، فالإجراء انتظار
        // تحسّن الحالة وإخلاء العمالة، لا استكمال ضابط تحكم ناقص.
        actionAr: 'أخلِ منطقة العمل وانتظر تحسّن حالة الجو (الرؤية وتركيز الغبار) — لا يمكن استئناف العمل بإجراء تنظيمي',
      }
    );
  }

  if (ctx.activity.isDustGenerating && ctx.activity.controls.dustSuppressionSystemOperational === false) {
    ruleHits.push(
      {
        code: 'GATE-SUPPRESSION-003',
        severity: 'MANDATORY_STOP',
        messageAr: 'إيقاف إلزامي: نظام تثبيط الغبار غير عامل على نشاط مولّد للغبار',
        actionAr: 'أعد تشغيل نظام تثبيط الغبار وتحقق من عمله فعلياً قبل استئناف النشاط',
      }
    );
  }

  // بروتوكول الملحق أ — أعلى من 25 كم/س: تُوقف كل الأنشطة المكشوفة
  // المولّدة للغبار عموماً (وليس فقط الهدم)؛ العمليات المغلقة فقط تستمر.
  // استثناء محطة الخلط (BATCHING_PLANT) تحديداً: لا يُشترط isEnclosedOperation
  // إطلاقاً (قد تكون المحطة فعلياً مكشوفة هيكلياً) — يكفي إحكام إغلاق
  // الصوامع (silosSealed، مدخل حقيقي لكل وحدة خلط) + كفاءة فلتر PM10 لا
  // تقل عن الحد الأدنى (نفس حد BATCHING-FILTER-002 في rulebook.ts) معاً،
  // طلب صريح من المستخدم: "حتى لو كان مكشوف بس الفلاتر 99 والصوامع مغلق
  // أبغاه يكون مسموح". بقية الأنشطة المغلقة (هدم مغلق، قطع أحجار مغلق)
  // تستمر بإعفاء isEnclosedOperation وحده كما كان دائماً.
  //
  // نفس الشرط (صوامع مغلقة + فلتر ≥99%) يُستخدم الآن أيضاً لإعفاء محطة
  // الخلط بالكامل من كل قواعد PM10 (احتراز/تحذير/تنبيه استباقي/تعليق
  // ومؤكَّد) — بمصدر واحد موحَّد بدل تكرار الشرط في مكانين.
  const isEnclosedExemptFromHighWind =
    ctx.activity.regulatoryActivity === 'BATCHING_PLANT'
      ? ctx.activity.controls.silosSealed === true &&
        ctx.activity.controls.pm10FilterEfficiencyPercent !== null &&
        ctx.activity.controls.pm10FilterEfficiencyPercent !== undefined &&
        ctx.activity.controls.pm10FilterEfficiencyPercent >= BATCHING_PM10_FILTER_MIN_PERCENT
      : ctx.activity.isEnclosedOperation;

  if (windBand === 'ABOVE_25' && ctx.activity.isDustGenerating && !isEnclosedExemptFromHighWind) {
    ruleHits.push(
      {
        code: 'GATE-WIND-ABOVE-25-004',
        severity: 'STOP_AFFECTED_ACTIVITY',
        messageAr: 'إيقاف الأنشطة المكشوفة المولّدة للغبار: سرعة الرياح تتجاوز 25 كم/س ',
        actionAr: 'أوقف الأنشطة المكشوفة وأمّن المواد السائبة، وانتظر انخفاض سرعة الرياح إلى ما دون 25 كم/س',
      }
    );
  }

  // إعفاء قواعد PM10 مقصور على BATCHING_PLANT تحديداً (مغلقة + فلتر ≥99%
  // معاً) — أي نشاط آخر غير BATCHING_PLANT له isEnclosedExemptFromHighWind
  // مبني فقط على isEnclosedOperation (بلا شرط فلتر إطلاقاً، لأن الحقل يبقى
  // null بالبناء)، فلا يجوز استخدامه هنا مباشرة كإعفاء PM10 — إلا لو كان
  // النشاط فعلياً BATCHING_PLANT.
  const isPm10ExemptEnclosedBatching =
    ctx.activity.regulatoryActivity === 'BATCHING_PLANT' && isEnclosedExemptFromHighWind;

  // 15-25 كم/س — تثبيط معزز عام (دون إيقاف)، و حدود PM10 التنظيمية —
  // "الاستخراج التنظيمي من المرفق" القسم 5-6. راجع rulebook.ts للتفاصيل.
  //
  // خطأ مكتشَف ومُصلَح: كان يُمرَّر ctx.activity.isEnclosedOperation الخام
  // (سؤال بنيوي: هل المحطة مغلقة فيزيائياً؟) بدل isEnclosedExemptFromHighWind
  // (الإعفاء الفعلي المطبَّق أعلاه لبوابة الرياح >25 وPM10 معاً). محطة الخلط
  // مستثناة عمداً من اشتراط isEnclosedOperation إطلاقاً (طلب صريح من
  // المستخدم: "حتى لو كان مكشوف بس الفلاتر 99 والصوامع مغلق أبغاه يكون
  // مسموح") — فمحطة خلط مكشوفة فيزيائياً لكن بصوامع مغلقة وفلتر ≥99% كانت
  // لا تزال تُفعِّل GATE-WIND-15-25-ENHANCED-005 (تثبيط معزز إضافي) عند رياح
  // 15-25 كم/س، رغم استثنائها الكامل من البوابة الأشد (>25) والقواعد
  // الأخرى. استخدام isEnclosedExemptFromHighWind هنا يوحّد شرط الإعفاء لكل
  // بوابات الرياح معاً — الاستثناء إما كامل أو لا يطبَّق إطلاقاً.
  ruleHits.push(...enhancedSuppressionRule(ctx.activity.isDustGenerating, isEnclosedExemptFromHighWind, windBand));
  ruleHits.push(
    ...pm10ThresholdRule(
      ctx.pm10UgM3,
      ctx.pm10SustainedMinutesAbove340,
      ctx.pm10SustainedMinutesAbove250,
      isPm10ExemptEnclosedBatching
    )
  );

  // --- قواعد النشاط التنظيمي المحدد (القسم 9.4-9.10) ---
  ruleHits.push(...applyActivityRules(ctx.project, riskClass, windBand, ctx.activity, ctx.windSpeedKmh));

  // --- التزامات الرصد (القسم 10) — تُبنى دائماً للعرض التوعوي فقط. لا
  // تؤثر على القرار (decisionCategory) إطلاقاً: لا نملك وسيلة فعلية للتحقق
  // من أن المستخدم ضبط محطة الرصد/الكاميرات/الخريطة فعلياً على أرض الواقع
  // (هذي حقول تصريح يدوي لا قياس مباشر)، فبناء قرار تقييد/إيقاف عليها قد
  // يعاقب مستخدماً ضبط كل شي فعلياً لكن نسي تحديث الحقل، بخلاف بقية القواعد
  // (رياح/PM10/مسافات) المبنية على قياسات حية فعلية.
  const { obligations } = buildMonitoringObligations(ctx, riskClass);
  const monitoringApplies = riskClass === 'CATEGORY_II_MEDIUM' || riskClass === 'CATEGORY_III_HIGH';

  let decisionCategory = decisionFromRules(ruleHits, missingCriticalInputs);

  // قاعدة استئناف خاصة ببوابة الرياح >25 (GATE-WIND-ABOVE-25-004): طلب صريح
  // من المستخدم — لا يُستأنف عند عودة الرياح إلى 25 كم/س بالضبط، بل يلزم
  // انخفاضها إلى أقل من 25 صراحة. classifyWind يضع 25 بالضبط ضمن النطاق
  // البرتقالي (FROM_15_TO_25، لا ABOVE_25)، فتتوقف بوابة الرياح عن التفعيل
  // بمجرد وصول القراءة لـ25 بالضبط — لكن هذا لا يعني جواز الاستئناف عندها؛
  // القاعدة التنظيمية للاستئناف أشد تحديداً من عتبة الإيقاف نفسها. يُطبَّق
  // هذا فقط إن كان الإيقاف السابق ناتجاً عن هذه البوابة تحديداً (لا أي سبب
  // إيقاف آخر)، ولا يُعاد تفعيله إن كانت الرياح ABOVE_25 فعلاً الآن (تلك
  // حالتها تُعالَج أصلاً عبر ruleHits أعلاه بلا حاجة لهذا القيد).
  const previousStopWasWindGate = ctx.previousDecisionCategory === 'STOP_AFFECTED_ACTIVITY';
  if (
    previousStopWasWindGate &&
    windBand !== 'ABOVE_25' &&
    ctx.windSpeedKmh !== null &&
    ctx.windSpeedKmh >= 25 &&
    DECISION_PRIORITY[decisionCategory] < DECISION_PRIORITY.STOP_AFFECTED_ACTIVITY
  ) {
    decisionCategory = 'STOP_AFFECTED_ACTIVITY';
  }

  // منع الاستئناف التلقائي الفوري بعد إيقاف — قرار كان موقِفاً
  // (MANDATORY_STOP أو STOP_AFFECTED_ACTIVITY) لا يتحسّن مباشرة بمجرد أن
  // القراءة الحالية أصبحت جيدة؛ يلزم استقرار حقيقي (10 دقائق متواصلة من
  // القراءة الجيدة) قبل السماح بالتحسّن.
  //
  // previousPendingResumeSince (لا previousDecisionUpdatedAt/stopped_since)
  // هو المصدر الصحيح هنا — يقيس "منذ متى أصبحت القراءة جيدة"، لا "منذ متى
  // بدأ الإيقاف". استخدام stopped_since هنا كان خللاً مكتشَفاً: لو استمر
  // الإيقاف 16 دقيقة قبل أن تتحسّن القراءة أخيراً، كان النظام يعتبر عداد
  // الـ10 دقائق منقضياً بالفعل منذ بداية الإيقاف نفسه، فيسمح باستئناف فوري
  // رغم عدم تراكم أي دقيقة فعلية من القراءة الجيدة بعد.
  //
  // غياب previousDecisionCategory (أول تقييم لنشاط، أو لم يُمرَّر من
  // المستدعي) يعني عدم تطبيق أي قيد — سلوك المحرك بلا تغيير.
  const RESUME_STABILITY_MINUTES = 10;
  const previousWasStopped =
    ctx.previousDecisionCategory === 'MANDATORY_STOP' ||
    ctx.previousDecisionCategory === 'STOP_AFFECTED_ACTIVITY';
  let resumeHoldApplied = false;
  if (previousWasStopped && DECISION_PRIORITY[decisionCategory] < DECISION_PRIORITY.STOP_AFFECTED_ACTIVITY) {
    const minutesSinceGoodReadingBegan = ctx.previousPendingResumeSince
      ? (Date.now() - new Date(ctx.previousPendingResumeSince).getTime()) / 60000
      : 0; // لا استقرار مسجَّل بعد = بداية الاستقرار الآن (فشل آمن نحو المنع)
    if (minutesSinceGoodReadingBegan < RESUME_STABILITY_MINUTES) {
      decisionCategory = 'STOP_AFFECTED_ACTIVITY';
      resumeHoldApplied = true;
    }
  }

  const confidenceScore = calculateComplianceConfidence(ctx, missingCriticalInputs);

  // منع قرار ALLOW مع ثقة أقل من 70 — يتحول تلقائياً لتحقق ميداني.
  if (decisionCategory === 'ALLOW' && confidenceScore < CONFIDENCE_MIN_FOR_ALLOW) {
    decisionCategory = 'FIELD_VERIFICATION_REQUIRED';
  }

  const mandatoryStop = decisionCategory === 'MANDATORY_STOP';
  const canOverride = !mandatoryStop && decisionCategory !== 'STOP_AFFECTED_ACTIVITY';

  // القاعدة التي حدَّدت هذا القرار فعلياً — نفس منطق shortReasonFor أدناه.
  // إن كانت MRQ-PM10-BLACK-PENDING-104 تحديداً، فالقرار "معلَّق" بانتظار
  // تأكيد استمرار القراءة، لا مخالفة مؤكَّدة — يجب ألا يظهر بنفس لغة
  // MANDATORY_STOP القطعية في الواجهة (راجع تعليق pendingConfirmation في
  // types.ts للسبب الكامل).
  const decidingRule = ruleHits.find((r) => r.severity === decisionCategory);
  const pendingConfirmation = decidingRule?.code === 'MRQ-PM10-BLACK-PENDING-104';

  // إن كان القرار النهائي إيقافاً مؤكَّداً فعلياً (MANDATORY_STOP أو
  // STOP_AFFECTED_ACTIVITY) من قاعدة أخرى غير MRQ-PM10-BLACK-PENDING-104
  // (مثال: بوابة رياح/هدم مكشوف)، فإن نص "معلَّق... بانتظار استمرار القراءة"
  // الخاص بتلك القاعدة يصبح متناقضاً ومضلِّلاً — النشاط موقوف فعلياً الآن،
  // لا "بانتظار" شيء. نستبعدها من القوائم المعروضة (لا من ruleHits الداخلية
  // نفسها، فقط من triggeredRules/requiredActions المعروضتين للمستخدم) حتى
  // لا تظهر رسالة تصف حالة مؤقتة بجانب قرار قطعي بالفعل.
  const displayedRuleHits = pendingConfirmation
    ? ruleHits
    : ruleHits.filter((r) => r.code !== 'MRQ-PM10-BLACK-PENDING-104');

  // الإجراءات المطلوبة تُبنى من actionAr (نص الإجراء التصحيحي) وليس من
  // messageAr (وصف المخالفة) — وإلا ظهرت نفس الجملة حرفياً مرتين في البطاقة:
  // مرة تحت "القواعد المفعّلة" ومرة تحت "الإجراءات المطلوبة"، فيظن المستخدم
  // أن النظام يكرر كلامه بلا فائدة.
  const requiredActions = Array.from(
    new Set(displayedRuleHits.filter((r) => r.severity !== 'ALLOW_WITH_CONTROLS').map((r) => r.actionAr))
  );

  const restartConditions: string[] = [];
  if (mandatoryStop || decisionCategory === 'STOP_AFFECTED_ACTIVITY') {
    if (windBand !== 'BELOW_15') {
      restartConditions.push('انخفاض سرعة الرياح إلى ما دون 15 كم/س');
    }
    if (dmpExplicitlyBlocksActivity) {
      restartConditions.push('اعتماد خطة إدارة الغبار (DMP) رسمياً من الجهة المختصة');
    }
    if (ctx.activity.controls.dustSuppressionSystemOperational === false) {
      restartConditions.push('إعادة تشغيل نظام تثبيط الغبار والتحقق من عمله');
    }
    // وراثة الإيقاف من الخطورة الفيزيائية ليست مخالفة تنظيمية يعالجها
    // المقاول — بدون ذكرها هنا تظهر البطاقة بقرار "إيقاف إلزامي" وشروط
    // استئناف لا تشرح متى يزول السبب الفعلي.
    if (ctx.dviMandatoryStop) {
      restartConditions.push('تحسّن حالة الجو: عودة مدى الرؤية وتركيز الغبار إلى الحدود الآمنة');
    }
    if (resumeHoldApplied) {
      restartConditions.push('استقرار القراءة الجيدة لمدة 10 دقائق متواصلة منذ آخر تغيّر في القرار قبل الاستئناف التلقائي');
    }
  }

  return {
    engineType: 'RIYADH_DUST_COMPLIANCE',
    engineVersion: ENGINE_VERSION,
    rulebookVersion: RULEBOOK_VERSION,

    regulatoryActivity: ctx.activity.regulatoryActivity,
    regulatoryActivityLabelAr:
      REGULATORY_ACTIVITY_LABEL_AR[ctx.activity.regulatoryActivity] ?? REGULATORY_ACTIVITY_LABEL_AR.OTHER,

    riskClass,
    riskClassReasonAr,
    windBand,
    isEnclosedOperation: ctx.activity.isEnclosedOperation,

    decisionCategory,
    decisionLabelAr: DECISION_LABEL_AR[decisionCategory],
    mandatoryStop,
    canOverride,
    pendingConfirmation,
    resumeHoldApplied,
    shortReasonAr: shortReasonFor(decisionCategory, ruleHits, resumeHoldApplied),

    pm10SustainedMinutesAbove340: ctx.pm10SustainedMinutesAbove340,
    pm10SustainedMinutesAbove250: ctx.pm10SustainedMinutesAbove250,
    pm10RulesExempt: isPm10ExemptEnclosedBatching,

    triggeredRules: displayedRuleHits,
    requiredActions,
    restartConditions,
    missingCriticalInputs,
    monitoringObligations: monitoringApplies
      ? obligations
      : obligations.map((o) => ({ ...o, required: false, status: 'NOT_APPLICABLE' as const })),

    confidenceScore,
    confidenceLabelAr: confidenceLabelAr(confidenceScore),
    validUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString(),

    evidence: {
      dviScore: ctx.dviScore,
      dviDecision: ctx.dviDecision,
      dviMandatoryStop: ctx.dviMandatoryStop,
      windSpeedKmh: ctx.windSpeedKmh,
      windGustKmh: ctx.windGustKmh,
      windDirectionDeg: ctx.windDirectionDeg,
      pm10UgM3: ctx.pm10UgM3,
      pm25UgM3: ctx.pm25UgM3,
      relativeHumidityPercent: ctx.relativeHumidityPercent,
      temperatureC: ctx.temperatureC,
      visibilityM: ctx.visibilityM,
      deviceLastReadingAt: ctx.deviceLastReadingAt,
      devicePm10LastReadingAt: ctx.devicePm10LastReadingAt,
    },
    caveatsAr: ctx.dviCaveatsAr ?? [],
  };
}
