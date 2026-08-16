// =============================================================
// Rule Bundles — RCRC-NCEC-RIYADH-DUST-2026.2 وRIYADH-DUST-2026.3
// حزم قواعد مجمَّدة وموثَّقة بالإصدار (القسم 5.3 من "دليل الإصلاح الجذري
// لمنظومة مرقاب") — تفصل النطاق التشغيلي لمرقاب (operational) عن الحكم
// التنظيمي الرسمي (regulatory) بدل خلطهما في حدود PM10 واحدة كما كانت في
// rulebook.ts. لا تُعدَّل حزمة بعد نشرها؛ أي تغيير على الحدود يتطلب حزمة
// جديدة تُضاف إلى RULE_BUNDLES أدناه — هذا بالضبط ما فعلته 2026.3 (راجع
// تعليقها الكامل أدناه).
//
// خطأ مكتشَف ومُصلَح سابقاً (طلب صريح من المستخدم): كانت حزمة
// RIYADH_DUST_2026_3 سابقة (نطاق تشغيلي أضيق: أخضر≤150، تقييد شديد من
// 321) معرَّفة هنا بجانب RIYADH_DUST_2026_2 كمرشَّحة للاعتماد لاحقاً بلا
// أي مستهلك فعلي — حُذفت بالكامل حينها. الاسم RIYADH_DUST_2026_3 يُعاد
// استخدامه الآن (حزمة مختلفة تماماً) لغرض مختلف: تصحيح توثيقي/ربط فعلي
// لحقول regulatory الثلاثة غير المقروءة (راجع Pm10RegulatoryBoundsV3).
// =============================================================

export interface Pm10OperationalBounds {
  normalMaxInclusive: number;
  precautionMaxInclusive: number;
  controlsMaxInclusive: number;
  severeMaxInclusive: number;
}

// خطأ توثيقي مكتشَف ومُصلَح (مراجعة كود خارجي — "حزمة القواعد نفسها ما
// زالت تحمل السياسة القديمة"): الحقول الثلاثة (violationDurationMsExclusive/
// suspensionThresholdInclusive/suspensionDurationMsInclusive) في 2026.2
// كانت معرَّفة هنا لكن لا يقرأها أي كود حي إطلاقاً — dustEvaluation.ts/
// rulebook.ts استخدما ثوابت محلية مستقلة تماماً عن هذه الحزمة (PM10_
// VIOLATION_CONFIRM_MINUTES=2, PM10_SUSPENSION_MINUTES=30، ومقارنة >340
// مباشرة). لا تغيير في القوانين/القيم نفسها هنا (2/30 دقيقة، >340 تبقى
// كما هي بالضبط) — فقط ربط فعلي: 2026.3 تصحّح الأسماء لتعكس الدلالة
// الفعلية (violationDurationMsInclusive بدل Exclusive — الإصلاح السابق
// جعل اكتمال الدقيقتين كافياً `>=` لا تجاوزهما `>`؛ activityStopThresholdExclusive/
// activityStopDurationMsInclusive بدل suspensionThresholdInclusive/
// suspensionDurationMsInclusive — الإيقاف مقصور على >340 حصراً، لا نطاق
// التحذير 250)، ودustEvaluation.ts/rulebook.ts يقرآن منها فعلياً بدل
// الثوابت المحلية — راجع تعليق RIYADH_DUST_2026_3 أدناه للتفاصيل الكاملة.
export interface Pm10RegulatoryBoundsV2 {
  warningThresholdInclusive: number;
  violationThresholdExclusive: number;
  violationDurationMsExclusive: number;
  suspensionThresholdInclusive: number;
  suspensionDurationMsInclusive: number;
}

// 2026.3 فقط — الشكل الجديد المطابق للدلالة الفعلية المُطبَّقة في الكود
// (راجع تعليق Pm10RegulatoryBoundsV2 أعلاه). لا حقل operational منفصل هنا
// لأن operational (150/250/340 التشغيلية) لم تتغيّر بين 2026.2 و2026.3 —
// كلا الحزمتين تشتركان بنفس Pm10OperationalBounds.
export interface Pm10RegulatoryBoundsV3 {
  warningThresholdInclusive: number;
  violationThresholdExclusive: number;
  violationDurationMsInclusive: number;
  activityStopThresholdExclusive: number;
  activityStopDurationMsInclusive: number;
}

export interface Pm10EvidenceBounds {
  liveFreshnessMsInclusive: number;
  maxContinuityGapMs: number;
  sourceMustBe: 'device';
}

// عام على شكل regulatory (V2 القديم أو V3 الحالي) — يسمح لحزم مختلفة
// الإصدار بالتعايش في RULE_BUNDLES بأشكال حقول مختلفة، بلا فقدان أمان
// الأنواع لكل حزمة بمفردها (RIYADH_DUST_2026_2 يبقى Pm10RegulatoryBoundsV2
// حرفياً، RIYADH_DUST_2026_3 يصبح Pm10RegulatoryBoundsV3).
export interface RuleBundle<TRegulatory = Pm10RegulatoryBoundsV3> {
  id: string;
  effectiveFrom: string;
  pm10: {
    operational: Pm10OperationalBounds;
    regulatory: TRegulatory;
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
// السجل (Registry) — لا تُعدَّل RIYADH_DUST_2026_2 بعد نشرها. مُبقاة كسجل
// تاريخي فقط (ليست ACTIVE_RULE_BUNDLE بعد الآن — راجع RIYADH_DUST_2026_3
// أدناه) — أضِف حزماً جديدة هنا (القسم 5.3) لأي تعديل لاحق، لا تعدّل حزمة
// قائمة.
export const RIYADH_DUST_2026_2: Readonly<RuleBundle<Pm10RegulatoryBoundsV2>> = deepFreeze({
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

// حزمة جديدة (خطأ توثيقي مكتشَف ومُصلَح — مراجعة كود خارجي: "حزمة القواعد
// نفسها ما زالت تحمل السياسة القديمة"، راجع تعليق Pm10RegulatoryBoundsV3
// أعلاه للتفاصيل الكاملة). لا تغيير في القوانين/القيم — 2 دقيقة، 30 دقيقة،
// >340 تبقى كما هي بالضبط في dustEvaluation.ts/rulebook.ts؛ فقط تصحيح
// أسماء الحقول لتعكس الدلالة الفعلية، وربط الكود الحي بقراءتها من هنا
// فعلياً (dustEvaluation.ts: PM10_SUSTAINED_VIOLATION_THRESHOLD/
// PM10_VIOLATION_CONFIRM_MINUTES/PM10_SUSPENSION_MINUTES، rulebook.ts:
// PM10_VIOLATION_STOP_UG_M3/PM10_SUSPENSION_MINUTES تُشتَق الآن من
// ACTIVE_RULE_BUNDLE.pm10.regulatory بدل ثوابت محلية مستقلة). operational
// (150/250/340 التشغيلية) لم تتغيّر — مطابقة حرفياً لـ2026.2.
export const RIYADH_DUST_2026_3: Readonly<RuleBundle<Pm10RegulatoryBoundsV3>> = deepFreeze({
  id: 'RCRC-NCEC-RIYADH-DUST-2026.3',
  effectiveFrom: '2026-08-16T00:00:00+03:00',
  pm10: {
    operational: {
      normalMaxInclusive: 249,
      precautionMaxInclusive: 249,
      controlsMaxInclusive: 340,
      severeMaxInclusive: 340,
    },
    regulatory: {
      warningThresholdInclusive: 250,
      violationThresholdExclusive: 340,
      // Inclusive لا Exclusive (2026.2 كانت Exclusive) — اكتمال دقيقتين
      // استمرار (120_000 مللي ثانية بالضبط) كافٍ لتسجيل المخالفة المؤكَّدة،
      // لا يشترط تجاوزهما. يطابق isConfirmedViolation340 في dustEvaluation.ts
      // (`>=` لا `>`).
      violationDurationMsInclusive: 120_000,
      // اسم جديد يعكس الدلالة الفعلية: عتبة الإيقاف الفعلي (لا عتبة تعليق
      // مرتبطة بحد التحذير 250 كما كانت suspensionThresholdInclusive سابقاً)
      // — الإيقاف مقصور على تجاوز 340 نفسه حصراً، لا نطاق التحذير [250,340].
      activityStopThresholdExclusive: 340,
      activityStopDurationMsInclusive: 1_800_000,
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

export const ACTIVE_RULE_BUNDLE = RIYADH_DUST_2026_3;
