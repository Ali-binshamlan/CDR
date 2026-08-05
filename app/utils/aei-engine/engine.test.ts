import { describe, expect, it } from 'vitest';
import { evaluateAei } from './engine';
import { AEI_RESTRICT_CAP } from './tables';
import type { DviEvaluationResult } from '../dust-engine/types';

// لا تغطية مباشرة سابقة لـevaluateAei في هذا المشروع (راجع مراجعة الكود) —
// تحديداً فرع forceRestrict الذي يجبر status إلى 'RESTRICT' حتى لو الدرجة
// الرقمية بعد السقف (score <= AEI_RESTRICT_CAP) كانت لتصنَّف MONITOR بموجب
// aeiStatusFromScore وحدها (59 <= 69). بلا هذا الإجبار: نشاط بقرار DVI مقيّد
// فعلياً (مثال: RESTRICT_SEVERE) قد تظهر بطاقة AEI الخاصة به "قابل للتنفيذ
// مع مراقبة" (MONITOR) بدل "تقييد تشغيلي" — تناقض بصري بين مؤشرين يصفان نفس
// النشاط بنفس اللحظة.
function baseDvi(overrides: Partial<DviEvaluationResult> = {}): DviEvaluationResult {
  return {
    indicatorType: 'DVI',
    dviBase: 10,
    score: 10,
    level: 'GREEN',
    causeClassification: 'UNKNOWN',
    decisionCategory: 'ALLOW',
    decisionLabelAr: 'تشغيل عادي',
    mandatoryStop: false,
    overridable: false,
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
      activitySensitivity: 0.5,
      activitySensitivityMultiplier: 1,
      receptorSensitivity: 0.5,
      downwindAlignment: 0,
      distanceFactor: 1,
      receptorImpact: 0,
      receptorSensitivityMultiplier: 1,
      mitigationScore: 0,
      mitigationReductionFactor: 1,
    },
    visibilityKm: 10,
    effectiveWindKmh: 5,
    visibilityDataMissing: false,
    visibilityConstraint: false,
    mandatoryVisibilityStop: false,
    respiratoryPPERequired: false,
    dustExposureHigh: false,
    outdoorWorkRestriction: false,
    triggeredRules: [],
    requiredActions: [],
    shortReason: 'ظروف طبيعية',
    topRiskDrivers: [],
    riskReducers: [],
    caveatsAr: [],
    confidenceScore: 1,
    confidenceLabel: 'عالية',
    validUntil: new Date().toISOString(),
    ...overrides,
  };
}

describe('AEI engine — البوابة الحاكمة (mandatoryStop)', () => {
  it('DVI بإيقاف إلزامي → AEI مُغلَق تماماً بصرف النظر عن أي درجة', () => {
    const result = evaluateAei(baseDvi({ mandatoryStop: true, decisionCategory: 'MANDATORY_STOP' }), 'EXCAVATION');
    expect(result.status).toBe('CLOSED');
    expect(result.score).toBe(0);
    expect(result.closedByGate).toBe(true);
  });
});

describe('AEI engine — الإجبار المنطقي لتطابق الحالة مع التقييد (forceRestrict)', () => {
  it('قرار DVI مقيَّد (RESTRICT_SEVERE) مع درجة أساس مرتفعة → status يُجبَر RESTRICT لا MONITOR، وscore لا يتجاوز السقف', () => {
    // safety/quality score لكلاهما = 100 عند score DVI=0 وactivity غير حساس
    // جودة — baseScore=100 قبل السقف؛ AEI_RESTRICT_CAP=59 يقصّه لاحقاً.
    const dvi = baseDvi({
      score: 0,
      decisionCategory: 'RESTRICT_SEVERE',
      decisionLabelAr: 'تقييد شديد',
    });
    const result = evaluateAei(dvi, 'EXCAVATION');

    expect(result.cappedByGate).toBe(true);
    expect(result.score).toBeLessThanOrEqual(AEI_RESTRICT_CAP);
    // لولا الإجبار: aeiStatusFromScore(59) === 'MONITOR' (59 <= 69) — الفحص
    // هنا يتحقق أن forceRestrict يقلبها إلى 'RESTRICT' فعلاً.
    expect(result.status).toBe('RESTRICT');
  });

  it('قرار DVI ALLOW_WITH_MONITORING مع status محسوبة ALLOW → تُخفَّض إلى MONITOR (طلب تطابق البانر/البطاقة)', () => {
    const dvi = baseDvi({
      score: 5,
      decisionCategory: 'ALLOW_WITH_MONITORING',
      decisionLabelAr: 'تشغيل مع مراقبة',
    });
    const result = evaluateAei(dvi, 'EXCAVATION');

    expect(result.cappedByGate).toBe(false); // ليس ضمن AEI_CAPPING_DVI_DECISIONS
    expect(result.status).toBe('MONITOR');
  });

  it('قرار DVI عادي (ALLOW) بدرجة عالية → لا سقف ولا إجبار، status تبقى ALLOW', () => {
    const dvi = baseDvi({ score: 0, decisionCategory: 'ALLOW' });
    const result = evaluateAei(dvi, 'EXCAVATION');

    expect(result.cappedByGate).toBe(false);
    expect(result.closedByGate).toBe(false);
    expect(result.status).toBe('ALLOW');
  });
});
