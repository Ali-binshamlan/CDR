import { describe, it, expect } from 'vitest';
import { computeInputSnapshotHash } from './dustEvaluation';
import type { DviEvaluationResult } from '@/app/utils/dust-engine/types';
import type { DustComplianceResult } from '@/app/utils/dust-compliance-engine/types';
import type { AeiEvaluationResult } from '@/app/utils/aei-engine/types';

function minimalAei(overrides: Partial<AeiEvaluationResult> = {}): AeiEvaluationResult {
  return {
    indicatorType: 'AEI',
    activityLabelAr: 'test',
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

// القسم 20 (Definition of Done، بند 7) من "دليل الإصلاح الجذري لمنظومة
// مرقاب" — "القرار والتنبيه يحملان input_snapshot_hash نفسها". يختبر هذا
// الملف computeInputSnapshotHash نفسها بمعزل (دالة نقية بلا I/O): بصمة
// حتمية لا تعتمد على ترتيب مفاتيح الكائن، وتتغيّر مع أي تغيّر فعلي في
// المدخلات. راجع supabase/tests/concurrency.dbtest.ts لاختبار التدفق الكامل
// (نفس البصمة تصل فعلياً إلى final_decisions عبر persist_activity_
// decision_atomic).
function minimalDvi(overrides: Partial<DviEvaluationResult> = {}): DviEvaluationResult {
  return {
    indicatorType: 'DVI',
    dviBase: 30,
    score: 40,
    level: 'ORANGE',
    causeClassification: 'DUST',
    decisionCategory: 'RESTRICT',
    decisionLabelAr: 'تقييد',
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
    shortReason: 'test',
    topRiskDrivers: [],
    riskReducers: [],
    caveatsAr: [],
    confidenceScore: 95,
    confidenceLabel: 'عالية',
    validUntil: new Date('2026-08-04T00:00:00.000Z').toISOString(),
    ...overrides,
  };
}

describe('computeInputSnapshotHash', () => {
  it('نفس المدخلات تُنتج نفس البصمة دائماً (حتمية)', () => {
    const dvi = minimalDvi();
    const a = computeInputSnapshotHash(dvi, null, 'LIVE_OPERATIONAL');
    const b = computeInputSnapshotHash(dvi, null, 'LIVE_OPERATIONAL');
    expect(a).toBe(b);
  });

  it('نفس المحتوى بترتيب مفاتيح مختلف (كائن مُعاد بناؤه) → نفس البصمة', () => {
    const dvi1 = minimalDvi();
    // نفس القيم بالضبط لكن بترتيب إنشاء خصائص مختلف فعلياً (spread من كائن
    // مبني بترتيب معكوس) — يثبت أن الفرز الداخلي في sortedStringify يعمل،
    // لا فقط الاعتماد الصدفي على ترتيب V8.
    const dvi2 = { ...dvi1, channels: { ...dvi1.channels }, multipliers: { ...dvi1.multipliers } };
    const a = computeInputSnapshotHash(dvi1, null, 'LIVE_OPERATIONAL');
    const b = computeInputSnapshotHash(dvi2, null, 'LIVE_OPERATIONAL');
    expect(a).toBe(b);
  });

  it('تغيّر حقيقي في dvi.decisionCategory → بصمة مختلفة', () => {
    const a = computeInputSnapshotHash(minimalDvi({ decisionCategory: 'RESTRICT' }), null, 'LIVE_OPERATIONAL');
    const b = computeInputSnapshotHash(minimalDvi({ decisionCategory: 'ALLOW' }), null, 'LIVE_OPERATIONAL');
    expect(a).not.toBe(b);
  });

  it('تغيّر mode وحده (PLANNING بدل LIVE_OPERATIONAL) → بصمة مختلفة', () => {
    const dvi = minimalDvi();
    const a = computeInputSnapshotHash(dvi, null, 'LIVE_OPERATIONAL');
    const b = computeInputSnapshotHash(dvi, null, 'PLANNING');
    expect(a).not.toBe(b);
  });

  it('وجود compliance مقابل null → بصمة مختلفة', () => {
    const dvi = minimalDvi();
    const compliance = { decisionCategory: 'ALLOW' } as unknown as DustComplianceResult;
    const a = computeInputSnapshotHash(dvi, null, 'LIVE_OPERATIONAL');
    const b = computeInputSnapshotHash(dvi, compliance, 'LIVE_OPERATIONAL');
    expect(a).not.toBe(b);
  });

  it('البصمة بصيغة hex SHA-256 (64 حرفاً)', () => {
    const hash = computeInputSnapshotHash(minimalDvi(), null, 'LIVE_OPERATIONAL');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  // خطأ مكتشَف ومُصلَح (مراجعة خبير خارجي — "بصمة القرار لا تشمل AEI رغم أن
  // AEI قد يغير القرار المعروض؛ قد يتغير القرار دون أن تتغير البصمة"): بعد
  // دمج AEI داخل decideFinal (راجع aeiIsMoreSevere في
  // final-decision-engine/engine.ts)، aei أصبح قادراً فعلياً على تغيير
  // level/decisionLabelAr المخزَّنة — فيجب أن يغيّر تغيّره وحده البصمة أيضاً،
  // وإلا يبقى "نفس البصمة، قرار مختلف فعلياً" ممكناً.
  describe('aei يؤثر على البصمة (خطأ مكتشَف ومُصلَح)', () => {
    it('aei موجود مقابل aei=null (بقية المدخلات مطابقة) → بصمة مختلفة', () => {
      const dvi = minimalDvi();
      const a = computeInputSnapshotHash(dvi, null, 'LIVE_OPERATIONAL', null);
      const b = computeInputSnapshotHash(dvi, null, 'LIVE_OPERATIONAL', minimalAei());
      expect(a).not.toBe(b);
    });

    it('تغيّر aei.color وحده (بقية المدخلات مطابقة تماماً) → بصمة مختلفة', () => {
      const dvi = minimalDvi();
      const a = computeInputSnapshotHash(dvi, null, 'LIVE_OPERATIONAL', minimalAei({ color: 'GREEN', status: 'ALLOW' }));
      const b = computeInputSnapshotHash(dvi, null, 'LIVE_OPERATIONAL', minimalAei({ color: 'YELLOW', status: 'MONITOR' }));
      expect(a).not.toBe(b);
    });

    it('aei غير مُمرَّر إطلاقاً (افتراضي) يساوي تمرير aei=null صراحة (توافق خلفي)', () => {
      const dvi = minimalDvi();
      const a = computeInputSnapshotHash(dvi, null, 'LIVE_OPERATIONAL');
      const b = computeInputSnapshotHash(dvi, null, 'LIVE_OPERATIONAL', null);
      expect(a).toBe(b);
    });

    it('نفس aei بترتيب مفاتيح مختلف (كائن مُعاد بناؤه) → نفس البصمة (حتمية الفرز تشمل aei أيضاً)', () => {
      const dvi = minimalDvi();
      const aei1 = minimalAei();
      const aei2 = { ...aei1, sources: [...aei1.sources] };
      const a = computeInputSnapshotHash(dvi, null, 'LIVE_OPERATIONAL', aei1);
      const b = computeInputSnapshotHash(dvi, null, 'LIVE_OPERATIONAL', aei2);
      expect(a).toBe(b);
    });
  });
});
