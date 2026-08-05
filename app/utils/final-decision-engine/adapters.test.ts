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

  it('dvi.mandatoryStop=true بسبب PM10 لحظي فقط + evidenceQuality=OK (قراءة حديثة) → يبقى MANDATORY_STOP كالمعتاد (لا تغيير هنا)', () => {
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
    expect(decision.mandatoryStop).toBe(true);
    expect(decision.operationalDecision).toBe('MANDATORY_STOP');
  });
});
