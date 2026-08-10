// =============================================================
// Rule Bundle — RCRC-NCEC-RIYADH-DUST-2026.2
// حزمة قواعد مجمَّدة وموثَّقة بالإصدار (القسم 5.3 من "دليل الإصلاح الجذري
// لمنظومة مرقاب") — تفصل النطاق التشغيلي لمرقاب (operational) عن الحكم
// التنظيمي الرسمي (regulatory) بدل خلطهما في حدود PM10 واحدة كما كانت في
// rulebook.ts. لا تُعدَّل هذه الحزمة بعد نشرها؛ أي تغيير على الحدود يتطلب
// حزمة جديدة تُضاف إلى RULE_BUNDLES أدناه.
//
// خطأ مكتشَف ومُصلَح (طلب صريح من المستخدم): كانت حزمة RIYADH_DUST_2026_3
// (نطاق تشغيلي أضيق: أخضر≤150، تقييد شديد من 321) معرَّفة هنا بجانب
// RIYADH_DUST_2026_2 كمرشَّحة للاعتماد لاحقاً بلا أي مستهلك فعلي (لم تكن
// ACTIVE_RULE_BUNDLE قط في هذه الجلسة) — حُذفت بالكامل بقرار صريح، لا مجرد
// تعطيل. RIYADH_DUST_2026_2 وحدها هي الحزمة المعتمدة الآن والوحيدة الموجودة.
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
//
// حدود الحكم التنظيمي (regulatory) — مستقلة تماماً عن الأعلى.
//
// maxContinuityGapMs (90 ثانية) هامش منطقي بعد فترة تسجيل معتمدة لا تتجاوز
// دقيقة (الملحق ب، صفحة 82) — ليس دليل اتصال مستمر تلقائي؛ الأربع دقائق
// (liveFreshnessMsInclusive) هي أقصى عمر قراءة للقرار الحي، لا فجوة استمرار.
//
// السجل (Registry) — لا تُعدَّل RIYADH_DUST_2026_2 بعد نشرها، فقط أضِف حزماً
// جديدة هنا (القسم 5.3) إن احتجت نسخة أحدث لاحقاً.
export const RIYADH_DUST_2026_2: Readonly<RuleBundle> = deepFreeze({
  id: 'RCRC-NCEC-RIYADH-DUST-2026.2',
  effectiveFrom: '2026-01-01T00:00:00+03:00',
  pm10: {
    // خطأ مكتشَف ومُصلَح (طلب صريح من المستخدم — توحيد إلى 3 مستويات فقط،
    // لا 4): كانت هذه الحدود تُنتج 4 مستويات فعلية في pm10ThresholdRule
    // (طبيعي/احتراز 201-249/ضوابط 250-339/تقييد شديد 340 فقط)، بينما الوثيقة
    // التنظيمية تنص على 3 مستويات حصراً: <250 سماح، 250-340 تحذير+تحكم
    // معزَّز موحَّد (بلا تدرّج داخلي)، >340 مخالفة. الإصلاح: normalMaxInclusive
    // يمتد الآن حتى 249 (يبتلع نطاق الاحتراز السابق بالكامل)،
    // precautionMaxInclusive يساوي normalMaxInclusive فعلياً (لا نطاق احتراز
    // منفصل بعد الآن)، وcontrolsMaxInclusive=340 (يبتلع نطاق التقييد الشديد
    // السابق 340 فقط) — فرع RESTRICT_ACTIVITY/PRECAUTION في pm10ThresholdRule
    // حُذف، يبقى فرع WARNING واحد يغطي [250,340] بالكامل. لا تغيير على حدود
    // regulatory/evidence (340 حد المخالفة، 120s المدة، 250/30min التعليق) —
    // هذه الثلاثة مطابقة للوثيقة التنظيمية أصلاً بلا حاجة لتعديل.
    operational: {
      normalMaxInclusive: 249,
      precautionMaxInclusive: 249,
      controlsMaxInclusive: 340,
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
      liveFreshnessMsInclusive: 1_200_000,
      maxContinuityGapMs: 90_000,
      sourceMustBe: 'device',
    },
  },
});

export const RULE_BUNDLES = {
  'RCRC-NCEC-RIYADH-DUST-2026.2': RIYADH_DUST_2026_2,
} as const;

export const ACTIVE_RULE_BUNDLE = RIYADH_DUST_2026_2;
