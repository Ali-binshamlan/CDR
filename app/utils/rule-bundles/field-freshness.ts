// =============================================================
// تصنيف حداثة مركزي لكل Metric (Field Freshness)
// خطأ مكتشَف ومُصلَح (مراجعة خبير خارجي — البند 3: "حداثة البيانات ما زالت
// جزئية؛ بوابة الأربع دقائق مطبَّقة فقط تقريباً على الرياح والهبات والاتجاه
// والرؤية"، واقتراح الحل الحرفي: "تصنيف حداثة مركزي لكل Metric"): قبل هذا
// الملف كانت عتبات الحداثة مبعثرة كثوابت منفصلة عبر 3 ملفات (FIELD_FRESHNESS_MS
// في dust-engine/engine.ts، PM10_LAST_READING_FRESHNESS_MINUTES في
// dustEvaluation.ts، DEVICE_READING_FRESHNESS_MINUTES/STALENESS_MINUTES
// المكرَّرة 3 مرات عبر final-decision-engine/adapters.ts وdustEvaluation.ts
// وCompliancewidgetcard.tsx) — بلا مرجع واحد موثَّق يوضح لماذا تختلف قيمها.
//
// هذا الملف يوثّق ويجمع في مكان واحد سبب اختلاف عتبتَي الحداثة الأساسيتين
// عمداً — PM10/الحقول اللحظية (4 دقائق) مقابل اتصال الجهاز العام، بدل ترك
// القارئ يكتشف "قيم مختلفة" بلا تفسير مركزي.
//
// الفرق الجوهري بين المجموعتين:
//   • LIVE (4 دقائق): "هل هذه القراءة اللحظية بعينها حديثة كفاية لاعتمادها
//     في قرار فيزيائي/استمرار فوري الآن؟" — تُطبَّق على كل حقل يدخل قرار DVI
//     الحي مباشرة (رياح/هبات/اتجاه/رؤية/PM2.5/رطوبة/حرارة عبر freshOrNull في
//     dust-engine/engine.ts)، وعلى استمرار PM10 المؤكَّد/المعلَّق تحديداً
//     (computeSustainedPm10Status في dustEvaluation.ts) — عتبة صارمة مقصودة
//     لأنها تحسم "هل يستمر خطر فيزيائي/مخالفة تنظيمية فعلياً حتى الآن".
//   • DEVICE_CONNECTION (10 دقائق): "هل المحطة ما زالت متصلة/ترسل أصلاً؟" —
//     أوسع عمداً من عتبة LIVE (تطابق فترة تسجيل نموذجية معقولة قبل اعتبار
//     المحطة منقطعة كلياً)، تُستخدم لتصنيف evidenceQuality (OK/STALE)
//     وتنبيهات قِدم القراءة في الواجهة — لا علاقة لها بحسم استمرار مخالفة
//     PM10 لحظة بلحظة.
//
//   خطأ مكتشَف ومُصلَح (مراجعة خبير خارجي — التقرير النهائي: خلط بين هذه
//   القيمة (كانت 20 دقيقة) وعتبة قرار الإيقاف الفوري (4 دقائق) رغم كونهما
//   لغرضين مختلفين تماماً؛ التقرير اعتبر هذا "PM10 قديم يدخل القرار" رغم أن
//   قرار الإيقاف نفسه كان يستخدم 4 دقائق بالفعل): 20 دقيقة كانت أطول من
//   اللازم عملياً (نافذة واسعة جداً قبل أي تنبيه "قراءة قديمة" للمستخدم أو
//   تراجع evidenceQuality)، فقُلِّصت إلى 10 دقائق كموقف وسط مؤقت.
//
//   قرار مستخدم صريح لاحق (2026-08-09): سياسة المشروع تُلزم كل جهاز رصد
//   حقيقي بوتيرة إرسال دقيقة واحدة (نفس معدّل provider-pull الفعلي) — لا
//   وجود لجهاز "بطيء طبيعياً" (5-8 دقائق) ضمن الأجهزة المدعومة فعلياً، فلا
//   خطر إنذار كاذب من عتبة أضيق. عتبتا DEVICE_CONNECTION وLIVE توحَّدتا الآن
//   على نفس القيمة (4 دقائق) — "لا قرار واثق بلا قراءة خلال آخر 4 دقائق"،
//   بلا استثناء لأي غرض (استمرار فيزيائي لحظي أو تصنيف evidenceQuality).
// =============================================================

// LIVE_FIELD_FRESHNESS_MS: عتبة الحداثة اللحظية — نفس FIELD_FRESHNESS_MS في
// dust-engine/engine.ts (رياح/هبات/اتجاه/رؤية/PM2.5/رطوبة/حرارة عبر
// freshOrNull) ونفس PM10_LAST_READING_FRESHNESS_MINUTES في dustEvaluation.ts
// (استمرار PM10 المؤكَّد/المعلَّق). قيمة واحدة موثَّقة هنا يقرأها الطرفان،
// بدل رقمين منفصلين قد ينحرفان عن بعضهما بصمت مستقبلاً.
export const LIVE_FIELD_FRESHNESS_MS = 4 * 60_000;

// DEVICE_CONNECTION_FRESHNESS_MS: عتبة اتصال المحطة العامة — نفس
// DEVICE_READING_FRESHNESS_MINUTES (dustEvaluation.ts وfinal-decision-engine/
// adapters.ts) وDEVICE_READING_STALENESS_MINUTES (Compliancewidgetcard.tsx).
// موحَّدة الآن مع LIVE_FIELD_FRESHNESS_MS (4 دقائق) — راجع تعليق القرار
// أعلاه.
export const DEVICE_CONNECTION_FRESHNESS_MS = 4 * 60_000;

export type FreshnessMetric =
  | 'windSpeed'
  | 'windGust'
  | 'windDirection'
  | 'visibility'
  | 'pm25'
  | 'relativeHumidity'
  | 'temperature'
  | 'pm10Continuity'
  | 'deviceConnection';

// عتبة الحداثة المُوصى بها لكل Metric — مرجع مركزي واحد لأي مستهلك جديد
// يحتاج تحديد "أي عتبة أستخدم لهذا الحقل؟" بدل تخمينها. المستهلكون الحاليون
// (dust-engine/engine.ts، dustEvaluation.ts، final-decision-engine/adapters.ts،
// Compliancewidgetcard.tsx) يبقون بثوابتهم المحلية المكرَّرة عمداً (توثيقاً
// لنفس الاتفاقية القائمة أصلاً في المشروع لتفادي استيراد متشابك) — هذه
// الدالة مرجع توثيقي/فحص اتساق مركزي، لا استبدالاً إلزامياً لكل موضع.
export function freshnessThresholdMsFor(metric: FreshnessMetric): number {
  switch (metric) {
    case 'windSpeed':
    case 'windGust':
    case 'windDirection':
    case 'visibility':
    case 'pm25':
    case 'relativeHumidity':
    case 'temperature':
    case 'pm10Continuity':
      return LIVE_FIELD_FRESHNESS_MS;
    case 'deviceConnection':
      return DEVICE_CONNECTION_FRESHNESS_MS;
  }
}
