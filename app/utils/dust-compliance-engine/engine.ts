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
  windGustSafetyRule,
  pm10ThresholdRule,
  REGULATORY_ACTIVITY_LABEL_AR,
  DECISION_PRIORITY,
  BATCHING_PM10_FILTER_MIN_PERCENT,
  ruleHit,
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

// خطأ مكتشَف ومُصلَح (مراجعة كود خبير خارجي — "قاعدة PM10 معلَّقة قد تتغلب
// على توقف مؤكَّد"): كانت هذه الدالة تشتق "القاعدة الحاسمة" بنفسها عبر
// ruleHits.find((r) => r.severity === decision) — نسخة ثانية مستقلة تماماً
// من نفس منطق decidingRule في evaluateDustCompliance أدناه، بنفس العلة
// (أول قاعدة بترتيب الدفع تفوز، بصرف النظر عن كونها معلَّقة أم مؤكَّدة).
// حتى بعد إصلاح decidingRule ليُفضِّل القاعدة المؤكَّدة، كان shortReasonAr
// المعروض فعلياً للمستخدم سيبقى نص القاعدة المعلَّقة لأن هذه الدالة تعيد
// الاشتقاق بمعزل تام. الإصلاح: تستقبل decidingRule الجاهزة (نفس القاعدة
// المُفضَّلة فعلياً) بدل إعادة البحث في ruleHits من الصفر — مصدر واحد فقط
// لـ"ما القاعدة الحاسمة"، لا مصدرين قد يختلفان.
function shortReasonFor(
  decision: DustComplianceDecisionCategory,
  decidingRule: DustRuleHit | undefined,
  resumeHoldApplied: boolean
): string {
  if (resumeHoldApplied) {
    return 'الظروف تحسّنت لكن لم يمضِ وقت كافٍ على استقرارها بعد آخر إيقاف — بانتظار استقرار القراءة (10 دقائق) قبل الاستئناف';
  }
  if (decision === 'ALLOW') return 'لا توجد مخالفات تنظيمية ظاهرة على النشاط الحالي';
  return decidingRule?.messageAr ?? DECISION_LABEL_AR[decision];
}

// نتيجة امتثال مبسَّطة لنشاط PLANNING (توقّع طقس، لم يبدأ بعد — راجع
// isPlanning في evaluateDustCompliance أعلاه) — decisionCategory=ALLOW
// دائماً (لا إيقاف/تعليق إلزامي على تقدير مستقبلي)، وshortReasonAr وحده
// يوضّح للمستخدم هل الأجواء المتوقعة تصلح للنشاط أم لا، حسب dviDecision
// الجاهز فعلاً (ALLOW/ALLOW_WITH_MONITORING = تصلح، أي فئة أخرى = لا تصلح).
const DVI_FORECAST_FAVORABLE: ReadonlySet<string> = new Set(['ALLOW', 'ALLOW_WITH_MONITORING']);

function buildPlanningForecastResult(ctx: DustComplianceContext, now: number): DustComplianceResult {
  const { riskClass, reasonAr: riskClassReasonAr } = classifyProject(ctx.project);
  const windBand = classifyWind(ctx.windSpeedKmh);
  const isFavorable = DVI_FORECAST_FAVORABLE.has(ctx.dviDecision);
  const shortReasonAr = isFavorable
    ? 'الأجواء المتوقعة تصلح للنشاط — تقييم مبني على توقّعات الطقس، لا قراءة جهاز حية بعد.'
    : 'الأجواء المتوقعة لا تصلح للنشاط — يُرجى مراجعة توقعات الساعات القادمة قبل البدء الفعلي (لا إيقاف إلزامي، تقييم توقّعي فقط).';

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

    decisionCategory: 'ALLOW',
    decisionLabelAr: DECISION_LABEL_AR.ALLOW,
    mandatoryStop: false,
    canOverride: true,
    pendingConfirmation: false,
    resumeHoldApplied: false,
    decidingRuleCode: null,
    decidingRuleMessageAr: null,
    shortReasonAr,

    pm10SustainedMinutesAbove340: undefined,
    pm10SustainedMinutesAbove250: undefined,
    evaluatedAt: new Date(now).toISOString(),

    triggeredRules: [],
    requiredActions: [],
    restartConditions: [],
    missingCriticalInputs: [],
    monitoringObligations: [],

    confidenceScore: ctx.dviConfidenceScore,
    confidenceLabelAr: confidenceLabelAr(ctx.dviConfidenceScore),
    validUntil: new Date(now + 60 * 60 * 1000).toISOString(),

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

// خطأ مكتشَف ومُصلَح (مراجعة كود خبير خارجي — H-07: "الاستئناف غير حتمي،
// يستخدم Date.now() داخل محرك القرار"): كانت الدالة تستدعي Date.now()
// مباشرة داخلها رغم توصيفها الصريح أعلى الملف كـ"دالة نقية بلا I/O" — نفس
// المدخلات (ctx) قد تُنتج قرارات مختلفة حسب لحظة الاستدعاء الفعلية، بلا
// إمكانية لإعادة الحساب لاختبار/تدقيق تاريخي بمعزل عن الوقت الحقيقي. now
// معامل اختياري ثانٍ (افتراضي Date.now()، نفس نمط computeSustainedPm10Status
// في dustEvaluation.ts بالضبط) — الاستدعاءات الحية بلا تغيير (لا تمرره
// فتحصل على السلوك الحالي)، والاختبارات/إعادة الحساب التاريخي يمكنها الآن
// تثبيت لحظة محددة صراحة.
export function evaluateDustCompliance(
  ctx: DustComplianceContext,
  now: number = Date.now(),
  // طلب مستخدم صريح: نشاط PLANNING (توقّع طقس لوقت بدء لم يحن بعد — راجع
  // ACTIVITY_LIVE_MARGIN_MS في dust-engine/engine.ts) لا يجوز أن يُصدر أي
  // قرار امتثال إلزامي (MANDATORY_STOP/STOP_AFFECTED_ACTIVITY/"معلَّق بانتظار
  // تأكيد") مهما بلغت قيم التوقّع (قد تكون مرتفعة/غير واقعية من نموذج طقس
  // عام). بدلاً من كل قواعد rulebook.ts (رياح>25، PM10>340، مسافة الكسارة،
  // إلخ)، تُرجَع نتيجة محايدة (decisionCategory=ALLOW دائماً) بنص توضيحي
  // فقط يعكس جودة الطقس المتوقّع (عبر dviDecision) — "تصلح" أو "لا تصلح"
  // للنشاط، بلا أي إجراء إلزامي فعلي. راجع الفرع أسفل هذا التوقيع مباشرة.
  isPlanning: boolean = false
): DustComplianceResult {
  if (isPlanning) {
    return buildPlanningForecastResult(ctx, now);
  }

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
        overridable: false,
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
    //
    // خطأ مكتشَف ومُصلَح (مراجعة كود خبير خارجي — "DVI يصدر إيقافاً تنظيمياً
    // فور قراءة واحدة"): كانت هذه البوابة تُصدر MANDATORY_STOP فوراً بمجرد
    // ctx.dviMandatoryStop=true، بلا أي فحص استمرار — حتى لو كان السبب
    // الوحيد قراءة PM10≥340 *لحظية واحدة* (DVI-DUST-ACTIVITY-STOP-004 في
    // dust-engine/engine.ts يُشعِلها من أول قراءة تصل، لا من استمرار). هذا
    // يتجاوز بالكامل pm10ThresholdRule أدناه (نفس الملف) الذي يشترط بحكمة
    // >دقيقتين استمرار فعلي (pm10ConfirmedViolation340) قبل تأكيد المخالفة
    // — وبما أن decisionFromRules يختار أعلى severity من كل القواعد معاً،
    // MANDATORY_STOP هنا كان يطغى دائماً على STOP_AFFECTED_ACTIVITY
    // "المعلَّق" الصحيح من pm10ThresholdRule، فتتحول قراءة لحظية واحدة إلى
    // إيقاف إلزامي قطعي غير قابل للتجاوز دون أي دليل استمرار.
    //
    // الإصلاح: عندما يكون سبب dviMandatoryStop الوحيد هو PM10 (لا خطر
    // فيزيائي فوري آخر كرؤية حرجة/رياح شديدة مساهم بنفس اللحظة —
    // dviMandatoryStopIsPm10Only)، تُطبَّق نفس عتبة الاستمرار هنا بالضبط:
    // مؤكَّدة (MANDATORY_STOP) فقط إن أثبت computeSustainedPm10Status
    // استمراراً فعلياً >دقيقتين من مصدر جهاز حقيقي (pm10ConfirmedViolation340)،
    // وإلا STOP_AFFECTED_ACTIVITY "معلَّق" فقط — طابق تماماً منطق
    // pm10ThresholdRule بدل التناقض معه. خطر الرؤية الحرجة/الرياح الشديدة
    // (dviMandatoryStopIsPm10Only=false) يبقى إيقافاً فورياً صحيحاً كما كان
    // — هذا خطر فيزيائي فعلي لا يحتاج "استمراراً" ليُصدَّق (لا يمكن انتظار
    // دقيقتين بينما الرؤية معدومة والرياح شديدة).
    const isPm10OnlyPending = ctx.dviMandatoryStopIsPm10Only === true && ctx.pm10ConfirmedViolation340 !== true;
    ruleHits.push(
      {
        code: 'GATE-DVI-002',
        severity: isPm10OnlyPending ? 'STOP_AFFECTED_ACTIVITY' : 'MANDATORY_STOP',
        messageAr:
          ctx.dviShortReason ||
          (isPm10OnlyPending
            ? 'تعليق مؤقت (معلَّق): تجاوز فوري في تركيز الغبار — بانتظار استمرار القراءة أكثر من دقيقتين لتصنيفها مخالفة تنظيمية مؤكدة'
            : 'إيقاف إلزامي تنظيمي: تجاوز خطر فوري في تركيز الغبار أو انعدام الرؤية بموقع النشاط'),
        // الإجراء هنا مختلف جوهرياً عن بقية القواعد: لا يوجد ما "يُصلحه"
        // المقاول في الموقع — الظرف الجوي نفسه هو المانع، فالإجراء انتظار
        // تحسّن الحالة وإخلاء العمالة، لا استكمال ضابط تحكم ناقص.
        actionAr: 'أخلِ منطقة العمل وانتظر تحسّن حالة الجو (الرؤية وتركيز الغبار) — لا يمكن استئناف العمل بإجراء تنظيمي',
        overridable: isPm10OnlyPending,
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
        overridable: false,
      }
    );
  }

  // بروتوكول الملحق أ — أعلى من 25 كم/س: تُوقف كل الأنشطة المكشوفة
  // المولّدة للغبار عموماً (وليس فقط الهدم)؛ العمليات المغلقة فقط تستمر.
  // استثناء محطة الخلط (BATCHING_PLANT) تحديداً: لا يُشترط isEnclosedOperation
  // إطلاقاً (قد تكون المحطة فعلياً مكشوفة هيكلياً) — يكفي إحكام إغلاق
  // الصوامع (silosSealed، مدخل حقيقي لكل وحدة خلط) + كفاءة فلتر PM10 لا
  // تقل عن الحد الأدنى (نفس حد BATCHING-FILTER-002 في rulebook.ts) معاً —
  // هذا هو الإعفاء التنظيمي الموثَّق فعلياً في "الاستخراج التنظيمي من
  // المرفق" (القسم الرابع/السادس، راجع BATCHING_PM10_FILTER_MIN_PERCENT في
  // rulebook.ts): "الحد المعتمد للاستمرار أثناء إيقاف الرياح فوق 25 كم/س"
  // — مقصور على بوابة الرياح تحديداً، لا قواعد PM10 المستقلة (راجع تعليق
  // مصلَح أدناه). بقية الأنشطة المغلقة (هدم مغلق، قطع أحجار مغلق) تستمر
  // بإعفاء isEnclosedOperation وحده كما كان دائماً.
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
        overridable: false,
      }
    );
  }

  // 15-25 كم/س — تثبيط معزز عام (دون إيقاف)، و حدود PM10 التنظيمية —
  // "الاستخراج التنظيمي من المرفق" القسم 5-6. راجع rulebook.ts للتفاصيل.
  //
  // isEnclosedExemptFromHighWind (لا isEnclosedOperation الخام) يُستخدم هنا
  // أيضاً لبوابة الرياح 15-25 المعززة — محطة خلط مكشوفة فيزيائياً لكن
  // بصوامع مغلقة وفلتر ≥99% تُستثنى من كلتا بوابتي الرياح معاً (>25 و15-25)
  // بنفس الشرط الموحَّد، لا فقط الأشد.
  //
  // خطأ مكتشَف ومُصلَح (مراجعة كود خبير خارجي — "إعفاء محطة الخلط مخالف
  // للمرجع"): كان يُمرَّر معامل isPm10ExemptEnclosedBatching منفصل لـ
  // pm10ThresholdRule يُعفي محطة الخلط من قواعد PM10 المستقلة (250/340)
  // بنفس شرط بوابة الرياح — لكن النص التنظيمي المصدر لنسبة الـ99% (راجع
  // BATCHING_PM10_FILTER_MIN_PERCENT في rulebook.ts) يوثّقها كحد استمرار
  // *أثناء إيقاف الرياح* تحديداً، لا إعفاءً عاماً من عتبات تركيز PM10
  // الفعلي في الهواء (قياس مباشر لا علاقة له بسرعة الرياح أو حالة الصوامع).
  // إعفاء PM10 كلياً كان توسيعاً غير موثَّق — حُذف بالكامل من pm10ThresholdRule
  // ومن استدعائها هنا؛ محطة الخلط الآن تخضع لقواعد PM10 (250/340/تعليق)
  // كأي نشاط آخر، وتبقى معفاة من بوابتي الرياح فقط.
  ruleHits.push(...enhancedSuppressionRule(ctx.activity.isDustGenerating, isEnclosedExemptFromHighWind, windBand));
  // احتراز هبات منفصل تماماً عن بروتوكول الملحق أ (windBand أعلاه، مبني
  // فقط على ctx.windSpeedKmh الخام الآن) — راجع windGustSafetyRule في
  // rulebook.ts وتعليق windSpeedKmh في types.ts للسبب الكامل.
  ruleHits.push(
    ...windGustSafetyRule(ctx.activity.isDustGenerating, isEnclosedExemptFromHighWind, ctx.windGustKmh)
  );
  ruleHits.push(
    ...pm10ThresholdRule(ctx.pm10UgM3, ctx.pm10ConfirmedViolation340, ctx.pm10Suspended250For30Min)
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

  // خطأ معماري مكتشَف ومُصلَح (مراجعة كود خبير خارجي — "الفصل بين القواعد
  // والقرار النهائي غير مكتمل"): الطبقات الثلاث أدناه (استئناف بوابة الرياح،
  // استقرار الاستئناف RESUME_STABILITY_MINUTES، ثقة<70) كانت تُعدِّل
  // decisionCategory مباشرة *بعد* decisionFromRules بمعزل تام عن نظام
  // ruleHits/DustRuleHit — فلا تظهر كقاعدة في triggeredRules، ولا تشارك في
  // اختيار decidingRule (فيعرض النظام قاعدة أخرى أضعف كسبب للقرار بينما
  // السبب الفعلي إحدى هذه الطبقات)، ولا تحمل overridable خاصاً بها. الإصلاح:
  // كل طبقة تُبنى الآن كـDustRuleHit فعلي يُدفَع إلى ruleHits، ثم يُعاد حساب
  // decisionFromRules على المجموعة الكاملة — نفس آلية اختيار "الأعلى فوزاً"
  // المستخدمة لكل قاعدة أخرى، لا استثناء خاص. الحلقة (evaluate → أضف قاعدة
  // ناتجة عن القرار الحالي → أعد التقييم) تتوقف تلقائياً حين لا تعود أي طبقة
  // تُضيف قاعدة جديدة (كل الطبقات أحادية الاتجاه: لا تُخفِّض قراراً، فقط
  // تُصعِّده أو تُبقيه، فتتقارب خلال تكرار واحد كحد أقصى عملياً).
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
  //
  // previousDecidingRuleCode (كود القاعدة الفعلية المخزَّن، لا فئة القرار
  // العامة) هو الدليل الصحيح على أن السبب كان بوابة الرياح تحديداً — راجع
  // تعليق previousDecidingRuleCode في types.ts لسبب استبعاد فئة القرار وحدها.
  const previousStopWasWindGate = ctx.previousDecidingRuleCode === 'GATE-WIND-ABOVE-25-004';
  if (
    previousStopWasWindGate &&
    windBand !== 'ABOVE_25' &&
    ctx.windSpeedKmh !== null &&
    ctx.windSpeedKmh >= 25
  ) {
    ruleHits.push(
      ruleHit(
        'GATE-WIND-ABOVE-25-RESUME-HOLD',
        'STOP_AFFECTED_ACTIVITY',
        'الإيقاف السابق كان بسبب رياح تجاوزت 25 كم/س — الاستئناف يتطلب انخفاضها إلى ما دون 25 كم/س صراحة، لا مجرد العودة إلى 25 بالضبط',
        'انتظر انخفاض سرعة الرياح إلى ما دون 25 كم/س صراحة قبل الاستئناف',
        false
      )
    );
    decisionCategory = decisionFromRules(ruleHits, missingCriticalInputs);
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
      ? (now - new Date(ctx.previousPendingResumeSince).getTime()) / 60000
      : 0; // لا استقرار مسجَّل بعد = بداية الاستقرار الآن (فشل آمن نحو المنع)
    if (minutesSinceGoodReadingBegan < RESUME_STABILITY_MINUTES) {
      resumeHoldApplied = true;
      ruleHits.push(
        ruleHit(
          'RESUME-STABILITY-HOLD',
          'STOP_AFFECTED_ACTIVITY',
          'الظروف تحسّنت لكن لم يمضِ وقت كافٍ على استقرارها بعد آخر إيقاف — بانتظار استقرار القراءة (10 دقائق) قبل الاستئناف',
          `أبقِ النشاط موقوفاً حتى تستقر القراءة الجيدة لمدة ${RESUME_STABILITY_MINUTES} دقائق متواصلة قبل الاستئناف`,
          true
        )
      );
      decisionCategory = decisionFromRules(ruleHits, missingCriticalInputs);
    }
  }

  const confidenceScore = calculateComplianceConfidence(ctx, missingCriticalInputs);

  // منع قرار ALLOW مع ثقة أقل من 70 — يتحول تلقائياً لتحقق ميداني.
  if (decisionCategory === 'ALLOW' && confidenceScore < CONFIDENCE_MIN_FOR_ALLOW) {
    ruleHits.push(
      ruleHit(
        'LOW-CONFIDENCE-VERIFICATION',
        'FIELD_VERIFICATION_REQUIRED',
        `مستوى الثقة في القرار (${confidenceScore}) أقل من الحد الأدنى المطلوب للسماح التلقائي (${CONFIDENCE_MIN_FOR_ALLOW})`,
        'راجع البيانات الناقصة/غير المؤكدة ميدانياً قبل اعتماد القرار كسماح كامل',
        true
      )
    );
    decisionCategory = decisionFromRules(ruleHits, missingCriticalInputs);
  }

  const mandatoryStop = decisionCategory === 'MANDATORY_STOP';

  // خطأ مكتشَف ومُصلَح (مراجعة كود خبير خارجي — "قاعدة PM10 معلَّقة قد
  // تتغلب على توقف مؤكَّد"): كان decidingRule = ruleHits.find(...) يختار
  // أول قاعدة بنفس شدة القرار النهائي بترتيب الدفع في ruleHits — بلا أي
  // اعتبار لكون تلك القاعدة معلَّقة أم مؤكَّدة. مثال حقيقي: نشاط هدم برياح
  // شديدة (DEMO-WIND-STOP-001، STOP_AFFECTED_ACTIVITY مؤكَّد، يُدفَع عبر
  // applyActivityRules في آخر الدالة) + PM10>340 لحظي لم يستمر بعد دقيقتين
  // (MRQ-PM10-BLACK-PENDING-104، STOP_AFFECTED_ACTIVITY معلَّق، يُدفَع عبر
  // pm10ThresholdRule *قبل* applyActivityRules) — كلاهما بنفس الشدة، فكان
  // .find() يختار قاعدة PM10 المعلَّقة لمجرد سبقها ترتيبياً، فيظهر القرار
  // بأكمله "معلَّق — بانتظار التأكيد" رغم وجود سبب إيقاف مؤكَّد آخر مستقل
  // تماماً لا علاقة له باستمرار PM10 إطلاقاً — يُوهم المستخدم بأن الإيقاف
  // قد يزول تلقائياً بينما هو مؤكَّد وقائم فعلاً.
  //
  // الإصلاح: بين كل القواعد المتعادلة بأعلى شدة (topHits)، تُفضَّل أي قاعدة
  // غير معلَّقة (confirmedHit) على القاعدة المعلَّقة — القرار المعروض يعكس
  // دائماً أشد تفسير مؤكَّد متاح، لا أول ما وصل ترتيبياً. pendingConfirmation
  // النهائية تصبح true فقط لو كانت *كل* القواعد المتعادلة بأعلى شدة معلَّقة
  // معاً (لا قاعدة مؤكَّدة واحدة بينها تكفي لإسقاط الصفة المعلَّقة عن القرار
  // بأكمله).
  //
  // isPendingRuleHit: نفس تعريف "معلَّق" المستخدم سابقاً حرفياً — إما
  // MRQ-PM10-BLACK-PENDING-104 تحديداً، أو GATE-DVI-002 حين يكون سببها
  // الوحيد PM10 لحظي لم يثبت استمراره بعد (راجع isPm10OnlyPending أعلاه).
  const isPendingRuleHit = (hit: DustRuleHit): boolean =>
    hit.code === 'MRQ-PM10-BLACK-PENDING-104' ||
    (hit.code === 'GATE-DVI-002' && ctx.dviMandatoryStopIsPm10Only === true && ctx.pm10ConfirmedViolation340 !== true);

  const topHits = ruleHits.filter((r) => r.severity === decisionCategory);
  const confirmedHit = topHits.find((hit) => !isPendingRuleHit(hit));
  const decidingRule = confirmedHit ?? topHits[0];
  const pendingConfirmation = topHits.length > 0 && topHits.every((hit) => isPendingRuleHit(hit));

  // canOverride مشتقة الآن من overridable الفعلي لقاعدة(قواعد) القرار
  // الحاسمة (topHits)، لا من فئة decisionCategory العامة كما كانت سابقاً —
  // راجع تعليق overridable في types.ts للسبب الكامل. أي قاعدة غير قابلة
  // للتجاوز بين المتعادلات بأعلى شدة تكفي لمنع تجاوز القرار بأكمله (نفس
  // مبدأ "الأشد يفوز" المطبَّق في كل مكان آخر بهذا المحرك) — افتراض true
  // لقاعدة لا تحدد overridable إطلاقاً (توافقاً مع تعريفها الافتراضي في
  // ruleHit()). لا topHits إطلاقاً (decisionCategory=ALLOW بلا أي ruleHits)
  // يعني قابلية تجاوز كاملة بداهة.
  const canOverride = topHits.length === 0 || topHits.every((hit) => hit.overridable !== false);

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
  //
  // خطأ مكتشَف ومُصلَح (مراجعة كود خبير خارجي — H-06.1: "استبعاد قواعد
  // ALLOW_WITH_CONTROLS من requiredActions مطلقاً"): كان الفلتر يستبعد كل
  // قاعدة بشدة ALLOW_WITH_CONTROLS (مثال: PM10-EARLY-WARNING-007، PM10-
  // WARNING-008، GATE-WIND-15-25-ENHANCED-005) بصرف النظر عن كون actionAr
  // مكرراً لـmessageAr أم لا — لكن كل قواعد ALLOW_WITH_CONTROLS فعلياً تحمل
  // actionAr مستقلاً تماماً عن messageAr (راجع rulebook.ts)، فلا تكرار
  // إطلاقاً يبرر الاستبعاد. هذا كان يُخفي بالضبط الإجراء التصحيحي الأهم
  // تشغيلياً (مثال: "فعّل التثبيط المعزز فوراً" عند اقتراب PM10 من حد
  // المخالفة) عن قسم "الإجراءات المطلوبة" في البطاقة. الإصلاح: لا استبعاد
  // بناءً على severity — الفلتر الوحيد المتبقي هو إزالة التكرار الفعلي
  // (Set على actionAr نفسه).
  const requiredActions = Array.from(new Set(displayedRuleHits.map((r) => r.actionAr)));

  // خطأ مكتشَف ومُصلَح (مراجعة كود خبير خارجي — H-06.2: "شرط انخفاض الرياح
  // تحت 15 يُضاف حتى لقرار سببه PM10/مسافة/DMP"): كان شرط "انخفاض الرياح"
  // يُضاف فقط بفحص windBand الحالي (سطر محذوف: windBand !== 'BELOW_15')،
  // بصرف النظر تماماً عن كون الرياح هي سبب الإيقاف الفعلي أصلاً — نشاط
  // موقوف بسبب مخالفة مسافة كسارة (مثلاً) بينما الرياح مرتفعة صدفةً في نفس
  // اللحظة كان يعرض "انخفاض الرياح" كشرط استئناف مضلِّل، رغم أن انخفاضها لن
  // يغيّر القرار شيئاً (المخالفة الفعلية مستقلة تماماً عن الرياح). الإصلاح:
  // الشرط يُضاف الآن فقط إن كانت إحدى القواعد الفائزة فعلياً (topHits) قاعدة
  // رياح حقيقية (بوابة >25، هدم/قطع أحجار مكشوف عند رياح≥15) — يعكس السبب
  // الحقيقي للإيقاف، لا حالة الرياح اللحظية بمعزل عنه.
  //
  // خطأ ثانٍ مكتشَف ومُصلَح (مراجعة تصحيح خارجية — "نص استئناف الرياح
  // موحَّد خطأً"): كانت كل قواعد الرياح الأربع تُدفَع لمجموعة واحدة تنتج
  // نص "أقل من 15 كم/س" بلا تمييز — بما فيها بوابة الرياح العامة
  // (GATE-WIND-ABOVE-25-004) التي رسالتها الفعلية (messageAr أعلاه)
  // وشرط استئنافها المخصَّص (GATE-WIND-ABOVE-25-RESUME-HOLD) يشترطان
  // صراحة "دون 25" لا "دون 15" — تناقض مباشر بين القاعدتين المعروضتين
  // لنفس الإيقاف. الإصلاح: مجموعتان منفصلتان بعتبتين مختلفتين؛ إن اجتمعتا
  // معاً (حالة نظرية: هدم مكشوف + رياح فوق 25 في نفس اللحظة)، يفوز الحد
  // الأشد (دون 15) — أي نشاط يحتاج انخفاضاً أكبر يحتاج بداهة الانخفاض
  // الأصغر أيضاً، فذكر الحد الأشد وحده كافٍ ولا يُضلِّل.
  const GENERAL_WIND_STOP_RULE_CODES = new Set(['GATE-WIND-ABOVE-25-004', 'GATE-WIND-ABOVE-25-RESUME-HOLD']);
  const ACTIVITY_WIND_15_STOP_RULE_CODES = new Set(['DEMO-WIND-STOP-001', 'STONECUT-WIND-STOP-003']);
  const requiresWindBelow15 = topHits.some((hit) => ACTIVITY_WIND_15_STOP_RULE_CODES.has(hit.code));
  const requiresWindBelow25 = topHits.some((hit) => GENERAL_WIND_STOP_RULE_CODES.has(hit.code));

  const restartConditions: string[] = [];
  if (mandatoryStop || decisionCategory === 'STOP_AFFECTED_ACTIVITY') {
    if (requiresWindBelow15) {
      restartConditions.push('انخفاض سرعة الرياح إلى ما دون 15 كم/س');
    } else if (requiresWindBelow25) {
      restartConditions.push('انخفاض سرعة الرياح إلى ما دون 25 كم/س');
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
    decidingRuleCode: decidingRule?.code ?? null,
    decidingRuleMessageAr: decidingRule?.messageAr ?? null,
    shortReasonAr: shortReasonFor(decisionCategory, decidingRule, resumeHoldApplied),

    pm10SustainedMinutesAbove340: ctx.pm10SustainedMinutesAbove340,
    pm10SustainedMinutesAbove250: ctx.pm10SustainedMinutesAbove250,
    evaluatedAt: new Date(now).toISOString(),

    triggeredRules: displayedRuleHits,
    requiredActions,
    restartConditions,
    missingCriticalInputs,
    monitoringObligations: monitoringApplies
      ? obligations
      : obligations.map((o) => ({ ...o, required: false, status: 'NOT_APPLICABLE' as const })),

    confidenceScore,
    confidenceLabelAr: confidenceLabelAr(confidenceScore),
    validUntil: new Date(now + 60 * 60 * 1000).toISOString(),

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
