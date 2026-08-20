import { describe, it, expect } from 'vitest';
import { buildFinalDecisionInput } from './adapters';
import { decideFinal } from './engine';
import type { DviEvaluationResult } from '@/app/utils/dust-engine/types';
import type { DustComplianceResult } from '@/app/utils/dust-compliance-engine/types';

// =====================================================================
// خطأ معماري مكتشَف ومُصلَح (طلب صريح من المستخدم — "لا تجعل API الطقس
// يحضر القراءة حق ساعة النشاط، دايماً اجعله يحتاج قراءة حقيقية من
// الجهاز"): كان deriveEvidenceQuality يتخطّى فحص STALE بالكامل عندما لا
// يوجد جهاز مرتبط أصلاً (evidence.deviceLastReadingAt === undefined)،
// فيسقط لتقييم confidenceScore وحده (مبني على تقدير Open-Meteo) وقد يصل
// OK كاملة — قرار حي واثق (ALLOW أو STOP) مبني على تقدير جوي، لا قراءة
// جهاز حقيقية. الآن: غياب الجهاز كلياً → UNAVAILABLE دائماً في التقييم
// الحي (LIVE_OPERATIONAL)، فيصبح operationalDecision=HOLD_FOR_VERIFICATION
// عبر decideFinal، بصرف النظر عن مدى "جودة" أو "ثقة" تقدير الطقس.
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
    },
    visibilityKm: 5,
    effectiveWindKmh: 10,
    visibilityDataMissing: false,
    dustExposureHigh: false,
    triggeredRules: [],
    requiredActions: [],
    shortReason: 'تقييد العمل: وجود فجوة في إجراءات التحكم الميدانية.',
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
      // deviceLastReadingAt عمداً غير موجود هنا — كل اختبار يمرّره صراحةً
      // حسب السيناريو المطلوب (undefined/null/تاريخ حديث/تاريخ قديم).
    },
    caveatsAr: [],
    resumeHoldApplied: false,
    ...overrides,
  } as DustComplianceResult;
}

describe('buildFinalDecisionInput/deriveEvidenceQuality — لا قرار حي بلا جهاز رصد حقيقي', () => {
  it('لا جهاز مرتبط أصلاً (deviceLastReadingAt===undefined) → evidenceQuality=UNAVAILABLE حتى مع confidenceScore عالٍ', () => {
    const compliance = baseCompliance(); // evidence.deviceLastReadingAt غائب تماماً
    const finalInput = buildFinalDecisionInput('snap-1', baseDvi(), compliance, null, 'LIVE_OPERATIONAL');
    expect(finalInput.evidenceQuality).toBe('UNAVAILABLE');
  });

  it('لا جهاز مرتبط أصلاً → operationalDecision=HOLD_FOR_VERIFICATION عبر decideFinal (لا ALLOW حي مبني على تقدير طقس)', () => {
    const compliance = baseCompliance({ decisionCategory: 'ALLOW' });
    const finalInput = buildFinalDecisionInput('snap-1', baseDvi({ decisionCategory: 'ALLOW', mandatoryStop: false }), compliance, null, 'LIVE_OPERATIONAL');
    const decision = decideFinal(finalInput);
    expect(decision.operationalDecision).toBe('HOLD_FOR_VERIFICATION');
    expect(decision.regulatoryFinding).toBe('NOT_DETERMINABLE');
  });

  it('جهاز مرتبط بقراءة حديثة (deviceLastReadingAt=الآن) → evidenceQuality=OK، قرار حي طبيعي', () => {
    const compliance = baseCompliance({
      evidence: { ...baseCompliance().evidence, deviceLastReadingAt: new Date().toISOString() },
    });
    const finalInput = buildFinalDecisionInput('snap-1', baseDvi(), compliance, null, 'LIVE_OPERATIONAL');
    expect(finalInput.evidenceQuality).toBe('OK');
    const decision = decideFinal(finalInput);
    expect(decision.operationalDecision).not.toBe('HOLD_FOR_VERIFICATION');
  });

  it('جهاز مرتبط لكن بلا قراءة PM10 قط (deviceLastReadingAt=null) → evidenceQuality=STALE (لا UNAVAILABLE)', () => {
    const compliance = baseCompliance({
      evidence: { ...baseCompliance().evidence, deviceLastReadingAt: null },
    });
    const finalInput = buildFinalDecisionInput('snap-1', baseDvi(), compliance, null, 'LIVE_OPERATIONAL');
    expect(finalInput.evidenceQuality).toBe('STALE');
  });

  it('جهاز مرتبط بقراءة قديمة جداً (أقدم من 10 دقائق) → evidenceQuality=STALE', () => {
    const staleTime = new Date(Date.now() - 45 * 60000).toISOString();
    const compliance = baseCompliance({
      evidence: { ...baseCompliance().evidence, deviceLastReadingAt: staleTime },
    });
    const finalInput = buildFinalDecisionInput('snap-1', baseDvi(), compliance, null, 'LIVE_OPERATIONAL');
    expect(finalInput.evidenceQuality).toBe('STALE');
  });

  // خطأ مكتشَف ومُصلَح (طلب صريح من المستخدم — "القراءة المستقبلية: محرك
  // الامتثال يصفها FUTURE، لكن محرك القرار النهائي قد يمنحها OK بسبب عدم
  // رفض العمر السالب"): dust-compliance-engine/adapters.ts يتحقق من عمر
  // سالب لتصنيف PM10 تحديداً (pm10EvidenceState='FUTURE')، لكن هذا التصنيف
  // معزول تماماً ولا يصل لـderiveEvidenceQuality هنا — الأخيرة كانت تعيد
  // اشتقاق العمر بشكل مستقل من نفس الطابع الزمني الخام بلا أي حراسة، فرقم
  // سالب (قراءة بتوقيت مستقبلي، خلل ساعة جهاز) يحقق `ageMinutes >
  // DEVICE_READING_FRESHNESS_MINUTES` بقيمة false تلقائياً، متجاوزاً شرط
  // STALE بالكامل وواصلاً حتى OK — أعلى ثقة ممكنة لقراءة فاسدة زمنياً.
  it('جهاز مرتبط بقراءة بتوقيت مستقبلي (خلل ساعة الجهاز — عمر سالب) → evidenceQuality=STALE، لا OK', () => {
    const futureTime = new Date(Date.now() + 10 * 60000).toISOString(); // بعد 10 دقائق من الآن
    const compliance = baseCompliance({
      evidence: { ...baseCompliance().evidence, deviceLastReadingAt: futureTime },
    });
    const finalInput = buildFinalDecisionInput('snap-1', baseDvi(), compliance, null, 'LIVE_OPERATIONAL');
    expect(finalInput.evidenceQuality).toBe('STALE');
    expect(finalInput.evidenceQuality).not.toBe('OK');
  });

  it('قراءة PM10 بتوقيت مستقبلي بالنسبة لـevaluatedAt نفسه (لا Date.now())، بينما deviceLastReadingAt حديثة → evidenceQuality=STALE (referenceReadingAt يفضّل devicePm10LastReadingAt)', () => {
    const evaluatedAt = new Date('2026-01-01T12:00:00.000Z').toISOString();
    const futurePm10Reading = new Date('2026-01-01T12:05:00.000Z').toISOString(); // بعد evaluatedAt بـ5 دقائق
    const compliance = baseCompliance({
      evidence: {
        ...baseCompliance().evidence,
        deviceLastReadingAt: evaluatedAt,
        devicePm10LastReadingAt: futurePm10Reading,
      },
    });
    const finalInput = buildFinalDecisionInput('snap-1', baseDvi(), compliance, null, 'LIVE_OPERATIONAL', evaluatedAt);
    expect(finalInput.evidenceQuality).toBe('STALE');
  });

  it('mandatoryStop فيزيائي حقيقي (DVI) يفوز حتى بلا جهاز مرتبط — خطر فيزيائي لا ينتظر قراءة جهاز', () => {
    const compliance = baseCompliance(); // بلا جهاز مرتبط
    const finalInput = buildFinalDecisionInput(
      'snap-1',
      baseDvi({ mandatoryStop: true, overridable: false }),
      compliance,
      null,
      'LIVE_OPERATIONAL'
    );
    expect(finalInput.evidenceQuality).toBe('UNAVAILABLE');
    const decision = decideFinal(finalInput);
    expect(decision.operationalDecision).toBe('MANDATORY_STOP');
  });

  it('وضع PLANNING (شبكة توقعات مستقبلية) لا يتأثر بغياب الجهاز — لا يُطلَب تحقق ميداني من توقّع', () => {
    const compliance = baseCompliance(); // بلا جهاز مرتبط
    const finalInput = buildFinalDecisionInput('snap-1', baseDvi(), compliance, null, 'PLANNING');
    expect(finalInput.evidenceQuality).toBe('UNAVAILABLE'); // التصنيف نفسه لا يتغيّر بالـmode
    const decision = decideFinal(finalInput);
    expect(decision.operationalDecision).not.toBe('HOLD_FOR_VERIFICATION'); // لكن PLANNING لا يُصعِّد له
  });
});

// خطأ مكتشَف ومُصلَح (مراجعة كود مدير — "evidenceQuality=PARTIAL قد ينتج
// ALLOW+COMPLIANT" و"غياب compliance ينتج COMPLIANT بدل NOT_DETERMINABLE"):
// deriveEvidenceQuality(null) كانت تُرجع PARTIAL دائماً، بافتراض أن
// compliance=null يحدث فقط في PLANNING (توقّع مستقبلي بسيط). لكن
// buildFinalDecisionInput يُستدعى فعلياً بـcompliance=null من مسارات
// LIVE_OPERATIONAL حقيقية (applyComplianceGatesToDustAei وcomputeUnifiedActivityDecision
// بـdustEvaluation.ts، إن فشلت computeDustComplianceResults أو أرجعت نتيجة
// فارغة) — فيصل PARTIAL هناك أيضاً، ولا يُصعِّد لـHOLD_FOR_VERIFICATION
// (بتصميم متعمَّد: "نقص غير حرج")، فيستمر القرار الحي يُبنى من dvi وحده
// بثقة كاملة رغم غياب أي تقييم امتثال إطلاقاً.
describe('deriveEvidenceQuality — compliance=null يختلف حسب mode', () => {
  it('compliance=null في LIVE_OPERATIONAL → UNAVAILABLE (لا PARTIAL) → HOLD_FOR_VERIFICATION/NOT_DETERMINABLE', () => {
    const finalInput = buildFinalDecisionInput('snap-1', baseDvi(), null, null, 'LIVE_OPERATIONAL');
    expect(finalInput.evidenceQuality).toBe('UNAVAILABLE');
    const decision = decideFinal(finalInput);
    expect(decision.operationalDecision).toBe('HOLD_FOR_VERIFICATION');
    expect(decision.regulatoryFinding).toBe('NOT_DETERMINABLE');
    expect(decision.decisionLabelAr).not.toBe(baseDvi().decisionLabelAr);
  });

  it('compliance=null في PLANNING → PARTIAL كما كان (لا يتصعَّد أصلاً في هذا الـmode، فلا فرق عملي)', () => {
    const finalInput = buildFinalDecisionInput('snap-1', baseDvi(), null, null, 'PLANNING');
    expect(finalInput.evidenceQuality).toBe('PARTIAL');
    const decision = decideFinal(finalInput);
    expect(decision.operationalDecision).not.toBe('HOLD_FOR_VERIFICATION');
  });

  it('mandatoryStop فيزيائي حقيقي (رؤية حرجة، لا PM10) يفوز حتى مع compliance=null في LIVE_OPERATIONAL', () => {
    const dvi = baseDvi({ mandatoryStop: true, overridable: false, triggeredRules: ['DVI-VISIBILITY-MANDATORY-STOP-001'] });
    const finalInput = buildFinalDecisionInput('snap-1', dvi, null, null, 'LIVE_OPERATIONAL');
    const decision = decideFinal(finalInput);
    expect(decision.operationalDecision).toBe('MANDATORY_STOP');
    expect(decision.mandatoryStop).toBe(true);
  });
});

// خطأ مكتشَف ومُصلَح (مراجعة كود مدير — "القراءة القديمة قد تنتج إيقافاً
// إلزامياً إذا كان DVI قد أوقفها أولاً"): dvi.mandatoryStop كان يفوز دائماً
// حتى مع evidenceUnavailable=true (قراءة PM10 قديمة/غير متوفرة) — لخطر
// فيزيائي *حقيقي* (رؤية حرجة/عاصفة) هذا صحيح (لا ينتظر تحقق بيانات)، لكن
// خاطئ حين يكون PM10 اللحظي نفسه (لا خطر فيزيائي آخر) هو سبب dvi.mandatoryStop
// الوحيد — قراءة قديمة لا يجوز أن "تُثبت" إيقافاً إلزامياً حياً.
describe('decideFinal — dvi.mandatoryStop المبني على PM10 لحظي لا يفوز مع قراءة قديمة/غير متوفرة', () => {
  it('dvi.mandatoryStop=true بسبب PM10 لحظي فقط (DVI-DUST-ACTIVITY-STOP-004-PM10-ONLY) + evidenceQuality=STALE + امتثال نظيف (ALLOW) → لا يُعتمَد، HOLD_FOR_VERIFICATION بدلاً من MANDATORY_STOP', () => {
    const dvi = baseDvi({
      mandatoryStop: true,
      overridable: false,
      triggeredRules: ['DVI-DUST-ACTIVITY-STOP-004', 'DVI-DUST-ACTIVITY-STOP-004-PM10-ONLY'],
      stopBasis: 'PM10',
      confirmationState: 'PENDING',
    });
    // امتثال نظيف عمداً هنا (لا STOP_AFFECTED_ACTIVITY/pendingConfirmation)
    // — يعزل اختبار dviPm10StopIsUnreliable بمعزل عن pendingAffectedStop
    // (ذاك مسار مختلف مُختبَر بالفعل في engine.test.ts). السبب الوحيد لعدم
    // اعتماد dvi.mandatoryStop هنا هو قِدم القراءة (STALE) + كون PM10
    // اللحظي هو مصدره الوحيد، لا أي قرار امتثال معلَّق.
    const compliance = baseCompliance({
      decisionCategory: 'ALLOW',
      evidence: { ...baseCompliance().evidence, deviceLastReadingAt: new Date(Date.now() - 40 * 60000).toISOString() },
    });
    const finalInput = buildFinalDecisionInput('snap-1', dvi, compliance, null, 'LIVE_OPERATIONAL');
    expect(finalInput.evidenceQuality).toBe('STALE');
    const decision = decideFinal(finalInput);
    expect(decision.mandatoryStop).toBe(false);
    expect(decision.operationalDecision).toBe('HOLD_FOR_VERIFICATION');
  });

  it('dvi.mandatoryStop=true بسبب خطر فيزيائي حقيقي (لا PM10 لحظي) + evidenceQuality=STALE → يبقى MANDATORY_STOP (لا ينتظر تحقق بيانات)', () => {
    const dvi = baseDvi({
      mandatoryStop: true,
      overridable: false,
      triggeredRules: ['DVI-VISIBILITY-MANDATORY-STOP-001'], // رؤية حرجة، لا PM10-ONLY
    });
    const compliance = baseCompliance({
      decisionCategory: 'ALLOW',
      evidence: { ...baseCompliance().evidence, deviceLastReadingAt: new Date(Date.now() - 40 * 60000).toISOString() },
    });
    const finalInput = buildFinalDecisionInput('snap-1', dvi, compliance, null, 'LIVE_OPERATIONAL');
    expect(finalInput.evidenceQuality).toBe('STALE');
    const decision = decideFinal(finalInput);
    expect(decision.mandatoryStop).toBe(true);
    expect(decision.operationalDecision).toBe('MANDATORY_STOP');
  });

  // إصلاح P0 لاحق (راجع engine.ts — dviMandatoryCandidate وdviMandatoryStopIsPm10Only):
  // كانت هذه الحالة تفترض أن قراءة PM10 اللحظية الحديثة وحدها كافية لإصدار
  // MANDATORY_STOP عبر DVI. لكن الإيقاف الرسمي الخاص بـPM10 يجب أن يأتي حصراً
  // من محرك الامتثال (RiyadhDustComplianceEngine) بعد تجاوز فعلي مؤكَّد
  // لمدة 30 دقيقة، لا من DVI (الذي لا يعرف شيئاً عن آلة حالة الاستمرارية
  // 2/30 دقيقة — راجع dust-engine/engine.ts). stopBasis='PM10' يبقى دوماً
  // PENDING (بلا انتهاء صلاحية زمني)، فهو غير موثوق لوحده بصرف النظر عن
  // حداثة القراءة (evidenceQuality). compliance هنا ALLOW نظيف (لا استمرارية
  // مؤكَّدة) → لا MANDATORY_STOP.
  it('dvi.mandatoryStop=true بسبب PM10 لحظي فقط + evidenceQuality=OK (قراءة حديثة)، بلا استمرارية مؤكَّدة من الامتثال → لا MANDATORY_STOP (الإيقاف الرسمي لـPM10 يأتي من محرك الامتثال فقط)', () => {
    const dvi = baseDvi({
      mandatoryStop: true,
      overridable: false,
      triggeredRules: ['DVI-DUST-ACTIVITY-STOP-004', 'DVI-DUST-ACTIVITY-STOP-004-PM10-ONLY'],
      stopBasis: 'PM10',
      confirmationState: 'PENDING',
    });
    const compliance = baseCompliance({
      decisionCategory: 'ALLOW',
      evidence: { ...baseCompliance().evidence, deviceLastReadingAt: new Date().toISOString() },
    });
    const finalInput = buildFinalDecisionInput('snap-1', dvi, compliance, null, 'LIVE_OPERATIONAL');
    expect(finalInput.evidenceQuality).toBe('OK');
    const decision = decideFinal(finalInput);
    expect(decision.mandatoryStop).toBe(false);
    expect(decision.operationalDecision).not.toBe('MANDATORY_STOP');
  });
});

// خطأ مكتشَف ومُصلَح (طلب صريح من المستخدم — "جودة الدليل تعتمد على
// Date.now() بدل وقت التقييم، بينما بصمة المدخلات لا تشملها؛ قد ينتج replay
// لاحق قراراً مختلفاً لنفس البصمة"): deriveEvidenceQuality كانت تستدعي
// Date.now() ضمنياً بدل استقبال nowMs — فحساب عمر القراءة كان يعتمد على
// لحظة تنفيذ الكود الفعلية، لا على evaluatedAt المخزَّن رسمياً كوقت
// التقييم. الاختبارات التالية تثبّت الإصلاح: تمرير evaluatedAt بعيداً جداً
// عن Date.now() الحقيقي (سواء ماضياً أو مستقبلاً) يجب أن يُنتج evidenceQuality
// متسقة مع evaluatedAt نفسه، لا مع لحظة تنفيذ الاختبار.
describe('evidenceQuality تُحسَب بالنسبة لـevaluatedAt الممرَّر، لا Date.now() الحقيقي', () => {
  it('قراءة عمرها 3 دقائق بالنسبة لـevaluatedAt ماضٍ بعيد (لا الآن الحقيقي) → OK، رغم أن نفس القراءة قديمة جداً بالنسبة للحظة الفعلية', () => {
    const farPastEvaluatedAt = new Date(Date.now() - 10 * 24 * 3600000).toISOString(); // قبل 10 أيام
    const readingAt = new Date(new Date(farPastEvaluatedAt).getTime() - 3 * 60000).toISOString(); // قبل evaluatedAt بـ3 دقائق فقط
    const compliance = baseCompliance({
      evidence: { ...baseCompliance().evidence, deviceLastReadingAt: readingAt },
    });
    const finalInput = buildFinalDecisionInput('snap-1', baseDvi(), compliance, null, 'LIVE_OPERATIONAL', farPastEvaluatedAt);
    // لو كانت الدالة لا تزال تستخدم Date.now() الحقيقي، هذه القراءة (قبل 10
    // أيام تقريباً) كانت ستُصنَّف STALE قطعاً — التصنيف الصحيح STALE فقط لو
    // اعتمدت على evaluatedAt نفسه (3 دقائق فرق، ضمن حد 4 دقائق) لتصبح OK.
    expect(finalInput.evidenceQuality).toBe('OK');
  });

  it('نفس السيناريو لكن عمر القراءة 5 دقائق بالنسبة لـevaluatedAt (يتجاوز حد 4 دقائق) → STALE', () => {
    const farPastEvaluatedAt = new Date(Date.now() - 10 * 24 * 3600000).toISOString();
    const readingAt = new Date(new Date(farPastEvaluatedAt).getTime() - 5 * 60000).toISOString();
    const compliance = baseCompliance({
      evidence: { ...baseCompliance().evidence, deviceLastReadingAt: readingAt },
    });
    const finalInput = buildFinalDecisionInput('snap-1', baseDvi(), compliance, null, 'LIVE_OPERATIONAL', farPastEvaluatedAt);
    expect(finalInput.evidenceQuality).toBe('STALE');
  });

  it('evaluatedAt مستقبلي (توقّع/محاكاة) مع قراءة "حديثة" بالنسبة له فقط → OK، لا يعتمد على الآن الحقيقي', () => {
    const farFutureEvaluatedAt = new Date(Date.now() + 10 * 24 * 3600000).toISOString();
    const readingAt = new Date(new Date(farFutureEvaluatedAt).getTime() - 2 * 60000).toISOString();
    const compliance = baseCompliance({
      evidence: { ...baseCompliance().evidence, deviceLastReadingAt: readingAt },
    });
    const finalInput = buildFinalDecisionInput('snap-1', baseDvi(), compliance, null, 'LIVE_OPERATIONAL', farFutureEvaluatedAt);
    expect(finalInput.evidenceQuality).toBe('OK');
  });
});
