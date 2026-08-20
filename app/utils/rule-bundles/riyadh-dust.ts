// =============================================================
// Rule Bundles — RCRC-NCEC-RIYADH-DUST-2026.3
// حزم قواعد مجمَّدة وموثَّقة بالإصدار (القسم 5.3 من "دليل الإصلاح الجذري
// لمنظومة مرقاب") — تفصل النطاق التشغيلي لمرقاب (operational) عن الحكم
// التنظيمي الرسمي (regulatory) بدل خلطهما في حدود PM10 واحدة كما كانت في
// rulebook.ts. لا تُعدَّل حزمة بعد نشرها؛ أي تغيير على الحدود يتطلب حزمة
// جديدة (ACTIVE_RULE_BUNDLE يُحدَّث للإشارة لها عند النشر — سجل RULE_BUNDLES
// الوسيط حُذف لعدم وجود أي مستهلك يبحث بالمعرّف، طلب مستخدم صريح: فحص شامل
// لكل كود ميت بالمشروع).
//
// خطأ مكتشَف ومُصلَح سابقاً (طلب صريح من المستخدم): كانت حزمة
// RIYADH_DUST_2026_3 سابقة (نطاق تشغيلي أضيق: أخضر≤150، تقييد شديد من
// 321) معرَّفة هنا بجانب حزمة 2026.2 (سابقة، محذوفة الآن بالكامل) كمرشَّحة
// للاعتماد لاحقاً بلا أي مستهلك فعلي — حُذفت بالكامل حينها. الاسم
// RIYADH_DUST_2026_3 يُعاد استخدامه الآن (حزمة مختلفة تماماً) لغرض مختلف:
// تصحيح توثيقي/ربط فعلي لحقول regulatory الثلاثة غير المقروءة.
//
// حزمة RIYADH_DUST_2026_2 (السجل التاريخي السابق لهذا الملف) حُذفت نهائياً
// (طلب صريح من المستخدم — مراجعة كود خارجي: "Rule Bundle قديم خطير يجب
// حذفه... استيراده مستقبلاً بالخطأ يستطيع إعادة السياسة القديمة"): لم تكن
// مستوردة من أي مكان آخر في المشروع (تحقُّق شامل)، وكانت مُبقاة كسجل توثيقي
// فقط داخل هذا الملف نفسه، لا ACTIVE_RULE_BUNDLE. القوانين/القيم نفسها لم
// تتغيّر بين 2026.2 و2026.3 (2 دقيقة، 30 دقيقة، >340 كما هي بالضبط) — فقط
// تصحيح أسماء الحقول لتعكس الدلالة الفعلية (راجع RIYADH_DUST_2026_3 أدناه).
// =============================================================

export interface Pm10OperationalBounds {
  normalMaxInclusive: number;
  precautionMaxInclusive: number;
  controlsMaxInclusive: number;
  severeMaxInclusive: number;
}

export interface Pm10RegulatoryBoundsV3 {
  warningThresholdInclusive: number;
  violationThresholdExclusive: number;
  violationDurationMsInclusive: number;
  activityStopThresholdExclusive: number;
  activityStopDurationMsInclusive: number;
}

export interface Pm10EvidenceBounds {
  maxContinuityGapMs: number;
  sourceMustBe: 'device';
}

// عام على شكل regulatory — يسمح لحزم مستقبلية بأشكال حقول مختلفة
// بالتعايش في RULE_BUNDLES، بلا فقدان أمان الأنواع لكل حزمة بمفردها.
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
// دقيقة (الملحق ب، صفحة 82) — ليس دليل اتصال مستمر تلقائي.
//
// حقل liveFreshnessMsInclusive (كان 20 دقيقة هنا) حُذف نهائياً (طلب صريح من
// المستخدم — مراجعة كود خارجي: "تعارض حداثة PM10 ما زال موجودًا... Runtime =
// 4 min، Rule Bundle metadata = 20 min"): لم يكن مقروءاً من أي كود فعلياً؛
// أقصى عمر قراءة للقرار الحي مصدره الوحيد الآن LIVE_FIELD_FRESHNESS_MS في
// field-freshness.ts (4 دقائق بالضبط)، لا نسخة موازية هنا.
//
// السجل (Registry) — لا تُعدَّل حزمة بعد نشرها. أضِف حزماً جديدة هنا (القسم
// 5.3) لأي تعديل لاحق، لا تعدّل حزمة قائمة.
//
// القوانين/القيم لم تتغيّر عن السياسة السابقة (2 دقيقة، 30 دقيقة، >340 كما
// هي بالضبط) — فقط تصحيح أسماء الحقول لتعكس الدلالة الفعلية، وربط الكود
// الحي بقراءتها من هنا فعلياً (dustEvaluation.ts:
// PM10_SUSTAINED_VIOLATION_THRESHOLD/PM10_VIOLATION_CONFIRM_MINUTES/
// PM10_SUSPENSION_MINUTES، rulebook.ts: PM10_VIOLATION_STOP_UG_M3/
// PM10_SUSPENSION_MINUTES تُشتَق من ACTIVE_RULE_BUNDLE.pm10.regulatory بدل
// ثوابت محلية مستقلة).
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
      maxContinuityGapMs: 90_000,
      sourceMustBe: 'device',
    },
  },
});

export const ACTIVE_RULE_BUNDLE = RIYADH_DUST_2026_3;
