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
  ruleHits: DustRuleHit[]
): string {
  if (decision === 'ALLOW') return 'لا توجد مخالفات تنظيمية ظاهرة على النشاط الحالي';
  const topRule = ruleHits.find((r) => r.severity === decision);
  return topRule?.messageAr ?? DECISION_LABEL_AR[decision];
}

function buildMonitoringObligations(
  ctx: DustComplianceContext,
  riskClass: DustRiskClass
): { obligations: DustMonitoringObligation[]; nonCompliantHit: DustRuleHit | null } {
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

  const nonCompliant = obligations.find((o) => o.required && o.status === 'NON_COMPLIANT');
  const nonCompliantHit: DustRuleHit | null = nonCompliant
    ? {
        code: `MONITORING-${nonCompliant.key}`,
        severity: 'RESTRICT_ACTIVITY',
        messageAr: `التزام رصد غير مكتمل: ${nonCompliant.descriptionAr}`,
        actionAr: `استوفِ التزام الرصد المطلوب: ${nonCompliant.descriptionAr}`,
      }
    : null;

  return { obligations, nonCompliantHit };
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
    // رسالة موجّهة للمستخدم غير التقني — توضح السبب الفيزيائي الفعلي
    // (رؤية/غبار خطر) بدل ذكر اسم محرك داخلي (DVI) لا يظهر له أي بطاقة
    // منفصلة في الواجهة الحالية. لا تغيير في منطق القرار نفسه — هذا التوقف
    // يبقى مورَّثاً فعلياً من نفس تقييم الرؤية والغبار الفيزيائي، فقط
    // صياغته أوضح.
    ruleHits.push(
      {
        code: 'GATE-DVI-002',
        severity: 'MANDATORY_STOP',
        messageAr: 'إيقاف إلزامي بسبب خطورة فيزيائية حالية (رؤية منعدمة أو تركيز غبار خطر) لا علاقة له بمخالفة تنظيمية',
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
  if (windBand === 'ABOVE_25' && ctx.activity.isDustGenerating && !ctx.activity.isEnclosedOperation) {
    ruleHits.push(
      {
        code: 'GATE-WIND-ABOVE-25-004',
        severity: 'STOP_AFFECTED_ACTIVITY',
        messageAr: 'إيقاف الأنشطة المكشوفة المولّدة للغبار: سرعة الرياح تتجاوز 25 كم/س (بروتوكول الملحق أ)',
        actionAr: 'أوقف الأنشطة المكشوفة وأمّن المواد السائبة، وانتظر انخفاض سرعة الرياح إلى ما دون 25 كم/س',
      }
    );
  }

  // --- قواعد النشاط التنظيمي المحدد (القسم 9.4-9.10) ---
  ruleHits.push(...applyActivityRules(ctx.project, riskClass, windBand, ctx.activity, ctx.windSpeedKmh));

  // --- التزامات الرصد (القسم 10) — تُبنى دائماً للعرض؛ فقط الفئتان
  // الثانية والثالثة تُلزَمان فعلياً بها (عدم الامتثال لمشروع فئة أولى
  // لا يُنتج قاعدة تقييد).
  const { obligations, nonCompliantHit } = buildMonitoringObligations(ctx, riskClass);
  const monitoringApplies = riskClass === 'CATEGORY_II_MEDIUM' || riskClass === 'CATEGORY_III_HIGH';
  if (monitoringApplies && nonCompliantHit) {
    ruleHits.push(nonCompliantHit);
  }

  let decisionCategory = decisionFromRules(ruleHits, missingCriticalInputs);

  const confidenceScore = calculateComplianceConfidence(ctx, missingCriticalInputs);

  // منع قرار ALLOW مع ثقة أقل من 70 — يتحول تلقائياً لتحقق ميداني.
  if (decisionCategory === 'ALLOW' && confidenceScore < CONFIDENCE_MIN_FOR_ALLOW) {
    decisionCategory = 'FIELD_VERIFICATION_REQUIRED';
  }

  const mandatoryStop = decisionCategory === 'MANDATORY_STOP';
  const canOverride = !mandatoryStop && decisionCategory !== 'STOP_AFFECTED_ACTIVITY';

  // الإجراءات المطلوبة تُبنى من actionAr (نص الإجراء التصحيحي) وليس من
  // messageAr (وصف المخالفة) — وإلا ظهرت نفس الجملة حرفياً مرتين في البطاقة:
  // مرة تحت "القواعد المفعّلة" ومرة تحت "الإجراءات المطلوبة"، فيظن المستخدم
  // أن النظام يكرر كلامه بلا فائدة.
  const requiredActions = Array.from(
    new Set(ruleHits.filter((r) => r.severity !== 'ALLOW_WITH_CONTROLS').map((r) => r.actionAr))
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
  }

  return {
    engineType: 'RIYADH_DUST_COMPLIANCE',
    engineVersion: ENGINE_VERSION,
    rulebookVersion: RULEBOOK_VERSION,

    riskClass,
    riskClassReasonAr,
    windBand,
    isEnclosedOperation: ctx.activity.isEnclosedOperation,

    decisionCategory,
    decisionLabelAr: DECISION_LABEL_AR[decisionCategory],
    mandatoryStop,
    canOverride,
    shortReasonAr: shortReasonFor(decisionCategory, ruleHits),

    triggeredRules: ruleHits,
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
    },
  };
}
