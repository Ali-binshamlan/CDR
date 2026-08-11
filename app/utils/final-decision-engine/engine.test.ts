import { describe, it, expect } from 'vitest';
import { decideFinal, pickWorstDecision } from './engine';
import type { FinalDecision, FinalDecisionInput } from './types';
import type { DviEvaluationResult } from '@/app/utils/dust-engine/types';
import type { DustComplianceResult } from '@/app/utils/dust-compliance-engine/types';
import type { AeiEvaluationResult } from '@/app/utils/aei-engine/types';

// =====================================================================
// اختبارات decideFinal — المحرك النهائي الوحيد المسموح له بدمج DVI +
// الامتثال + AEI في قرار واحد (راجع types.ts للسياق الكامل حول سبب وجود
// هذا الملف: كان الدمج موزَّعاً بمنطق مستقل في computeUnifiedActivityDecision،
// applyComplianceGateToAei، ومولّد التنبيهات — ثلاث نسخ قابلة للتناقض).
// السيناريوهات أدناه تغطي نفس الحالات المختبرة سابقاً في
// dustEvaluation.unifiedDecision.test.ts (القديم) لضمان تطابق سلوكي كامل
// بعد النقل، بالإضافة لسيناريوهات جديدة خاصة بـevidenceQuality/mode.
// =====================================================================

function baseDvi(overrides: Partial<DviEvaluationResult> = {}): DviEvaluationResult {
  return {
    indicatorType: 'DVI',
    dviBase: 30,
    score: 40,
    level: 'ORANGE',
    causeClassification: 'DUST',
    decisionCategory: 'RESTRICT',
    decisionLabelAr: 'تقييد النشاط وتفعيل أنظمة الرش',
    mandatoryStop: false,
    overridable: true,
    stopBasis: 'NONE',
    confirmationState: 'NOT_APPLICABLE',
    channels: {
      visibilityRisk: 0,
      particulateRisk: 0,
      windTransportRisk: 0,
      dustForecastRisk: 0,
      siteDustGenerationRisk: 0,
      adjustedSiteDustGenerationRisk: 0,
      externalHazard: 0,
      internalDustHazard: 0,
    },
    multipliers: {
      activitySensitivity: 0,
      activitySensitivityMultiplier: 1,
      receptorSensitivity: 0,
      downwindAlignment: 0,
      distanceFactor: 1,
      receptorImpact: 0,
      receptorSensitivityMultiplier: 1,
      mitigationScore: 0,
      mitigationReductionFactor: 1,
    },
    visibilityKm: 5,
    effectiveWindKmh: 10,
    visibilityDataMissing: false,
    visibilityConstraint: false,
    mandatoryVisibilityStop: false,
    respiratoryPPERequired: false,
    dustExposureHigh: false,
    outdoorWorkRestriction: false,
    triggeredRules: ['DVI-PM10-ACTION-003'],
    requiredActions: [],
    shortReason: 'تقييد العمل: وجود فجوة في إجراءات التحكم الميدانية (مثل غياب رش المياه أو مصدات الغبار).',
    topRiskDrivers: [],
    riskReducers: [],
    caveatsAr: [],
    confidenceScore: 95,
    confidenceLabel: 'عالية',
    validUntil: new Date().toISOString(),
    ...overrides,
  };
}

function baseCompliance(overrides: Partial<DustComplianceResult> = {}): DustComplianceResult {
  return {
    engineType: 'RIYADH_DUST_COMPLIANCE',
    engineVersion: '1.0.0',
    rulebookVersion: 'TEST-VERSION',
    regulatoryActivity: 'OTHER',
    regulatoryActivityLabelAr: 'أخرى',
    riskClass: 'CATEGORY_I_LOW',
    riskClassReasonAr: '',
    windBand: 'BELOW_15',
    isEnclosedOperation: false,
    decisionCategory: 'ALLOW',
    decisionLabelAr: 'مسموح — تشغيل اعتيادي',
    mandatoryStop: false,
    canOverride: true,
    shortReasonAr: 'لا توجد مخالفات تنظيمية ظاهرة على النشاط الحالي',
    pendingConfirmation: false,
    triggeredRules: [],
    requiredActions: [],
    restartConditions: [],
    missingCriticalInputs: [],
    monitoringObligations: [],
    confidenceScore: 95,
    confidenceLabelAr: 'عالية',
    validUntil: new Date().toISOString(),
    evidence: {
      dviScore: 40,
      dviDecision: 'RESTRICT',
      dviMandatoryStop: false,
      windSpeedKmh: 10,
      windGustKmh: 15,
      windDirectionDeg: 90,
      pm10UgM3: 20,
      pm25UgM3: 10,
      relativeHumidityPercent: 40,
      temperatureC: 30,
      visibilityM: 5000,
    },
    caveatsAr: [],
    resumeHoldApplied: false,
    ...overrides,
  } as DustComplianceResult;
}

function input(overrides: Partial<FinalDecisionInput> = {}): FinalDecisionInput {
  return {
    snapshotId: 'snap-1',
    evaluatedAt: new Date().toISOString(),
    mode: 'LIVE_OPERATIONAL',
    dvi: baseDvi(),
    compliance: baseCompliance(),
    aei: null,
    evidenceQuality: 'OK',
    ruleBundleVersion: 'TEST-VERSION',
    ...overrides,
  };
}

describe('decideFinal — invariant: لا يجوز أن يكون mandatoryStop=true وoverridable=true معاً', () => {
  it('MANDATORY_STOP من الامتثال → mandatoryStop=true وoverridable=false', () => {
    const r = decideFinal(input({ compliance: baseCompliance({ decisionCategory: 'MANDATORY_STOP', canOverride: false, mandatoryStop: true }) }));
    expect(r.mandatoryStop).toBe(true);
    expect(r.overridable).toBe(false);
    expect(r.operationalDecision).toBe('MANDATORY_STOP');
  });

  it('dvi.mandatoryStop=true وحده (بلا امتثال حاجب) → mandatoryStop=true وoverridable=false', () => {
    const r = decideFinal(input({ dvi: baseDvi({ mandatoryStop: true, overridable: false }) }));
    expect(r.mandatoryStop).toBe(true);
    expect(r.overridable).toBe(false);
    expect(r.operationalDecision).toBe('MANDATORY_STOP');
    expect(r.level).toBe('BLACK');
  });
});

describe('decideFinal — نقل سيناريوهات computeUnifiedActivityDecision القديمة', () => {
  // dvi=ALLOW صراحة هنا (بدل baseDvi() الافتراضي RESTRICT) — هذا الاختبار
  // يعزل مسار نص/قرار ALLOW_WITH_CONTROLS القادم من compliance وحده؛ القسم
  // 18.1 يجعل DVI RESTRICT يفوز بترتيب أعلى من MONITOR لو تُرك الافتراضي،
  // فيخفي ما يقيسه هذا الاختبار فعلياً.
  it('ALLOW_WITH_CONTROLS (PM10-EARLY-WARNING-007) يظهر نصه بدل نص DVI العام', () => {
    const dvi = baseDvi({ decisionCategory: 'ALLOW' });
    const compliance = baseCompliance({
      decisionCategory: 'ALLOW_WITH_CONTROLS',
      decisionLabelAr: 'مسموح مع ضوابط تحكم إضافية',
      shortReasonAr: 'تنبيه استباقي: تركيز PM10 (300 ميكروجرام/م³) يقترب من حد المخالفة (340 ميكروجرام/م³)',
    });
    const r = decideFinal(input({ dvi, compliance }));
    expect(r.shortReasonAr).toBe('تنبيه استباقي: تركيز PM10 (300 ميكروجرام/م³) يقترب من حد المخالفة (340 ميكروجرام/م³)');
    expect(r.decisionLabelAr).toBe('مسموح مع ضوابط تحكم إضافية');
    expect(r.mandatoryStop).toBe(false);
    expect(r.operationalDecision).toBe('MONITOR');
  });

  it('RESTRICT_ACTIVITY يظهر نصه الخاص → operationalDecision=RESTRICT', () => {
    const compliance = baseCompliance({
      decisionCategory: 'RESTRICT_ACTIVITY',
      decisionLabelAr: 'تقييد النشاط',
      shortReasonAr: 'سرعة الطرق غير المسفلتة (15 كم/س) تتجاوز الحد (10 كم/س)',
      canOverride: true,
    });
    const r = decideFinal(input({ compliance }));
    expect(r.shortReasonAr).toBe('سرعة الطرق غير المسفلتة (15 كم/س) تتجاوز الحد (10 كم/س)');
    expect(r.decisionLabelAr).toBe('تقييد النشاط');
    expect(r.operationalDecision).toBe('RESTRICT');
  });

  // خطأ مكتشَف ومُصلَح (مراجعة خبير خارجي — "التحقق الميداني ما زال يتحول
  // إلى مراقبة"): FIELD_VERIFICATION_REQUIRED كان يُطابَق MONITOR (نفس
  // مستوى الاحتراز العادي) رغم أن اسم الفئة نفسه يقول "يتطلب تحقق ميداني
  // قبل الاستمرار" — نفس دلالة HOLD_FOR_VERIFICATION بالضبط.
  it('FIELD_VERIFICATION_REQUIRED يظهر نصه الخاص → operationalDecision=HOLD_FOR_VERIFICATION وregulatoryFinding=NOT_DETERMINABLE', () => {
    const compliance = baseCompliance({
      decisionCategory: 'FIELD_VERIFICATION_REQUIRED',
      decisionLabelAr: 'يتطلب تحقق ميداني قبل الاستمرار',
      shortReasonAr: 'لم يتم تحديد نقطة دخول المشروع على الخريطة',
    });
    const r = decideFinal(input({ compliance }));
    expect(r.shortReasonAr).toBe('لم يتم تحديد نقطة دخول المشروع على الخريطة');
    expect(r.decisionLabelAr).toBe('يتطلب تحقق ميداني قبل الاستمرار');
    expect(r.operationalDecision).toBe('HOLD_FOR_VERIFICATION');
    expect(r.regulatoryFinding).toBe('NOT_DETERMINABLE');
    expect(r.mandatoryStop).toBe(false);
  });

  // القسم 18.1 من "دليل الإصلاح الجذري لمنظومة مرقاب": DVI RESTRICT +
  // Compliance ALLOW → RESTRICT مباشرة (لا MONITOR) — baseDvi() الافتراضي
  // decisionCategory='RESTRICT' تحديداً.
  it('امتثال ALLOW نظيف مع DVI RESTRICT → يبقى نص DVI كما هو وoperationalDecision=RESTRICT (القسم 18.1)', () => {
    const r = decideFinal(input());
    expect(r.shortReasonAr).toBe(baseDvi().shortReason);
    expect(r.decisionLabelAr).toBe(baseDvi().decisionLabelAr);
    expect(r.operationalDecision).toBe('RESTRICT');
  });
});

// القسم 18.1 من "دليل الإصلاح الجذري لمنظومة مرقاب" (مصفوفة اختبارات
// القبول): STOP_DUST_GENERATING_ACTIVITIES/STOP_VISIBILITY_DEPENDENT_
// ACTIVITIES → PROTECTIVE_STOP (غير إلزامي)، لا MONITOR. الإصلاح الجزئي
// السابق (مراجعة كود خبير خارجي — منع سقوطهما لـALLOW) كان يطابقهما
// MONITOR وحده، معتمداً على محرك امتثال منفصل ليكتشف نفس الخطر الفيزيائي
// الذي رصده DVI بالفعل قبل أن يُنتج تقييداً حقيقياً — تناقض مباشر مع جدول
// 18.1 الذي يطلب PROTECTIVE_STOP مباشرة من DVI نفسه، بلا انتظار compliance.
// applyMandatoryGates في dust-engine/engine.ts تبدأ decision=baseDecision
// (من baseDecisionFromLevel عند level=RED/DARK_RED/BLACK لنشاط غبار/رؤية) —
// إن لم يُفعِّل أي فرع لاحق mandatoryStop=true صراحة (ذلك يحدث فقط من بوابات
// صريحة كرؤية<0.5كم أو PM10>340 أو رياح≥55)، فـdvi.mandatoryStop تبقى false
// بينما dvi.decisionCategory تبقى STOP_* فعلياً — خطر فيزيائي حقيقي غير
// إلزامي بعد، تماماً ما يصفه PROTECTIVE_STOP.
describe('decideFinal — STOP_DUST_GENERATING_ACTIVITIES/STOP_VISIBILITY_DEPENDENT_ACTIVITIES بلا mandatoryStop', () => {
  it('dvi.decisionCategory=STOP_DUST_GENERATING_ACTIVITIES مع mandatoryStop=false + compliance=ALLOW → operationalDecision=PROTECTIVE_STOP (القسم 18.1)', () => {
    const dvi = baseDvi({
      decisionCategory: 'STOP_DUST_GENERATING_ACTIVITIES',
      decisionLabelAr: 'إيقاف الأعمال المثيرة للغبار',
      level: 'RED',
      mandatoryStop: false,
      overridable: true,
      shortReason: 'إيقاف الأعمال المثيرة للغبار (حفر/ردم/دمك/تسوية/نقل تربة) حتى تحسن الظروف',
    });
    const r = decideFinal(input({ dvi }));

    expect(r.operationalDecision).toBe('PROTECTIVE_STOP');
    expect(r.mandatoryStop).toBe(false);
    expect(r.operationalDecision).not.toBe('ALLOW');
  });

  it('dvi.decisionCategory=STOP_VISIBILITY_DEPENDENT_ACTIVITIES مع mandatoryStop=false + compliance=ALLOW → operationalDecision=PROTECTIVE_STOP (القسم 18.1)', () => {
    const dvi = baseDvi({
      decisionCategory: 'STOP_VISIBILITY_DEPENDENT_ACTIVITIES',
      decisionLabelAr: 'إيقاف الأنشطة المعتمدة على الرؤية',
      level: 'RED',
      mandatoryStop: false,
      overridable: true,
      shortReason: 'إيقاف الأنشطة المعتمدة على الرؤية حتى تحسن الظروف',
    });
    const r = decideFinal(input({ dvi }));

    expect(r.operationalDecision).toBe('PROTECTIVE_STOP');
    expect(r.mandatoryStop).toBe(false);
    expect(r.operationalDecision).not.toBe('ALLOW');
  });

  it('لا قرار امتثال إطلاقاً (null) → يبقى نص DVI كما هو، regulatoryFinding=COMPLIANT (فشل آمن)', () => {
    const r = decideFinal(input({ compliance: null }));
    expect(r.shortReasonAr).toBe(baseDvi().shortReason);
    expect(r.regulatoryFinding).toBe('COMPLIANT');
  });

  it('DVI نفسه mandatoryStop حتى مع امتثال غير حاجب → يبقى إيقاف إلزامي BLACK', () => {
    const compliance = baseCompliance({
      decisionCategory: 'ALLOW_WITH_CONTROLS',
      decisionLabelAr: 'مسموح مع ضوابط تحكم إضافية',
      shortReasonAr: 'تحذير: تركيز PM10 (260) تجاوز حد التحذير (250)',
    });
    const r = decideFinal(input({ dvi: baseDvi({ mandatoryStop: true, overridable: false }), compliance }));
    expect(r.mandatoryStop).toBe(true);
    expect(r.decisionLabelAr).toBe('إيقاف إلزامي نظامي');
    expect(r.level).toBe('BLACK');
  });

  it('امتثال يحجب (MANDATORY_STOP) → NON_COMPLIANT وmandatoryStop=true', () => {
    const compliance = baseCompliance({
      decisionCategory: 'MANDATORY_STOP',
      decisionLabelAr: 'إيقاف إلزامي غير قابل للتجاوز',
      shortReasonAr: 'مسافة الكسارة عن سكني أقل من الحد الأدنى (500 م)',
      canOverride: false,
      mandatoryStop: true,
    });
    const r = decideFinal(input({ compliance }));
    expect(r.decisionLabelAr).toBe('إيقاف إلزامي نظامي');
    expect(r.shortReasonAr).toBe('مسافة الكسارة عن سكني أقل من الحد الأدنى (500 م)');
    expect(r.mandatoryStop).toBe(true);
    expect(r.level).toBe('BLACK');
    expect(r.pendingConfirmation).toBe(false);
    expect(r.regulatoryFinding).toBe('NON_COMPLIANT');
  });

  it('امتثال يحجب لكنه معلَّق فقط (pendingConfirmation=true) → PROTECTIVE_STOP لا MANDATORY_STOP، regulatoryFinding=PENDING_CONFIRMATION', () => {
    const compliance = baseCompliance({
      decisionCategory: 'STOP_AFFECTED_ACTIVITY',
      decisionLabelAr: 'إيقاف النشاط المتأثر',
      shortReasonAr:
        'تعليق مؤقت (معلَّق): تركيز PM10 (345 ميكروجرام/م³) تجاوز حد المخالفة (340 ميكروجرام/م³) — بانتظار استمرار القراءة أكثر من دقيقتين لتصنيفها مخالفة تنظيمية مؤكدة',
      pendingConfirmation: true,
      canOverride: false,
    });
    const r = decideFinal(input({ compliance }));
    expect(r.decisionLabelAr).not.toBe('إيقاف إلزامي نظامي');
    expect(r.pendingConfirmation).toBe(true);
    expect(r.operationalDecision).toBe('PROTECTIVE_STOP');
    expect(r.regulatoryFinding).toBe('PENDING_CONFIRMATION');
    expect(r.mandatoryStop).toBe(false);
    expect(r.overridable).toBe(false); // معلَّق يبقى غير قابل للتجاوز رغم عدم كونه قطعياً
  });

  // خطأ مكتشَف ومُصلَح (مراجعة كود مدير — "FinalDecisionEngine يعيد الخطأ
  // بعد أن يصححه محرك الامتثال"): عينة PM10 لحظية واحدة (>340، بلا استمرار
  // مُثبَت بعد) تجعل dust-engine يضبط dvi.mandatoryStop=true (DVI-DUST-
  // ACTIVITY-STOP-004-PM10-ONLY) — خطر لحظي لا فيزيائي حقيقي. محرك الامتثال
  // (GATE-DVI-002 بdust-compliance-engine) يقرأ هذا ويحوّله بنفسه لـ
  // STOP_AFFECTED_ACTIVITY معلَّق (pendingConfirmation=true)، مصحِّحاً الخطأ.
  // لكن decideFinal كان (قبل الإصلاح) يقرأ dvi.mandatoryStop الخام مباشرة
  // بمعزل عن ذلك التصحيح، فيعيد ترقيتها لـmandatoryStop=true/MANDATORY_STOP
  // رغم regulatoryFinding=PENDING_CONFIRMATION في نفس النتيجة — تناقض مباشر
  // بين حقلين في نفس الكائن. هذا الاختبار هو التركيبة المحدَّدة (dvi.mandatoryStop=true
  // معاً مع compliance.pendingConfirmation=true) التي لم تكن مُختبَرة سابقاً
  // (الاختبار أعلاه يستخدم dvi.mandatoryStop=false الافتراضي).
  it('dvi.mandatoryStop=true (PM10 لحظي فقط) + compliance معلَّق (pendingConfirmation=true) → لا يُعاد ترقيته إلى MANDATORY_STOP، يبقى PROTECTIVE_STOP متسقاً مع PENDING_CONFIRMATION', () => {
    const compliance = baseCompliance({
      decisionCategory: 'STOP_AFFECTED_ACTIVITY',
      decisionLabelAr: 'إيقاف النشاط المتأثر',
      shortReasonAr:
        'تعليق مؤقت (معلَّق): تركيز PM10 (345 ميكروجرام/م³) تجاوز حد المخالفة (340 ميكروجرام/م³) — بانتظار استمرار القراءة أكثر من دقيقتين لتصنيفها مخالفة تنظيمية مؤكدة',
      pendingConfirmation: true,
      canOverride: false,
    });
    const dvi = baseDvi({ mandatoryStop: true, overridable: false });
    const r = decideFinal(input({ dvi, compliance }));

    // لا تناقض بين operationalDecision وregulatoryFinding وmandatoryStop.
    expect(r.mandatoryStop).toBe(false);
    expect(r.operationalDecision).toBe('PROTECTIVE_STOP');
    expect(r.regulatoryFinding).toBe('PENDING_CONFIRMATION');
    expect(r.decisionLabelAr).not.toBe('إيقاف إلزامي نظامي');
    expect(r.level).toBe('RED'); // معلَّق = أحمر، لا أسود (مؤكَّد)
  });

  // تغطية صريحة لسيناريو راجعه خبير خارجي: هل decisionCategory='MANDATORY_STOP'
  // تحديداً (لا فقط STOP_AFFECTED_ACTIVITY) مع pendingConfirmation=true من
  // محرك الامتثال يمكن أن ينتج mandatoryStop=true معاً مع regulatoryFinding=
  // PENDING_CONFIRMATION؟ complianceBlocks (سطر 64) يضم الفئتين معاً عمداً —
  // "الحقل (pendingConfirmation) هو الحاسم، لا الفئة" (راجع تعليق confirmedAffectedStop
  // أعلاه) — فحتى MANDATORY_STOP معلَّقة تُعامَل كـpendingAffectedStop، لا
  // confirmedAffectedStop. هذا الاختبار يثبت أن التناقض المزعوم
  // (MANDATORY_STOP + PENDING_CONFIRMATION + mandatoryStop=true معاً) غير
  // ممكن فعلياً في الكود الحالي — كان نظرياً فقط في تعليق الكود (سطر 138)
  // قبل هذا الاختبار المباشر.
  it('compliance.decisionCategory=MANDATORY_STOP لكن pendingConfirmation=true → لا تناقض: يُعامَل كمعلَّق (PROTECTIVE_STOP)، لا mandatoryStop=true قطعي', () => {
    const compliance = baseCompliance({
      decisionCategory: 'MANDATORY_STOP',
      decisionLabelAr: 'إيقاف إلزامي غير قابل للتجاوز',
      shortReasonAr: 'تعليق مؤقت (معلَّق): تركيز PM10 تجاوز حد المخالفة — بانتظار استمرار القراءة',
      pendingConfirmation: true,
      canOverride: false,
    });
    const r = decideFinal(input({ compliance }));

    expect(r.mandatoryStop).toBe(false);
    expect(r.operationalDecision).toBe('PROTECTIVE_STOP');
    expect(r.regulatoryFinding).toBe('PENDING_CONFIRMATION');
    expect(r.pendingConfirmation).toBe(true);
    expect(r.decisionLabelAr).not.toBe('إيقاف إلزامي نظامي');
    expect(r.level).toBe('RED');
  });

  // خطر فيزيائي حقيقي غير PM10 (رؤية حرجة) لا يُنتج pendingAffectedStop
  // أصلاً (محرك الامتثال لا يعامله كمعلَّق) — الإصلاح أعلاه لا يجوز أن يمسّه:
  // يبقى إيقافاً فورياً قطعياً كما كان دائماً، بلا انتظار أي تأكيد.
  it('dvi.mandatoryStop=true بسبب خطر فيزيائي حقيقي (لا PM10 لحظي) + امتثال غير معلَّق → يبقى MANDATORY_STOP فورياً كالسابق تماماً', () => {
    const compliance = baseCompliance({
      decisionCategory: 'ALLOW_WITH_CONTROLS',
      decisionLabelAr: 'مسموح مع ضوابط تحكم إضافية',
      pendingConfirmation: false,
    });
    const dvi = baseDvi({ mandatoryStop: true, overridable: false, shortReason: 'رؤية حرجة أقل من 500م' });
    const r = decideFinal(input({ dvi, compliance }));

    expect(r.mandatoryStop).toBe(true);
    expect(r.operationalDecision).toBe('MANDATORY_STOP');
    expect(r.decisionLabelAr).toBe('إيقاف إلزامي نظامي');
    expect(r.level).toBe('BLACK');
  });

  // STOP_AFFECTED_ACTIVITY مؤكَّد (pendingConfirmation=false) يُعامَل بنفس
  // قوة MANDATORY_STOP تماماً — canOverride=false محسوبة فعلياً لكلتا
  // الحالتين في dust-compliance-engine/engine.ts، فلا فرق في قوة الإلزام.
  it('STOP_AFFECTED_ACTIVITY مؤكَّد (pendingConfirmation=false) → MANDATORY_STOP وNON_COMPLIANT (نفس قوة MANDATORY_STOP)', () => {
    const compliance = baseCompliance({
      decisionCategory: 'STOP_AFFECTED_ACTIVITY',
      decisionLabelAr: 'إيقاف النشاط المتأثر',
      shortReasonAr: 'إيقاف الأنشطة المكشوفة المولّدة للغبار: سرعة الرياح تتجاوز 25 كم/س',
      pendingConfirmation: false,
      canOverride: false,
    });
    const r = decideFinal(input({ compliance }));
    expect(r.operationalDecision).toBe('MANDATORY_STOP');
    expect(r.mandatoryStop).toBe(true);
    expect(r.overridable).toBe(false);
    expect(r.level).toBe('BLACK');
    expect(r.decisionLabelAr).toBe('إيقاف إلزامي نظامي');
    expect(r.regulatoryFinding).toBe('NON_COMPLIANT');
    expect(r.pendingConfirmation).toBe(false);
  });
});

describe('decideFinal — evidenceQuality وHOLD_FOR_VERIFICATION', () => {
  it('UNAVAILABLE في LIVE_OPERATIONAL → HOLD_FOR_VERIFICATION وNOT_DETERMINABLE', () => {
    const r = decideFinal(input({ evidenceQuality: 'UNAVAILABLE', mode: 'LIVE_OPERATIONAL' }));
    expect(r.operationalDecision).toBe('HOLD_FOR_VERIFICATION');
    expect(r.regulatoryFinding).toBe('NOT_DETERMINABLE');
  });

  it('UNAVAILABLE في PLANNING → لا يُطلَب تحقق ميداني (لا "الآن" لتحقق ميداني منه)', () => {
    const r = decideFinal(input({ evidenceQuality: 'UNAVAILABLE', mode: 'PLANNING' }));
    expect(r.operationalDecision).not.toBe('HOLD_FOR_VERIFICATION');
  });

  it('mandatoryStop يفوز حتى مع evidenceQuality=UNAVAILABLE (خطر فيزيائي فوري لا ينتظر تحقق بيانات)', () => {
    const r = decideFinal(input({ dvi: baseDvi({ mandatoryStop: true, overridable: false }), evidenceQuality: 'UNAVAILABLE' }));
    expect(r.operationalDecision).toBe('MANDATORY_STOP');
  });

  it('PARTIAL لا يُصعِّد لـHOLD_FOR_VERIFICATION (نقص بيانات غير حرج، لا قِدم فعلي)', () => {
    const partial = decideFinal(input({ evidenceQuality: 'PARTIAL' }));
    expect(partial.operationalDecision).not.toBe('HOLD_FOR_VERIFICATION');
  });

  // خطأ مكتشَف ومُصلَح (مراجعة كود خبير خارجي — "القراءة القديمة ما زالت
  // تنتج ALLOW أو STOP حيًا"): كان STALE مستثناة عمداً من هذا التصعيد
  // (بطلب سابق) — قراءة جهاز أقدم من عتبة الحداثة كانت تُعرَض بتحذير قِدم
  // في الواجهة فقط، بينما القرار التشغيلي الفعلي (ALLOW/RESTRICT/MANDATORY_
  // STOP) يستمر يُحسَب منها بثقة كاملة. عُكس صراحة الآن: STALE تُعامَل
  // معاملة UNAVAILABLE تماماً.
  it('STALE في LIVE_OPERATIONAL → HOLD_FOR_VERIFICATION وNOT_DETERMINABLE (لا يُستخدَم القرار الحي من قراءة قديمة)', () => {
    const stale = decideFinal(input({ evidenceQuality: 'STALE', mode: 'LIVE_OPERATIONAL' }));
    expect(stale.operationalDecision).toBe('HOLD_FOR_VERIFICATION');
    expect(stale.regulatoryFinding).toBe('NOT_DETERMINABLE');
    expect(stale.decisionLabelAr).not.toBe('مسموح — تشغيل اعتيادي');
  });

  it('STALE في PLANNING → لا يُطلَب تحقق ميداني (نفس استثناء UNAVAILABLE في وضع التوقّع)', () => {
    const stale = decideFinal(input({ evidenceQuality: 'STALE', mode: 'PLANNING' }));
    expect(stale.operationalDecision).not.toBe('HOLD_FOR_VERIFICATION');
  });

  it('mandatoryStop يفوز حتى مع evidenceQuality=STALE (خطر فيزيائي فوري لا ينتظر تحقق بيانات)', () => {
    const r = decideFinal(
      input({ dvi: baseDvi({ mandatoryStop: true, overridable: false }), evidenceQuality: 'STALE' })
    );
    expect(r.operationalDecision).toBe('MANDATORY_STOP');
  });

  it('HOLD_FOR_VERIFICATION يعرض نصاً/لوناً محايدَين (ORANGE)، لا نص/لون DVI أو الامتثال المحسوب من نفس البيانات القديمة', () => {
    const r = decideFinal(
      input({
        dvi: baseDvi({ decisionCategory: 'ALLOW', level: 'GREEN' }),
        evidenceQuality: 'STALE',
      })
    );
    expect(r.level).toBe('ORANGE');
    expect(r.shortReasonAr).toContain('تحقق ميداني');
  });
});

// اختبارا قبول صريحان (طلب المستخدم — تقرير المراجعة الخارجي: "إيقاف مبني
// على PM10 قديم يتغلب على HOLD"). راجع تعليق dviStopIsPm10StaleOnly الكامل
// في engine.ts للسبب: mandatoryStop يُضبَط false بنجاح لقراءة PM10 لحظية
// قديمة (dust-engine/engine.ts)، لكن decisionCategory يبقى STOP_DUST_
// GENERATING_ACTIVITIES رغم ذلك — وdviCandidate كان يُطابِقها PROTECTIVE_STOP
// (رتبة 4) بلا فحص حداثة خاص، فيتغلب على HOLD_FOR_VERIFICATION (رتبة 3).
describe('decideFinal — إيقاف DVI مبني على PM10 لحظي قديم لا يتغلب على HOLD_FOR_VERIFICATION', () => {
  it('PM10=500 بعمر 5 دقائق (قديم) وحده، بلا أي خطر فيزيائي مستقل → HOLD_FOR_VERIFICATION، لا PROTECTIVE_STOP', () => {
    const dvi = baseDvi({
      decisionCategory: 'STOP_DUST_GENERATING_ACTIVITIES',
      mandatoryStop: false,
      overridable: true,
      stopBasis: 'NONE',
      confirmationState: 'NOT_APPLICABLE',
      triggeredRules: ['DVI-DUST-ACTIVITY-STOP-004', 'DVI-DUST-ACTIVITY-STOP-004-PM10-ONLY', 'DVI-DUST-ACTIVITY-STOP-004-PM10-STALE'],
      shortReason: 'تركيز PM10 = 500 (قراءة قديمة)',
    });
    const compliance = baseCompliance({ decisionCategory: 'ALLOW', pendingConfirmation: false });
    const r = decideFinal(input({ dvi, compliance, evidenceQuality: 'STALE', mode: 'LIVE_OPERATIONAL' }));

    expect(r.operationalDecision).toBe('HOLD_FOR_VERIFICATION');
    expect(r.operationalDecision).not.toBe('PROTECTIVE_STOP');
    expect(r.mandatoryStop).toBe(false);
    expect(r.regulatoryFinding).toBe('NOT_DETERMINABLE');
  });

  it('PM10 قديم + رؤية حية 499م (خطر مستقل حقيقي) → يبقى الإيقاف الإلزامي بسبب الرؤية', () => {
    const dvi = baseDvi({
      decisionCategory: 'STOP_VISIBILITY_DEPENDENT_ACTIVITIES',
      mandatoryStop: true,
      overridable: false,
      stopBasis: 'MIXED',
      confirmationState: 'CONFIRMED',
      visibilityKm: 0.499,
      mandatoryVisibilityStop: true,
      // الرؤية الحرجة (DVI-VISIBILITY-MANDATORY-STOP-001) ورؤية PM10 اللحظي
      // القديم مساهمان معاً بنفس اللحظة — dviHasIndependentPhysicalHazard
      // يجب أن يكتشف قاعدة الرؤية ويرفض تخفيف dviCandidate رغم وجود
      // PM10-STALE أيضاً بين triggeredRules.
      triggeredRules: [
        'DVI-VISIBILITY-MANDATORY-STOP-001',
        'DVI-DUST-ACTIVITY-STOP-004',
        'DVI-DUST-ACTIVITY-STOP-004-PM10-ONLY',
        'DVI-DUST-ACTIVITY-STOP-004-PM10-STALE',
      ],
      shortReason: 'رؤية حرجة أقل من 500م',
    });
    const compliance = baseCompliance({ decisionCategory: 'ALLOW', pendingConfirmation: false });
    const r = decideFinal(input({ dvi, compliance, evidenceQuality: 'STALE', mode: 'LIVE_OPERATIONAL' }));

    expect(r.operationalDecision).toBe('MANDATORY_STOP');
    expect(r.mandatoryStop).toBe(true);
    expect(r.overridable).toBe(false);
  });
});

describe('decideFinal — reasonCodes وsnapshotId وruleBundleVersion', () => {
  it('reasonCodes يجمع رموز DVI والامتثال معاً', () => {
    const compliance = baseCompliance({
      decisionCategory: 'RESTRICT_ACTIVITY',
      triggeredRules: [{ code: 'SITE-TRAFFIC-SPEED-001', severity: 'RESTRICT_ACTIVITY', messageAr: '', actionAr: '' }],
    });
    const r = decideFinal(input({ dvi: baseDvi({ triggeredRules: ['DVI-PM10-ACTION-003'] }), compliance }));
    expect(r.reasonCodes).toContain('DVI-PM10-ACTION-003');
    expect(r.reasonCodes).toContain('SITE-TRAFFIC-SPEED-001');
  });

  it('snapshotId وmode وruleBundleVersion تُنقَل حرفياً من المدخل', () => {
    const r = decideFinal(input({ snapshotId: 'snap-xyz', mode: 'PLANNING', ruleBundleVersion: 'V-42' }));
    expect(r.snapshotId).toBe('snap-xyz');
    expect(r.mode).toBe('PLANNING');
    expect(r.ruleBundleVersion).toBe('V-42');
  });

  it('النتيجة مجمَّدة (Object.freeze) — لا يمكن تعديلها بعد الإرجاع', () => {
    const r = decideFinal(input());
    expect(Object.isFrozen(r)).toBe(true);
  });
});

describe('decideFinal — ALLOW نظيف', () => {
  it('DVI وامتثال كلاهما ALLOW → operationalDecision=ALLOW، regulatoryFinding=COMPLIANT', () => {
    const r = decideFinal(input({ dvi: baseDvi({ decisionCategory: 'ALLOW', mandatoryStop: false, overridable: true }) }));
    expect(r.operationalDecision).toBe('ALLOW');
    expect(r.regulatoryFinding).toBe('COMPLIANT');
    expect(r.mandatoryStop).toBe(false);
    expect(r.level).toBe('ORANGE'); // dvi.level يبقى كما هو، لا يوجد floor لأن compliance=ALLOW
  });
});

// =====================================================================
// طلب مستخدم صريح (اكتشاف عبر الواجهة — نشاط PLANNING بعيد بقيمة PM10
// توقّعية مرتفعة جداً/غير واقعية (2041.5) كان لا يزال يظهر "إيقاف إلزامي
// نظامي" أسود، رغم أن buildPlanningForecastResult في dust-compliance-engine
// يُرجع ALLOW دائماً بالفعل): dvi.mandatoryStop مصدره محرك DVI المستقل
// تماماً عن محرك الامتثال — كان يفوز هنا بصرف النظر عن mode، فلا يكفي
// إصلاح جانب الامتثال وحده. الفرع المبكر (mode === 'PLANNING') في أول
// decideFinal يحسم هذا نهائياً: النتيجة دائماً ALLOW/GREEN محايدة مهما بلغت
// شدة dvi/compliance المُدخَلة، بلا استثناءات متفرقة قد تُنسى مستقبلاً.
// =====================================================================
describe('decideFinal — PLANNING: لا قرار إلزامي أبداً مهما كانت شدة التوقّع', () => {
  it('dvi.mandatoryStop=true (PM10 توقّعي مرتفع جداً) + mode=PLANNING → mandatoryStop=false, level=GREEN, operationalDecision=ALLOW', () => {
    const dvi = baseDvi({
      decisionCategory: 'MANDATORY_STOP',
      level: 'BLACK',
      mandatoryStop: true,
      overridable: false,
      shortReason: 'PM10 = 2041.5',
    });
    const compliance = baseCompliance({
      decisionCategory: 'MANDATORY_STOP',
      mandatoryStop: true,
      canOverride: false,
      pendingConfirmation: false,
    });
    const r = decideFinal(input({ mode: 'PLANNING', dvi, compliance }));

    // dvi.decisionCategory=MANDATORY_STOP ليست ALLOW/ALLOW_WITH_MONITORING
    // → "لا تصلح" → أصفر/MONITOR (لا إيقاف إلزامي فعلي، لكن اللون يعكس
    // التحذير بدل أخضر ثابت رغم النص — راجع تعليق decideFinal الكامل).
    expect(r.mandatoryStop).toBe(false);
    expect(r.overridable).toBe(true);
    expect(r.level).toBe('YELLOW');
    expect(r.operationalDecision).toBe('MONITOR');
    expect(r.regulatoryFinding).toBe('COMPLIANT');
    expect(r.pendingConfirmation).toBe(false);
    expect(r.shortReasonAr).toContain('توقّعات طقس');
    expect(r.shortReasonAr).toContain('لا تصلح للنشاط');
  });

  it('dvi.decisionCategory=ALLOW + mode=PLANNING → نص "تصلح للنشاط" (لا "لا تصلح")', () => {
    const dvi = baseDvi({ decisionCategory: 'ALLOW', level: 'GREEN', mandatoryStop: false, overridable: true });
    const r = decideFinal(input({ mode: 'PLANNING', dvi }));

    expect(r.mandatoryStop).toBe(false);
    expect(r.level).toBe('GREEN');
    expect(r.shortReasonAr).toContain('تصلح للنشاط');
    expect(r.shortReasonAr).not.toContain('لا تصلح للنشاط');
  });

  it('mode=LIVE_OPERATIONAL بنفس مدخلات PM10 المرتفعة → يبقى إيقافاً إلزامياً حقيقياً (لا تراجع عن السلوك الأصلي)', () => {
    const dvi = baseDvi({ decisionCategory: 'MANDATORY_STOP', level: 'BLACK', mandatoryStop: true, overridable: false });
    const r = decideFinal(input({ mode: 'LIVE_OPERATIONAL', dvi }));

    expect(r.mandatoryStop).toBe(true);
    expect(r.level).toBe('BLACK');
  });

  // خطأ مكتشَف ومُصلَح — طلب صريح من المستخدم: "ليه ما يقول تنبيه استباقي
  // الأجواء غير المناسبة... اتوقع انه يستثني قاعدة PM10". قبل هذا الإصلاح،
  // dvi.decisionCategory=ALLOW (رياح/رؤية فيزيائية جيدة) كان يكفي وحده
  // لإظهار "مسموح — تشغيل اعتيادي" في وضع PLANNING، حتى لو كان تركيز PM10
  // المتوقّع (compliance.evidence.pm10UgM3) ضخماً جداً (أكبر من حد المخالفة
  // 340 بأضعاف) — لا خاص بنشاط معيّن (محطة الخلط)، بل لكل الأنشطة في وضع
  // PLANNING على حد سواء.
  it('dvi.decisionCategory=ALLOW لكن compliance.evidence.pm10UgM3 مرتفع جداً + mode=PLANNING → "لا تصلح" أصفر، لا "مسموح" أخضر', () => {
    const dvi = baseDvi({ decisionCategory: 'ALLOW', level: 'GREEN', mandatoryStop: false, overridable: true });
    const compliance = baseCompliance({
      evidence: { ...baseCompliance().evidence, pm10UgM3: 1315 },
    });
    const r = decideFinal(input({ mode: 'PLANNING', dvi, compliance }));

    expect(r.operationalDecision).toBe('MONITOR');
    expect(r.level).toBe('YELLOW');
    expect(r.decisionLabelAr).toBe('تنبيه: أجواء متوقعة غير مناسبة');
    expect(r.shortReasonAr).toContain('1315');
    expect(r.shortReasonAr).toContain('تركيز الغبار');
    expect(r.mandatoryStop).toBe(false); // لا إيقاف إلزامي فعلي على تقدير، مهما بلغت القيمة
  });

  it('dvi.decisionCategory=ALLOW وpm10UgM3 تحت حد التحذير (251) + mode=PLANNING → يبقى "مسموح" أخضر', () => {
    const dvi = baseDvi({ decisionCategory: 'ALLOW', level: 'GREEN', mandatoryStop: false, overridable: true });
    const compliance = baseCompliance({
      evidence: { ...baseCompliance().evidence, pm10UgM3: 100 },
    });
    const r = decideFinal(input({ mode: 'PLANNING', dvi, compliance }));

    expect(r.operationalDecision).toBe('ALLOW');
    expect(r.level).toBe('GREEN');
    expect(r.decisionLabelAr).toBe('مسموح — تشغيل اعتيادي');
  });

  it('compliance غائب تماماً (undefined) + dvi.decisionCategory=ALLOW → يبقى "مسموح" (فشل آمن، لا افتراض PM10 مرتفع بلا دليل)', () => {
    const dvi = baseDvi({ decisionCategory: 'ALLOW', level: 'GREEN', mandatoryStop: false, overridable: true });
    const r = decideFinal(input({ mode: 'PLANNING', dvi, compliance: null }));

    expect(r.operationalDecision).toBe('ALLOW');
    expect(r.level).toBe('GREEN');
  });
});

describe('decideFinal — نشاط مغلق فعلياً وامتثاله نظيف يُخفي تنبيه مراقبة DVI مصدره الرياح فقط', () => {
  it('DVI يُظهر ALLOW_WITH_MONITORING (رياح) لكن isEnclosedOperation=true وcompliance=ALLOW → operationalDecision=ALLOW وlevel=GREEN', () => {
    const compliance = baseCompliance({ decisionCategory: 'ALLOW', isEnclosedOperation: true });
    const dvi = baseDvi({ decisionCategory: 'ALLOW_WITH_MONITORING', level: 'YELLOW', decisionLabelAr: 'تشغيل مع المراقبة', mandatoryStop: false });
    const r = decideFinal(input({ dvi, compliance }));
    expect(r.operationalDecision).toBe('ALLOW');
    expect(r.level).toBe('GREEN');
    expect(r.decisionLabelAr).toBe('مسموح — تشغيل اعتيادي');
  });

  it('نفس الحالة لكن dvi.mandatoryStop=true (رؤية حرجة مثلاً) → لا يُقمَع، يبقى إيقافاً إلزامياً', () => {
    const compliance = baseCompliance({ decisionCategory: 'ALLOW', isEnclosedOperation: true });
    const dvi = baseDvi({ mandatoryStop: true, overridable: false });
    const r = decideFinal(input({ dvi, compliance }));
    expect(r.operationalDecision).toBe('MANDATORY_STOP');
    expect(r.level).toBe('BLACK');
  });

  it('isEnclosedOperation=false → لا قمع، يبقى قرار DVI كما هو', () => {
    const compliance = baseCompliance({ decisionCategory: 'ALLOW', isEnclosedOperation: false });
    const dvi = baseDvi({ decisionCategory: 'ALLOW_WITH_MONITORING', level: 'YELLOW', decisionLabelAr: 'تشغيل مع المراقبة', mandatoryStop: false });
    const r = decideFinal(input({ dvi, compliance }));
    expect(r.operationalDecision).toBe('MONITOR');
    expect(r.level).toBe('YELLOW');
    expect(r.decisionLabelAr).toBe('تشغيل مع المراقبة');
  });

  // خطأ حرج مكتشَف ومُصلَح (مراجعة كود خبير خارجي — "عند اعتبار العملية
  // مغلقة، قد يُلغى خطأً تقييد شديد أو إيقاف متعلق بالرؤية ويصدر ALLOW"):
  // suppressDviMonitoring كان يفحص فقط compliance.isEnclosedOperation
  // وcompliance.decisionCategory==='ALLOW' — بلا أي فحص لـdvi.decisionCategory
  // إطلاقاً. الاختبار الأقدم ("نفس الحالة لكن dvi.mandatoryStop=true") كان
  // يثبت فقط أن mandatoryStop=true (بوابة صريحة كرؤية<0.5كم) لا يُقمَع — لكن
  // RESTRICT_SEVERE (رؤية<1كم، بلا الوصول لحد mandatoryStop الصريح بعد) لم
  // يكن مختبَراً، وهو بالضبط ما وصفه الخبير. الإصلاح: القمع الآن مقصور على
  // dvi.decisionCategory==='ALLOW_WITH_MONITORING' تحديداً (القصد الأصلي —
  // راجع عنوان describe أعلى هذا الملف)، لا أي قرار DVI آخر.
  // القسم 18.1: RESTRICT_SEVERE → RESTRICT مباشرة (بدل MONITOR) بعد إصلاح
  // dviCandidate — الاختبار يبقى يثبت "لا قمع" (ليس ALLOW)، فقط القيمة
  // المتوقعة تغيّرت لتطابق 18.1.
  it('DVI=RESTRICT_SEVERE بسبب رؤية حرجة (لا رياح) + isEnclosedOperation=true وcompliance=ALLOW → لا يُقمَع، يبقى RESTRICT (القسم 18.1)', () => {
    const compliance = baseCompliance({ decisionCategory: 'ALLOW', isEnclosedOperation: true });
    const dvi = baseDvi({
      decisionCategory: 'RESTRICT_SEVERE',
      level: 'RED',
      decisionLabelAr: 'تقييد شديد — رؤية حرجة',
      mandatoryStop: false,
      shortReason: 'رؤية حرجة (أقل من 1 كم) — منع بدء رفع جديد ومنع الرفع المعقد',
    });
    const r = decideFinal(input({ dvi, compliance }));

    expect(r.operationalDecision).toBe('RESTRICT');
    expect(r.operationalDecision).not.toBe('ALLOW');
    expect(r.level).toBe('RED');
    expect(r.decisionLabelAr).toBe('تقييد شديد — رؤية حرجة');
  });

  it('DVI=STOP_VISIBILITY_DEPENDENT_ACTIVITIES + isEnclosedOperation=true وcompliance=ALLOW → لا يُقمَع، يبقى PROTECTIVE_STOP (القسم 18.1)', () => {
    const compliance = baseCompliance({ decisionCategory: 'ALLOW', isEnclosedOperation: true });
    const dvi = baseDvi({
      decisionCategory: 'STOP_VISIBILITY_DEPENDENT_ACTIVITIES',
      level: 'RED',
      decisionLabelAr: 'إيقاف الأنشطة المعتمدة على الرؤية',
      mandatoryStop: false,
      shortReason: 'إيقاف الأنشطة المعتمدة على الرؤية حتى تحسن الظروف',
    });
    const r = decideFinal(input({ dvi, compliance }));

    expect(r.operationalDecision).toBe('PROTECTIVE_STOP');
    expect(r.operationalDecision).not.toBe('ALLOW');
    expect(r.level).toBe('RED');
  });
});

describe('decideFinal — PRECAUTION يرفع الحد الأدنى للون دون تقييد الدرجة', () => {
  it('PRECAUTION مع DVI أخضر → level يُرفَع لأصفر كحد أدنى', () => {
    const compliance = baseCompliance({
      decisionCategory: 'PRECAUTION',
      shortReasonAr: 'حالة احتراز: تركيز PM10 ضمن نطاق الإنذار المبكر',
    });
    const r = decideFinal(input({ dvi: baseDvi({ level: 'GREEN', decisionCategory: 'ALLOW' }), compliance }));
    expect(r.level).toBe('YELLOW');
    expect(r.operationalDecision).toBe('MONITOR');
  });
});

// خطأ مكتشَف (مراجعة خبير خارجي — البند 2: "سبب القرار المعروض لا يرتبط
// دائمًا بالمرشح الفائز"): complianceIsDecisive كان يعتمد فقط على
// compliance.decisionCategory !== 'ALLOW' بصرف النظر تماماً عن أي مرشح فعلاً
// فاز (winner.source). لو فاز DVI بقرار أشد (PROTECTIVE_STOP، رتبة 4) بينما
// compliance في نفس اللحظة غير-ALLOW لكن أضعف (PRECAUTION → MONITOR، رتبة 1
// فقط)، كان النص/العنوان المعروضان يُؤخَذان من compliance الأضعف رغم أن
// القرار التشغيلي الفعلي (PROTECTIVE_STOP) مصدره DVI بالكامل — يفسد قابلية
// التدقيق (يعرض للمستخدم سبباً لا يفسر شدة القرار الفعلي).
describe('decideFinal — نص/عنوان القرار يجب أن يطابق المرشح الفائز فعلياً لا أي فحص منفصل', () => {
  it('DVI يفوز بـPROTECTIVE_STOP بينما compliance=PRECAUTION (أضعف، MONITOR) → النص/العنوان من DVI لا compliance', () => {
    const dvi = baseDvi({
      decisionCategory: 'STOP_VISIBILITY_DEPENDENT_ACTIVITIES',
      level: 'RED',
      decisionLabelAr: 'إيقاف الأنشطة المعتمدة على الرؤية',
      mandatoryStop: false,
      shortReason: 'إيقاف الأنشطة المعتمدة على الرؤية حتى تحسن الظروف',
    });
    const compliance = baseCompliance({
      decisionCategory: 'PRECAUTION',
      decisionLabelAr: 'حالة احتراز',
      shortReasonAr: 'حالة احتراز: تركيز PM10 ضمن نطاق الإنذار المبكر',
    });
    const r = decideFinal(input({ dvi, compliance }));

    expect(r.operationalDecision).toBe('PROTECTIVE_STOP');
    expect(r.shortReasonAr).toBe('إيقاف الأنشطة المعتمدة على الرؤية حتى تحسن الظروف');
    expect(r.decisionLabelAr).toBe('إيقاف الأنشطة المعتمدة على الرؤية');
  });

  it('compliance يفوز فعلاً بـRESTRICT_ACTIVITY بينما DVI أضعف (MONITOR عبر ALLOW_WITH_MONITORING) → النص/العنوان من compliance', () => {
    const dvi = baseDvi({ decisionCategory: 'ALLOW_WITH_MONITORING', level: 'YELLOW' });
    const compliance = baseCompliance({
      decisionCategory: 'RESTRICT_ACTIVITY',
      decisionLabelAr: 'تقييد النشاط',
      shortReasonAr: 'سرعة الطرق غير المسفلتة (15 كم/س) تتجاوز الحد (10 كم/س)',
    });
    const r = decideFinal(input({ dvi, compliance }));

    expect(r.operationalDecision).toBe('RESTRICT');
    expect(r.shortReasonAr).toBe('سرعة الطرق غير المسفلتة (15 كم/س) تتجاوز الحد (10 كم/س)');
    expect(r.decisionLabelAr).toBe('تقييد النشاط');
  });
});

function baseAei(overrides: Partial<AeiEvaluationResult> = {}): AeiEvaluationResult {
  return {
    indicatorType: 'AEI',
    activityLabelAr: 'أعمال الحفر والترابية',
    status: 'ALLOW',
    statusLabelAr: 'قابل للتنفيذ',
    color: 'GREEN',
    score: 100,
    safetyScore: 100,
    qualityScore: 100,
    baseScore: 100,
    closedByGate: false,
    cappedByGate: false,
    gateReasonAr: null,
    isHoldForVerification: false,
    shortReasonAr: '',
    recommendationAr: '',
    sources: [],
    ...overrides,
  };
}

// خطأ معماري حرج مكتشَف ومُصلَح (مراجعة خبير خارجي — "القرار المعروض قد
// يختلف عن القرار المحفوظ": decideFinal كانت تستقبل input.aei صراحة عبر
// FinalDecisionInput لكن لا تقرأه إطلاقاً — الدمج الفعلي (AEI أشد يستبدل
// level/النص) كان يحدث فقط في computeUnifiedActivityDecision (dustEvaluation.ts)
// حياً وقت العرض، بلا أي انعكاس على النتيجة المخزَّنة فعلياً عبر
// persistFinalDecisions → decideFinal مباشرة. هذا يختبر decideFinal نفسها
// (لا الغلاف) لضمان أن أي مسار يستدعيها مباشرة (مسار الحفظ ضمناً) يحصل على
// نفس نتيجة الدمج التي كانت تظهر فقط حياً سابقاً — راجع
// dustEvaluation.unifiedDecision.test.ts لتغطية شاملة إضافية عبر الغلاف.
describe('decideFinal — يدمج input.aei داخلياً (لا طبقة خارجية منفصلة بعد الآن)', () => {
  it('DVI وامتثال كلاهما ALLOW نظيف، لكن aei يحذّر (MONITOR/YELLOW) → النتيجة المُرجَعة من decideFinal نفسها تعكس تحذير aei', () => {
    const dvi = baseDvi({ level: 'GREEN', decisionCategory: 'ALLOW', decisionLabelAr: 'مسموح — تشغيل اعتيادي', mandatoryStop: false, overridable: true });
    const compliance = baseCompliance({ decisionCategory: 'ALLOW', decisionLabelAr: 'مسموح — تشغيل اعتيادي' });
    const aei = baseAei({ status: 'MONITOR', statusLabelAr: 'قابل للتنفيذ مع مراقبة', color: 'YELLOW', shortReasonAr: 'انخفاض مستوى الأمان للعمال بسبب الغبار.' });

    const r = decideFinal(input({ dvi, compliance, aei }));

    expect(r.level).toBe('YELLOW');
    expect(r.decisionLabelAr).toBe('قابل للتنفيذ مع مراقبة');
    expect(r.shortReasonAr).toBe('انخفاض مستوى الأمان للعمال بسبب الغبار.');
    expect(r.mandatoryStop).toBe(false);
  });

  it('mandatoryStop=true → aei لا يُستبدَل به مهما كان لونه (BLACK يبقى الأعلى دائماً)', () => {
    const dvi = baseDvi({ level: 'BLACK', mandatoryStop: true, overridable: false, decisionLabelAr: 'إيقاف إلزامي نظامي' });
    const compliance = baseCompliance({ decisionCategory: 'ALLOW' });
    const aei = baseAei({ status: 'ALLOW', statusLabelAr: 'قابل للتنفيذ', color: 'GREEN' });

    const r = decideFinal(input({ dvi, compliance, aei }));

    expect(r.mandatoryStop).toBe(true);
    expect(r.level).toBe('BLACK');
    expect(r.decisionLabelAr).toBe('إيقاف إلزامي نظامي');
  });

  it('pendingConfirmation=true (معلَّق بانتظار تأكيد) → aei لا يُستبدَل به (يبقى RED/معلَّق كما هو)', () => {
    const dvi = baseDvi({ level: 'GREEN', decisionCategory: 'ALLOW', mandatoryStop: false });
    const compliance = baseCompliance({
      decisionCategory: 'STOP_AFFECTED_ACTIVITY',
      pendingConfirmation: true,
      decisionLabelAr: 'إيقاف النشاط المتأثر',
      shortReasonAr: 'تعليق مؤقت (معلَّق): بانتظار استمرار القراءة',
    });
    const aei = baseAei({ status: 'ALLOW', statusLabelAr: 'قابل للتنفيذ', color: 'GREEN' });

    const r = decideFinal(input({ dvi, compliance, aei }));

    expect(r.pendingConfirmation).toBe(true);
    expect(r.level).toBe('RED');
    expect(r.mandatoryStop).toBe(false);
  });

  it('aei أخف من الفائز الفعلي (compliance يحذّر بشدة أعلى) → لا يُستبدَل، نتيجة decideFinal الأشد تبقى كما هي', () => {
    const dvi = baseDvi({ level: 'GREEN', decisionCategory: 'ALLOW', mandatoryStop: false });
    const compliance = baseCompliance({ decisionCategory: 'RESTRICT_ACTIVITY', decisionLabelAr: 'تقييد النشاط', shortReasonAr: 'مخالفة مسافة الكسارة' });
    const aei = baseAei({ status: 'ALLOW', statusLabelAr: 'قابل للتنفيذ', color: 'GREEN' });

    const r = decideFinal(input({ dvi, compliance, aei }));

    expect(r.level).toBe('RED');
    expect(r.decisionLabelAr).toBe('تقييد النشاط');
  });

  it('aei=null (غياب تام) → سلوك decideFinal بلا تغيير (توافق خلفي لمستهلكين لا يمررون aei)', () => {
    const dvi = baseDvi({ level: 'GREEN', decisionCategory: 'ALLOW', decisionLabelAr: 'مسموح — تشغيل اعتيادي', mandatoryStop: false });
    const compliance = baseCompliance({ decisionCategory: 'ALLOW', decisionLabelAr: 'مسموح — تشغيل اعتيادي' });

    const r = decideFinal(input({ dvi, compliance, aei: null }));

    expect(r.level).toBe('GREEN');
    expect(r.decisionLabelAr).toBe('مسموح — تشغيل اعتيادي');
  });

  it('mode=PLANNING + aei.color=BLACK → aei لا يُستهلَك إطلاقاً (الفرع المبكر لـPLANNING يعيد قبل الوصول لمنطق الدمج)', () => {
    const dvi = baseDvi({
      level: 'BLACK',
      decisionCategory: 'MANDATORY_STOP',
      decisionLabelAr: 'إيقاف إلزامي نظامي',
      mandatoryStop: true,
      overridable: false,
    });
    const compliance = baseCompliance({ decisionCategory: 'MANDATORY_STOP', decisionLabelAr: 'إيقاف إلزامي نظامي' });
    const aei = baseAei({ status: 'CLOSED', statusLabelAr: 'بيئة العمل غير آمنة (مغلق)', color: 'BLACK', score: 0 });

    const r = decideFinal(input({ dvi, compliance, aei, mode: 'PLANNING' }));

    expect(r.mandatoryStop).toBe(false);
    expect(r.level).toBe('YELLOW');
    expect(r.decisionLabelAr).toBe('تنبيه: أجواء متوقعة غير مناسبة');
  });
});

// =====================================================================
// pickWorstDecision — راجع ملاحظة مراجعة خارجية: "النظام يختار أول صف بدل
// أسوأ قرار". dashboard/global وviewer/dashboard كانا يختاران أول نشاط
// جارٍ يُعثر عليه (ترتيب استعلام غير مضمون) لتلوين نقطة الخريطة، بدل تقييم
// كل الأنشطة الجارية واختيار أسوأها. اختبار القبول المطلوب صراحة: تبديل
// ترتيب صف آمن وصف موقوف يجب ألا يغيّر النتيجة.
// =====================================================================
function decisionWith(operationalDecision: FinalDecision['operationalDecision']): FinalDecision {
  const r = decideFinal(input());
  return { ...r, operationalDecision };
}

describe('pickWorstDecision — يختار أسوأ قرار بصرف النظر عن ترتيب الصفوف', () => {
  it('يرمي خطأً صريحاً عند قائمة فارغة (لا يُرجع undefined بصمت)', () => {
    expect(() => pickWorstDecision([])).toThrow('pickWorstDecision: cannot select from an empty list');
  });

  it('صف واحد فقط → يُرجعه كما هو', () => {
    const rows = [{ id: 'a', finalDecision: decisionWith('ALLOW') }];
    expect(pickWorstDecision(rows).id).toBe('a');
  });

  // اختبار القبول المطلوب حرفياً في الملاحظة: تبديل ترتيب صف آمن (ALLOW)
  // وصف موقوف (MANDATORY_STOP) يجب ألا يغيّر النتيجة — النتيجة تعتمد على
  // شدة القرار فقط، لا على أي ترتيب صادف أن يصل به الاستعلام.
  it('تبديل ترتيب صف آمن وصف موقوف لا يغيّر النتيجة (الصف الموقوف يفوز دائماً)', () => {
    const safe = { id: 'safe', finalDecision: decisionWith('ALLOW') };
    const stopped = { id: 'stopped', finalDecision: decisionWith('MANDATORY_STOP') };

    const resultA = pickWorstDecision([safe, stopped]);
    const resultB = pickWorstDecision([stopped, safe]);

    expect(resultA.id).toBe('stopped');
    expect(resultB.id).toBe('stopped');
    expect(resultA.id).toBe(resultB.id);
  });

  it('يختار الأسوأ عبر كل مستويات FINAL_RANK بصرف النظر عن الترتيب', () => {
    const rows = [
      { id: 'monitor', finalDecision: decisionWith('MONITOR') },
      { id: 'restrict', finalDecision: decisionWith('RESTRICT') },
      { id: 'hold', finalDecision: decisionWith('HOLD_FOR_VERIFICATION') },
      { id: 'protective', finalDecision: decisionWith('PROTECTIVE_STOP') },
      { id: 'allow', finalDecision: decisionWith('ALLOW') },
    ];
    expect(pickWorstDecision(rows).id).toBe('protective');
    expect(pickWorstDecision([...rows].reverse()).id).toBe('protective');
  });

  it('MANDATORY_STOP يفوز على PROTECTIVE_STOP (الأعلى في FINAL_RANK)', () => {
    const rows = [
      { id: 'protective', finalDecision: decisionWith('PROTECTIVE_STOP') },
      { id: 'mandatory', finalDecision: decisionWith('MANDATORY_STOP') },
    ];
    expect(pickWorstDecision(rows).id).toBe('mandatory');
    expect(pickWorstDecision([...rows].reverse()).id).toBe('mandatory');
  });

  it('عدة صفوف بنفس أسوأ درجة → يُرجع أحدها بثبات (أول ما يُعثر عليه بهذه الدرجة)، لا يرمي خطأً', () => {
    const rows = [
      { id: 'stopped-1', finalDecision: decisionWith('MANDATORY_STOP') },
      { id: 'allow', finalDecision: decisionWith('ALLOW') },
      { id: 'stopped-2', finalDecision: decisionWith('MANDATORY_STOP') },
    ];
    const result = pickWorstDecision(rows);
    expect(result.finalDecision.operationalDecision).toBe('MANDATORY_STOP');
  });

  // خطأ مكتشَف ومُصلَح (مراجعة كود خبير خارجي — H-08: "لا Candidate Engine
  // أو حسم تعادل ثابت"): كان reduce يبقي دائماً على العنصر الأول عند تعادل
  // operationalDecision بالضبط (`>` صارم لا `>=`)، بصرف النظر عن أي فرق
  // حقيقي آخر بين الصفين (مثال: أحدهما level=BLACK والآخر level=RED رغم
  // تطابق operationalDecision=MANDATORY_STOP) — فترتيب الاستعلام وحده كان
  // يحدد الفائز. الآن level يُقارَن صراحة كمعيار حسم ثانٍ.
  it('H-08: تعادل operationalDecision (كلاهما MANDATORY_STOP) لكن level مختلف → الأسوأ لوناً (BLACK) يفوز دائماً بصرف النظر عن ترتيب الصفوف', () => {
    const blackRow = { id: 'black', finalDecision: { ...decisionWith('MANDATORY_STOP'), level: 'BLACK' as const } };
    const redRow = { id: 'red', finalDecision: { ...decisionWith('MANDATORY_STOP'), level: 'RED' as const } };

    const resultA = pickWorstDecision([redRow, blackRow]);
    const resultB = pickWorstDecision([blackRow, redRow]);

    expect(resultA.id).toBe('black');
    expect(resultB.id).toBe('black');
  });

  it('H-08: تعادل operationalDecision وlevel معاً لكن mandatoryStop مختلف → true (إيقاف إلزامي فعلي) يفوز على false', () => {
    const trueRow = { id: 'true', finalDecision: { ...decisionWith('MANDATORY_STOP'), level: 'BLACK' as const, mandatoryStop: true } };
    const falseRow = { id: 'false', finalDecision: { ...decisionWith('MANDATORY_STOP'), level: 'BLACK' as const, mandatoryStop: false } };

    const resultA = pickWorstDecision([falseRow, trueRow]);
    const resultB = pickWorstDecision([trueRow, falseRow]);

    expect(resultA.id).toBe('true');
    expect(resultB.id).toBe('true');
  });
});
