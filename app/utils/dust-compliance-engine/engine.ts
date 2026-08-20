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
  PM10_WARNING_UG_M3,
  ruleHit,
} from './rulebook';
import { attachRuleMetadata } from './ruleMetadata';
import { getRuleParameters } from './ruleParameters';
import type {
  DustComplianceContext,
  DustComplianceDecisionCategory,
  DustComplianceResult,
  DustMonitoringObligation,
  DustRiskClass,
  DustRuleHit,
  Pm10TemporalEvidenceSnapshot,
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

const CONFIDENCE_MIN_FOR_ALLOW = () => getRuleParameters().CONFIDENCE_MIN_FOR_ALLOW;
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

// طلب مستخدم صريح ("لقطة القرار والبصمة"): يبني evidence.pm10TemporalEvidence
// من نفس حقول ctx التي تبني evidence.pm10TemporalEvidenceState المسطَّحة —
// مصدر الحقيقة الوحيد نفسه (pm10TemporalEvidenceState/pm10HistoryFailureCode
// في DustComplianceContext)، لا اشتقاق مستقل. Undefined حين
// pm10TemporalEvidenceState نفسه غير محدَّد (استدعاءات قديمة/اختبارات تبني
// evidence يدوياً) — نفس دلالة undefined للحقل المسطَّح تماماً، بلا كائن
// جزئي مضلِّل بقيم افتراضية وهمية.
function buildPm10TemporalEvidenceSnapshot(
  ctx: DustComplianceContext,
  now: number
): Pm10TemporalEvidenceSnapshot | undefined {
  if (!ctx.pm10TemporalEvidenceState) return undefined;
  return {
    queryState: ctx.pm10TemporalEvidenceState,
    failureCode: ctx.pm10HistoryFailureCode ?? null,
    evaluatedAt: new Date(now).toISOString(),
  };
}

function buildPlanningForecastResult(ctx: DustComplianceContext, now: number): DustComplianceResult {
  const { riskClass, reasonAr: riskClassReasonAr } = classifyProject(ctx.project);
  const windBand = classifyWind(ctx.windSpeedKmh);

  // خطأ مكتشَف ومُصلَح — طلب صريح من المستخدم: "ليه ما يقول تنبيه استباقي
  // الأجواء غير المناسبة... اتوقع انه يستثني قاعدة PM10". isFavorable كانت
  // تفحص dviDecision (DVI الفيزيائي: رياح/رؤية) فقط، بلا أي فحص لـ PM10
  // المتوقّع — فساعة PM10=1315 (أكبر من حد المخالفة 340 بأضعاف) كانت تظهر
  // "مسموح — تشغيل اعتيادي" طالما الرياح/الرؤية جيدتان، لكل الأنشطة (لا
  // خاص بمحطة الخلط). الآن أي PM10 متوقّع ≥ PM10_WARNING_UG_M3 (251) يجعل
  // التوقّع "غير مناسب" بصرف النظر عن DVI الفيزيائي — لا يزال decisionCategory
  // يبقى ALLOW دائماً (بلا إيقاف إلزامي على تقدير)، فقط النص/isFavorable
  // يعكسان جودة الهواء المتوقّعة أيضاً، لا الطقس الفيزيائي وحده.
  const isPm10Unfavorable = ctx.pm10UgM3 !== null && ctx.pm10UgM3 >= PM10_WARNING_UG_M3;
  const isFavorable = DVI_FORECAST_FAVORABLE.has(ctx.dviDecision) && !isPm10Unfavorable;
  // القسم 18.6: توقّع مبني على بيانات طقس قديمة (فشل/انقطاع Open-Meteo) لا
  // يجوز أن يعرض ثقة كاملة "تصلح/لا تصلح" — يُستبدَل بتحذير قِدم صريح يبقى
  // decisionCategory=ALLOW/mandatoryStop=false (لا إيقاف إلزامي على تقدير
  // مهما كانت حالته، نفس مبدأ mode==='PLANNING' في decideFinal).
  const shortReasonAr = ctx.isForecastStale
    ? 'تعذّر تحديث توقّعات الطقس لهذه الساعة (انقطاع مؤقت في مصدر التوقعات) — النتيجة المعروضة قديمة وقد لا تعكس الأجواء الفعلية. يُرجى مراجعة توقعات الساعات القادمة لاحقاً قبل البدء الفعلي.'
    : isFavorable
      ? 'الأجواء المتوقعة تصلح للنشاط — تقييم مبني على توقّعات الطقس، لا قراءة جهاز حية بعد.'
      : isPm10Unfavorable
        ? `الأجواء المتوقعة لا تصلح للنشاط — تركيز الغبار (PM10) المتوقّع (${ctx.pm10UgM3} ميكروجرام/م³) يتجاوز حد التحذير التنظيمي (${PM10_WARNING_UG_M3} ميكروجرام/م³). يُرجى مراجعة توقعات الساعات القادمة قبل البدء الفعلي (لا إيقاف إلزامي، تقييم توقّعي فقط).`
        : 'الأجواء المتوقعة لا تصلح للنشاط — يُرجى مراجعة توقعات الساعات القادمة قبل البدء الفعلي (لا إيقاف إلزامي، تقييم توقّعي فقط).';

  // خطأ معماري مكتشَف ومُصلَح (مراجعة كود خارجي — P1، الملاحظة #11:
  // "FinalDecisionEngine يعيد تطبيق Threshold لـPM10 في وضع PLANNING"): راجع
  // تعليق planningSuitability الكامل في types.ts. هذا هو المكان الوحيد الذي
  // يُحسَب فيه isFavorable الآن — final-decision-engine يقرأ هذا الحقل
  // الجاهز مباشرة، بلا أي استيراد لـPM10_WARNING_UG_M3 أو إعادة حساب. نفس
  // القيمة المستخدَمة أعلاه لبناء shortReasonAr بالضبط — مصدر واحد لا اثنان.
  const planningSuitability = {
    isFavorable,
    reasonAr: ctx.isForecastStale
      ? 'تعذّر تحديث توقّعات الطقس لهذه الساعة (انقطاع مؤقت في مصدر التوقعات) — النتيجة المعروضة قديمة وقد لا تعكس الأجواء الفعلية.'
      : isFavorable
        ? 'الأجواء المتوقعة تصلح للنشاط.'
        : isPm10Unfavorable
          ? `تركيز الغبار (PM10) المتوقّع (${ctx.pm10UgM3} ميكروجرام/م³) يتجاوز حد التحذير التنظيمي (${PM10_WARNING_UG_M3} ميكروجرام/م³).`
          : 'الأجواء المتوقعة (رياح/رؤية) لا تصلح للنشاط.',
  };

  return {
    engineType: 'RIYADH_DUST_COMPLIANCE',
    engineVersion: ENGINE_VERSION,
    rulebookVersion: RULEBOOK_VERSION,

    regulatoryActivity: ctx.activity.regulatoryActivity,
    regulatoryActivityLabelAr:
      REGULATORY_ACTIVITY_LABEL_AR[ctx.activity.regulatoryActivity],

    riskClass,
    riskClassReasonAr,
    windBand,
    isEnclosedOperation: ctx.activity.isEnclosedOperation,

    decisionCategory: 'ALLOW',
    decisionLabelAr: DECISION_LABEL_AR.ALLOW,
    mandatoryStop: false,
    canOverride: true,
    pendingConfirmation: false,
    // PLANNING (توقّع طقس، لا قراءة حية) — لا rulebook.ts تُشغَّل هنا
    // إطلاقاً (راجع تعليق evaluateDustCompliance للفرع المبكر)، فلا مخالفة
    // مؤكَّدة ممكنة أصلاً.
    hasConfirmedRegulatoryViolation: false,
    hasPendingRegulatoryFinding: false,
    resumeHoldApplied: false,
    decidingRuleCode: null,
    decidingRuleMessageAr: null,
    shortReasonAr,

    pm10SustainedMinutesAbove340: undefined,
    pm10SustainedMinutesAbove250: undefined,
    pm10EvidenceReadingIds: undefined,
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
      windDirection: ctx.windDirectionEvidence,
      // خطأ مكتشَف ومُصلَح (راجع تعليق pm10RawUgM3/pm10EvidenceState الكامل
      // في types.ts): ctx.pm10UgM3 قد يكون null الآن بسبب بوابة الحداثة
      // (قراءة جهاز قديمة) رغم وجود قيمة خام فعلية — العرض هنا يجب أن يبقى
      // القيمة الحقيقية دائماً (pm10RawUgM3)، لا القيمة المُصفَّرة المستخدَمة
      // في القرار. ?? ctx.pm10UgM3 احتياطي فقط لاستدعاءات context() القديمة
      // في الاختبارات التي لا تمرّر pm10RawUgM3 إطلاقاً.
      pm10UgM3: ctx.pm10RawUgM3 ?? ctx.pm10UgM3,
      pm25UgM3: ctx.pm25UgM3,
      relativeHumidityPercent: ctx.relativeHumidityPercent,
      temperatureC: ctx.temperatureC,
      visibilityM: ctx.visibilityM,
      deviceLastReadingAt: ctx.deviceLastReadingAt,
      devicePm10LastReadingAt: ctx.devicePm10LastReadingAt,
      pm10EvidenceState: ctx.pm10EvidenceState,
      pm10TemporalEvidenceState: ctx.pm10TemporalEvidenceState,
      pm10TemporalEvidence: buildPm10TemporalEvidenceSnapshot(ctx, now),
    },
    caveatsAr: ctx.dviCaveatsAr ?? [],
    planningSuitability,
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
  // خطأ مكتشَف ومُصلَح (مراجعة خبير خارجي — "فقد الرؤية قد يؤدي إلى ALLOW"):
  // راجع تعليق dviVisibilityDataMissing الكامل في types.ts. غياب قراءة
  // الرؤية (جهاز مرتبط فعلياً، لكن الرؤية تحديداً غائبة/قديمة) لم يكن يُعامَل
  // كنقص بيانات حرج إطلاقاً — الآن يمنع ALLOW واثقاً بنفس آلية بقية الحقول
  // الحرجة أعلاه، بدل ترك بوابتي الرؤية في dust-engine تتخطيان صامتاً.
  if (ctx.dviVisibilityDataMissing === true) {
    missingCriticalInputs.push('قراءة الرؤية غير متوفرة من الجهاز');
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
        regulatoryFinding: 'VIOLATION',
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
    // قرار تنظيمي مُعاد النظر فيه عبر عدة جولات (طلب صريح من المستخدم في كل
    // مرة، اتساقاً مع نفس التعديلات في pm10ThresholdRule أدناه): عندما يكون
    // سبب dviMandatoryStop الوحيد هو PM10 (لا خطر فيزيائي فوري آخر كرؤية
    // حرجة/رياح شديدة مساهم بنفس اللحظة — dviMandatoryStopIsPm10Only)، هذه
    // البوابة لا تُصدر MANDATORY_STOP إطلاقاً. ثلاث حالات فعلية:
    //   1) لم يكتمل استمرار دقيقتين بعد (pm10ConfirmedViolation340 غير
    //      true) → "معلَّقة" ALLOW_WITH_CONTROLS (نفس معاملة
    //      MRQ-PM10-BLACK-PENDING-104 — راجع الملاحظة #7: قرار مُعاد النظر
    //      فيه مرة أخرى لاحقاً، "قبل 120 ثانية: MONITOR، وليس
    //      STOP_AFFECTED_ACTIVITY/PROTECTIVE_STOP". كانت STOP_AFFECTED_
    //      ACTIVITY هنا نفس الثغرة بالضبط التي أُصلحت في pm10ThresholdRule،
    //      لكن عبر مسار GATE-DVI-002 المستقل تماماً — لم تُكتشَف إلا لاحقاً
    //      عبر الملاحظة #8 التي رصدت أن final-decision-engine/engine.ts
    //      لا يزال يُنتج PROTECTIVE_STOP لنفس النافذة الزمنية من dviCandidate،
    //      المُغذَّى من GATE-DVI-002 هنا، لا من pm10ThresholdRule).
    //   2) اكتمل استمرار دقيقتين (مؤكَّدة، ≥2 لا >2) لكن لم يكتمل بعد
    //      استمرار 30 دقيقة فوق 340 (pm10Suspended250For30Min) →
    //      ALLOW_WITH_CONTROLS: توثيق/تنبيه بلا إيقاف، تماماً مثل
    //      pm10ThresholdRule.
    //   3) اكتمل استمرار 30 دقيقة فوق 340 حصراً (لا نطاق التحذير
    //      [250,340]، راجع computeSustainedPm10Status في dustEvaluation.ts
    //      للتفاصيل) → STOP_AFFECTED_ACTIVITY فعلي، الإيقاف الوحيد الحقيقي.
    // خطر الرؤية الحرجة/الرياح الشديدة (dviMandatoryStopIsPm10Only=false)
    // يبقى إيقافاً فورياً صحيحاً كما كان — خطر فيزيائي فعلي لا علاقة له
    // بـPM10 ولا يحتاج "استمراراً" ليُصدَّق.
    const isPm10Only = ctx.dviMandatoryStopIsPm10Only === true;
    const pm10OnlyPending = isPm10Only && ctx.pm10ConfirmedViolation340 !== true;
    const pm10OnlySuspended = isPm10Only && ctx.pm10Suspended250For30Min === true;
    const pm10OnlySeverity: DustComplianceDecisionCategory = pm10OnlySuspended
      ? 'STOP_AFFECTED_ACTIVITY'
      : 'ALLOW_WITH_CONTROLS';
    ruleHits.push(
      {
        code: 'GATE-DVI-002',
        severity: isPm10Only ? pm10OnlySeverity : 'MANDATORY_STOP',
        // خطأ صياغة مكتشَف ومُصلَح (طلب صريح من المستخدم — رأى "إيقاف أعمال
        // الغبار: ..." على الشاشة في حالة pm10OnlyPending رغم عدم وجود أي
        // إيقاف تشغيلي فعلي في هذه المرحلة، فقط نافذة تأكيد دقيقتين): كان
        // ctx.dviShortReason (نص dust-engine الخام، دائماً يبدأ بـ"إيقاف
        // أعمال الغبار..." لهذه الحالة تحديداً — راجع STOP_DUST_GENERATING_
        // ACTIVITIES في dust-engine/engine.ts) يفوز دائماً بسبب || قبل نص
        // pm10OnlyPending الدقيق أدناه (كان ميتاً فعلياً، لا يظهر أبداً).
        // الآن نص pm10OnlyPending المعلَّق تحديداً يُقدَّم على dviShortReason
        // (لا يحمل كلمة "إيقاف" إطلاقاً، يصف الانتظار بدقة)؛ بقية الحالات
        // (مؤكَّدة/موقوفة 30 دقيقة/غير PM10) تبقى تستخدم dviShortReason أولاً
        // كما كانت — لا تغيير في أي حالة أخرى غير هذه المعلَّقة تحديداً.
        // "تعليق مؤقت (معلَّق)" استُبدلت بـ"تنبيه" (الملاحظة #7/#8) — لم يعد
        // يوجد أي تعليق/إيقاف فعلي أو حتى احترازي في هذه النافذة.
        messageAr: isPm10Only && pm10OnlyPending
          ? 'تنبيه: تجاوز فوري في تركيز الغبار — بانتظار اكتمال دقيقتين استمرار لتصنيفها مخالفة تنظيمية مؤكدة'
          : ctx.dviShortReason ||
            (isPm10Only
              ? (pm10OnlySuspended
                  ? `تعليق النشاط: تجاوز تركيز الغبار استمر عند ${PM10_WARNING_UG_M3} ميكروجرام/م³ أو أكثر لمدة 30 دقيقة متواصلة`
                  : 'تجاوز فوري مسجَّل في تركيز الغبار — النشاط مستمر تحت الضوابط المعزَّزة، الإيقاف الفعلي مرتبط فقط باستمرار التجاوز 30 دقيقة متواصلة')
              : 'إيقاف إلزامي تنظيمي: تجاوز خطر فوري في تركيز الغبار أو انعدام الرؤية بموقع النشاط'),
        // الإجراء هنا مختلف جوهرياً عن بقية القواعد: لا يوجد ما "يُصلحه"
        // المقاول في الموقع — الظرف الجوي نفسه هو المانع، فالإجراء انتظار
        // تحسّن الحالة وإخلاء العمالة، لا استكمال ضابط تحكم ناقص.
        actionAr: isPm10Only
          ? 'فعّل التثبيط المعزز فوراً (رش ساعي أو مثبطات، تغطية الأكوام، خفض ارتفاع التفريغ، تقييد حركة النقل) وراقب استمرار التجاوز'
          : 'أخلِ منطقة العمل وانتظر تحسّن حالة الجو (الرؤية وتركيز الغبار) — لا يمكن استئناف العمل بإجراء تنظيمي',
        // overridable=false فقط لحالة STOP_AFFECTED_ACTIVITY الحقيقية
        // الوحيدة المتبقية (pm10OnlySuspended، 30 دقيقة مؤكَّدة فوق 340) —
        // نفس افتراض ruleHit() الموحَّد في rulebook.ts (severity !==
        // MANDATORY_STOP/STOP_AFFECTED_ACTIVITY). ALLOW_WITH_CONTROLS
        // (معلَّقة قبل الدقيقتين، أو مؤكَّدة موثَّقة بلا اكتمال 30 دقيقة)
        // تبقى قابلة للتجاوز في كلتا الحالتين — النشاط مستمر أصلاً.
        overridable: isPm10Only && pm10OnlySeverity === 'ALLOW_WITH_CONTROLS',
        // خطأ مكتشَف ومُصلَح (مراجعة كود خارجي — P0، الملاحظة #5): نفس
        // تصنيف MRQ-PM10-BLACK-PENDING-104 في rulebook.ts بالضبط —
        // pm10OnlyPending (لم يكتمل دليل الدقيقتين بعد) هو PENDING؛ خطر
        // فيزيائي حقيقي (رؤية حرجة/عاصفة، !isPm10Only) أو PM10 مؤكَّد/موقوف
        // 30 دقيقة (isPm10Only && !pm10OnlyPending) كلاهما VIOLATION —
        // تجاوز موثَّق وقائم فعلياً.
        regulatoryFinding: isPm10Only && pm10OnlyPending ? 'PENDING' : 'VIOLATION',
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
        regulatoryFinding: 'VIOLATION',
      }
    );
  }

  // بروتوكول الملحق أ — أعلى من 25 كم/س: تُوقف كل الأنشطة المولّدة للغبار
  // عموماً، مكشوفة أو مغلقة على حد سواء. الإعفاء الوحيد من بوابتي الرياح
  // (>25 و15-25) هو محطة الخلط (BATCHING_PLANT) تحديداً، بشرطيها معاً: إحكام
  // إغلاق الصوامع (silosSealed، مدخل حقيقي لكل وحدة خلط) + كفاءة فلتر PM10
  // لا تقل عن الحد الأدنى (نفس حد BATCHING-FILTER-002 في rulebook.ts) —
  // هذا هو الإعفاء التنظيمي الموثَّق فعلياً في "الاستخراج التنظيمي من
  // المرفق" (القسم الرابع/السادس، راجع BATCHING_PM10_FILTER_MIN_PERCENT في
  // rulebook.ts): "الحد المعتمد للاستمرار أثناء إيقاف الرياح فوق 25 كم/س"
  // — مقصور على بوابة الرياح تحديداً، لا قواعد PM10 المستقلة (راجع تعليق
  // مصلَح أدناه). خطأ مكتشَف ومُصلَح: كان isEnclosedOperation وحده يُعفي أي
  // نشاط مغلق (هدم مغلق، حفر مغلق، إلخ) من بوابتي الرياح كلياً — لا سند
  // تنظيمي موثَّق لهذا التعميم؛ الإغلاق الفيزيائي وحده لا يمنع تأثر النشاط
  // بسرعة رياح متجاوزة للحد دون ضوابط محطة الخلط المحدَّدة (صوامع + فلتر).
  const isEnclosedExemptFromHighWind =
    ctx.activity.regulatoryActivity === 'BATCHING_PLANT' &&
    ctx.activity.controls.silosSealed === true &&
    ctx.activity.controls.pm10FilterEfficiencyPercent !== null &&
    ctx.activity.controls.pm10FilterEfficiencyPercent !== undefined &&
    ctx.activity.controls.pm10FilterEfficiencyPercent >= BATCHING_PM10_FILTER_MIN_PERCENT();

  if (windBand === 'ABOVE_25' && ctx.activity.isDustGenerating && !isEnclosedExemptFromHighWind) {
    const windGateStopKmh = getRuleParameters().WIND_GATE_STOP_KMH;
    ruleHits.push(
      {
        code: 'GATE-WIND-ABOVE-25-004',
        severity: 'STOP_AFFECTED_ACTIVITY',
        messageAr: `إيقاف الأنشطة المولّدة للغبار: سرعة الرياح تتجاوز ${windGateStopKmh} كم/س `,
        actionAr: `أوقف النشاط وأمّن المواد السائبة، وانتظر انخفاض سرعة الرياح إلى ما دون ${windGateStopKmh} كم/س`,
        overridable: false,
        regulatoryFinding: 'VIOLATION',
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
  const windGateStopKmhForResume = getRuleParameters().WIND_GATE_STOP_KMH;
  if (
    previousStopWasWindGate &&
    windBand !== 'ABOVE_25' &&
    ctx.windSpeedKmh !== null &&
    ctx.windSpeedKmh >= windGateStopKmhForResume
  ) {
    ruleHits.push(
      ruleHit(
        'GATE-WIND-ABOVE-25-RESUME-HOLD',
        'STOP_AFFECTED_ACTIVITY',
        `الإيقاف السابق كان بسبب رياح تجاوزت ${windGateStopKmhForResume} كم/س — الاستئناف يتطلب انخفاضها إلى ما دون ${windGateStopKmhForResume} كم/س صراحة، لا مجرد العودة إلى ${windGateStopKmhForResume} بالضبط`,
        `انتظر انخفاض سرعة الرياح إلى ما دون ${windGateStopKmhForResume} كم/س صراحة قبل الاستئناف`,
        false,
        // Same violation the wind gate itself is enforcing
        // (GATE-WIND-ABOVE-25-004, regulatoryFinding='VIOLATION') — this rule
        // only extends how long that violation's stop must persist before
        // resuming, not a separate/lesser condition.
        'VIOLATION'
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
  // خطأ مكتشَف ومُصلَح (مراجعة كود خارجي — "فجوة تقييم تُحسب ضمن مدة
  // الاستقرار"): previousEvaluationUpdatedAt (updated_at الخام لآخر دورة
  // محفوظة لهذا النشاط) يُقارَن بـnow؛ فجوة أطول من الوتيرة الفعلية للتقييم
  // (دقيقة واحدة تقريباً، راجع scheduler-worker) تعني أن دورة تقييم واحدة أو
  // أكثر لم تُنفَّذ إطلاقاً (توقّف cron/فشل شبكة/إلخ) — لا "استقرار حقيقي"
  // خلال تلك الفجوة، لأن لا قراءة حقيقية أثبتته. 90 ثانية (لا 60 بالضبط)
  // تسمح بتأخر دورة واحدة عابرة بلا تصفير كاذب، لكن تكتشف أي فجوة أطول.
  const PENDING_RESUME_GAP_TOLERANCE_MS = 90_000;
  const evaluationGapDetected =
    ctx.previousEvaluationUpdatedAt != null &&
    now - new Date(ctx.previousEvaluationUpdatedAt).getTime() > PENDING_RESUME_GAP_TOLERANCE_MS;
  const previousWasStopped =
    ctx.previousDecisionCategory === 'MANDATORY_STOP' ||
    ctx.previousDecisionCategory === 'STOP_AFFECTED_ACTIVITY';
  let resumeHoldApplied = false;

  // خطأ مكتشَف ومُصلَح (مراجعة كود خارجي — "فشل استعلام القرار السابق يُبتلع
  // ويزيل حماية الاستئناف"): previousDecisionQueryFailed=true يعني تعذّر
  // معرفة إن كان النشاط موقوفاً سابقاً أصلاً — لا previousWasStopped يمكن
  // الوثوق بها هنا (=false زائفة، لا "لا إيقاف سابق حقيقي"). فشل آمن: إيقاف
  // احترازي حتى ينجح الاستعلام مجدداً ويُثبت الحالة الفعلية، بدل افتراض
  // "لا شيء موقوف" بلا دليل.
  if (ctx.previousDecisionQueryFailed === true && DECISION_PRIORITY[decisionCategory] < DECISION_PRIORITY.STOP_AFFECTED_ACTIVITY) {
    resumeHoldApplied = true;
    ruleHits.push(
      ruleHit(
        'PREVIOUS-DECISION-QUERY-FAILED-HOLD',
        'STOP_AFFECTED_ACTIVITY',
        'تعذّر قراءة القرار السابق لهذا النشاط (فشل استعلام) — لا يمكن التأكد من عدم وجود إيقاف سابق فعّال، فيبقى النشاط موقوفاً احترازياً',
        'أعد المحاولة أو تحقق من اتصال قاعدة البيانات قبل اعتماد أي قرار على هذا النشاط',
        false,
        // خطأ مكتشَف ومُصلَح (مراجعة كود خارجي — P0، الملاحظة #5): استمرارية
        // احترازية (فشل استعلام يمنع إثبات زوال إيقاف سابق) — لا تجاوز حد
        // رقمي/قانوني جديد مؤكَّد الآن بذاته.
        'NONE'
      )
    );
    decisionCategory = decisionFromRules(ruleHits, missingCriticalInputs);
  }

  // خطأ حرج مكتشَف ومُصلَح (مراجعة كود خارجي — "فشل استعلام سلسلة PM10 يتحول
  // إلى سلسلة فارغة"): pm10HistoryQueryFailed=true يعني تعذّر معرفة استمرار
  // PM10 فعلياً (فشل استعلام pm10_readings_history، لا "لا قراءات" — راجع
  // تعليق Pm10SustainedFetchResult الكامل في dustEvaluation.ts). ليست تسجيل
  // مخالفة (regulatoryFinding لا يصبح VIOLATION — لم نُثبت تجاوزاً)، وليست
  // امتثالاً مثبتاً أيضاً (لا NONE بمعنى "متوافق تماماً") — تحقّق ميداني
  // مطلوب صراحة، أقل حدة من STOP_AFFECTED_ACTIVITY (لا يجوز افتراض إيقاف
  // مستحق بلا دليل)، لكن أعلى من PRECAUTION العادية (لا يجوز إخفاء فشل قاعدة
  // البيانات خلف احتراز عابر).
  if (ctx.pm10HistoryQueryFailed === true) {
    // طلب مستخدم صريح ("سجل الأعطال والتدقيق"): نص messageAr/actionAr هنا
    // هو بالضبط ما تعرضه الواجهة للمستخدم النهائي — يجب أن يبقى خالياً من
    // أي تفصيل تقني داخلي (نص PostgreSQL، اسم الجدول pm10_readings_history،
    // Stack trace، بيانات اتصال قاعدة البيانات). التفاصيل التشخيصية الكاملة
    // تُسجَّل بدلاً من ذلك في جدول technical_fault_events عبر
    // logPm10HistoryQueryFailureTelemetry (dustEvaluation.ts) — مسار منفصل
    // تماماً لا تقرأ منه هذه الواجهة.
    ruleHits.push(
      ruleHit(
        'PM10-HISTORY-QUERY-FAILED-HOLD',
        'FIELD_VERIFICATION_REQUIRED',
        'تعذر التحقق من استمرارية PM10 بسبب مشكلة مؤقتة في سجل القراءات. لم يعتبر النظام ذلك عدم وجود تجاوز، ويلزم إعادة التقييم.',
        'أعد التقييم ميدانياً بعد استعادة القراءة الطبيعية لسجل PM10',
        false,
        'NONE'
      )
    );
    decisionCategory = decisionFromRules(ruleHits, missingCriticalInputs);
  }

  // خطأ حرج مكتشَف ومُصلَح (نفس المراجعة أعلاه، الخطوة 6): فشل استعلام سلسلة
  // PM10 لا يجوز أن يُزيل إيقافاً سابقاً كان سببه PM10 تحديداً — نفس مبدأ
  // previousDecisionQueryFailed أعلاه (فشل استعلام القرار السابق يُبقي
  // النشاط موقوفاً احترازياً)، مطبَّقاً هنا حين يكون سبب الإيقاف السابق نفسه
  // (previousDecidingRuleCode) قاعدة PM10. previousDecisionQueryFailed=true
  // (فشل قراءة القرار السابق نفسه) يُغطّى بالفعل بقاعدة أخرى أعلاه، فهذه
  // القاعدة تُطبَّق فقط حين نجح قراءة القرار السابق (نعرف أنه كان PM10-STOP)
  // لكن فشل تحديث سلسلة PM10 الحية اللاحقة.
  //
  // خطأ مكتشَف ومُصلَح أثناء كتابة الاختبار: بادئة الكود وحدها ('PM10-')
  // كانت ستفوّت القاعدة الوحيدة التي تُنتج STOP_AFFECTED_ACTIVITY فعلياً —
  // RCRC-PM10-30M-SUSPENSION-012 (تعليق 30 دقيقة، الكود الفعلي المخزَّن في
  // previousDecidingRuleCode لأي إيقاف PM10 حقيقي سابق) لا تبدأ بـ'PM10-'.
  // القواعد الثلاث الأخرى المرتبطة بـPM10 (PM10-VIOLATION-STOP-006/MRQ-PM10-
  // BLACK-PENDING-104/PM10-WARNING-008) كلها ALLOW_WITH_CONTROLS — لا تُنتج
  // STOP_AFFECTED_ACTIVITY إطلاقاً، فلا يمكن أصلاً أن تكون previousDecidingRuleCode
  // لقرار موقوف سابقاً. المطابقة الصحيحة إذن هي الكود الفعلي حصراً، لا بادئة.
  const previousWasPm10Stop =
    (ctx.previousDecisionCategory === 'MANDATORY_STOP' || ctx.previousDecisionCategory === 'STOP_AFFECTED_ACTIVITY') &&
    ctx.previousDecidingRuleCode === 'RCRC-PM10-30M-SUSPENSION-012';
  if (ctx.pm10HistoryQueryFailed === true && previousWasPm10Stop) {
    ruleHits.push(
      ruleHit(
        'PM10-PREVIOUS-STOP-PRESERVED-ON-QUERY-FAILURE',
        'STOP_AFFECTED_ACTIVITY',
        'تعذّر التحقق من زوال سبب إيقاف PM10 السابق؛ يبقى النشاط موقوفاً حتى نجاح إعادة التقييم',
        'استعد سجل PM10 وأعد التقييم قبل الاستئناف',
        false,
        'NONE'
      )
    );
    decisionCategory = decisionFromRules(ruleHits, missingCriticalInputs);
  }

  if (previousWasStopped && DECISION_PRIORITY[decisionCategory] < DECISION_PRIORITY.STOP_AFFECTED_ACTIVITY) {
    const minutesSinceGoodReadingBegan =
      ctx.previousPendingResumeSince && !evaluationGapDetected
        ? (now - new Date(ctx.previousPendingResumeSince).getTime()) / 60000
        : 0; // لا استقرار مسجَّل بعد، أو فجوة تقييم مكتشَفة = بداية الاستقرار
             // الآن (فشل آمن نحو المنع — فجوة تُصفِّر العداد، لا "تُحتسب").
    if (minutesSinceGoodReadingBegan < RESUME_STABILITY_MINUTES) {
      resumeHoldApplied = true;
      ruleHits.push(
        ruleHit(
          'RESUME-STABILITY-HOLD',
          'STOP_AFFECTED_ACTIVITY',
          `الظروف تحسّنت لكن لم يمضِ وقت كافٍ على استقرارها بعد آخر إيقاف — بانتظار استقرار القراءة (${RESUME_STABILITY_MINUTES} دقائق) قبل الاستئناف`,
          `أبقِ النشاط موقوفاً حتى تستقر القراءة الجيدة لمدة ${RESUME_STABILITY_MINUTES} دقائق متواصلة قبل الاستئناف`,
          // خطأ مكتشَف ومُصلَح (مراجعة كود خارجي — P2، الملاحظة #14: "عقد
          // Override غير متسق"): كانت overridable=true صراحةً هنا — الوحيدة
          // بين كل قواعد resume-hold الشقيقة (PREVIOUS-DECISION-QUERY-FAILED-
          // HOLD، VISIBILITY/WIND/PM10-DATA-MISSING-RESUME-HOLD) التي تمرر
          // جميعها false صراحةً لنفس severity=STOP_AFFECTED_ACTIVITY. القرار
          // النهائي الرسمي (final-decision-engine) لم يتأثر فعلياً (confirmedAffectedStop
          // يُترجَم دائماً MANDATORY_STOP رتبةً بصرف النظر عن canOverride)،
          // لكن DustComplianceResult.canOverride الوسيط كان يبقى true بلا
          // مبرر — عقد غير نظيف قد يُضلِّل أي مستهلك مستقبلي يقرأه مباشرة.
          // false (نفس افتراض ruleHit() الطبيعي لهذا الـseverity أصلاً، ونفس
          // قيمة كل القواعد الشقيقة) يوحّد العقد.
          false,
          // الظروف تحسّنت فعلياً (النص نفسه يقر بذلك) — استمرارية احترازية
          // لإثبات استقرار الزوال، لا مخالفة جديدة.
          'NONE'
        )
      );
      decisionCategory = decisionFromRules(ruleHits, missingCriticalInputs);
    }
  }

  // خطأ مكتشَف ومُصلَح (مراجعة خبير خارجي — "فقد الرؤية قد يؤدي إلى ALLOW أو
  // يسمح باستكمال نافذة الاستئناف من إيقاف سابق"): applyMandatoryGates
  // (dust-engine/engine.ts) يتخطى بوابتي الرؤية بصمت عند visibilityKm===null
  // (غياب القراءة، لا تحسّنها الفعلي) — فلو كان النشاط موقَّفاً سابقاً
  // (MANDATORY_STOP/STOP_AFFECTED_ACTIVITY) لأي سبب، وانقطعت قراءة الرؤية
  // الآن (dviVisibilityDataMissing=true)، كان القرار الخام قد "يتحسّن" بمجرد
  // غياب البيانات لا بتحسّن الظروف فعلياً، فيبدأ عداد RESUME_STABILITY_MINUTES
  // أعلاه من بيانات لا تثبت شيئاً. الإصلاح: نفس مبدأ previousStopWasWindGate
  // أعلاه بالضبط — طالما الرؤية غير متوفرة، لا يجوز اعتبار الإيقاف السابق
  // "تحسّن" إطلاقاً، بصرف النظر عن مدة استقرار أي حقل آخر.
  if (previousWasStopped && ctx.dviVisibilityDataMissing === true && DECISION_PRIORITY[decisionCategory] < DECISION_PRIORITY.STOP_AFFECTED_ACTIVITY) {
    resumeHoldApplied = true;
    ruleHits.push(
      ruleHit(
        'VISIBILITY-DATA-MISSING-RESUME-HOLD',
        'STOP_AFFECTED_ACTIVITY',
        'قراءة الرؤية غير متوفرة من الجهاز — لا يمكن التأكد من تحسّن الرؤية بعد إيقاف سابق، فيبقى النشاط موقوفاً احترازياً',
        'أعد الاتصال بجهاز الرصد أو تحقق ميدانياً من الرؤية قبل اعتماد أي استئناف',
        false,
        'NONE'
      )
    );
    decisionCategory = decisionFromRules(ruleHits, missingCriticalInputs);
  }

  // خطأ مكتشَف ومُصلَح (مراجعة كود خارجي — "انقطاع البيانات يُحسب ضمن مدة
  // الاستقرار ويسمح بالاستئناف"): نفس ثغرة dviVisibilityDataMissing أعلاه
  // بالضبط، لكن لسرعة الرياح — classifyWind(null)='UNKNOWN' فلا تُفعَّل
  // بوابة الرياح (GATE-WIND-ABOVE-25-004) عند غياب القراءة، فلو كان الإيقاف
  // السابق بسبب رياح شديدة وانقطع الجهاز الآن، decisionCategory قد "يتحسّن"
  // بمجرد غياب البيانات لا بانخفاض الرياح فعلياً. طالما سرعة الرياح غير
  // متوفرة (ctx.windSpeedKmh===null)، لا يجوز اعتبار الإيقاف السابق "تحسّن".
  if (previousWasStopped && (ctx.windSpeedKmh === null || ctx.windSpeedKmh === undefined) && DECISION_PRIORITY[decisionCategory] < DECISION_PRIORITY.STOP_AFFECTED_ACTIVITY) {
    resumeHoldApplied = true;
    ruleHits.push(
      ruleHit(
        'WIND-DATA-MISSING-RESUME-HOLD',
        'STOP_AFFECTED_ACTIVITY',
        'قراءة سرعة الرياح غير متوفرة من الجهاز — لا يمكن التأكد من انخفاض الرياح بعد إيقاف سابق، فيبقى النشاط موقوفاً احترازياً',
        'أعد الاتصال بجهاز الرصد أو تحقق ميدانياً من سرعة الرياح قبل اعتماد أي استئناف',
        false,
        'NONE'
      )
    );
    decisionCategory = decisionFromRules(ruleHits, missingCriticalInputs);
  }

  // نفس المبدأ بالضبط لـPM10 — pm10EvidenceState (adapters.ts، راجع تعليقه
  // الكامل في types.ts) يُصفِّر ctx.pm10UgM3 إلى null متى كانت قراءة الجهاز
  // قديمة/مفقودة/مستقبلية، فيختفي أي سبب إيقاف مبني على PM10 من ruleHits
  // بصمت (pm10ThresholdRule يعيد [] لقيمة null) — بلا فحص هنا، هذا "الاختفاء"
  // كان قد يُقرأ كتحسّن فعلي بعد إيقاف سابق. تُطبَّق فقط لقراءة جهاز
  // (pm10Source='device') — FRESH افتراضية دائماً لمصادر أخرى (نفس استثناء
  // dust-engine/engine.ts وadapters.ts)، فلا تُفعِّل هذه البوابة لهما.
  if (
    previousWasStopped &&
    ctx.pm10Source === 'device' &&
    ctx.pm10EvidenceState !== undefined &&
    ctx.pm10EvidenceState !== 'FRESH' &&
    DECISION_PRIORITY[decisionCategory] < DECISION_PRIORITY.STOP_AFFECTED_ACTIVITY
  ) {
    resumeHoldApplied = true;
    ruleHits.push(
      ruleHit(
        'PM10-DATA-MISSING-RESUME-HOLD',
        'STOP_AFFECTED_ACTIVITY',
        'قراءة PM10 غير متوفرة/قديمة من الجهاز — لا يمكن التأكد من انخفاض تركيز الغبار بعد إيقاف سابق، فيبقى النشاط موقوفاً احترازياً',
        'أعد الاتصال بجهاز الرصد أو تحقق ميدانياً من تركيز PM10 قبل اعتماد أي استئناف',
        false,
        'NONE'
      )
    );
    decisionCategory = decisionFromRules(ruleHits, missingCriticalInputs);
  }

  const confidenceScore = calculateComplianceConfidence(ctx, missingCriticalInputs);

  // منع قرار ALLOW مع ثقة أقل من الحد الأدنى — يتحول تلقائياً لتحقق ميداني.
  const confidenceMinForAllow = CONFIDENCE_MIN_FOR_ALLOW();
  if (decisionCategory === 'ALLOW' && confidenceScore < confidenceMinForAllow) {
    ruleHits.push(
      ruleHit(
        'LOW-CONFIDENCE-VERIFICATION',
        'FIELD_VERIFICATION_REQUIRED',
        `مستوى الثقة في القرار (${confidenceScore}) أقل من الحد الأدنى المطلوب للسماح التلقائي (${confidenceMinForAllow})`,
        'راجع البيانات الناقصة/غير المؤكدة ميدانياً قبل اعتماد القرار كسماح كامل',
        true,
        // Uncertainty gate on decision confidence — not a confirmed
        // violation of a numeric/legal threshold.
        'NONE'
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
  // الوحيد PM10 لحظي لم يثبت استمراره >دقيقتين بعد (راجع pm10OnlyPending
  // أعلاه). لا يشمل GATE-DVI-002 حين يكون STOP_AFFECTED_ACTIVITY بسبب
  // اكتمال استمرار 30 دقيقة الموحَّد (pm10OnlySuspended) — تلك حالة مؤكَّدة
  // نهائياً، لا تتحول تلقائياً لأي قرار آخر بمجرد مرور وقت إضافي.
  const isPendingRuleHit = (hit: DustRuleHit): boolean =>
    hit.code === 'MRQ-PM10-BLACK-PENDING-104' ||
    (hit.code === 'GATE-DVI-002' && ctx.dviMandatoryStopIsPm10Only === true && ctx.pm10ConfirmedViolation340 !== true);

  const topHits = ruleHits.filter((r) => r.severity === decisionCategory);
  const confirmedHit = topHits.find((hit) => !isPendingRuleHit(hit));
  const decidingRule = confirmedHit ?? topHits[0];
  const pendingConfirmation = topHits.length > 0 && topHits.every((hit) => isPendingRuleHit(hit));

  // خطأ معماري مكتشَف ومُصلَح (مراجعة كود خارجي — "المخالفة التنظيمية عند
  // تأكيد PM10 لا تنعكس في regulatoryFinding"): PM10-VIOLATION-STOP-006
  // (مخالفة مؤكَّدة موثَّقة، ALLOW_WITH_CONTROLS عمداً — لا إيقاف فوري) قد
  // لا تكون القاعدة الفائزة بأعلى شدة إن وُجدت قاعدة أخف لا علاقة لها بها،
  // لكنها قد تكون *أشد ما فُعِّل فعلياً* حين لا توجد أي مشكلة أخرى — عندها
  // decisionCategory النهائي يصبح ALLOW_WITH_CONTROLS بالكامل، فلا ينعكس
  // وجود المخالفة في أي حقل. مستقل تماماً عن topHits/decisionCategory —
  // يفحص كل ruleHits (لا فقط الفائزة بأعلى شدة)، لأن هذا حقل "هل حدثت
  // مخالفة تنظيمية مؤكَّدة إطلاقاً هذه الدورة"، لا "ما القرار الفائز".
  //
  // خطأ معماري مكتشَف ومُصلَح (مراجعة كود خارجي — P0، الملاحظة #5:
  // "regulatoryFinding مصمم حالياً حول PM10 فقط"): كان هذا الحقل مقيَّداً
  // حرفياً بمطابقة كود قاعدة واحد (PM10-VIOLATION-STOP-006) — أي مخالفة
  // صريحة أخرى موثَّقة في rulebook.ts (سرعة طريق غير مسفلت >10، طريق مسفلت
  // >20، تأخر تنظيف انسكاب >15 دقيقة، حمولة غير مغطاة، صوامع غير محكمة،
  // تسرب صومعة، إلخ) لم تكن تُنتج hasConfirmedRegulatoryViolation=true
  // إطلاقاً رغم كونها تجاوزاً صريحاً لحد رقمي/قانوني موثَّق — قد يُنتج
  // operationalDecision=RESTRICT + regulatoryFinding=COMPLIANT، تناقض
  // مباشر. الإصلاح: كل قاعدة تحمل الآن دلالتها التنظيمية المستقلة صراحة
  // (regulatoryFinding: NONE|PENDING|VIOLATION، راجع RuleRegulatoryFinding
  // في types.ts) — لا تُستنتَج من severity (الذي يجيب "ماذا نفعل تشغيلياً؟"
  // فقط، لا "هل وقع إخلال تنظيمي؟"). هذا الحقل يفحص أي قاعدة VIOLATION عبر
  // كل ruleHits (لا فقط topHits)، بنفس مبدأ الفحص الشامل السابق تماماً —
  // فقط معيار المطابقة تغيّر من كود واحد صريح إلى دلالة عامة لكل قاعدة.
  const hasConfirmedRegulatoryViolation = ruleHits.some((hit) => hit.regulatoryFinding === 'VIOLATION');

  // hasPendingRegulatoryFinding: separate from pendingConfirmation above —
  // pendingConfirmation answers "is the whole winning topHits decision pending?"
  // (false the moment any non-pending rule ties at the same severity, e.g. a
  // concurrent 15-25 km/h wind gate with regulatoryFinding='NONE'). This field
  // answers "does an unresolved pending regulatory condition exist at all right
  // now?", checked across all ruleHits like hasConfirmedRegulatoryViolation
  // above, not just topHits. A confirmed violation always wins over an unrelated
  // pending condition (hasConfirmedRegulatoryViolation is checked first by
  // final-decision-engine). Without this field, a confirmed-but-non-violating
  // fact (e.g. wind's regulatoryFinding='NONE') could silently demote an active
  // PM10 pending-confirmation window down to a plain "compliant" reading.
  const hasPendingRegulatoryFinding = ruleHits.some((hit) => hit.regulatoryFinding === 'PENDING');

  // canOverride مشتقة الآن من overridable الفعلي لقاعدة(قواعد) القرار
  // الحاسمة (topHits)، لا من فئة decisionCategory العامة كما كانت سابقاً —
  // راجع تعليق overridable في types.ts للسبب الكامل. أي قاعدة غير قابلة
  // للتجاوز بين المتعادلات بأعلى شدة تكفي لمنع تجاوز القرار بأكمله (نفس
  // مبدأ "الأشد يفوز" المطبَّق في كل مكان آخر بهذا المحرك) — افتراض true
  // لقاعدة لا تحدد overridable إطلاقاً (توافقاً مع تعريفها الافتراضي في
  // ruleHit()). لا topHits إطلاقاً (decisionCategory=ALLOW بلا أي ruleHits)
  // يعني قابلية تجاوز كاملة بداهة.
  const canOverride = topHits.length === 0 || topHits.every((hit) => hit.overridable !== false);

  // خطأ معماري مكتشَف ومُصلَح (مراجعة كود خارجي — P0: "PM10 المعلَّق يمكن أن
  // يختفي إذا ظهرت قاعدة أخرى بنفس الشدة"): كان الاستبعاد أدناه مربوطاً
  // بـpendingConfirmation العام (topHits.every(isPending)) — لكن ذلك الحقل
  // يجيب سؤالاً مختلفاً تماماً ("هل القرار الفائز بأكمله معلَّق؟")، لا السؤال
  // المقصود فعلياً هنا ("هل يوجد إيقاف مؤكَّد فعلي يجعل نص PM10 المعلَّق
  // متناقضاً؟"). مثال حقيقي: PM10>340 معلَّق (MRQ-PM10-BLACK-PENDING-104،
  // ALLOW_WITH_CONTROLS) + رياح 15-25 كم/س (GATE-WIND-15-25-ENHANCED-005،
  // نفس الشدة ALLOW_WITH_CONTROLS لكنها قاعدة مؤكَّدة لا معلَّقة) — topHits
  // تضم القاعدتين معاً بنفس الشدة، فـpendingConfirmation=false (صحيح: القرار
  // الفائز ليس معلَّقاً بالكامل)، فكانت MRQ-PM10-BLACK-PENDING-104 تُحذَف
  // كلياً من displayedRuleHits رغم أنها لا تتعارض إطلاقاً مع ALLOW_WITH_
  // CONTROLS (القرار النهائي، غير قطعي أصلاً) — يُخفي عن المستخدم أن عداد
  // تأكيد PM10 لا يزال يجري (120 ثانية)، لا لأي سبب حقيقي.
  //
  // الإصلاح: شرط الاستبعاد يعكس الآن حرفياً ما وصفه التعليق الأصلي أدناه —
  // إيقاف مؤكَّد فعلياً (MANDATORY_STOP أو STOP_AFFECTED_ACTIVITY تحديداً،
  // الفئتان اللتان تتعارض نصوصهما فعلياً مع "بانتظار...") ناتج عن قاعدة أخرى
  // غير MRQ-PM10-BLACK-PENDING-104 نفسها. أي شدة أخف (بما فيها ALLOW_WITH_
  // CONTROLS، كما في المثال أعلاه) لا تُخفي القاعدة المعلَّقة إطلاقاً — لا
  // تعارض حقيقي بين "مسموح بضوابط" و"PM10 لا يزال معلَّقاً بانتظار تأكيد".
  const pm10PendingRuleCode = 'MRQ-PM10-BLACK-PENDING-104';
  const confirmedStopFromOtherRule =
    (decisionCategory === 'MANDATORY_STOP' || decisionCategory === 'STOP_AFFECTED_ACTIVITY') &&
    ruleHits.some((r) => r.code !== pm10PendingRuleCode && r.severity === decisionCategory);
  // البند 10 ("طوّر Rule Hit ليحمل metadata المطلوبة بدل الاعتماد على
  // catalog يدوي"، راجع تعليق RuleMetadata الكامل في types.ts): metadata
  // تُلحق هنا فقط — نقطة تجميع واحدة قبل التصدير النهائي كـtriggeredRules
  // — لا أثناء بناء كل قاعدة على حدة (يتجنب استيراداً دائرياً بين
  // rulebook.ts وruleMetadata.ts، وrulebook.ts يستورد من ruleMetadata.ts).
  // إلحاق توثيقي بحت — لا يُغيّر code/severity/messageAr/actionAr/
  // overridable/regulatoryFinding لأي قاعدة، فلا يؤثر على القرار الفعلي.
  const displayedRuleHits = (confirmedStopFromOtherRule
    ? ruleHits.filter((r) => r.code !== pm10PendingRuleCode)
    : ruleHits
  ).map(attachRuleMetadata);

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
  // خطأ مكتشَف ومُصلَح (مراجعة كود خارجي — P0، الملاحظة #7: "قاعدة رياح قطع
  // الأحجار غير صحيحة"): STONECUT-WIND-STOP-003 كانت مُصنَّفة ضمن مجموعة
  // "دون 15" (نفس مجموعة الهدم) رغم أنها لم تعد تُفعَّل إلا عند windBand===
  // 'ABOVE_25' (>25 كم/س، بعد إصلاح سابق هذه الجلسة) — فكان شرط الاستئناف
  // المعروض للمستخدم عند إيقاف قطع الأحجار بسبب الرياح يقول خطأً "انخفاض
  // الرياح دون 15"، رغم أن القاعدة نفسها تشترط تجاوز 25 لتُفعَّل أصلاً (لا
  // علاقة لها بعتبة 15 — تلك عتبة التثبيط المعزَّز STONECUT-WIND-ENHANCED-004
  // المنفصلة تماماً، التي لا تُنتج إيقافاً إطلاقاً). الهدم يبقى الاستثناء
  // الوحيد الموثَّق فعلياً بعتبة 15 (DEMO-WIND-STOP-001، ثابته الخاص
  // WIND_GATE_ENHANCED_MIN_KMH). الإصلاح: STONECUT-WIND-STOP-003 تنتقل إلى
  // مجموعة "دون 25" (نفس عتبة GATE-WIND-ABOVE-25-004 العامة تماماً — القاعدة
  // فعلياً تكرار لنفس شرط تلك البوابة، بعتبة مطابقة تماماً الآن).
  const GENERAL_WIND_STOP_RULE_CODES = new Set(['GATE-WIND-ABOVE-25-004', 'GATE-WIND-ABOVE-25-RESUME-HOLD', 'STONECUT-WIND-STOP-003']);
  const ACTIVITY_WIND_15_STOP_RULE_CODES = new Set(['DEMO-WIND-STOP-001']);
  const requiresWindBelow15 = topHits.some((hit) => ACTIVITY_WIND_15_STOP_RULE_CODES.has(hit.code));
  const requiresWindBelow25 = topHits.some((hit) => GENERAL_WIND_STOP_RULE_CODES.has(hit.code));

  const restartConditions: string[] = [];
  if (mandatoryStop || decisionCategory === 'STOP_AFFECTED_ACTIVITY') {
    if (requiresWindBelow15) {
      restartConditions.push(`انخفاض سرعة الرياح إلى ما دون ${getRuleParameters().WIND_GATE_ENHANCED_MIN_KMH} كم/س`);
    } else if (requiresWindBelow25) {
      restartConditions.push(`انخفاض سرعة الرياح إلى ما دون ${getRuleParameters().WIND_GATE_STOP_KMH} كم/س`);
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
      REGULATORY_ACTIVITY_LABEL_AR[ctx.activity.regulatoryActivity],

    riskClass,
    riskClassReasonAr,
    windBand,
    isEnclosedOperation: ctx.activity.isEnclosedOperation,

    decisionCategory,
    decisionLabelAr: DECISION_LABEL_AR[decisionCategory],
    mandatoryStop,
    canOverride,
    pendingConfirmation,
    hasConfirmedRegulatoryViolation,
    hasPendingRegulatoryFinding,
    resumeHoldApplied,
    decidingRuleCode: decidingRule?.code ?? null,
    decidingRuleMessageAr: decidingRule?.messageAr ?? null,
    shortReasonAr: shortReasonFor(decisionCategory, decidingRule, resumeHoldApplied),

    pm10SustainedMinutesAbove340: ctx.pm10SustainedMinutesAbove340,
    pm10SustainedMinutesAbove250: ctx.pm10SustainedMinutesAbove250,
    pm10EvidenceReadingIds: ctx.pm10EvidenceReadingIds,
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
      windDirection: ctx.windDirectionEvidence,
      // خطأ مكتشَف ومُصلَح (راجع تعليق pm10RawUgM3/pm10EvidenceState الكامل
      // في types.ts): ctx.pm10UgM3 قد يكون null الآن بسبب بوابة الحداثة
      // (قراءة جهاز قديمة) رغم وجود قيمة خام فعلية — العرض هنا يجب أن يبقى
      // القيمة الحقيقية دائماً (pm10RawUgM3)، لا القيمة المُصفَّرة المستخدَمة
      // في القرار. ?? ctx.pm10UgM3 احتياطي فقط لاستدعاءات context() القديمة
      // في الاختبارات التي لا تمرّر pm10RawUgM3 إطلاقاً.
      pm10UgM3: ctx.pm10RawUgM3 ?? ctx.pm10UgM3,
      pm25UgM3: ctx.pm25UgM3,
      relativeHumidityPercent: ctx.relativeHumidityPercent,
      temperatureC: ctx.temperatureC,
      visibilityM: ctx.visibilityM,
      deviceLastReadingAt: ctx.deviceLastReadingAt,
      devicePm10LastReadingAt: ctx.devicePm10LastReadingAt,
      pm10EvidenceState: ctx.pm10EvidenceState,
      pm10TemporalEvidenceState: ctx.pm10TemporalEvidenceState,
      pm10TemporalEvidence: buildPm10TemporalEvidenceSnapshot(ctx, now),
    },
    caveatsAr: ctx.dviCaveatsAr ?? [],
  };
}
