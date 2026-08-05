// =============================================================
// Rule Bundle — RCRC-NCEC-RIYADH-DUST-2026.3
// حزمة قواعد مجمَّدة وموثَّقة بالإصدار (القسم 5.3 من "دليل الإصلاح الجذري
// لمنظومة مرقاب") — تفصل النطاق التشغيلي لمرقاب (operational) عن الحكم
// التنظيمي الرسمي (regulatory) بدل خلطهما في حدود PM10 واحدة كما كانت في
// rulebook.ts. لا تُعدَّل هذه الحزمة بعد نشرها؛ أي تغيير على الحدود يتطلب
// حزمة جديدة (2026.4...) تُضاف إلى RULE_BUNDLES أدناه.
// =============================================================

export interface Pm10OperationalBounds {
  normalMaxInclusive: number;
  precautionMaxInclusive: number;
  controlsMaxInclusive: number;
  severeMaxInclusive: number;
}

export interface Pm10RegulatoryBounds {
  warningThresholdInclusive: number;
  violationThresholdExclusive: number;
  violationDurationMsExclusive: number;
  suspensionThresholdInclusive: number;
  suspensionDurationMsInclusive: number;
}

export interface Pm10EvidenceBounds {
  liveFreshnessMsInclusive: number;
  maxContinuityGapMs: number;
  sourceMustBe: 'device';
}

export interface RuleBundle {
  id: string;
  effectiveFrom: string;
  pm10: {
    operational: Pm10OperationalBounds;
    regulatory: Pm10RegulatoryBounds;
    evidence: Pm10EvidenceBounds;
  };
}

function deepFreeze<T>(value: T): Readonly<T> {
  Object.values(value as Record<string, unknown>).forEach((v) => {
    if (v !== null && (typeof v === 'object' || typeof v === 'function') && !Object.isFrozen(v)) {
      deepFreeze(v);
    }
  });
  return Object.freeze(value);
}

// حدود التشغيل (operational) — القسم 5.2 من الدليل الإيضاحي: النطاق
// التشغيلي المعتمد لمرقاب، منفصل عن الحكم التنظيمي الرسمي أدناه.
//   ≤150            → طبيعي (ALLOW)
//   150 < x ≤ 250   → احتراز (MONITOR)
//   250 < x ≤ 320   → ضوابط إلزامية (MONITOR)
//   320 < x ≤ 340   → تقييد شديد (RESTRICT)
//   > 340           → إيقاف احترازي فوري (PROTECTIVE_STOP)، مؤكَّد
//                     (MANDATORY_STOP) بعد استمرار >120 ثانية (٢ دقيقة)
//
// حدود الحكم التنظيمي (regulatory) — مستقلة تماماً عن الأعلى:
//   تحذير تنظيمي: pm10 >= 250
//   تجاوز معلَّق فوراً: pm10 > 340
//   مخالفة مؤكدة: pm10 > 340 لأكثر من 120000ms (دقيقتين) استمرار فعلي
//   بروتوكول تعليق 30 دقيقة: pm10 >= 250 لمدة 1_800_000ms متواصلة
//
// maxContinuityGapMs (90 ثانية) هامش منطقي بعد فترة تسجيل معتمدة لا تتجاوز
// دقيقة (الملحق ب، صفحة 82) — ليس دليل اتصال مستمر تلقائي؛ الأربع دقائق
// (liveFreshnessMsInclusive) هي أقصى عمر قراءة للقرار الحي، لا فجوة استمرار.
export const RIYADH_DUST_2026_3: Readonly<RuleBundle> = deepFreeze({
  id: 'RCRC-NCEC-RIYADH-DUST-2026.3',
  effectiveFrom: '2026-08-04T00:00:00+03:00',
  pm10: {
    operational: {
      normalMaxInclusive: 150,
      precautionMaxInclusive: 250,
      controlsMaxInclusive: 320,
      severeMaxInclusive: 340,
    },
    regulatory: {
      warningThresholdInclusive: 250,
      violationThresholdExclusive: 340,
      violationDurationMsExclusive: 120_000,
      suspensionThresholdInclusive: 250,
      suspensionDurationMsInclusive: 1_800_000,
    },
    evidence: {
      liveFreshnessMsInclusive: 240_000,
      maxContinuityGapMs: 90_000,
      sourceMustBe: 'device',
    },
  },
});

// السجل (Registry) — لا تُعدَّل RIYADH_DUST_2026_2/2026_3 بعد نشرها، فقط
// أضِف حزماً جديدة هنا (القسم 5.3). RIYADH_DUST_2026_2 تمثيل رمزي للحزمة
// التاريخية (RULEBOOK_VERSION القديمة في dust-compliance-engine/rulebook.ts)
// — محفوظة هنا للتوثيق فقط، ليست الحزمة النشطة حالياً.
export const RIYADH_DUST_2026_2: Readonly<RuleBundle> = deepFreeze({
  id: 'RCRC-NCEC-RIYADH-DUST-2026.2',
  effectiveFrom: '2026-01-01T00:00:00+03:00',
  pm10: {
    operational: {
      normalMaxInclusive: 200,
      precautionMaxInclusive: 250,
      controlsMaxInclusive: 339,
      severeMaxInclusive: 340,
    },
    regulatory: {
      warningThresholdInclusive: 251,
      violationThresholdExclusive: 340,
      violationDurationMsExclusive: 120_000,
      suspensionThresholdInclusive: 251,
      suspensionDurationMsInclusive: 1_800_000,
    },
    evidence: {
      liveFreshnessMsInclusive: 1_200_000,
      maxContinuityGapMs: 90_000,
      sourceMustBe: 'device',
    },
  },
});

export const RULE_BUNDLES = {
  'RCRC-NCEC-RIYADH-DUST-2026.2': RIYADH_DUST_2026_2,
  'RCRC-NCEC-RIYADH-DUST-2026.3': RIYADH_DUST_2026_3,
} as const;

// طلب صريح من المستخدم (تراجع عن رفع الإصدار في P0 لهذه الجلسة نفسها): عودة
// للحزمة القديمة 2026.2 كنشطة — راجع النقاش الذي أدى لهذا القرار قبل تعديل
// هذا السطر. RIYADH_DUST_2026_3 تبقى معرَّفة أعلاه (لا تُحذف — قد تُعتمَد
// لاحقاً)، لكنها لم تعد ACTIVE_RULE_BUNDLE.
export const ACTIVE_RULE_BUNDLE = RIYADH_DUST_2026_2;
