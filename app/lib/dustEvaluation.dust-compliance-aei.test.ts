import { describe, it, expect } from 'vitest';
import { applyComplianceGatesToDustAei, activityDecisionKey, NEUTRAL_DVI_FALLBACK } from './dustEvaluation';
import type { StoredFinalDecisionRow } from './dustEvaluation';
import { isRegulatoryWindGateActive } from '@/app/utils/dust-compliance-engine';
import type { AeiEvaluationResult } from '@/app/utils/aei-engine/types';
import type { DustComplianceResult } from '@/app/utils/dust-compliance-engine/types';
import type { DviEvaluationResult } from '@/app/utils/dust-engine/types';

function baseDvi(overrides: Partial<DviEvaluationResult> = {}): DviEvaluationResult {
  return { ...NEUTRAL_DVI_FALLBACK, ...overrides };
}

// =====================================================================
// اختبارات تناغم AEI ("قابلية التنفيذ") وبوابة الرياح الساعية مع قرار
// الامتثال التنظيمي — يمنعان عرض "قابل للتنفيذ"/ساعة "آمنة" رغم إيقاف
// تنظيمي فعلي لنفس اللحظة (التناقض الذي رصده المستخدم بين توصية DVI
// الخضراء وقرار الامتثال الأحمر لنفس النشاط في نفس الوقت).
// =====================================================================

function baseAei(overrides: Partial<AeiEvaluationResult> = {}): AeiEvaluationResult {
  return {
    indicatorType: 'AEI',
    activityLabelAr: 'سفلتة',
    status: 'ALLOW',
    statusLabelAr: 'قابل للتنفيذ',
    color: 'GREEN',
    score: 94.6,
    safetyScore: 94.6,
    qualityScore: 96,
    baseScore: 94.6,
    closedByGate: false,
    cappedByGate: false,
    gateReasonAr: null,
    shortReasonAr: 'الأجواء ممتازة والظروف آمنة.',
    recommendationAr: 'استمر بالعمل، لا توجد قيود حالية.',
    isHoldForVerification: false,
    sources: [],
    ...overrides,
  };
}

// شكل امتثال كامل صالح — الحقول التي لا يقرأها applyFinalDecisionToAei/
// decideFinal فعلياً في هذه الاختبارات تحمل قيماً محايدة ثابتة، وكل اختبار
// يُجاوِز الحقول ذات الصلة فقط (decisionCategory/shortReasonAr/evidence/إلخ)
// عبر overrides — نفس نمط baseAei أعلاه بالضبط.
const NEUTRAL_COMPLIANCE_EVIDENCE: DustComplianceResult['evidence'] = {
  dviScore: 0,
  dviDecision: 'ALLOW',
  dviMandatoryStop: false,
  windSpeedKmh: null,
  windGustKmh: null,
  windDirectionDeg: null,
  pm10UgM3: null,
  pm25UgM3: null,
  relativeHumidityPercent: null,
  temperatureC: null,
  visibilityM: null,
};

function baseCompliance(
  overrides: Partial<Omit<DustComplianceResult, 'evidence'>> & { evidence?: Partial<DustComplianceResult['evidence']> } = {}
): DustComplianceResult {
  return {
    engineType: 'RIYADH_DUST_COMPLIANCE',
    engineVersion: '1.0',
    rulebookVersion: 'test',
    regulatoryActivity: 'OTHER',
    regulatoryActivityLabelAr: 'أخرى',
    riskClass: 'CATEGORY_I_LOW',
    riskClassReasonAr: '',
    windBand: 'BELOW_15',
    isEnclosedOperation: false,
    decisionCategory: 'ALLOW',
    decisionLabelAr: 'مسموح',
    mandatoryStop: false,
    canOverride: true,
    shortReasonAr: '',
    pendingConfirmation: false,
    hasConfirmedRegulatoryViolation: false,
    hasPendingRegulatoryFinding: false,
    decidingRuleCode: null,
    decidingRuleMessageAr: null,
    evaluatedAt: new Date().toISOString(),
    triggeredRules: [],
    requiredActions: [],
    restartConditions: [],
    missingCriticalInputs: [],
    monitoringObligations: [],
    confidenceScore: 100,
    confidenceLabelAr: 'عالية',
    validUntil: new Date().toISOString(),
    caveatsAr: [],
    resumeHoldApplied: false,
    ...overrides,
    evidence: { ...NEUTRAL_COMPLIANCE_EVIDENCE, ...overrides.evidence },
  };
}

describe('applyComplianceGatesToDustAei — قص AEI عند إيقاف تنظيمي', () => {
  it('يقص AEI إلى CLOSED/0 عندما يوقف الامتثال النشاط (MANDATORY_STOP)', () => {
    const dustResults = [
      { activityId: '1', aei: baseAei(), compliance: baseCompliance({ decisionCategory: 'MANDATORY_STOP', shortReasonAr: 'رياح تتجاوز الحد' }) },
    ];
    applyComplianceGatesToDustAei(dustResults, 'project-1');
    expect(dustResults[0].aei.status).toBe('CLOSED');
    expect(dustResults[0].aei.score).toBe(0);
    expect(dustResults[0].aei.color).toBe('BLACK');
    expect(dustResults[0].aei.closedByGate).toBe(true);
  });

  it('يقص AEI عند STOP_AFFECTED_ACTIVITY أيضاً', () => {
    const dustResults = [
      { activityId: '1', aei: baseAei(), compliance: baseCompliance({ decisionCategory: 'STOP_AFFECTED_ACTIVITY', shortReasonAr: 'إيقاف النشاط المتأثر' }) },
    ];
    applyComplianceGatesToDustAei(dustResults, 'project-1');
    expect(dustResults[0].aei.status).toBe('CLOSED');
  });

  it('لا يمس AEI عندما يكون قرار الامتثال ALLOW (جهاز مرتبط بقراءة حديثة)', () => {
    const dustResults = [
      {
        activityId: '1',
        aei: baseAei(),
        compliance: baseCompliance({
          decisionCategory: 'ALLOW',
          shortReasonAr: 'لا مخالفات',
          evidence: { deviceLastReadingAt: new Date().toISOString() },
        }),
      },
    ];
    applyComplianceGatesToDustAei(dustResults, 'project-1');
    expect(dustResults[0].aei.status).toBe('ALLOW');
    expect(dustResults[0].aei.score).toBe(94.6);
  });

  // خطأ مكتشَف ومُصلَح (مراجعة كود مدير — "غياب نتيجة الامتثال compliance=null
  // ينتج COMPLIANT بدل NOT_DETERMINABLE" و"evidenceQuality=PARTIAL قد ينتج
  // ALLOW+COMPLIANT"): deriveEvidenceQuality(null) كانت تُرجع PARTIAL دائماً
  // (لا تُصعِّد لـHOLD_FOR_VERIFICATION)، فيبقى AEI "مسموح" بثقة كاملة رغم
  // غياب أي تقييم امتثال إطلاقاً — بالضبط ما يصفه هذا الاختبار سابقاً كسلوك
  // "صحيح". الآن compliance=null في LIVE_OPERATIONAL (الافتراضي) ينتج
  // UNAVAILABLE، فيُقصّ AEI فعلياً بدل تركه بلا مساس.
  it('compliance = null في LIVE_OPERATIONAL → يُقيَّد AEI (بانتظار تحقق ميداني)، لا يبقى بلا مساس', () => {
    const dustResults = [{ activityId: '1', aei: baseAei(), compliance: null }];
    applyComplianceGatesToDustAei(dustResults, 'project-1');
    expect(dustResults[0].aei.status).toBe('RESTRICT');
    expect(dustResults[0].aei.isHoldForVerification).toBe(true);
  });

  // خطأ مكتشَف ومُصلَح (طلب صريح من المستخدم — "لا زالت المشكلة"، بعد أول
  // إصلاح): السيناريو الفعلي المُبلَّغ عنه — PM10 لحظي عالٍ جداً (تقدير طقس
  // بلا جهاز) يجعل dvi.mandatoryStop=true فيضبط aei.closedByGate=true داخل
  // evaluateAei الأساسية *قبل* أن يصل القرار لـapplyFinalDecisionToAei. كان
  // شرط "if (aei.closedByGate) return aei" يُفحَص قبل HOLD_FOR_VERIFICATION،
  // فيبقى AEI "مغلق" بثقة كاملة رغم غياب جهاز الرصد تماماً. الآن يجب أن
  // يظهر "بانتظار تحقق ميداني" حتى في هذه الحالة تحديداً.
  // ملاحظة تصميم: compliance.decisionCategory='MANDATORY_STOP'/'STOP_AFFECTED_
  // ACTIVITY' *مؤكَّد* (pendingConfirmation!==true) يفوز في decideFinal حتى
  // بلا جهاز مرتبط (confirmedAffectedStop في engine.ts يُفحَص قبل evidence
  // Unavailable) — قرار متعمَّد: مخالفة امتثال مؤكَّدة فعلياً (مثال: قاعدة
  // هندسية ثابتة كمسافة كسارة) لا يجوز أن يُضعفها غياب جهاز رصد PM10. هذا
  // السيناريو (compliance يُنتج MANDATORY_STOP من قراءة PM10 تقديرية بلا
  // جهاز) لم يعد ممكناً الحدوث فعلياً بعد منع استدعاء API كلياً لنشاط بلا
  // جهاز (راجع buildAwaitingEvaluationWindow في dust-engine/engine.ts) —
  // dviResult الممرَّر لـbuildComplianceContext يحمل pm10=null دائماً حينها،
  // فلا قاعدة PM10 تُفعَّل أصلاً. يبقى الاختبار التالي كشبكة أمان دفاعية على
  // مستوى AEI نفسه فقط، لا توثيقاً لسيناريو واقعي.
  it('لا جهاز رصد مرتبط، وcompliance يُنتج RESTRICT_ACTIVITY (لا MANDATORY_STOP مؤكَّد) → AEI "بانتظار تحقق ميداني"', () => {
    const dustResults = [
      {
        activityId: '1',
        aei: baseAei(),
        windowEval: {
          worst: baseDvi({
            mandatoryStop: false,
            decisionCategory: 'ALLOW_WITH_MONITORING',
          }),
        },
        compliance: baseCompliance({
          decisionCategory: 'RESTRICT_ACTIVITY',
          shortReasonAr: 'مؤشر جودة الهواء يقترب من الحد التنظيمي',
          missingCriticalInputs: [],
          evidence: {}, // لا جهاز مرتبط
        }),
      },
    ];
    applyComplianceGatesToDustAei(dustResults, 'project-1');
    expect(dustResults[0].aei.status).toBe('RESTRICT');
    expect(dustResults[0].aei.color).toBe('ORANGE');
    expect(dustResults[0].aei.closedByGate).toBe(false);
    expect(dustResults[0].aei.isHoldForVerification).toBe(true);
    expect(dustResults[0].aei.statusLabelAr).toContain('تحقق ميداني');
  });

  it('لا يكرر الإغلاق إن كان AEI مغلقاً أصلاً من بوابة DVI (closedByGate=true)', () => {
    const dvClosed = baseAei({ status: 'CLOSED', score: 0, closedByGate: true, gateReasonAr: 'إيقاف DVI' });
    const dustResults = [
      { activityId: '1', aei: dvClosed, compliance: baseCompliance({ decisionCategory: 'MANDATORY_STOP', shortReasonAr: 'إيقاف تنظيمي' }) },
    ];
    applyComplianceGatesToDustAei(dustResults, 'project-1');
    // يبقى سبب الإغلاق الأصلي (DVI) دون استبداله بسبب الامتثال
    expect(dustResults[0].aei.gateReasonAr).toBe('إيقاف DVI');
  });

  // سيناريو حقيقي رصده المستخدم: DVI ممتاز (93.4، "قابل للتنفيذ") بينما
  // الامتثال RESTRICT_ACTIVITY فعلياً (لا توجد شبكة/حاجز غبار حول موقع
  // الهدم) — لم يكن هذا يُقص إطلاقاً سابقاً لأن RESTRICT_ACTIVITY ليس ضمن
  // فئتي الإيقاف الكامل، فيظهر AEI أخضر "قابل للتنفيذ" متناقضاً مع "تقييد
  // النشاط" الظاهر بجانبه في قسم الامتثال.
  it('يقص AEI إلى RESTRICT (سقف AEI_RESTRICT_CAP) عند RESTRICT_ACTIVITY، لا يُترك بلا تأثير', () => {
    const dustResults = [
      {
        activityId: '1',
        aei: baseAei({ score: 93.4, safetyScore: 93.4, qualityScore: 96, baseScore: 93.4 }),
        compliance: baseCompliance({
          decisionCategory: 'RESTRICT_ACTIVITY',
          decisionLabelAr: 'تقييد النشاط',
          shortReasonAr: 'لا توجد شبكة/حاجز غبار حول موقع الهدم',
          evidence: { deviceLastReadingAt: new Date().toISOString() },
        }),
      },
    ];
    applyComplianceGatesToDustAei(dustResults, 'project-1');
    expect(dustResults[0].aei.status).toBe('RESTRICT');
    expect(dustResults[0].aei.score).toBeLessThan(93.4);
    expect(dustResults[0].aei.score).toBe(59);
    expect(dustResults[0].aei.cappedByGate).toBe(true);
    // السبب المعروض يجب أن يصبح السبب التنظيمي، لا نص التقييم الفيزيائي
    // الأصلي — وإلا ظهرت البطاقة بعنوان "تقييد تشغيلي" وتحته مباشرة
    // "الأجواء ممتازة والظروف آمنة" (تناقض صريح رصده المستخدم).
    expect(dustResults[0].aei.shortReasonAr).toBe('لا توجد شبكة/حاجز غبار حول موقع الهدم');
    expect(dustResults[0].aei.shortReasonAr).not.toContain('الظروف آمنة');
  });

  it('لا يرفع AEI أبداً — إن كان أصلاً أقل من سقف RESTRICT يبقى كما هو', () => {
    const dustResults = [
      {
        activityId: '1',
        aei: baseAei({ score: 40, status: 'RESTRICT', color: 'RED' }),
        compliance: baseCompliance({ decisionCategory: 'RESTRICT_ACTIVITY', decisionLabelAr: 'تقييد النشاط', shortReasonAr: 'سبب ما' }),
      },
    ];
    applyComplianceGatesToDustAei(dustResults, 'project-1');
    expect(dustResults[0].aei.score).toBe(40);
  });

  // pendingConfirmation (مثال: MRQ-PM10-BLACK-PENDING-104، قراءة PM10≥340
  // لم تستمر بعد دقيقتين) هو STOP_AFFECTED_ACTIVITY مؤقت بانتظار تأكيد، لا
  // مخالفة مؤكَّدة — يجب ألا يُقص AEI إلى CLOSED (اللغة القطعية) بنفس طريقة
  // إيقاف مؤكَّد، بل RESTRICT (أحمر) بنص مختلف يوضّح الطابع المؤقت.
  it('pendingConfirmation=true (STOP_AFFECTED_ACTIVITY معلَّق) → RESTRICT أحمر، لا CLOSED أسود', () => {
    const dustResults = [
      {
        activityId: '1',
        aei: baseAei(),
        compliance: baseCompliance({
          decisionCategory: 'STOP_AFFECTED_ACTIVITY',
          pendingConfirmation: true,
          shortReasonAr: 'تعليق مؤقت (معلَّق): تركيز PM10 (345) تجاوز حد المخالفة (340) — بانتظار استمرار القراءة أكثر من دقيقتين',
          evidence: { deviceLastReadingAt: new Date().toISOString() },
        }),
      },
    ];
    applyComplianceGatesToDustAei(dustResults, 'project-1');
    expect(dustResults[0].aei.status).toBe('RESTRICT');
    expect(dustResults[0].aei.color).toBe('RED');
    expect(dustResults[0].aei.closedByGate).toBeFalsy();
    expect(dustResults[0].aei.statusLabelAr).not.toContain('مغلق');
    expect(dustResults[0].aei.shortReasonAr).toContain('معلَّق');
  });

  it('pendingConfirmation=true مع MANDATORY_STOP → لا يزال يُعامَل كمعلَّق (الحقل هو الحاسم، لا الفئة)', () => {
    const dustResults = [
      {
        activityId: '1',
        aei: baseAei(),
        compliance: baseCompliance({
          decisionCategory: 'MANDATORY_STOP',
          pendingConfirmation: true,
          shortReasonAr: 'حالة معلَّقة افتراضية للاختبار',
        }),
      },
    ];
    applyComplianceGatesToDustAei(dustResults, 'project-1');
    expect(dustResults[0].aei.status).toBe('RESTRICT');
    expect(dustResults[0].aei.closedByGate).toBeFalsy();
  });

  it('pendingConfirmation=false (أو غائب) مع STOP_AFFECTED_ACTIVITY → يبقى CLOSED كالسابق تماماً', () => {
    const dustResults = [
      { activityId: '1', aei: baseAei(), compliance: baseCompliance({ decisionCategory: 'STOP_AFFECTED_ACTIVITY', shortReasonAr: 'مسافة الكسارة غير كافية' }) },
    ];
    applyComplianceGatesToDustAei(dustResults, 'project-1');
    expect(dustResults[0].aei.status).toBe('CLOSED');
    expect(dustResults[0].aei.color).toBe('BLACK');
    expect(dustResults[0].aei.closedByGate).toBe(true);
  });

  // PRECAUTION (نطاق PM10 150-250) — طلب صريح من المستخدم (مُحدَّث): يجب أن
  // تعكس حالة/لون AEI نفس الاحتراز الأصفر الظاهر في بانر الامتثال دائماً —
  // القرار السابق (لا تقييد حالة/لون إطلاقاً) كان يُنتج تناقضاً ظاهرياً
  // (بطاقة AEI خضراء "قابل للتنفيذ" تحت بانر أصفر "احتراز — زيادة المراقبة"
  // لنفس اللحظة)، فعُكس صراحة: الحالة الآن MONITOR أصفر بنص decisionLabelAr
  // نفسه الظاهر في بانر الامتثال، لا ALLOW أخضر.
  it('PRECAUTION يُحوّل AEI إلى MONITOR أصفر بنفس نص بانر الاحتراز، لا ALLOW أخضر', () => {
    const dustResults = [
      {
        activityId: '1',
        aei: baseAei(),
        compliance: baseCompliance({
          decisionCategory: 'PRECAUTION',
          decisionLabelAr: 'احتراز — زيادة المراقبة',
          shortReasonAr: 'حالة احتراز: تركيز PM10 (200 ميكروجرام/م³) ضمن نطاق الإنذار المبكر (150–250 ميكروجرام/م³)',
          evidence: { deviceLastReadingAt: new Date().toISOString() },
        }),
      },
    ];
    applyComplianceGatesToDustAei(dustResults, 'project-1');
    expect(dustResults[0].aei.status).toBe('MONITOR');
    expect(dustResults[0].aei.color).toBe('YELLOW');
    expect(dustResults[0].aei.statusLabelAr).toBe('احتراز — زيادة المراقبة');
    expect(dustResults[0].aei.shortReasonAr).toContain('احتراز');
    expect(dustResults[0].aei.shortReasonAr).not.toContain('الظروف آمنة');
  });

  // خطأ مكتشَف ومُصلَح (طلب صريح من المستخدم — "التايمر موجود والقراءات
  // موجودة، أصلح أيضاً"): كان هذا الفرع (HOLD_FOR_VERIFICATION، لا جهاز
  // رصد مرتبط) غائباً بالكامل عن applyFinalDecisionToAei، فيسقط لقراءة
  // compliance.decisionCategory الخام (مثلاً RESTRICT_ACTIVITY مبني على
  // تقدير PM10 من طقس لا جهاز) فيظهر "تقييد تشغيلي" بثقة كاملة رغم أن
  // البانر الموحَّد يعرض "بانتظار تحقق ميداني" لنفس اللحظة. RESTRICT_ACTIVITY
  // (لا MANDATORY_STOP) مُستخدَمة هنا عمداً: MANDATORY_STOP/STOP_AFFECTED_
  // ACTIVITY المؤكَّدان يفوزان قبل فحص evidenceUnavailable في decideFinal
  // (راجع تعليق mandatoryStop في engine.ts) — سلوك صحيح لقواعد هندسية ثابتة
  // (مثال: مسافة كسارة عن سكني) لا تعتمد على قراءة حية أصلاً، فلا يجوز أن
  // يُضعفها غياب الجهاز. RESTRICT_ACTIVITY يمثّل الحالة الفعلية المتأثرة
  // (قرار مبني على قياس متغيّر كـPM10 يحتاج مصدراً موثوقاً حياً).
  it('لا جهاز رصد مرتبط (evidence.deviceLastReadingAt غائب) → AEI يعرض "بانتظار تحقق ميداني" لا RESTRICT العادي', () => {
    const dustResults = [
      {
        activityId: '1',
        aei: baseAei(),
        compliance: baseCompliance({
          decisionCategory: 'RESTRICT_ACTIVITY',
          shortReasonAr: 'تركيز PM10 يتجاوز حد التحذير',
          missingCriticalInputs: [],
          evidence: {}, // لا deviceLastReadingAt إطلاقاً — لا جهاز مرتبط
        }),
      },
    ];
    applyComplianceGatesToDustAei(dustResults, 'project-1');
    expect(dustResults[0].aei.status).toBe('RESTRICT');
    expect(dustResults[0].aei.color).toBe('ORANGE');
    expect(dustResults[0].aei.closedByGate).toBe(false);
    expect(dustResults[0].aei.isHoldForVerification).toBe(true);
    expect(dustResults[0].aei.statusLabelAr).toContain('تحقق ميداني');
  });

  it('جهاز رصد مرتبط بقراءة حديثة → AEI يتبع compliance.decisionCategory طبيعياً (لا isHoldForVerification)', () => {
    const dustResults = [
      {
        activityId: '1',
        aei: baseAei(),
        compliance: baseCompliance({
          decisionCategory: 'RESTRICT_ACTIVITY',
          shortReasonAr: 'تركيز PM10 يتجاوز حد التحذير',
          missingCriticalInputs: [],
          evidence: { deviceLastReadingAt: new Date().toISOString() },
        }),
      },
    ];
    applyComplianceGatesToDustAei(dustResults, 'project-1');
    expect(dustResults[0].aei.isHoldForVerification).toBe(false);
  });

  it('يقص AEI أيضاً عند FIELD_VERIFICATION_REQUIRED (بيانات ناقصة تمنع قراراً حاسماً)', () => {
    const dustResults = [
      {
        activityId: '1',
        aei: baseAei(),
        // evidence.deviceLastReadingAt صريحة (جهاز مرتبط بقراءة حديثة) —
        // هذا الاختبار يفحص قص AEI بسبب FIELD_VERIFICATION_REQUIRED نفسها،
        // لا جودة الأدلة. بلا هذا، evidence غائبة كلياً تعني "لا جهاز مرتبط
        // أصلاً" (راجع deriveEvidenceQuality بعد طلب المستخدم "دايماً يحتاج
        // قراءة حقيقية من الجهاز") فيسقط القرار لـHOLD_FOR_VERIFICATION بدل
        // المسار المقصود فعلياً هنا (RESTRICT عبر floorLevel).
        compliance: baseCompliance({
          decisionCategory: 'FIELD_VERIFICATION_REQUIRED',
          decisionLabelAr: 'يتطلب تحقق ميداني',
          shortReasonAr: 'بيانات ناقصة',
          evidence: { deviceLastReadingAt: new Date().toISOString() },
        }),
      },
    ];
    applyComplianceGatesToDustAei(dustResults, 'project-1');
    expect(dustResults[0].aei.status).toBe('RESTRICT');
    expect(dustResults[0].aei.score).toBe(59);
  });
});

// خطأ معماري مكتشَف ومُصلَح (مراجعة كود خبير خارجي — "القرار النهائي لا
// يُحفظ كقرار رسمي واحد... البطاقة والخريطة والتنبيهات تعيد حساب القرار
// بمعرّفات مختلفة"): applyComplianceGatesToDustAei كانت تستدعي decideFinal
// محلياً دائماً (بمعزل عن final_decisions المخزَّنة من evaluate/route.ts) —
// الآن تقبل finalDecisionsByGroup اختيارياً وتقرأ منه إن توفر، بدل إعادة
// الحساب. هذه الاختبارات تثبت أن الصف المخزَّن يفوز فعلياً على الحساب
// المحلي عند وجوده، ويبقى fallback الحساب المحلي يعمل عند غيابه.
describe('applyComplianceGatesToDustAei — القراءة من final_decisions المخزَّنة بدل إعادة الحساب', () => {
  // ملاحظة على واقعية السيناريو: compliance.decisionCategory هنا (المحلي)
  // ليس ALLOW عمداً — applyFinalDecisionToAei ترجع aei بلا تعديل فوراً إن
  // كان compliance.decisionCategory=ALLOW (سطر compliance?.decisionCategory
  // === 'ALLOW' return aei أعلى هذا الملف)، بصرف النظر عن decision.operationalDecision
  // القادم من أي مصدر. في الإنتاج الفعلي r.compliance وfinal_decisions
  // المخزَّنة يُبنيان من نفس تقييم الامتثال في نفس الاستدعاء تقريباً، فلا
  // يتناقضان على decisionCategory نفسه — الاختلاف الذي يُصلحه هذا التغيير
  // هو نص/تصنيف decision (operationalDecision/shortReasonAr/decisionLabelAr)
  // حين يُعاد حسابه من DVI/AEI بمعزل، لا decisionCategory نفسه.
  it('finalDecisionsByGroup يحمل نص قرار مخزَّن مختلفاً عن الحساب المحلي (نفس decisionCategory غير ALLOW) → النص المعروض من الصف المخزَّن، لا من إعادة الحساب المحلي', () => {
    const dustResults = [
      {
        activityId: '1',
        activityGroupId: 'group-1',
        aei: baseAei(),
        compliance: baseCompliance({
          decisionCategory: 'MANDATORY_STOP',
          shortReasonAr: 'نص محلي لو أُعيد الحساب هنا',
          evidence: { deviceLastReadingAt: new Date().toISOString() },
        }),
      },
    ];
    const finalDecisionsByGroup = new Map<string, StoredFinalDecisionRow>([
      [
        activityDecisionKey('project-1', 'group-1'),
        {
          activity_group_id: 'group-1',
          level: 'BLACK',
          operational_decision: 'MANDATORY_STOP',
          short_reason_ar: 'إيقاف إلزامي مخزَّن من evaluate/route.ts',
          decision_label_ar: 'إيقاف إلزامي نظامي',
          pending_confirmation: false,
          mandatory_stop: true,
        },
      ],
    ]);
    applyComplianceGatesToDustAei(dustResults, 'project-1', finalDecisionsByGroup);
    expect(dustResults[0].aei.status).toBe('CLOSED');
    expect(dustResults[0].aei.score).toBe(0);
    // النص المعروض هو نص الصف المخزَّن تحديداً، لا "نص محلي لو أُعيد الحساب
    // هنا" — يثبت أن الدالة قرأت من finalDecisionsByGroup فعلياً، لا أعادت
    // الحساب محلياً رغم توفر الخريطة.
    expect(dustResults[0].aei.shortReasonAr).toBe('إيقاف إلزامي مخزَّن من evaluate/route.ts');
  });

  it('لا صف مخزَّن لهذا activityGroupId (خريطة فارغة) → fallback للحساب المحلي كالسابق تماماً', () => {
    const dustResults = [
      {
        activityId: '1',
        activityGroupId: 'group-no-stored-row',
        aei: baseAei(),
        compliance: baseCompliance({
          decisionCategory: 'MANDATORY_STOP',
          shortReasonAr: 'إيقاف محلي',
          evidence: { deviceLastReadingAt: new Date().toISOString() },
        }),
      },
    ];
    applyComplianceGatesToDustAei(dustResults, 'project-1', new Map());
    expect(dustResults[0].aei.status).toBe('CLOSED');
    expect(dustResults[0].aei.shortReasonAr).toBe('إيقاف محلي');
  });

  it('finalDecisionsByGroup غير مُمرَّرة إطلاقاً (undefined) → نفس سلوك الاستدعاء القديم بلا تغيير', () => {
    const dustResults = [
      {
        activityId: '1',
        activityGroupId: 'group-x',
        aei: baseAei(),
        compliance: baseCompliance({
          decisionCategory: 'MANDATORY_STOP',
          shortReasonAr: 'إيقاف محلي بلا خريطة',
          evidence: { deviceLastReadingAt: new Date().toISOString() },
        }),
      },
    ];
    applyComplianceGatesToDustAei(dustResults, 'project-1');
    expect(dustResults[0].aei.status).toBe('CLOSED');
    expect(dustResults[0].aei.shortReasonAr).toBe('إيقاف محلي بلا خريطة');
  });

  // خطأ مكتشَف ومُصلَح — طلب صريح من المستخدم: "شوف الفرق" (نشاط محطة خلط
  // PLANNING عرض مرة "قابل للتنفيذ مع مراقبة" ومرة "بيئة العمل غير آمنة
  // (مغلق)" لنفس اللحظة ونفس البيانات، بين تحميلين متتاليين). السبب: mode
  // لم تكن تُحسَب من startIso إطلاقاً هنا (تثبت دائماً LIVE_OPERATIONAL)،
  // وstoredRow قديم (قد يكون محسوباً بوضع LIVE_OPERATIONAL من دورة سابقة
  // مختلفة السياق) كان يُستخدَم مباشرة بلا أي فحص لتطابقه مع PLANNING.
  it('نشاط PLANNING (startIso بعيد) مع storedRow قديم "مغلق" → يتجاهل الصف المخزَّن ويحسب PLANNING محلياً بدل عرض إيقاف قديم', () => {
    const farFutureIso = new Date(Date.now() + 5 * 3600000).toISOString(); // بعد 5 ساعات — خارج هامش الساعتين
    const dustResults = [
      {
        activityId: '1',
        activityGroupId: 'group-batching',
        startIso: farFutureIso,
        aei: baseAei(),
        windowEval: { worst: baseDvi({ decisionCategory: 'ALLOW' }) },
        compliance: baseCompliance({
          decisionCategory: 'MANDATORY_STOP',
          shortReasonAr: 'لن تُقرأ — compliance المحلي غير ALLOW لكن mode=PLANNING يمنع أي تصعيد',
          evidence: { deviceLastReadingAt: null, pm10UgM3: 1557.2 },
        }),
      },
    ];
    // صف قديم مخزَّن يقول "إيقاف إلزامي مغلق" — من دورة LIVE_OPERATIONAL
    // سابقة، غير ذي صلة بلحظة PLANNING الحالية.
    const finalDecisionsByGroup = new Map<string, StoredFinalDecisionRow>([
      [
        activityDecisionKey('project-1', 'group-batching'),
        {
          activity_group_id: 'group-batching',
          level: 'BLACK',
          operational_decision: 'MANDATORY_STOP',
          short_reason_ar: 'إيقاف إلزامي مخزَّن من دورة سابقة',
          decision_label_ar: 'إيقاف إلزامي نظامي',
          pending_confirmation: false,
          mandatory_stop: true,
        },
      ],
    ]);
    applyComplianceGatesToDustAei(dustResults, 'project-1', finalDecisionsByGroup);

    // لا يجوز أن يظهر "مغلق/CLOSED" من الصف القديم — mode=PLANNING يمنع أي
    // إيقاف إلزامي حقيقي، بصرف النظر عن أي مصدر (قديم مخزَّن أو محلي).
    expect(dustResults[0].aei.status).not.toBe('CLOSED');
    expect(dustResults[0].aei.closedByGate).toBe(false);
  });
});

describe('isRegulatoryWindGateActive — بوابة الرياح التنظيمية الساعية', () => {
  it('تُفعَّل عند رياح >25 كم/س لنشاط مكشوف مولّد للغبار', () => {
    expect(isRegulatoryWindGateActive(29.66, true, false)).toBe(true);
  });

  it('لا تُفعَّل عند رياح =25 كم/س بالضبط (الحد الأعلى للنطاق المتوسط)', () => {
    expect(isRegulatoryWindGateActive(25, true, false)).toBe(false);
  });

  it('لا تُفعَّل لعملية مغلقة حتى مع رياح شديدة', () => {
    expect(isRegulatoryWindGateActive(30, true, true)).toBe(false);
  });

  it('لا تُفعَّل لنشاط غير مولّد للغبار', () => {
    expect(isRegulatoryWindGateActive(30, false, false)).toBe(false);
  });

  it('لا تُفعَّل مع رياح غير معروفة (null)', () => {
    expect(isRegulatoryWindGateActive(null, true, false)).toBe(false);
  });
});
