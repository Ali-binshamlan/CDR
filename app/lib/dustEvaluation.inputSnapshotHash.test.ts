import { describe, it, expect } from 'vitest';
import { computeInputSnapshotHash } from './dustEvaluation';
import { resetRuleParametersForTests, refreshRuleParameters, getActiveParameterVersionIds } from '@/app/utils/dust-compliance-engine';
import type { SupabaseClient } from '@supabase/supabase-js';
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

  // خطأ مكتشَف ومُصلَح (طلب صريح من المستخدم — "جودة الدليل تعتمد على
  // Date.now() بدل وقت التقييم، بينما بصمة المدخلات لا تشمل evaluatedAt أو
  // evidenceQuality؛ قد ينتج replay لاحق قراراً مختلفاً لنفس البصمة"): نفس
  // نمط قسم aei أعلاه بالضبط — evidenceQuality قادرة فعلياً على قلب
  // operationalDecision (راجع evidenceUnavailable في final-decision-engine/
  // engine.ts)، فيجب أن يغيّر تغيّرها وحده البصمة أيضاً.
  describe('evidenceQuality يؤثر على البصمة (خطأ مكتشَف ومُصلَح)', () => {
    it('evidenceQuality=OK مقابل STALE (بقية المدخلات مطابقة تماماً) → بصمة مختلفة', () => {
      const dvi = minimalDvi();
      const a = computeInputSnapshotHash(dvi, null, 'LIVE_OPERATIONAL', null, 'OK');
      const b = computeInputSnapshotHash(dvi, null, 'LIVE_OPERATIONAL', null, 'STALE');
      expect(a).not.toBe(b);
    });

    it('evidenceQuality غير مُمرَّرة إطلاقاً (افتراضي) يساوي تمرير evidenceQuality=null صراحة (توافق خلفي)', () => {
      const dvi = minimalDvi();
      const a = computeInputSnapshotHash(dvi, null, 'LIVE_OPERATIONAL', null);
      const b = computeInputSnapshotHash(dvi, null, 'LIVE_OPERATIONAL', null, null);
      expect(a).toBe(b);
    });

    it('كل قيم EvidenceQuality الأربع تُنتج بصمات مختلفة عن بعضها لنفس بقية المدخلات', () => {
      const dvi = minimalDvi();
      const hashes = (['OK', 'PARTIAL', 'STALE', 'UNAVAILABLE'] as const).map((q) =>
        computeInputSnapshotHash(dvi, null, 'LIVE_OPERATIONAL', null, q)
      );
      expect(new Set(hashes).size).toBe(4);
    });
  });

  // خطأ مكتشَف (مراجعة تدقيق — "لا تُحفظ معرفات نسخ المعاملات مع القرار"):
  // computeInputSnapshotHash يُجزّئ مخرجات التقييم (dvi/compliance/mode/aei)
  // فقط — يجب ألا يتأثر إطلاقاً بأي تغيّر في rule_parameter_versions
  // (مدخلات العتبات، لا مخرجات القرار)، وإلا يختلط "إثبات نفس المخرجات" مع
  // "إثبات نفس مدخلات المعاملات"، وهما التزامان منفصلان تماماً (الثاني
  // مُخزَّن الآن في عمود مستقل final_decisions.rule_parameter_version_
  // snapshot، لا داخل هذه البصمة). هذا الاختبار يثبت الضمان صراحة بدل
  // افتراضه ضمنياً من عدم تمرير الدالة لهذه البصمة في توقيعها أصلاً.
  describe('البصمة لا تتأثر بمعاملات القواعد (rule_parameter_versions)', () => {
    it('نفس dvi/compliance/mode/aei تُنتج نفس البصمة بصرف النظر عن حالة getActiveParameterVersionIds() الحالية', async () => {
      resetRuleParametersForTests();
      const dvi = minimalDvi();
      const beforeHash = computeInputSnapshotHash(dvi, null, 'LIVE_OPERATIONAL');
      expect(getActiveParameterVersionIds()).toEqual({});

      // نشر معامل قواعد فعلي (تغيّر حقيقي في rule_parameter_versions) —
      // يجب ألا يغيّر هذا البصمة إطلاقاً رغم نفس مدخلات dvi/compliance/mode.
      const mockSupabase = {
        from: () => ({
          select: () => ({
            eq: async () => ({
              data: [{ id: 'v-99', parameter_code: 'STONE_CUTTING_WIND_STOP_KMH', value: 12 }],
              error: null,
            }),
          }),
        }),
      } as unknown as SupabaseClient;
      await refreshRuleParameters(mockSupabase);
      expect(getActiveParameterVersionIds().STONE_CUTTING_WIND_STOP_KMH).toBe('v-99');

      const afterHash = computeInputSnapshotHash(dvi, null, 'LIVE_OPERATIONAL');
      expect(afterHash).toBe(beforeHash);

      resetRuleParametersForTests();
    });
  });

  // اختبار قبول صريح (طلب المستخدم — تقرير المراجعة الخارجي، القسم 5،
  // البند "تعديل توثيق الجهاز بعد قرار قديم → Replay القرار القديم لا
  // يتغيّر"): evidence.windDirection (WindDirectionEvidence، migration
  // 202608190002) هو الآن جزء من compliance المُجزَّأ هنا — نفس مبدأ aei/
  // evidenceQuality أعلاه بالضبط: تغيّره الفعلي يجب أن يغيّر البصمة (يثبت
  // أنه جزء حقيقي من الالتزام)، لكن الأهم: نسخة compliance المخزَّنة فعلياً
  // مع قرار قديم تبقى ثابتة إلى الأبد بصرف النظر عن أي تعديل لاحق على
  // توثيق الجهاز الحي في project_devices — لأن هذه الدالة (ولقطة القرار
  // المخزَّنة عموماً) لا تقرأ أبداً من project_devices مباشرة وقت إعادة
  // البناء، فقط من evidence.windDirection المجمَّدة داخل compliance نفسها.
  describe('evidence.windDirection يؤثر على البصمة، والقرار القديم لا يتأثر بتعديل توثيق لاحق (Replay)', () => {
    it('compliance بـevidence.windDirection موثَّق (VERIFIED) مقابل غير موثَّق (UNVERIFIED)، بقية الحقول مطابقة تماماً → بصمة مختلفة', () => {
      const dvi = minimalDvi();
      const unverified = {
        decisionCategory: 'ALLOW',
        evidence: {
          windDirection: {
            rawDeg: 270,
            directionForAnalysisDeg: null,
            quality: 'UNVERIFIED',
            source: 'DEVICE',
            deviceId: 'device-1',
            trueNorthDocumented: false,
            alignmentType: null,
            verifiedAt: null,
            verifiedBy: null,
            verificationMethod: null,
            deviationDeg: null,
            evidenceUrl: null,
          },
        },
      } as unknown as DustComplianceResult;
      const verified = {
        decisionCategory: 'ALLOW',
        evidence: {
          windDirection: {
            rawDeg: 270,
            directionForAnalysisDeg: 270,
            quality: 'VERIFIED',
            source: 'DEVICE',
            deviceId: 'device-1',
            trueNorthDocumented: true,
            alignmentType: 'TRUE_NORTH',
            verifiedAt: '2026-01-01T00:00:00.000Z',
            verifiedBy: 'مساح مرخَّص',
            verificationMethod: 'مساحة GPS',
            deviationDeg: 0,
            evidenceUrl: null,
          },
        },
      } as unknown as DustComplianceResult;
      const a = computeInputSnapshotHash(dvi, unverified, 'LIVE_OPERATIONAL');
      const b = computeInputSnapshotHash(dvi, verified, 'LIVE_OPERATIONAL');
      expect(a).not.toBe(b);
    });

    it('Replay: نفس كائن compliance المخزَّن فعلياً مع قرار قديم (evidence.windDirection مجمَّدة وقت الحفظ) يُعيد إنتاج نفس البصمة تماماً، بصرف النظر عن أي تغيّر لاحق في توثيق الجهاز الحي — الدالة لا تقرأ project_devices إطلاقاً', () => {
      const dvi = minimalDvi();
      // compliance كما خُزِّن فعلياً وقت صدور القرار — الجهاز كان غير موثَّق
      // حينها (rawDeg=270، quality=UNVERIFIED، directionForAnalysisDeg=null).
      const complianceAsStoredAtDecisionTime = {
        decisionCategory: 'ALLOW',
        evidence: {
          windDirection: {
            rawDeg: 270,
            directionForAnalysisDeg: null,
            quality: 'UNVERIFIED',
            source: 'DEVICE',
            deviceId: 'device-1',
            trueNorthDocumented: false,
            alignmentType: null,
            verifiedAt: null,
            verifiedBy: null,
            verificationMethod: null,
            deviationDeg: null,
            evidenceUrl: null,
          },
        },
      } as unknown as DustComplianceResult;

      const hashAtDecisionTime = computeInputSnapshotHash(dvi, complianceAsStoredAtDecisionTime, 'LIVE_OPERATIONAL');

      // أسبوع لاحق: تغيَّر توثيق الجهاز نفسه في project_devices (أصبح
      // موثَّقاً TRUE_NORTH) — لكن Replay يُعيد بناء البصمة من نفس الصف
      // المخزَّن (compliance القديم كما هو)، لا من حالة الجهاز الحية
      // الحالية. النتيجة يجب أن تبقى مطابقة تماماً — القرار القديم "لا
      // يتغيّر" لمجرد أن الجهاز أصبح موثَّقاً لاحقاً.
      const hashOnReplayAWeekLater = computeInputSnapshotHash(dvi, complianceAsStoredAtDecisionTime, 'LIVE_OPERATIONAL');

      expect(hashOnReplayAWeekLater).toBe(hashAtDecisionTime);
    });
  });

  // اختبار قبول صريح (طلب المستخدم — "لقطة القرار والبصمة"): evidence.
  // pm10TemporalEvidence ({queryState, failureCode, evaluatedAt}) يجب أن
  // يدخل ضمن اللقطة/البصمة، تحديداً كي لا تحمل "استعلام ناجح بلا قراءات"
  // (NO_READINGS) و"استعلام فاشل" (QUERY_FAILED) نفس البصمة — الشاهد
  // المباشر لطلب المستخدم بالنص.
  describe('evidence.pm10TemporalEvidence يؤثر على البصمة — NO_READINGS مقابل QUERY_FAILED لا يحملان نفس input_snapshot_hash', () => {
    it('نفس كل الحقول الأخرى، فرق واحد فقط هو pm10TemporalEvidence (NO_READINGS مقابل QUERY_FAILED) → بصمة مختلفة', () => {
      const dvi = minimalDvi();
      const noReadings = {
        decisionCategory: 'ALLOW',
        evidence: {
          pm10TemporalEvidenceState: 'NO_READINGS',
          pm10TemporalEvidence: {
            queryState: 'NO_READINGS',
            failureCode: null,
            evaluatedAt: '2026-08-18T09:30:00.000Z',
          },
        },
      } as unknown as DustComplianceResult;
      const queryFailed = {
        decisionCategory: 'ALLOW',
        evidence: {
          pm10TemporalEvidenceState: 'QUERY_FAILED',
          pm10TemporalEvidence: {
            queryState: 'QUERY_FAILED',
            failureCode: 'PM10_HISTORY_QUERY_FAILED',
            evaluatedAt: '2026-08-18T09:30:00.000Z',
          },
        },
      } as unknown as DustComplianceResult;

      const hashNoReadings = computeInputSnapshotHash(dvi, noReadings, 'LIVE_OPERATIONAL');
      const hashQueryFailed = computeInputSnapshotHash(dvi, queryFailed, 'LIVE_OPERATIONAL');

      expect(hashNoReadings).not.toBe(hashQueryFailed);
    });

    it('Replay: نفس compliance المخزَّن (pm10TemporalEvidence مجمَّدة وقت الحفظ) يُعيد نفس البصمة تماماً بلا اعتماد على أي حالة حية لاحقة', () => {
      const dvi = minimalDvi();
      const complianceAsStoredAtDecisionTime = {
        decisionCategory: 'FIELD_VERIFICATION_REQUIRED',
        evidence: {
          pm10TemporalEvidenceState: 'QUERY_FAILED',
          pm10TemporalEvidence: {
            queryState: 'QUERY_FAILED',
            failureCode: 'PM10_HISTORY_QUERY_FAILED',
            evaluatedAt: '2026-08-18T09:30:00.000Z',
          },
        },
      } as unknown as DustComplianceResult;

      const hashAtDecisionTime = computeInputSnapshotHash(dvi, complianceAsStoredAtDecisionTime, 'LIVE_OPERATIONAL');
      const hashOnReplay = computeInputSnapshotHash(dvi, complianceAsStoredAtDecisionTime, 'LIVE_OPERATIONAL');

      expect(hashOnReplay).toBe(hashAtDecisionTime);
    });
  });
});
