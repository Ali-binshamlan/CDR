import { describe, it, expect } from 'vitest';
import { computeUnifiedActivityDecision } from './dustEvaluation';
import type { DustComplianceResult } from '@/app/utils/dust-compliance-engine/types';
import type { DviEvaluationResult } from '@/app/utils/dust-engine/types';
import type { AeiEvaluationResult } from '@/app/utils/aei-engine/types';

// =====================================================================
// اختبارات "القرار الموحد للنشاط" (computeUnifiedActivityDecision) — الآن
// غلاف رقيق حول decideFinal (app/utils/final-decision-engine)، راجع ذلك
// الملف للاختبارات الأساسية الشاملة. هذا الملف يبقى للتحقق من أن الغلاف
// يحافظ على نفس شكل/سلوك UnifiedActivityDecision القديم لمستهلكيه الحاليين
// (summaryFromDust في route.ts، حساب حالة نقطة الخريطة في dashboard/global
// وviewer/dashboard) بلا كسر توافقي.
// =====================================================================

function baseDviWorst(overrides: Partial<DviEvaluationResult> = {}): DviEvaluationResult {
  return {
    indicatorType: 'DVI',
    dviBase: 40,
    score: 45,
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
    triggeredRules: [],
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

function complianceWith(
  decisionCategory: DustComplianceResult['decisionCategory'],
  decisionLabelAr: string,
  shortReasonAr: string,
  pendingConfirmation = false,
  isEnclosedOperation = false
): DustComplianceResult {
  return {
    decisionCategory,
    decisionLabelAr,
    shortReasonAr,
    pendingConfirmation,
    isEnclosedOperation,
    canOverride: decisionCategory !== 'MANDATORY_STOP' && decisionCategory !== 'STOP_AFFECTED_ACTIVITY',
    mandatoryStop: decisionCategory === 'MANDATORY_STOP',
    missingCriticalInputs: [],
    triggeredRules: [],
    confidenceScore: 95,
    // جهاز رصد مرتبط بقراءة حديثة (الآن) — هذا الملف يختبر أولوية نص/درجة
    // DVI مقابل الامتثال حصراً، لا جودة الأدلة (evidenceQuality). بلا هذا،
    // evidence.deviceLastReadingAt===undefined يعني "لا جهاز مرتبط أصلاً"
    // (راجع deriveEvidenceQuality في final-decision-engine/adapters.ts بعد
    // طلب المستخدم "دايماً يحتاج قراءة حقيقية من الجهاز") فيسقط كل اختبار
    // هنا لـUNAVAILABLE/HOLD_FOR_VERIFICATION بلا علاقة بما يختبره فعلياً.
    evidence: { deviceLastReadingAt: new Date().toISOString() },
  } as unknown as DustComplianceResult;
}

describe('computeUnifiedActivityDecision — قرار امتثال غير إيقاف يجب ألا يختفي خلف نص DVI', () => {
  // ملاحظة: baseDviWorst() الافتراضي decisionCategory='RESTRICT' (رتبة 2) —
  // أشد من ALLOW_WITH_CONTROLS/RESTRICT_ACTIVITY (رتبة 1/2) في بعض هذه
  // الاختبارات، فيُستخدَم dvi:{decisionCategory:'ALLOW'} صراحةً هنا (رتبة 0،
  // أضعف فعلياً من كل فئات الامتثال المختبرة) لعزل مسار "الامتثال هو الفائز
  // فعلاً" تحديداً (راجع القسم 18.1 في final-decision-engine/engine.test.ts
  // لنفس مبدأ العزل، وتعليق complianceIsDecisive في engine.ts لسبب الربط
  // الآن برتبة الفائز الفعلي لا بمجرد decisionCategory!=='ALLOW').
  it('PM10-EARLY-WARNING-007 (ALLOW_WITH_CONTROLS) يظهر بدل رسالة DVI العامة', () => {
    const compliance = complianceWith(
      'ALLOW_WITH_CONTROLS',
      'مسموح مع ضوابط تحكم إضافية',
      'تنبيه استباقي: تركيز PM10 (300 ميكروجرام/م³) يقترب من حد المخالفة (340 ميكروجرام/م³)'
    );
    const r = computeUnifiedActivityDecision(baseDviWorst({ decisionCategory: 'ALLOW' }), compliance);
    expect(r.shortReason).toBe('تنبيه استباقي: تركيز PM10 (300 ميكروجرام/م³) يقترب من حد المخالفة (340 ميكروجرام/م³)');
    expect(r.decisionLabelAr).toBe('مسموح مع ضوابط تحكم إضافية');
    expect(r.mandatoryStop).toBe(false);
  });

  it('RESTRICT_ACTIVITY يظهر نصه الخاص بدل نص DVI العام', () => {
    const compliance = complianceWith('RESTRICT_ACTIVITY', 'تقييد النشاط', 'سرعة الطرق غير المسفلتة (15 كم/س) تتجاوز الحد (10 كم/س)');
    const r = computeUnifiedActivityDecision(baseDviWorst({ decisionCategory: 'ALLOW' }), compliance);
    expect(r.shortReason).toBe('سرعة الطرق غير المسفلتة (15 كم/س) تتجاوز الحد (10 كم/س)');
    expect(r.decisionLabelAr).toBe('تقييد النشاط');
  });

  it('FIELD_VERIFICATION_REQUIRED يظهر نصه الخاص بدل نص DVI العام', () => {
    const compliance = complianceWith('FIELD_VERIFICATION_REQUIRED', 'يتطلب تحقق ميداني قبل الاستمرار', 'لم يتم تحديد نقطة دخول المشروع على الخريطة');
    const r = computeUnifiedActivityDecision(baseDviWorst({ decisionCategory: 'ALLOW' }), compliance);
    expect(r.shortReason).toBe('لم يتم تحديد نقطة دخول المشروع على الخريطة');
    expect(r.decisionLabelAr).toBe('يتطلب تحقق ميداني قبل الاستمرار');
  });

  it('امتثال ALLOW نظيف → يبقى نص DVI كما هو (لا شيء يُخفى)', () => {
    const compliance = complianceWith('ALLOW', 'مسموح — تشغيل اعتيادي', 'لا توجد مخالفات تنظيمية ظاهرة على النشاط الحالي');
    const r = computeUnifiedActivityDecision(baseDviWorst(), compliance);
    expect(r.shortReason).toBe(baseDviWorst().shortReason);
    expect(r.decisionLabelAr).toBe(baseDviWorst().decisionLabelAr);
  });

  // خطأ مكتشَف ومُصلَح (مراجعة كود مدير — "غياب نتيجة الامتثال compliance=null
  // ينتج COMPLIANT بدل NOT_DETERMINABLE"): deriveEvidenceQuality(null) كانت
  // تُرجع دائماً PARTIAL (لا تُصعِّد لـHOLD_FOR_VERIFICATION)، فيبقى نص DVI
  // الخام معروضاً بثقة كاملة رغم غياب أي تقييم امتثال إطلاقاً. الآن compliance=null
  // في LIVE_OPERATIONAL (الافتراضي هنا) ينتج UNAVAILABLE، فيُعرَض نص "تعذّر
  // اعتماد قرار واثق" بدل نص DVI — لا قرار حي واثق بلا محرك امتثال شغَّال.
  it('لا قرار امتثال إطلاقاً (null) في LIVE_OPERATIONAL → HOLD_FOR_VERIFICATION، لا نص DVI بثقة كاملة', () => {
    const r = computeUnifiedActivityDecision(baseDviWorst(), null);
    expect(r.shortReason).not.toBe(baseDviWorst().shortReason);
    expect(r.decisionLabelAr).toBe('بانتظار تحقق ميداني — بيانات غير كافية');
  });

  it('DVI نفسه mandatoryStop حتى مع امتثال غير حاجب → يبقى إيقاف إلزامي', () => {
    const compliance = complianceWith('ALLOW_WITH_CONTROLS', 'مسموح مع ضوابط تحكم إضافية', 'تحذير: تركيز PM10 (260) تجاوز حد التحذير (250)');
    const r = computeUnifiedActivityDecision(baseDviWorst({ mandatoryStop: true, overridable: false }), compliance);
    expect(r.mandatoryStop).toBe(true);
    expect(r.decisionLabelAr).toBe('إيقاف إلزامي نظامي');
    expect(r.level).toBe('BLACK');
  });

  // خطأ مكتشَف ومُصلَح أثناء بناء decideFinal: STOP_AFFECTED_ACTIVITY مؤكَّد
  // (pendingConfirmation=false) يُعامَل بنفس قوة MANDATORY_STOP فعلياً —
  // كلاهما canOverride=false في dust-compliance-engine/engine.ts، فلا يجوز
  // أن يظهر "معلَّق" أو أخف من إيقاف إلزامي قطعي.
  it('امتثال يحجب (MANDATORY_STOP) يبقى بسلوكه السابق بلا تغيير', () => {
    const compliance = complianceWith('MANDATORY_STOP', 'إيقاف إلزامي غير قابل للتجاوز', 'مسافة الكسارة عن سكني أقل من الحد الأدنى (500 م)');
    const r = computeUnifiedActivityDecision(baseDviWorst(), compliance);
    expect(r.decisionLabelAr).toBe('إيقاف إلزامي نظامي');
    expect(r.shortReason).toBe('مسافة الكسارة عن سكني أقل من الحد الأدنى (500 م)');
    expect(r.mandatoryStop).toBe(true);
    expect(r.level).toBe('BLACK');
    expect(r.pendingConfirmation).toBe(false);
  });

  it('امتثال يحجب لكنه معلَّق فقط (pendingConfirmation=true، مثال MRQ-PM10-BLACK-PENDING-104) → لا يظهر "إيقاف إلزامي نظامي" القطعية', () => {
    const compliance = complianceWith(
      'STOP_AFFECTED_ACTIVITY',
      'إيقاف النشاط المتأثر',
      'تعليق مؤقت (معلَّق): تركيز PM10 (345 ميكروجرام/م³) تجاوز حد المخالفة (340 ميكروجرام/م³) — بانتظار استمرار القراءة أكثر من دقيقتين لتصنيفها مخالفة تنظيمية مؤكدة',
      true
    );
    const r = computeUnifiedActivityDecision(baseDviWorst(), compliance);
    expect(r.decisionLabelAr).not.toBe('إيقاف إلزامي نظامي');
    expect(r.pendingConfirmation).toBe(true);
    expect(r.mandatoryStop).toBe(false);
    expect(r.level).toBe('RED');
    expect(r.shortReason).toContain('معلَّق');
  });

  it('DVI أخضر + امتثال ALLOW_WITH_CONTROLS → level لا يبقى أخضر (يطابق حد AEI الأحمر)', () => {
    const compliance = complianceWith(
      'ALLOW_WITH_CONTROLS',
      'مسموح مع ضوابط تحكم إضافية',
      'تحذير: تركيز PM10 (260 ميكروجرام/م³) تجاوز حد التحذير (250 ميكروجرام/م³)'
    );
    const r = computeUnifiedActivityDecision(baseDviWorst({ level: 'GREEN', decisionCategory: 'ALLOW', mandatoryStop: false }), compliance);
    expect(r.level).not.toBe('GREEN');
    expect(r.level).toBe('RED');
    expect(r.mandatoryStop).toBe(false);
  });

  it('DVI أخضر + امتثال PRECAUTION → level يصبح أصفر (لا أخضر متناقض مع نص الاحتراز، ولا أحمر مبالغ فيه)', () => {
    const compliance = complianceWith('PRECAUTION', 'احتراز — زيادة المراقبة', 'حالة احتراز: تركيز PM10 (200 ميكروجرام/م³) ضمن نطاق الإنذار المبكر (150–250 ميكروجرام/م³)');
    const r = computeUnifiedActivityDecision(baseDviWorst({ level: 'GREEN', decisionCategory: 'ALLOW', mandatoryStop: false }), compliance);
    expect(r.level).toBe('YELLOW');
    expect(r.decisionLabelAr).toBe('احتراز — زيادة المراقبة');
    expect(r.mandatoryStop).toBe(false);
  });

  it('DVI أشد من الامتثال (مثال DVI=BLACK) → لا يُخفَّض level رغم أن الامتثال ALLOW_WITH_CONTROLS فقط', () => {
    const compliance = complianceWith('ALLOW_WITH_CONTROLS', 'مسموح مع ضوابط تحكم إضافية', 'تحذير بسيط');
    const r = computeUnifiedActivityDecision(baseDviWorst({ level: 'BLACK', mandatoryStop: true, overridable: false }), compliance);
    expect(r.level).toBe('BLACK');
  });

  it('نشاط مغلق + امتثال ALLOW نظيف + DVI أصفر بسبب الرياح فقط → البانر يعرض أخضر (الامتثال هو المرجع لنشاط مغلق)', () => {
    const compliance = complianceWith('ALLOW', 'مسموح — تشغيل اعتيادي', 'لا توجد مخالفات تنظيمية ظاهرة على النشاط الحالي', false, true);
    const r = computeUnifiedActivityDecision(
      baseDviWorst({ level: 'YELLOW', decisionLabelAr: 'تشغيل مع المراقبة والمتابعة', decisionCategory: 'ALLOW_WITH_MONITORING', mandatoryStop: false }),
      compliance
    );
    expect(r.level).toBe('GREEN');
    expect(r.decisionLabelAr).toBe('مسموح — تشغيل اعتيادي');
    expect(r.mandatoryStop).toBe(false);
  });

  it('نشاط مكشوف (غير مغلق) + امتثال ALLOW نظيف + DVI أصفر بسبب الرياح → يبقى أصفر كما هو (لا استثناء لنشاط مكشوف)', () => {
    const compliance = complianceWith('ALLOW', 'مسموح — تشغيل اعتيادي', 'لا توجد مخالفات تنظيمية ظاهرة على النشاط الحالي', false, false);
    const r = computeUnifiedActivityDecision(
      baseDviWorst({ level: 'YELLOW', decisionLabelAr: 'تشغيل مع المراقبة والمتابعة', decisionCategory: 'ALLOW_WITH_MONITORING', mandatoryStop: false }),
      compliance
    );
    expect(r.level).toBe('YELLOW');
    expect(r.decisionLabelAr).toBe('تشغيل مع المراقبة والمتابعة');
  });

  it('نشاط مغلق + امتثال ALLOW نظيف + DVI mandatoryStop حقيقي (رؤية حرجة) → لا يُستثنى، الإيقاف يبقى قائماً', () => {
    const compliance = complianceWith('ALLOW', 'مسموح — تشغيل اعتيادي', 'لا توجد مخالفات تنظيمية ظاهرة على النشاط الحالي', false, true);
    const r = computeUnifiedActivityDecision(
      baseDviWorst({ level: 'BLACK', mandatoryStop: true, overridable: false }),
      compliance
    );
    expect(r.mandatoryStop).toBe(true);
    expect(r.decisionLabelAr).toBe('إيقاف إلزامي نظامي');
    expect(r.level).toBe('BLACK');
  });

  it('نشاط مغلق لكن الامتثال غير نظيف (PRECAUTION) → لا يُستثنى تنبيه DVI، الامتثال نفسه يحمل تنبيهاً بالفعل', () => {
    const compliance = complianceWith('PRECAUTION', 'احتراز — زيادة المراقبة', 'حالة احتراز: تركيز PM10 ضمن نطاق الإنذار المبكر', false, true);
    const r = computeUnifiedActivityDecision(
      baseDviWorst({ level: 'YELLOW', decisionLabelAr: 'تشغيل مع المراقبة والمتابعة', decisionCategory: 'ALLOW_WITH_MONITORING', mandatoryStop: false }),
      compliance
    );
    expect(r.decisionLabelAr).toBe('احتراز — زيادة المراقبة');
    expect(r.level).toBe('YELLOW');
  });

  // خطأ مكتشَف ومُصلَح (بناء decideFinal): كان هذا الاختبار يتوقع
  // pendingConfirmation=false وmandatoryStop=true معاً — سلوك صحيح ومحفوظ،
  // لكن التوقعات هنا صارت أدق (تؤكد أيضاً overridable=false).
  it('امتثال STOP_AFFECTED_ACTIVITY مؤكَّد (غير معلَّق) لا يزال يظهر "إيقاف إلزامي نظامي" كسابقاً', () => {
    const compliance = complianceWith(
      'STOP_AFFECTED_ACTIVITY',
      'إيقاف النشاط المتأثر',
      'مسافة الكسارة عن سكني/مدارس/مستشفيات (420 م) أقل من الحد الأدنى (500 م)',
      false
    );
    const r = computeUnifiedActivityDecision(baseDviWorst(), compliance);
    expect(r.decisionLabelAr).toBe('إيقاف إلزامي نظامي');
    expect(r.pendingConfirmation).toBe(false);
    expect(r.mandatoryStop).toBe(true);
    expect(r.overridable).toBe(false);
    expect(r.level).toBe('BLACK');
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

// خطأ مكتشَف ومُصلَح (مراجعة مستخدم — "تناقض بين البطاقات التي تصدر
// قرارات: فوق تشغيل اعتيادي وتحت مع مراقبة"): evaluateAei تحسب safetyScore/
// qualityScore من dvi.score الرقمي المستمر بمعزل عن dvi.decisionCategory
// الثنائي، فقد تُنتج AEI تحذيراً (MONITOR/RESTRICT) حتى عندما يكون كل من
// DVI والامتثال 'ALLOW' نصياً بلا أي تحفظ. العنوان الأعلى ("القرار الموحد
// للنشاط") كان يتجاهل aei تماماً (يُمرَّر null دائماً لـdecideFinal)، فيظهر
// "مسموح — تشغيل اعتيادي" أخضر فوق بطاقة AEI "قابل للتنفيذ مع مراقبة"
// صفراء لنفس النشاط — تناقض ظاهري مباشر بين بطاقتين متجاورتين.
describe('computeUnifiedActivityDecision — دمج aei في العنوان الموحّد يمنع التناقض مع بطاقة AEI', () => {
  it('DVI وامتثال كلاهما ALLOW نظيف، لكن aei يحذّر (MONITOR/YELLOW) → العنوان الموحّد يعكس تحذير aei لا "مسموح"', () => {
    const compliance = complianceWith('ALLOW', 'مسموح — تشغيل اعتيادي', 'لا توجد مخالفات تنظيمية ظاهرة على النشاط الحالي');
    const dvi = baseDviWorst({
      level: 'GREEN',
      decisionCategory: 'ALLOW',
      decisionLabelAr: 'مسموح — تشغيل اعتيادي',
      mandatoryStop: false,
      score: 35, // >0 يكفي لخفض AEI رغم decisionCategory='ALLOW'
    });
    const aei = baseAei({
      status: 'MONITOR',
      statusLabelAr: 'قابل للتنفيذ مع مراقبة',
      color: 'YELLOW',
      score: 65,
      shortReasonAr: 'انخفاض مستوى الأمان للعمال بسبب الغبار وتدني مدى الرؤية.',
    });

    const r = computeUnifiedActivityDecision(dvi, compliance, aei);
    expect(r.decisionLabelAr).toBe('قابل للتنفيذ مع مراقبة');
    expect(r.level).toBe('YELLOW');
    expect(r.mandatoryStop).toBe(false);
  });

  it('aei أخف من decideFinal (امتثال يحذّر بشدة أعلى) → لا يُستبدَل، decideFinal يبقى الأشد ويُعرَض كما هو', () => {
    const compliance = complianceWith('RESTRICT_ACTIVITY', 'تقييد النشاط', 'مخالفة مسافة الكسارة');
    const dvi = baseDviWorst({ level: 'GREEN', decisionCategory: 'ALLOW', decisionLabelAr: 'مسموح — تشغيل اعتيادي', mandatoryStop: false });
    const aei = baseAei({ status: 'ALLOW', statusLabelAr: 'قابل للتنفيذ', color: 'GREEN', score: 100 });

    const r = computeUnifiedActivityDecision(dvi, compliance, aei);
    // RESTRICT_ACTIVITY يرفع floorLevel إلى RED في decideFinal — أشد من
    // aei.color=GREEN هنا، فيبقى نص/درجة decideFinal الفائزة كما هي.
    expect(r.level).toBe('RED');
    expect(r.decisionLabelAr).toBe('تقييد النشاط');
  });

  it('mandatoryStop=true → aei لا يُستبدَل به مهما كان (BLACK يبقى الأعلى دائماً)', () => {
    const compliance = complianceWith('ALLOW', 'مسموح — تشغيل اعتيادي', 'لا توجد مخالفات تنظيمية ظاهرة');
    const dvi = baseDviWorst({ level: 'BLACK', mandatoryStop: true, overridable: false });
    const aei = baseAei({ status: 'ALLOW', statusLabelAr: 'قابل للتنفيذ', color: 'GREEN' });

    const r = computeUnifiedActivityDecision(dvi, compliance, aei);
    expect(r.mandatoryStop).toBe(true);
    expect(r.decisionLabelAr).toBe('إيقاف إلزامي نظامي');
    expect(r.level).toBe('BLACK');
  });

  it('aei غير مُمرَّر (undefined) → سلوك decideFinal بلا تغيير (توافق خلفي كامل لمستهلكين لا يمررون aei)', () => {
    const compliance = complianceWith('ALLOW', 'مسموح — تشغيل اعتيادي', 'لا توجد مخالفات تنظيمية ظاهرة');
    const dvi = baseDviWorst({ level: 'GREEN', decisionCategory: 'ALLOW', decisionLabelAr: 'مسموح — تشغيل اعتيادي', mandatoryStop: false });

    const r = computeUnifiedActivityDecision(dvi, compliance);
    expect(r.decisionLabelAr).toBe('مسموح — تشغيل اعتيادي');
    expect(r.level).toBe('GREEN');
  });

  // طلب مستخدم صريح (اكتشاف عبر الواجهة — بانر "القرار الموحد" استمر يعرض
  // "بيئة العمل غير آمنة (مغلق)" أسود لنشاط PLANNING رغم أن decideFinal
  // نفسها تُرجع نتيجة محايدة (لا إيقاف إلزامي) بشكل صحيح تماماً): aei محرك
  // مستقل تماماً لا يعرف mode=PLANNING إطلاقاً — كان لا يزال يحسب aei.color
  // من dvi.score الخام (مبني على قيم توقّعية مرتفعة)، فتفوز قاعدة "الأشد
  // يحكم" أعلاه بلون AEI الأسود فوق قرار decideFinal الصحيح. startIso هنا
  // بعيد جداً (أبعد من هامش الساعتين) فيُنتج mode=PLANNING داخلياً. dvi.
  // decisionCategory=MANDATORY_STOP ليست ALLOW/ALLOW_WITH_MONITORING →
  // "لا تصلح" → أصفر (لا أخضر) بتصميم decideFinal، لكن الأهم: aei.color=
  // BLACK لا يجوز أن يستبدل هذا بلون أسود/mandatoryStop=true إطلاقاً.
  it('mode=PLANNING (startIso بعيد) + aei.color=BLACK → aei لا يُستبدَل به إطلاقاً، لا mandatoryStop ولا لون أسود', () => {
    const compliance = {
      ...complianceWith('MANDATORY_STOP', 'إيقاف إلزامي نظامي', 'PM10 تجاوز حد المخالفة'),
      // خطأ معماري مكتشَف ومُصلَح (مراجعة كود خارجي — P1، الملاحظة #11):
      // decideFinal لم يعد يشتق "هل الأجواء المتوقعة مناسبة؟" من dvi.
      // decisionCategory بنفسه — يقرأ compliance.planningSuitability الجاهزة
      // (محسوبة في dust-compliance-engine). راجع تعليقها الكامل في types.ts.
      planningSuitability: { isFavorable: false, reasonAr: 'الأجواء المتوقعة (رياح/رؤية) لا تصلح للنشاط.' },
    } as unknown as DustComplianceResult;
    const dvi = baseDviWorst({
      level: 'BLACK',
      decisionCategory: 'MANDATORY_STOP',
      decisionLabelAr: 'إيقاف إلزامي نظامي',
      mandatoryStop: true,
      overridable: false,
      shortReason: 'PM10 = 2041.5',
    });
    const aei = baseAei({ status: 'CLOSED', statusLabelAr: 'بيئة العمل غير آمنة (مغلق)', color: 'BLACK', score: 0 });

    const startIsoFarInFuture = new Date(Date.now() + 24 * 3600000).toISOString(); // بعد يوم كامل
    const r = computeUnifiedActivityDecision(dvi, compliance, aei, startIsoFarInFuture);

    expect(r.mandatoryStop).toBe(false);
    expect(r.level).toBe('YELLOW');
    expect(r.decisionLabelAr).toBe('تنبيه: أجواء متوقعة غير مناسبة');
  });
});
