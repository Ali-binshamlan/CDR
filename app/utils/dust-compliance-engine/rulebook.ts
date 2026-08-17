// =============================================================
// Riyadh Dust Compliance Engine — Rulebook
// منطق التصنيف والقواعد المأخوذ من دليل RCRC/NCEC لضبط الغبار في
// مشاريع الإنشاء بمدينة الرياض + مستند "مرقاب" التصميمي (الأقسام 6-9).
// كل قاعدة IF/THEN دالة منفصلة تُرجع DustRuleHit[] — بلا eval، بلا
// تفسير ديناميكي (القسم 17.1 من مستند "مرقاب").
// =============================================================

import type {
  DustActivityComplianceProfile,
  DustComplianceDecisionCategory,
  DustProjectComplianceProfile,
  DustRiskClass,
  DustRuleHit,
  DustWindBand,
} from './types';
import { ACTIVE_RULE_BUNDLE } from '@/app/utils/rule-bundles/riyadh-dust';
import { getRuleParameters } from './ruleParameters';

export const RULEBOOK_VERSION = ACTIVE_RULE_BUNDLE.id;

// تسمية عربية لكل نشاط تنظيمي (RegulatoryDustActivity) — تُعرض في بطاقة
// الامتثال بدل مسمى نشاط DVI الفيزيائي (activity_type)، لأن المستخدم يهتم
// بالنشاط التنظيمي المحدد الذي تُبنى عليه قرارات الإيقاف/التقييد (هدم/كسارة/
// حركة شاحنات...)، لا التصنيف الفيزيائي العام.
export const REGULATORY_ACTIVITY_LABEL_AR: Record<string, string> = {
  EARTHWORKS: 'أعمال الحفر والترابية',
  SITE_TRAFFIC: 'حركة الشاحنات والطرق الداخلية',
  ENTRY_EXIT: 'نقاط الدخول والخروج',
  MATERIAL_HANDLING_STOCKPILE: 'مناولة وتخزين المواد والأكوام',
  DEMOLITION: 'الهدم والترميم',
  CRUSHER: 'الكسارة',
  BATCHING_PLANT: 'محطة خلط الخرسانة',
  STONE_CUTTING: 'قطع الأحجار والصخور',
  CD_WASTE_TRANSPORT: 'نقل مخلفات الهدم والبناء',
  IDLE_SURFACE: 'الأسطح المكشوفة غير النشطة',
  OTHER: 'نشاط غبار عام',
};

// حد الكسارة من المستقبِل الحساس: الدليل التنظيمي يذكر 200م في موضع (القسم
// 3.5، تخزين المواد) و500م في موضع آخر (القسم 3.8، مناطق الكسارات تحديداً).
// نطبّق الحد الأكثر تحفظاً (500م) للكسارة تحديداً حتى يصدر تفسير رسمي من
// الجهة — راجع ملاحظة "مرقاب" القسم 9.5.
// خطأ مكتشَف ومُصلَح (مراجعة خبير خارجي — "لا نظام إدارة قواعد حقيقي: لا
// نسخ، لا نشر، لا rollback"): العتبات أدناه لم تعد ثوابت TypeScript صرفة —
// تُقرأ الآن حية من getRuleParameters() (ruleParameters.ts)، القيمة
// المنشورة فعلياً حالياً (أو الافتراضي المطابق لما كان هنا قبل هذا التغيير
// إن لم يُنشَر أي شيء بعد). دوال getter صغيرة بدل استبدال كل استخدام مباشرة
// بـgetRuleParameters().X المطوَّل — الأسماء والدلالة تبقيان كما هما تماماً
// في بقية الملف، فقط القراءة تحوّلت من حرفي ثابت إلى حالة حية قابلة للنشر.
const CRUSHER_SENSITIVE_RECEPTOR_DISTANCE_M = () => getRuleParameters().CRUSHER_SENSITIVE_RECEPTOR_DISTANCE_M;
const CRUSHER_GENERAL_RECEPTOR_DISTANCE_M = () => getRuleParameters().CRUSHER_GENERAL_RECEPTOR_DISTANCE_M;
// حد مساحة الفئة الأولى (منخفضة المخاطر) — يُستخدم في classifyProject فقط
// لتصنيف فئة المشروع حسب المساحة (القسم 6). لا علاقة له بأهلية تشغيل
// الكسارة؛ أهلية الكسارة تُحدَّد حصراً عبر riskClass النهائي في crusherRules
// (CRUSHER-CATEGORY-001)، الذي يسمح للفئة الثالثة بصرف النظر عن سبب وصول
// المشروع إليها (مساحة كبيرة، أو حركة شاحنات، أو تصريح صريح بوجود كسارة).
// مُستبعَدة عمداً من نظام النسخ (raise the bar): تُحدِّد الفئة التنظيمية
// الأساسية للمشروع كاملاً، لا عتبة قاعدة مفردة — تبقى ثابتاً برمجياً.
const CATEGORY_I_MAX_AREA_M2 = 2000;
const STOCKPILE_SENSITIVE_RECEPTOR_DISTANCE_M = () => getRuleParameters().STOCKPILE_SENSITIVE_RECEPTOR_DISTANCE_M;
const DEMOLITION_MAX_AREA_M2 = () => getRuleParameters().DEMOLITION_MAX_AREA_M2;
const IDLE_SURFACE_MAX_DAYS = () => getRuleParameters().IDLE_SURFACE_MAX_DAYS;
const UNPAVED_SPEED_LIMIT_KMH = () => getRuleParameters().UNPAVED_SPEED_LIMIT_KMH;
const PAVED_SPEED_LIMIT_KMH = () => getRuleParameters().PAVED_SPEED_LIMIT_KMH;
const SPILL_CLEANUP_LIMIT_MIN = () => getRuleParameters().SPILL_CLEANUP_LIMIT_MIN;
const DROP_HEIGHT_NORMAL_LIMIT_M = () => getRuleParameters().DROP_HEIGHT_NORMAL_LIMIT_M;
const DROP_HEIGHT_HIGH_WIND_LIMIT_M = () => getRuleParameters().DROP_HEIGHT_HIGH_WIND_LIMIT_M;
const DEBRIS_PILE_MAX_HEIGHT_M = () => getRuleParameters().DEBRIS_PILE_MAX_HEIGHT_M;
const IMMERSION_ZONE_MIN_LENGTH_M = () => getRuleParameters().IMMERSION_ZONE_MIN_LENGTH_M;
const WHEEL_WASH_CYCLE_MIN_SEC = () => getRuleParameters().WHEEL_WASH_CYCLE_MIN_SEC;
const STONE_CUTTING_WIND_STOP_KMH = () => getRuleParameters().STONE_CUTTING_WIND_STOP_KMH;
// A6 — كفاءة فلاتر PM10 الدنيا في الصوامع ومحطات الخلط المغلقة (القسم
// الرابع، الفقرة "ب"؛ "الاستخراج التنظيمي من المرفق" القسم 6 — الحد المعتمد
// للاستمرار أثناء إيقاف الرياح فوق 25 كم/س).
// مصدَّرة (لا محلية فقط) لأن engine.ts يحتاجها أيضاً لربط استثناء البيتشنج
// المغلق ببوابة إيقاف الرياح >25 كم/س (GATE-WIND-ABOVE-25-004)، لا فقط
// لقاعدة BATCHING-FILTER-002 المحلية هنا.
export const BATCHING_PM10_FILTER_MIN_PERCENT = () => getRuleParameters().BATCHING_PM10_FILTER_MIN_PERCENT;
// A4 — سرعة الرياح التي تستوجب فحص أغطية الأسطح غير النشطة وإصلاحها فوراً
// (مختلفة عن عتبات 15/25 كم/س العامة — خاصة بحالة الأغطية تحديداً).
const IDLE_SURFACE_COVER_INSPECTION_WIND_KMH = () => getRuleParameters().IDLE_SURFACE_COVER_INSPECTION_WIND_KMH;

// حدود PM10 — 3 مستويات فقط (طلب صريح من المستخدم، توحيد عن 4 فروع سابقة):
// النطاق التشغيلي لمرقاب منفصل عن الحكم التنظيمي الرسمي
// (warningThresholdInclusive/violationThresholdExclusive أدناه). لا تُعدَّل
// هذه القيم هنا مباشرة — أي تغيير يتطلب حزمة قواعد جديدة في
// app/utils/rule-bundles.
//   ≤249    → سماح (ALLOW) — لا Trigger خاص بـPM10
//   250-340 → تحذير + تحكم معزَّز موحَّد (ALLOW_WITH_CONTROLS)، مع قاعدة
//             استمرار 30 دقيقة (RCRC-PM10-30M-SUSPENSION-012) أدناه
//   > 340   → معلَّق/مؤكَّد (STOP_AFFECTED_ACTIVITY/MANDATORY_STOP)، بقاعدة
//             استمرار الدقيقتين (>120s)
// مُصدَّر (لا محلي فقط) — يُستخدَم أيضاً في buildPlanningForecastResult
// (engine.ts) لتحديد "هل التوقّع صالح للنشاط؟" بناءً على الحكم التنظيمي، لا
// DVI الفيزيائي وحده (راجع تعليق isFavorable هناك للسبب الكامل).
export const PM10_WARNING_UG_M3 = ACTIVE_RULE_BUNDLE.pm10.regulatory.warningThresholdInclusive;
const PM10_VIOLATION_STOP_UG_M3 = ACTIVE_RULE_BUNDLE.pm10.regulatory.violationThresholdExclusive;

// -----------------------------------------------------------------------
// تصنيف فئة مخاطر المشروع (القسم 6 من "مرقاب"، جدول 1 من الدليل التنظيمي)
// -----------------------------------------------------------------------
export function classifyProject(profile: DustProjectComplianceProfile): {
  riskClass: DustRiskClass;
  reasonAr: string;
} {
  const { siteAreaM2, dailyTruckMovements, hasOnsiteCrusher, hasOnsiteBatchingPlant } = profile;

  if (
    siteAreaM2 !== null && siteAreaM2 !== undefined && siteAreaM2 > 5000
  ) {
    return { riskClass: 'CATEGORY_III_HIGH', reasonAr: 'مساحة الموقع تتجاوز 5,000 م²' };
  }
  if (
    dailyTruckMovements !== null && dailyTruckMovements !== undefined && dailyTruckMovements > 50
  ) {
    return { riskClass: 'CATEGORY_III_HIGH', reasonAr: 'حركة الشاحنات اليومية تتجاوز 50 رحلة' };
  }
  if (hasOnsiteCrusher === true) {
    return { riskClass: 'CATEGORY_III_HIGH', reasonAr: 'يوجد كسارة داخل الموقع' };
  }
  if (hasOnsiteBatchingPlant === true) {
    return { riskClass: 'CATEGORY_III_HIGH', reasonAr: 'يوجد محطة خلط خرساني داخل الموقع' };
  }

  // حماية من التصنيف المنخفض الكاذب: لا يجوز استبعاد الفئة الثالثة إذا كان
  // أي محفز عالي الخطورة مجهولاً — نقص البيانات لا يساوي خطراً منخفضاً.
  if (
    siteAreaM2 === null || siteAreaM2 === undefined ||
    dailyTruckMovements === null || dailyTruckMovements === undefined ||
    hasOnsiteCrusher === null || hasOnsiteCrusher === undefined ||
    hasOnsiteBatchingPlant === null || hasOnsiteBatchingPlant === undefined
  ) {
    return { riskClass: 'UNCLASSIFIED', reasonAr: 'بيانات تصنيف المشروع غير مكتملة — يتعذر استبعاد الفئة الثالثة' };
  }

  if (siteAreaM2 >= CATEGORY_I_MAX_AREA_M2) {
    return { riskClass: 'CATEGORY_II_MEDIUM', reasonAr: 'مساحة الموقع بين 2,000 و5,000 م²' };
  }
  return { riskClass: 'CATEGORY_I_LOW', reasonAr: 'مساحة الموقع أقل من 2,000 م² ولا يوجد محفز خطر عالٍ آخر' };
}

// -----------------------------------------------------------------------
// تصنيف نطاق الرياح (بروتوكول الملحق أ)
// -----------------------------------------------------------------------
export function classifyWind(windSpeedKmh: number | null): DustWindBand {
  if (windSpeedKmh === null || windSpeedKmh === undefined) return 'UNKNOWN';
  const { WIND_GATE_ENHANCED_MIN_KMH, WIND_GATE_STOP_KMH } = getRuleParameters();
  if (windSpeedKmh < WIND_GATE_ENHANCED_MIN_KMH) return 'BELOW_15';
  if (windSpeedKmh <= WIND_GATE_STOP_KMH) return 'FROM_15_TO_25';
  return 'ABOVE_25';
}

// بوابة الرياح التنظيمية لكل ساعة على حدة (نفس عتبة GATE-WIND-ABOVE-25-004
// في engine.ts) — تُستخدم لوسم شبكة التوقعات الساعية (workDayHourly) بلا
// تشغيل محرك الامتثال الكامل لكل ساعة؛ فقط نفس شرط البوابة العامة: نشاط
// مكشوف ومولّد للغبار + رياح >25 كم/س لتلك الساعة تحديداً.
export function isRegulatoryWindGateActive(
  windSpeedKmh: number | null,
  isDustGenerating: boolean,
  isEnclosedOperation: boolean
): boolean {
  return classifyWind(windSpeedKmh) === 'ABOVE_25' && isDustGenerating && !isEnclosedOperation;
}

// -----------------------------------------------------------------------
// ترتيب أولوية القرار (القسم 8 من "مرقاب") — الأعلى دائماً يفوز
// -----------------------------------------------------------------------
export const DECISION_PRIORITY: Record<DustComplianceDecisionCategory, number> = {
  ALLOW: 0,
  PRECAUTION: 1,
  ALLOW_WITH_CONTROLS: 2,
  FIELD_VERIFICATION_REQUIRED: 3,
  RESTRICT_ACTIVITY: 4,
  STOP_AFFECTED_ACTIVITY: 5,
  MANDATORY_STOP: 6,
};

function severityToDecision(severity: DustRuleHit['severity']): DustComplianceDecisionCategory {
  return severity;
}

export function decisionFromRules(
  ruleHits: DustRuleHit[],
  missingCriticalInputs: string[]
): DustComplianceDecisionCategory {
  let decision: DustComplianceDecisionCategory = 'ALLOW';

  for (const rule of ruleHits) {
    const candidate = severityToDecision(rule.severity);
    if (DECISION_PRIORITY[candidate] > DECISION_PRIORITY[decision]) {
      decision = candidate;
    }
  }

  // نقص البيانات الحرجة يمنع القرار الأخضر فقط — لا يُخفِّض قراراً أشد قائماً.
  if (
    missingCriticalInputs.length > 0 &&
    DECISION_PRIORITY.FIELD_VERIFICATION_REQUIRED > DECISION_PRIORITY[decision]
  ) {
    decision = 'FIELD_VERIFICATION_REQUIRED';
  }

  return decision;
}

// -----------------------------------------------------------------------
// قواعد الأنشطة التنظيمية (القسم 9 من "مرقاب")
// -----------------------------------------------------------------------

// actionAr مستقل تماماً عن messageAr (راجع تعليق DustRuleHit في types.ts) —
// إجراء تصحيحي موجَّه للمستخدم، وليس إعادة وصف للمخالفة نفسها.
//
// overridable اختياري — يفترض تلقائياً نفس القاعدة العامة القديمة (severity
// دون MANDATORY_STOP/STOP_AFFECTED_ACTIVITY = قابل للتجاوز) لأي قاعدة لا
// تحدده صراحة، فلا حاجة لتعديل عشرات نداءات ruleHit() الحالية. مرِّر القيمة
// صراحة فقط حين تختلف قابلية القاعدة عن افتراض severity العام (راجع
// overridable في types.ts للسبب الكامل).
//
// مُصدَّرة (لا محلية فقط) لأن engine.ts يبنيها أيضاً لطبقات القرار الثلاث
// (استئناف بوابة الرياح/استقرار الاستئناف/الثقة المنخفضة) بعد تحويلها من
// تعديل decisionCategory مباشرة إلى DustRuleHit فعلي — راجع تعليق الفصل بين
// القواعد والقرار في engine.ts.
export function ruleHit(
  code: string,
  severity: DustRuleHit['severity'],
  messageAr: string,
  actionAr: string,
  overridable: boolean = severity !== 'MANDATORY_STOP' && severity !== 'STOP_AFFECTED_ACTIVITY'
): DustRuleHit {
  return { code, severity, messageAr, actionAr, overridable };
}

// بوابة عامة على كل الأنشطة المكشوفة المولّدة للغبار — "الاستخراج التنظيمي
// من المرفق" القسم 5: رياح 15-25 كم/س تستوجب تثبيطاً معززاً (رش ساعي،
// تغطية الأكوام، خفض ارتفاع التفريغ لمتر، تشديد تنظيف الطرق وغسيل
// الإطارات)، دون إيقاف كامل — بخلاف GATE-WIND-ABOVE-25-004 (نفس النطاق
// المكشوف/المولّد للغبار لكن فوق 25 كم/س، إيقاف فعلي). أولويتها الدنيا
// (ALLOW_WITH_CONTROLS) تعني أنها لا تتجاوز أي قاعدة نشاط أشد قائمة أصلاً
// على نفس نطاق الرياح (مثال: إيقاف الهدم الصارم DEMO-WIND-STOP-001 عند
// نفس النطاق يبقى الأعلى أولوية).
export function enhancedSuppressionRule(
  isDustGenerating: boolean,
  isEnclosedOperation: boolean,
  windBand: DustWindBand
): DustRuleHit[] {
  if (windBand !== 'FROM_15_TO_25' || !isDustGenerating || isEnclosedOperation) return [];
  return [
    ruleHit(
      'GATE-WIND-15-25-ENHANCED-005',
      'ALLOW_WITH_CONTROLS',
      'تثبيط معزز مطلوب: سرعة الرياح بين 15-25 كم/س',
      'فعّل الرش الساعي، غطِّ الأكوام، اخفض ارتفاع التفريغ إلى متر واحد، وشدّد تنظيف الطرق وغسيل الإطارات'
    ),
  ];
}

// هبة قوية عابرة — احتراز سلامة إضافي منّا، لا بند من "بروتوكول الملحق أ"
// (النص التنظيمي يذكر "سرعة الرياح" فقط بعتبتي 15/25 كم/س، بلا أي إشارة
// للهبات). يقرأ windGustKmh الخام مباشرة (لا effectiveWindKmh، ولا يؤثر
// على windBand/classifyWind إطلاقاً) — منفصل تماماً عن بوابتي الرياح
// النظاميتين أعلاه (GATE-WIND-ABOVE-25-004/GATE-WIND-15-25-ENHANCED-005)،
// برمز مستقل (GATE-WIND-GUST-SAFETY) وseverity أخف (تنبيه/تثبيط، لا إيقاف
// إلزامي قطعي) حتى لا تُقرأ الواجهة أنها مخالفة تنظيمية بموجب الملحق أ.
// العتبة (50 كم/س) أعلى بكثير من حد الملحق أ (25) عمداً — هبة عابرة عند
// 30 مثلاً لا تستحق أي إجراء إضافي فوق ما تفرضه سرعة الرياح المستدامة
// نفسها؛ فقط هبات شديدة الخطورة فعلياً (قريبة من عتبة DVI-WIND-LOOSE-
// MATERIAL-005 الفيزيائية في dust-engine/engine.ts) تستحق تنبيهاً منفصلاً.
const WIND_GUST_SAFETY_THRESHOLD_KMH = () => getRuleParameters().WIND_GUST_SAFETY_THRESHOLD_KMH;

export function windGustSafetyRule(
  isDustGenerating: boolean,
  isEnclosedOperation: boolean,
  windGustKmh: number | null
): DustRuleHit[] {
  const windGustSafetyThresholdKmh = WIND_GUST_SAFETY_THRESHOLD_KMH();
  if (
    windGustKmh === null ||
    windGustKmh === undefined ||
    windGustKmh < windGustSafetyThresholdKmh ||
    !isDustGenerating ||
    isEnclosedOperation
  ) {
    return [];
  }
  return [
    ruleHit(
      'GATE-WIND-GUST-SAFETY',
      'ALLOW_WITH_CONTROLS',
      `هبة رياح قوية عابرة رُصدت (${windGustKmh} كم/س) — احتراز سلامة إضافي، ليست مخالفة بموجب بروتوكول الملحق أ`,
      'أمّن المواد السائبة والمعدات الخفيفة فوراً حتى تهدأ الهبة، وراقب استقرار سرعة الرياح المستدامة'
    ),
  ];
}

// مدة الاستمرار الدنيا (بالدقائق) قبل تصنيف قراءة ≥340 "مخالفة تنظيمية
// مؤكدة" (RCRC-PM10-340-VIOLATION-011) بدل "معلَّقة" فقط (MRQ-PM10-BLACK-
// PENDING-104) — النص التنظيمي: "لأكثر من دقيقتين". العتبة الفعلية
// (PM10_VIOLATION_CONFIRM_MINUTES) لم تعد هنا — انتقلت مع الحساب بالكامل
// إلى computeSustainedPm10Status في app/lib/dustEvaluation.ts، المصدر
// الوحيد الآن لقرار "مؤكَّدة" (راجع pm10ConfirmedViolation340 في
// DustComplianceContext وتعليق pm10ThresholdRule أدناه). لا ثابت مكرَّر هنا
// كي لا يبدو مصدراً فعلياً للقرار بينما هو ليس كذلك.

// مدة الاستمرار الدنيا لتفعيل تعليق النشاط الكامل عند >340 (RCRC-PM10-30M-
// SUSPENSION-012) — راجع تعليق pm10ThresholdRule أدناه لتفاصيل القرار
// التنظيمي (الجولة الثانية: الإيقاف يشترط استمرار التجاوز فوق 340 نفسه
// حصراً، لا نطاق التحذير [250,340]). يبقى مستخدَماً هنا للعرض النصي فقط
// بالرسالة (عدد الدقائق بالجملة) — قرار "معلَّقة 30 دقيقة" نفسه يُقرأ جاهزاً
// من pm10Suspended250For30Min، لا يُشتق من هذا الثابت.
//
// خطأ توثيقي مكتشَف ومُصلَح (مراجعة كود خارجي — "حزمة القواعد نفسها ما
// زالت تحمل السياسة القديمة"): كان رقماً مستقلاً مكتوباً يدوياً هنا، بمعزل
// عن ACTIVE_RULE_BUNDLE.pm10.regulatory.activityStopDurationMsInclusive —
// القيمة الفعلية (30 دقيقة) لم تتغيّر، فقط أصبحت تُقرأ من الحزمة النشطة.
const PM10_SUSPENSION_MINUTES = ACTIVE_RULE_BUNDLE.pm10.regulatory.activityStopDurationMsInclusive / 60_000;

// حدود PM10 التنظيمية العامة — "الاستخراج التنظيمي من المرفق" القسم 6.
// منفصلة تماماً عن بوابات DVI الفيزيائية (DVI-PM10-ACTION-003 وDVI-DUST-
// ACTIVITY-STOP-004 في dust-engine/engine.ts) — هذه عتبات تنظيمية رسمية
// من الوثيقة مباشرة، لا تقديرات فيزيائية.
//
// خطأ مكتشَف ومُصلَح (مراجعة كود مدير): كانت هذي الدالة تستقبل رقمي الدقائق
// (sustainedMinutesAbove340/250) وتُعيد اشتقاق "مؤكَّدة"/"معلَّقة 30 دقيقة"
// بنفسها من مقارنة محلية بسيطة — فتفقد كل فحوص computeSustainedPm10Status
// الحقيقية (هل مصدر السلسلة device فعلاً؟ هل آخر قراءة حديثة أم الجهاز
// متوقف؟)، وقد تقارن رقم دقائق محسوباً من سلسلة قراءات مصدرها مختلف عن
// pm10UgM3 نفسه (قراءات جهاز على مستوى المشروع تُدمَج لأي نشاط، راجع
// fetchPm10SustainedStatus). الإصلاح: القرار يُحسب مرة واحدة فقط في
// computeSustainedPm10Status (حيث كل الأدلة متوفرة معاً) ويُمرَّر هنا جاهزاً
// كـconfirmedViolation340/suspended250For30Min — لا إعادة اشتقاق من أرقام
// خام هنا إطلاقاً.
export function pm10ThresholdRule(
  pm10UgM3: number | null,
  // الحالتان الجاهزتان من computeSustainedPm10Status (عبر DustComplianceContext.
  // pm10ConfirmedViolation340/pm10Suspended250For30Min) — undefined يعني "لا
  // بيانات استمرار متاحة"، فيُعامَل كـfalse (فشل آمن: يبقى القرار معلَّقاً لا
  // مؤكَّداً بلا دليل).
  //
  // خطأ مكتشَف ومُصلَح (مراجعة كود خبير خارجي — "إعفاء محطة الخلط مخالف
  // للمرجع"): كان هذا التوقيع يقبل معامل isPm10ExemptEnclosedBatching يُعفي
  // محطة خلط (صوامع مغلقة + فلتر ≥99%) من قواعد PM10 كلها. الإعفاء يبقى
  // مقصوراً على بوابة الرياح (isEnclosedExemptFromHighWind في engine.ts).
  confirmedViolation340?: boolean,
  suspended250For30Min?: boolean
): DustRuleHit[] {
  if (pm10UgM3 === null || pm10UgM3 === undefined) return [];

  const hits: DustRuleHit[] = [];

  // قرار تنظيمي مُعاد النظر فيه عبر عدة جولات (طلب صريح من المستخدم في كل
  // مرة): تصعيد إلى >340 لأكثر من دقيقتين كان يوقف النشاط فوراً وإلزامياً
  // في التصميم الأصلي — أُلغي ذلك، فأصبح تأكيد مخالفة 340 توثيقاً/تنبيهاً
  // فقط (PM10-VIOLATION-STOP-006، ALLOW_WITH_CONTROLS)، نفس مستوى الضوابط
  // المعروض في نطاق [250,340]. الإيقاف الفعلي الوحيد للنشاط هو RCRC-PM10-
  // 30M-SUSPENSION-012 أدناه — والذي أصبح بدوره (الجولة الثانية) يشترط
  // استمرار التجاوز فوق 340 نفسه لمدة 30 دقيقة، لا استمراراً موحَّداً من
  // 250 (راجع computeSustainedPm10Status في dustEvaluation.ts للتفاصيل
  // الكاملة). `>` صراحة لا `>=` عند حد المخالفة (340 بالضبط يبقى ضمن نطاق
  // التحذير أدناه لا "مخالفة"، حتى تتجاوز الحد فعلياً). أما تأكيد المخالفة
  // نفسها (الدقيقتان)، فأصبح `>=` بدل `>` (طلب صريح: اكتمال الدقيقتين كافٍ)
  // — راجع isConfirmedViolation340 في dustEvaluation.ts.
  if (pm10UgM3 > PM10_VIOLATION_STOP_UG_M3) {
    const isConfirmed = confirmedViolation340 === true;
    if (isConfirmed) {
      hits.push(
        ruleHit(
          'PM10-VIOLATION-STOP-006',
          'ALLOW_WITH_CONTROLS',
          `مخالفة تنظيمية مؤكدة ومسجَّلة: تركيز PM10 (${pm10UgM3} ميكروجرام/م³) تجاوز حد المخالفة (${PM10_VIOLATION_STOP_UG_M3} ميكروجرام/م³) لدقيقتين متتاليتين فأكثر — النشاط مستمر تحت الضوابط المعزَّزة، الإيقاف الفعلي مرتبط فقط باستمرار التجاوز فوق ${PM10_VIOLATION_STOP_UG_M3} ميكروجرام/م³ لمدة ${PM10_SUSPENSION_MINUTES} دقيقة متواصلة`,
          'استمر بتطبيق التثبيط المعزز فوراً (رش ساعي أو مثبطات، تغطية الأكوام، خفض ارتفاع التفريغ، تقييد حركة النقل) — هذه مخالفة موثَّقة رسمياً، لا إيقاف إلزامي بحد ذاته'
        )
      );
    } else {
      // قرار تنظيمي مُعاد النظر فيه (طلب صريح من المستخدم — مراجعة كود
      // خبير خارجي، الملاحظة #7: "قبل 30 دقيقة يوجد إيقاف احترازي ❌ P0
      // — المطلوب قبل 120 ثانية: PENDING_CONFIRMATION + ENHANCED_CONTROLS
      // + MONITOR، وليس STOP_AFFECTED_ACTIVITY"): كانت severity=
      // STOP_AFFECTED_ACTIVITY هنا تجعل decideFinal يُصعِّد القرار إلى
      // PROTECTIVE_STOP (عبر pendingAffectedStop في final-decision-engine/
      // engine.ts)، وAEI يعرض حالة "معلَّق مؤقتاً" حمراء مع سقف درجة —
      // تقييد/تحذير فعلي قبل حتى اكتمال الدقيقتين، رغم أن القرار الصريح
      // المُثبَّت مسبقاً هو: لا إيقاف ولا تقييد بسبب PM10 قبل تأكيد 30
      // دقيقة فوق 340. الآن ALLOW_WITH_CONTROLS (نفس مستوى PM10-WARNING-008)
      // — القراءة لم تُثبِت بعد اكتمال دقيقتين استمرار، فتبقى "معلَّقة"
      // (pendingConfirmation=true عبر isPendingRuleHit في engine.ts، غير
      // متأثر بهذا التغيير) لكن بلا أي تقييد تشغيلي، فقط ضوابط معزَّزة
      // ومراقبة (MONITOR عبر decideFinal/AEI).
      hits.push(
        ruleHit(
          'MRQ-PM10-BLACK-PENDING-104',
          'ALLOW_WITH_CONTROLS',
          `تنبيه: تركيز PM10 (${pm10UgM3} ميكروجرام/م³) تجاوز حد المخالفة (${PM10_VIOLATION_STOP_UG_M3} ميكروجرام/م³) — بانتظار اكتمال دقيقتين استمرار لتصنيفها مخالفة تنظيمية مؤكدة`,
          'فعّل التثبيط المعزز فوراً (رش ساعي أو مثبطات، تغطية الأكوام، خفض ارتفاع التفريغ) وراقب استمرار القراءة عن كثب — ستُصبح مخالفة تنظيمية مؤكدة وموثَّقة (بلا إيقاف إلزامي فوري) إن استمر التجاوز دقيقتين فأكثر'
        )
      );
    }
  } else if (pm10UgM3 >= PM10_WARNING_UG_M3) {
    // نطاق التحذير/التحكم المعزَّز الموحَّد [250,340] — طلب صريح من
    // المستخدم بدمج نطاقي "احتراز" و"تقييد شديد" السابقين في مستوى واحد
    // فقط (لا تدرّج داخلي)، مطابقةً لنص الوثيقة التنظيمية حرفياً (3 مستويات
    // لا 4). الفرع أعلاه (> PM10_VIOLATION_STOP_UG_M3 = 340) يتولى ما بعد
    // حد المخالفة بمعزل تام — هذا الفرع (else) يتوقف تلقائياً عنده.
    hits.push(
      ruleHit(
        'PM10-WARNING-008',
        'ALLOW_WITH_CONTROLS',
        `تحذير: تركيز PM10 (${pm10UgM3} ميكروجرام/م³) بلغ أو تجاوز حد التحذير (${PM10_WARNING_UG_M3} ميكروجرام/م³)`,
        'فعّل التثبيط المعزز فوراً: رش ساعي أو مثبطات، تغطية الأكوام وخفض ارتفاع التفريغ إلى متر واحد، تقليل واجهات العمل المتزامنة، وتقييد حركة النقل'
      )
    );
  }

  // RCRC-PM10-30M-SUSPENSION-012: قرار تنظيمي مُعاد النظر فيه (طلب صريح من
  // المستخدم — "الإيقاف الفعلي فقط عند استمرار التجاوز فوق 340 لمدة 30
  // دقيقة"، يُلغي التوحيد السابق مع نطاق التحذير [250,340]): الشرط أصبح
  // pm10UgM3 > PM10_VIOLATION_STOP_UG_M3 (لا >= PM10_WARNING_UG_M3) —
  // القراءة الحالية يجب أن تكون فوق 340 فعلياً، متسقاً مع suspended250For30Min
  // التي أصبحت تقيس (عبر computeSustainedPm10Status) مدة الاستمرار فوق 340
  // حصراً، لا استمراراً موحَّداً من 250. منفصلة عن شرط PM10-VIOLATION-STOP-006/
  // MRQ-PM10-BLACK-PENDING-104 أعلاه (قد يتحقق الاثنان معاً؛ decisionFromRules
  // يختار الأشد). القرار جاهز من computeSustainedPm10Status، لا يُعاد اشتقاقه هنا.
  if (pm10UgM3 > PM10_VIOLATION_STOP_UG_M3 && suspended250For30Min === true) {
    hits.push(
      ruleHit(
        'RCRC-PM10-30M-SUSPENSION-012',
        'STOP_AFFECTED_ACTIVITY',
        `تعليق النشاط: تركيز PM10 (${pm10UgM3} ميكروجرام/م³) استمر فوق ${PM10_VIOLATION_STOP_UG_M3} ميكروجرام/م³ لمدة ${PM10_SUSPENSION_MINUTES} دقيقة متواصلة`,
        'علّق النشاط المسبب للغبار حتى ينخفض التركيز ويستقر دون الحد لفترة كافية، وفعّل التثبيط المعزز فوراً'
      )
    );
  }

  return hits;
}

// A1 — تجهيز الموقع وأعمال الحفر والأعمال الترابية (الحفر، التسوية، الردم،
// الخنادق، الدمك). القسم الرابع، ثانياً: "رش التربة أثناء الحفر والتحميل
// والتفريغ" إلزامي، وارتفاع تفريغ التربة يخضع لنفس حدود A5 (1.5م اعتيادياً،
// 1م أثناء الرياح ≥15 كم/س).
// حقول الضوابط البوليانية لهذا النشاط (رش التربة، مسارات الشاحنات، الدك،
// إلخ) لم تعد تُدخَل عبر الواجهة — تحوّلت إلى تنبيهات نصية عامة توعوية
// (راجع GENERAL_ALERTS_AR في AddActivityModal/DustStep.tsx) بقرار صريح
// بحذف تأثيرها من القرار التنظيمي بدل الاعتماد على قيم افتراضية/فارغة قد
// تُخفي مخالفة فعلية. الحقل الرقمي الوحيد المتبقي كمدخل حقيقي (dropHeightM)
// يبقى قاعدة فعلية لأنه قياس، لا تصريح "نعم/لا".
function earthworksRules(
  activity: DustActivityComplianceProfile,
  windBand: DustWindBand
): DustRuleHit[] {
  const hits: DustRuleHit[] = [];

  const dropHeightHighWindLimitM = DROP_HEIGHT_HIGH_WIND_LIMIT_M();
  const dropHeightNormalLimitM = DROP_HEIGHT_NORMAL_LIMIT_M();
  const dropHeight = activity.measurements.dropHeightM;
  if (dropHeight !== null && dropHeight !== undefined) {
    if (windBand !== 'BELOW_15' && dropHeight > dropHeightHighWindLimitM) {
      hits.push(
        ruleHit(
          'EARTHWORKS-DROP-002',
          'STOP_AFFECTED_ACTIVITY',
          `ارتفاع تفريغ التربة (${dropHeight} م) يتجاوز الحد المسموح أثناء الرياح النشطة (${dropHeightHighWindLimitM} م)`,
          `خفّض ارتفاع تفريغ التربة إلى ${dropHeightHighWindLimitM} م أو أقل طوال فترة الرياح النشطة`
        )
      );
    } else if (dropHeight > dropHeightNormalLimitM) {
      hits.push(
        ruleHit(
          'EARTHWORKS-DROP-003',
          'STOP_AFFECTED_ACTIVITY',
          `ارتفاع تفريغ التربة (${dropHeight} م) يتجاوز الحد الاعتيادي (${dropHeightNormalLimitM} م)`,
          `خفّض ارتفاع تفريغ التربة إلى ${dropHeightNormalLimitM} م أو أقل`
        )
      );
    }
  }

  return hits;
}

// 9.4 الهدم — بوابة الرياح (DEMO-WIND-STOP-001) وحد المساحة (DEMO-AREA-002)
// وحدهما يبقيان قاعدتين فعليتين: يعتمدان على isEnclosedOperation (سؤال
// بنيوي حقيقي، راجع تعليقه في DustStep.tsx) وdemolitionActiveAreaM2 (قياس
// رقمي)، وهما الحقلان الوحيدان الباقيان كمدخلات حقيقية لهذا النشاط. بقية
// الضوابط (الرش/الشاشات/مدى المدفع/تغطية الكسارات/طريقة القطع/الضغط
// الرملي) تحوّلت إلى تنبيهات نصية عامة — حُذف تأثيرها من القرار هنا.
function demolitionRules(
  activity: DustActivityComplianceProfile,
  windBand: DustWindBand
): DustRuleHit[] {
  const hits: DustRuleHit[] = [];
  const isExposed = !activity.isEnclosedOperation;

  if (isExposed && (windBand === 'FROM_15_TO_25' || windBand === 'ABOVE_25')) {
    const windGateEnhancedMinKmh = getRuleParameters().WIND_GATE_ENHANCED_MIN_KMH;
    hits.push(
      ruleHit(
        'DEMO-WIND-STOP-001',
        'MANDATORY_STOP',
        `إيقاف إلزامي: أعمال هدم مكشوفة أثناء رياح ≥${windGateEnhancedMinKmh} كم/س (الحد الأقصى التنظيمي ${windGateEnhancedMinKmh} كم/س لأعمال الهدم)`,
        `أوقف أعمال الهدم المكشوفة فوراً حتى تنخفض سرعة الرياح إلى ما دون ${windGateEnhancedMinKmh} كم/س، أو حوّلها لعملية مغلقة`
      )
    );
  }

  const activeArea = activity.measurements.demolitionActiveAreaM2;
  const demolitionMaxAreaM2 = DEMOLITION_MAX_AREA_M2();
  if (activeArea !== null && activeArea !== undefined && activeArea > demolitionMaxAreaM2) {
    hits.push(
      ruleHit(
        'DEMO-AREA-002',
        'STOP_AFFECTED_ACTIVITY',
        `مساحة الهدم النشطة (${activeArea} م²) تتجاوز الحد المسموح (${demolitionMaxAreaM2} م² في المرة الواحدة)`,
        `قسّم أعمال الهدم إلى مراحل بحيث لا تتجاوز المساحة النشطة ${demolitionMaxAreaM2} م² في المرة الواحدة`
      )
    );
  }

  return hits;
}

// 9.5 الكسارة
function crusherRules(
  project: DustProjectComplianceProfile,
  riskClass: DustRiskClass,
  activity: DustActivityComplianceProfile
): DustRuleHit[] {
  const hits: DustRuleHit[] = [];

  if (riskClass !== 'CATEGORY_III_HIGH') {
    hits.push(
      ruleHit(
        'CRUSHER-CATEGORY-001',
        'MANDATORY_STOP',
        'الكسارات مسموحة فقط في مشاريع الفئة الثالثة (عالية المخاطر)',
        'أوقف تشغيل الكسارة — غير مسموح بها إلا في مشاريع الفئة الثالثة (عالية المخاطر)'
      )
    );
  }


  // المسافة المحسوبة تلقائياً من إحداثيات الكسارة + جدول sensitive_receptors
  // (عند توفرها) لها الأولوية على الحقل اليدوي القديم — نفس مبدأ "دع مرقاب
  // يحسبها" الوارد صراحة في المستند.
  const autoAny = activity.measurements.crusherDistanceToNearestReceptorAutoM;
  const autoResidential = activity.measurements.crusherDistanceToResidentialReceptorAutoM;
  const manualDistance = activity.measurements.crusherDistanceToReceptorM;

  // قرار مُعاد النظر فيه بالكامل (طلب صريح من المستخدم — "المستقبلات الحساسة
  // لا تدخل ضمن قرارات الإيقاف"): كل قواعد مسافة المستقبِل الحساس للكسارة
  // (البيانات الناقصة، والمسافتان العامة/السكنية، واتجاه الريح) كانت تُصدر
  // MANDATORY_STOP/FIELD_VERIFICATION_REQUIRED/RESTRICT_ACTIVITY — إيقاف أو
  // تقييد فعلي للنشاط بناءً على بيانات مستقبلات قد تكون غير مكتملة أصلاً
  // (جدول sensitive_receptors يدوي بحت، لا يشمل مستقبلات OSM المكتشفة تلقائياً
  // المعروضة توعوياً في نفس الشاشة — راجع app/api/projects/[projectId]/route.ts).
  // هذا التناقض (المستخدم يرى مستقبِلاً حقيقياً قريباً بينما القرار يقول "لا
  // توجد بيانات") كان السبب المباشر لإعادة النظر. المسافتان العامة/السكنية
  // واتجاه الريح أدناه أصبحت ALLOW_WITH_CONTROLS (تحذير/تنبيه توعوي فقط).
  //
  // CRUSHER-RECEPTORS-DATA-MISSING حُذفت بالكامل (لا مجرد تخفيف severity —
  // طلب صريح لاحق من المستخدم: "لا اريد ان يظهر تعذر"): حتى كتنبيه
  // ALLOW_WITH_CONTROLS، رسالة "تعذّر التحقق... لا توجد بيانات" تبقى مربكة
  // بذاتها لأنها لا تعرف شيئاً عن مستقبلات OSM المكتشفة والمعروضة توعوياً في
  // نفس الشاشة (computeUnitReceptors في route.ts) — غياب الجدول اليدوي وحده
  // لا يعني فعلياً "لا بيانات متاحة"، فعرض هذه الرسالة أصلاً مضلِّل بصرف
  // النظر عن severity. القواعد الأخرى (المسافة الفعلية إن حُسبت auto/يدوياً)
  // تبقى، فهي معلومة حقيقية عن مسافة معروفة فعلاً، لا عن غياب بيانات.
  const crusherGeneralReceptorDistanceM = CRUSHER_GENERAL_RECEPTOR_DISTANCE_M();
  const crusherSensitiveReceptorDistanceM = CRUSHER_SENSITIVE_RECEPTOR_DISTANCE_M();

  const generalDistance = autoAny ?? manualDistance;
  if (generalDistance !== null && generalDistance !== undefined && generalDistance < crusherGeneralReceptorDistanceM) {
    hits.push(
      ruleHit(
        'CRUSHER-DISTANCE-200-002B',
        'ALLOW_WITH_CONTROLS',
        `تنبيه: مسافة الكسارة عن أقرب مستقبل حساس (${autoAny !== null && autoAny !== undefined ? 'محسوبة تلقائياً: ' : ''}${generalDistance} م) أقل من الحد الأدنى (${crusherGeneralReceptorDistanceM} م). تنبيه توعوي فقط، لا يوقف النشاط`,
        `يُفضَّل نقل الكسارة لمسافة لا تقل عن ${crusherGeneralReceptorDistanceM} م عن أقرب مستقبل حساس، أو زيادة إجراءات التثبيط`
      )
    );
  }

  const residentialDistance = autoResidential ?? manualDistance;
  if (residentialDistance !== null && residentialDistance !== undefined && residentialDistance < crusherSensitiveReceptorDistanceM) {
    hits.push(
      ruleHit(
        'CRUSHER-DISTANCE-500-002C',
        'ALLOW_WITH_CONTROLS',
        `تنبيه: مسافة الكسارة عن سكني/مدارس/مستشفيات (${autoResidential !== null && autoResidential !== undefined ? 'محسوبة تلقائياً: ' : ''}${residentialDistance} م) أقل من الحد الأدنى (${crusherSensitiveReceptorDistanceM} م). تنبيه توعوي فقط، لا يوقف النشاط`,
        `يُفضَّل نقل الكسارة لمسافة لا تقل عن ${crusherSensitiveReceptorDistanceM} م عن أقرب منطقة سكنية/مدرسة/مستشفى، أو زيادة إجراءات التثبيط`
      )
    );
  }

  // MRQ-RECEPTOR-DOWNWIND-120: تنبيه عند وجود مستقبِل حساس فعلياً باتجاه هبوب
  // الرياح (لا مجرد قريب بالمسافة المستقيمة) — يُطبَّق فقط لو كان اتجاه الرياح
  // متوفراً (crusherDistanceToDownwindReceptorAutoM يبقى null لو غاب اتجاه
  // الرياح أصلاً، راجع adapters.ts).
  const downwindDistance = activity.measurements.crusherDistanceToDownwindReceptorAutoM;
  if (
    downwindDistance !== null &&
    downwindDistance !== undefined &&
    downwindDistance < crusherSensitiveReceptorDistanceM
  ) {
    hits.push(
      ruleHit(
        'MRQ-RECEPTOR-DOWNWIND-120',
        'ALLOW_WITH_CONTROLS',
        `تنبيه: مستقبِل حساس (سكني/مدرسي/صحي) يقع فعلياً باتجاه هبوب الرياح الحالي من الكسارة (على بُعد ${downwindDistance === Infinity ? '—' : downwindDistance + ' م'}). تنبيه توعوي فقط، لا يوقف النشاط`,
        'يُفضَّل زيادة إجراءات التثبيط طالما استمر اتجاه الرياح نحو المستقبِل الحساس'
      )
    );
  }

  // ضوابط الكسارة التفصيلية (تغطية الوحدات/الناقلات، أنظمة الرش والضباب،
  // ارتفاع التفريغ، الشفط والفلترة) تحوّلت إلى تنبيهات نصية عامة — حُذف
  // تأثيرها من القرار هنا. القواعد الباقية فعلياً: CRUSHER-CATEGORY-001
  // (تصنيف المشروع، لا مدخل مستخدم) ومسافتا المستقبِل الحساس أعلاه
  // (محسوبتان تلقائياً من موقع الكسارة على الخريطة، ما زال مدخلاً حقيقياً).

  return hits;
}

// A6 — محطات خلط الخرسانة ونقل الإسمنت (القسم الرابع، الفقرة "ب"؛
// مصفوفة الأنشطة A6 في "الاستخراج التنظيمي من المرفق").
function batchingPlantRules(activity: DustActivityComplianceProfile): DustRuleHit[] {
  const hits: DustRuleHit[] = [];

  if (activity.controls.silosSealed === false) {
    hits.push(
      ruleHit('BATCHING-SILO-001', 'MANDATORY_STOP', 'إيقاف إلزامي: صوامع الإسمنت غير محكمة الإغلاق', 'أوقف التشغيل حتى يتم إحكام إغلاق صوامع الإسمنت بالكامل')
    );
  }

  const filterEfficiency = activity.controls.pm10FilterEfficiencyPercent;
  const batchingPm10FilterMinPercent = BATCHING_PM10_FILTER_MIN_PERCENT();
  if (
    filterEfficiency !== null && filterEfficiency !== undefined &&
    filterEfficiency < batchingPm10FilterMinPercent
  ) {
    hits.push(
      ruleHit(
        'BATCHING-FILTER-002',
        'MANDATORY_STOP',
        `كفاءة فلتر الجسيمات العالقة (${filterEfficiency}%) أقل من الحد الأدنى (${batchingPm10FilterMinPercent}%)`,
        `استبدل أو اصلح فلتر الجسيمات العالقة حتى تصل كفاءته إلى ${batchingPm10FilterMinPercent}% على الأقل`
      )
    );
  }

  if (activity.controls.leakDetected === true) {
    hits.push(
      ruleHit('BATCHING-LEAK-003', 'STOP_AFFECTED_ACTIVITY', 'تسرب مرصود من صومعة الإسمنت أو نظام النقل', 'أصلح مصدر التسرب في الصومعة أو نظام النقل فوراً')
    );
  }

  if (activity.controls.dryCleaningMethodUsed === true) {
    hits.push(
      ruleHit('BATCHING-DRYCLEAN-004', 'RESTRICT_ACTIVITY', 'استخدام الكنس الجاف أو النفخ بالهواء المضغوط ممنوع؛ يلزم الشفط أو التنظيف الرطب', 'استبدل الكنس الجاف/الهواء المضغوط بالشفط أو التنظيف الرطب')
    );
  }

  if (activity.controls.dustSuppressionSystemOperational === false) {
    hits.push(
      ruleHit('BATCHING-SUPPRESSION-005', 'STOP_AFFECTED_ACTIVITY', 'نظام تثبيط الغبار غير مُشغَّل عند محطة الخلط', 'شغّل نظام تثبيط الغبار عند محطة الخلط قبل الاستئناف')
    );
  }

  // خطأ مكتشَف ومُصلَح (مراجعة كود خبير خارجي — "قاعدة 200م لمحطة الخلط غير
  // منفذة"): المرجع التنظيمي (القسم 3.5، تخزين المواد) يمنع إنشاء محطات
  // خلط أو تخزين مواد ضمن 200م من المدارس/المستشفيات/المساجد/المناطق
  // السكنية — نفس الحد المستخدم فعلاً لأقرب مستقبِل حساس للكسارة
  // (CRUSHER_GENERAL_RECEPTOR_DISTANCE_M أعلاه). الإحداثيات والمسافة
  // المحسوبة تلقائياً (batchingDistanceToNearestReceptorAutoM، عبر
  // adapters.ts + geo.ts) كانتا تُجمَعان وتُمرَّران بالكامل حتى
  // DustActivityComplianceProfile، لكن لا قاعدة هنا كانت تستهلكهما —
  // فمحطة خلط على بُعد أمتار من مدرسة كانت تمر بلا أي مخالفة مسافة إطلاقاً.
  //
  // null (لا Infinity) يعني تحديداً "لم تُدخَل إحداثيات محطة الخلط على
  // الخريطة بعد" (راجع nearestReceptorDistancesM في geo.ts: lat/lng غائبين
  // → null؛ إحداثيات موجودة بلا أي مستقبِل حساس مسجَّل قريب → Infinity).
  const batchingDistance = activity.measurements.batchingDistanceToNearestReceptorAutoM;
  // قرار مُعاد النظر فيه (طلب صريح من المستخدم — "المستقبلات الحساسة لا
  // تدخل ضمن قرارات الإيقاف"، نفس القرار المطبَّق على قواعد الكسارة أعلاه):
  // BATCHING-DISTANCE-200 أدناه أصبحت ALLOW_WITH_CONTROLS (تنبيه توعوي فقط)
  // بدل MANDATORY_STOP.
  //
  // BATCHING-DISTANCE-MISSING وBATCHING-RECEPTORS-DATA-MISSING حُذفتا
  // بالكامل (طلب صريح لاحق من المستخدم: "لا اريد ان يظهر تعذر") — نفس
  // منطق CRUSHER-RECEPTORS-DATA-MISSING أعلاه: رسالة "تعذّر..." تبقى مربكة
  // بذاتها حتى كتنبيه، لأنها لا تعرف شيئاً عن مستقبلات OSM المكتشفة توعوياً
  // في نفس الشاشة. لا يوجد إيقاف أو تنبيه إطلاقاً الآن لغياب إحداثيات محطة
  // الخلط أو غياب بيانات المستقبلات — فقط BATCHING-DISTANCE-200 يبقى
  // مفعَّلاً حين تُحسَب مسافة فعلية أقل من الحد.
  if (batchingDistance !== null && batchingDistance < CRUSHER_GENERAL_RECEPTOR_DISTANCE_M()) {
    const crusherGeneralReceptorDistanceM = CRUSHER_GENERAL_RECEPTOR_DISTANCE_M();
    hits.push(
      ruleHit(
        'BATCHING-DISTANCE-200',
        'ALLOW_WITH_CONTROLS',
        `تنبيه: مسافة محطة الخلط عن أقرب مستقبل حساس (محسوبة تلقائياً: ${batchingDistance} م) أقل من الحد الأدنى (${crusherGeneralReceptorDistanceM} م). تنبيه توعوي فقط، لا يوقف النشاط`,
        `يُفضَّل نقل محطة الخلط لمسافة لا تقل عن ${crusherGeneralReceptorDistanceM} م عن أقرب مستقبِل حساس (مدرسة/مستشفى/مسجد/منطقة سكنية)، أو زيادة إجراءات التثبيط`
      )
    );
  }

  // بقية ضوابط محطة الخلط (صيانة الفلاتر، فحص موانع التسرب، حظر الكنس
  // الجاف/الهواء المضغوط، رطوبة النفايات) تحوّلت إلى تنبيهات نصية عامة —
  // حُذف تأثيرها من القرار هنا. الحقول الخمسة السابقة + مسافة المستقبِل
  // الحساس أعلاه تبقى مدخلات حقيقية.

  return hits;
}

// 9.6 قطع الأحجار — wetCuttingActive/hepaExtractionActive/cuttingResiduesCleaned
// لم تعد تُدخَل عبر الواجهة (تحوّلت لتنبيه نصي عام) — حُذف تأثيرها من
// القرار هنا. القاعدة الباقية فعلياً هي بوابة الرياح (STONECUT-WIND-STOP-003)
// المعتمدة على isEnclosedOperation (سؤال بنيوي حقيقي ما زال مدخلاً) وبيانات
// الرياح الحية، لا تصريح المستخدم عن طريقة القطع.
function stoneCuttingRules(
  activity: DustActivityComplianceProfile,
  windBand: DustWindBand
): DustRuleHit[] {
  const hits: DustRuleHit[] = [];

  // إيقاف تلقائي من سرعة الرياح (API/مستشعر) — بلا سؤال مستخدم، بنفس مبدأ
  // demolitionRules، لأعمال القطع المكشوفة فقط.
  const isExposed = !activity.isEnclosedOperation;
  if (isExposed && (windBand === 'FROM_15_TO_25' || windBand === 'ABOVE_25')) {
    const stoneCuttingWindStopKmh = STONE_CUTTING_WIND_STOP_KMH();
    hits.push(
      ruleHit(
        'STONECUT-WIND-STOP-003',
        'MANDATORY_STOP',
        `إيقاف إلزامي: قطع أحجار مكشوف أثناء رياح تتجاوز الحد المسموح (${stoneCuttingWindStopKmh} كم/س)`,
        `أوقف القطع المكشوف فوراً حتى تنخفض سرعة الرياح إلى ما دون ${stoneCuttingWindStopKmh} كم/س، أو حوّله لتشغيل مغلق`
      )
    );
  }

  return hits;
}

// 9.7 الدخول والخروج — يشمل تفريع طريقة تنظيف الإطارات (وحدة غسيل مقابل
// غمر بالمياه)، كل فرع بأسئلته الخاصة، حسب تفصيل مستند "تجهيز الموقع
// وأعمال الحفر.pdf".
function entryExitRules(
  activity: DustActivityComplianceProfile,
  windBand: DustWindBand
): DustRuleHit[] {
  const hits: DustRuleHit[] = [];

  if (activity.controls.wheelWashOperational === false) {
    hits.push(ruleHit('ENTRY-WHEELWASH-001', 'STOP_AFFECTED_ACTIVITY', 'وحدة غسيل الإطارات غير متوفرة أو غير عاملة', 'شغّل وحدة غسيل الإطارات أو وفّر بديلاً عاملاً قبل السماح بخروج الشاحنات'));
  }

  if (activity.measurements.visibleTrackoutBeyond15m === true) {
    hits.push(ruleHit('ENTRY-TRACKOUT-002', 'STOP_AFFECTED_ACTIVITY', 'أتربة منقولة مرئية تتجاوز 15 متراً من بوابة الخروج', 'نظّف الأتربة المنقولة خارج البوابة فوراً وعالج سبب انتقالها'));
  }

  if (windBand === 'FROM_15_TO_25' && activity.controls.hourlyInspectionRecorded === false) {
    hits.push(ruleHit('ENTRY-INSPECTION-003', 'RESTRICT_ACTIVITY', 'لم يُسجَّل فحص وحدة غسيل الإطارات كل ساعة أثناء الرياح 15-25 كم/س', 'سجّل فحصاً موثقاً لوحدة غسيل الإطارات كل ساعة طوال فترة الرياح 15-25 كم/س'));
  }

  if (activity.measurements.entryPointLat === null || activity.measurements.entryPointLng === null) {
    hits.push(ruleHit('ENTRY-POINT-MISSING-004', 'FIELD_VERIFICATION_REQUIRED', 'لم يتم تحديد نقطة دخول المشروع على الخريطة', 'حدّد نقطة دخول المشروع على الخريطة في بيانات النشاط'));
  }
  if (activity.measurements.exitPointLat === null || activity.measurements.exitPointLng === null) {
    hits.push(ruleHit('ENTRY-EXITPOINT-MISSING-005', 'FIELD_VERIFICATION_REQUIRED', 'لم يتم تحديد نقطة خروج المشروع على الخريطة', 'حدّد نقطة خروج المشروع على الخريطة في بيانات النشاط'));
  }
  if (activity.controls.accessRoadPaved === false) {
    hits.push(ruleHit('ENTRY-ROADPAVED-006', 'RESTRICT_ACTIVITY', 'الطريق المؤدي للمدخل غير مسفلت أو غير ممهد', 'اسفلت الطريق المؤدي للمدخل أو مهّده بمادة تمنع تطاير الغبار'));
  }

  // فرع وحدة غسيل الإطارات
  if (activity.controls.tireCleaningMethod === 'WHEEL_WASH') {
    if (activity.controls.sandTrapPresent === false) {
      hits.push(ruleHit('ENTRY-SANDTRAP-007', 'RESTRICT_ACTIVITY', 'لا توجد مصيدة رمال في وحدة غسيل الإطارات', 'ركّب مصيدة رمال في وحدة غسيل الإطارات'));
    }
    if (activity.controls.oilSeparatorPresent === false) {
      hits.push(ruleHit('ENTRY-OILSEP-008', 'RESTRICT_ACTIVITY', 'لا يوجد فاصل زيوت في وحدة غسيل الإطارات', 'ركّب فاصل زيوت في وحدة غسيل الإطارات'));
    }
    if (activity.controls.washCycleDurationAdequate === false) {
      const wheelWashCycleMinSec = WHEEL_WASH_CYCLE_MIN_SEC();
      hits.push(ruleHit('ENTRY-WASHCYCLE-009', 'RESTRICT_ACTIVITY', `مدة دورة غسيل الإطارات أقل من ${wheelWashCycleMinSec} ثانية لكل محور`, `اضبط مدة دورة الغسيل على ${wheelWashCycleMinSec} ثانية على الأقل لكل محور`));
    }
    if (activity.controls.washWaterReused === false) {
      hits.push(ruleHit('ENTRY-WASHREUSE-010', 'ALLOW_WITH_CONTROLS', 'يُفضَّل إعادة استخدام مياه غسيل الإطارات', 'أضف نظام إعادة استخدام لمياه غسيل الإطارات'));
    }
  }

  // فرع غمر الإطارات بالمياه
  if (activity.controls.tireCleaningMethod === 'WATER_IMMERSION') {
    if (activity.controls.antiSlipMeshPresent === false) {
      hits.push(ruleHit('ENTRY-IMMERSION-MESH-011', 'RESTRICT_ACTIVITY', 'لا توجد شبكة مانعة للانزلاق في منطقة غمر الإطارات', 'ركّب شبكة مانعة للانزلاق في منطقة غمر الإطارات'));
    }
    if (activity.controls.immersionZoneLengthAdequate === false) {
      const immersionZoneMinLengthM = IMMERSION_ZONE_MIN_LENGTH_M();
      hits.push(ruleHit('ENTRY-IMMERSION-LENGTH-012', 'RESTRICT_ACTIVITY', `طول منطقة غمر الإطارات أقل من ${immersionZoneMinLengthM} أمتار`, `وسّع منطقة غمر الإطارات إلى ${immersionZoneMinLengthM} أمتار على الأقل`));
    }
    if (activity.controls.collectionBasinPresent === false) {
      hits.push(ruleHit('ENTRY-BASIN-013', 'RESTRICT_ACTIVITY', 'لا يوجد حوض سفلي لتجميع مخلفات غمر الإطارات', 'أنشئ حوضاً سفلياً لتجميع مخلفات غمر الإطارات'));
    }
  }

  if (activity.controls.truckPathCleanedWithin15Min === false) {
    hits.push(ruleHit('ENTRY-PATHCLEAN-014', 'RESTRICT_ACTIVITY', 'لم يتم تنظيف مسار الشاحنات خلال 15 دقيقة', 'نظّف مسار الشاحنات خلال 15 دقيقة من كل عملية عبور'));
  }
  if (activity.measurements.waterTracesBeyond15mFromGate === true) {
    hits.push(ruleHit('ENTRY-WATERTRACE-015', 'RESTRICT_ACTIVITY', 'آثار مياه أو مخلفات ظاهرة على بعد 15 متراً من البوابة', 'أزل آثار المياه والمخلفات حول البوابة وقلّل كمية المياه المستخدمة في الغسيل'));
  }

  return hits;
}

// 9.8 الطرق والنقل (A2 — النقل داخل الموقع والطرق الخدمية) — ضوابط الرش/
// اللافتات/الكنس/غسيل الإطارات تحوّلت إلى تنبيهات نصية عامة — حُذف تأثيرها
// من القرار. الحقول الرقمية العتبية الثلاثة (سرعة الطرق، زمن تنظيف
// الانسكاب) تبقى قواعد فعلية لأنها قياسات، لا تصريحات. تغطية الحمولة
// (loadCovered) استثناء متعمَّد من "التحوّل لتنبيه نصي": منع خروج شاحنة
// غير مغطاة الحمولة قاعدة إلزامية صريحة في الدليل التنظيمي (لا مجرد إجراء
// موصى به)، فتبقى قاعدة فعلية تؤثر على القرار.
function siteTrafficRules(
  activity: DustActivityComplianceProfile,
  _riskClass: DustRiskClass
): DustRuleHit[] {
  const hits: DustRuleHit[] = [];

  if (activity.controls.loadCovered === false) {
    hits.push(
      ruleHit(
        'TRAFFIC-LOAD-004',
        'STOP_AFFECTED_ACTIVITY',
        'حمولة نقل التربة/المواد غير مغطاة — يُمنع خروج أي شاحنة بحمولة مكشوفة من الموقع',
        'أوقف خروج الشاحنات حتى يتم تغطية الحمولة بالكامل، والتزم بتغطية كل حمولة لاحقة قبل الخروج'
      )
    );
  }

  const unpaved = activity.measurements.unpavedSpeedKmh;
  const unpavedSpeedLimitKmh = UNPAVED_SPEED_LIMIT_KMH();
  if (unpaved !== null && unpaved !== undefined && unpaved > unpavedSpeedLimitKmh) {
    hits.push(ruleHit('TRAFFIC-UNPAVED-002', 'RESTRICT_ACTIVITY', `سرعة الطرق غير المسفلتة (${unpaved} كم/س) تتجاوز الحد (${unpavedSpeedLimitKmh} كم/س)`, `اخفض السرعة على الطرق غير المسفلتة إلى ${unpavedSpeedLimitKmh} كم/س أو أقل`));
  }
  const paved = activity.measurements.pavedSpeedKmh;
  const pavedSpeedLimitKmh = PAVED_SPEED_LIMIT_KMH();
  if (paved !== null && paved !== undefined && paved > pavedSpeedLimitKmh) {
    hits.push(ruleHit('TRAFFIC-PAVED-003', 'RESTRICT_ACTIVITY', `سرعة الطرق المسفلتة (${paved} كم/س) تتجاوز الحد (${pavedSpeedLimitKmh} كم/س)`, `اخفض السرعة على الطرق المسفلتة إلى ${pavedSpeedLimitKmh} كم/س أو أقل`));
  }
  const spillMin = activity.measurements.spillCleanupMinutes;
  const spillCleanupLimitMin = SPILL_CLEANUP_LIMIT_MIN();
  if (spillMin !== null && spillMin !== undefined && spillMin > spillCleanupLimitMin) {
    hits.push(ruleHit('TRAFFIC-SPILL-005', 'RESTRICT_ACTIVITY', `تنظيف المواد المنسكبة تجاوز الحد الزمني (${spillCleanupLimitMin} دقيقة)`, `قلّص زمن تنظيف المواد المنسكبة إلى ${spillCleanupLimitMin} دقيقة أو أقل`));
  }

  return hits;
}

// نقل مخلفات الهدم والبناء — ضوابط الرش/التخزين/التغطية/السعة تحوّلت إلى
// تنبيهات نصية عامة — حُذف تأثيرها من القرار. ارتفاع أكوام المخلفات يبقى
// قاعدة فعلية لأنه قياس رقمي، لا تصريح.
function cdWasteTransportRules(activity: DustActivityComplianceProfile): DustRuleHit[] {
  const hits: DustRuleHit[] = [];

  const pileHeight = activity.measurements.debrisPileHeightM;
  const debrisPileMaxHeightM = DEBRIS_PILE_MAX_HEIGHT_M();
  if (pileHeight !== null && pileHeight !== undefined && pileHeight > debrisPileMaxHeightM) {
    hits.push(ruleHit('CDWASTE-PILEHEIGHT-003', 'RESTRICT_ACTIVITY', `ارتفاع أكوام المخلفات (${pileHeight} م) يتجاوز الحد (${debrisPileMaxHeightM} م)`, `اخفض ارتفاع أكوام المخلفات إلى ${debrisPileMaxHeightM} م أو أقل`));
  }

  return hits;
}

// 9.9 الأكوام والمناولة
function stockpileRules(
  riskClass: DustRiskClass,
  windBand: DustWindBand,
  activity: DustActivityComplianceProfile
): DustRuleHit[] {
  const hits: DustRuleHit[] = [];
  const stockpileLimit = riskClass === 'CATEGORY_I_LOW' ? 1 : 3;

  const height = activity.measurements.stockpileHeightM;
  if (height !== null && height !== undefined && height > stockpileLimit) {
    hits.push(ruleHit('STOCKPILE-HEIGHT-001', 'RESTRICT_ACTIVITY', `ارتفاع الأكوام (${height} م) يتجاوز الحد (${stockpileLimit} م) لفئة المشروع`, `اخفض ارتفاع الأكوام إلى ${stockpileLimit} م أو أقل`));
  }

  // المسافة المحسوبة تلقائياً من إحداثيات موقع الأكوام + جدول
  // sensitive_receptors (عند توفرها) لها الأولوية على الحقل اليدوي — لا
  // يجوز أن يعتمد قرار المطابقة على تصريح المستخدم وحده بأن لا مستقبل
  // حساس قريب، لأنه قد يخطئ أو يتجاهل وجود منشأة فعلياً.
  const distance = activity.measurements.stockpileDistanceToNearestReceptorAutoM ?? activity.measurements.stockpileBatchingDistanceToReceptorM;
  const stockpileSensitiveReceptorDistanceM = STOCKPILE_SENSITIVE_RECEPTOR_DISTANCE_M();
  if (distance !== null && distance !== undefined && distance < stockpileSensitiveReceptorDistanceM) {
    hits.push(
      ruleHit(
        'STOCKPILE-DISTANCE-002',
        'STOP_AFFECTED_ACTIVITY',
        `مسافة الأكوام/محطة الخلط من المستقبِل الحساس (${activity.measurements.stockpileDistanceToNearestReceptorAutoM !== null && activity.measurements.stockpileDistanceToNearestReceptorAutoM !== undefined ? 'محسوبة تلقائياً: ' : ''}${distance} م) أقل من ${stockpileSensitiveReceptorDistanceM} م`,
        `انقل الأكوام/محطة الخلط إلى مسافة لا تقل عن ${stockpileSensitiveReceptorDistanceM} م عن أقرب مستقبل حساس`
      )
    );
  }

  // ضوابط التغطية/الرش/الشكل/الحواجز/السيور تحوّلت إلى تنبيهات نصية عامة —
  // حُذف تأثيرها من القرار. ارتفاع التفريغ يبقى قاعدة فعلية (قياس رقمي).
  const dropHeight = activity.measurements.dropHeightM;
  const dropHeightHighWindLimitM = DROP_HEIGHT_HIGH_WIND_LIMIT_M();
  const dropHeightNormalLimitM = DROP_HEIGHT_NORMAL_LIMIT_M();
  if (dropHeight !== null && dropHeight !== undefined) {
    if (windBand !== 'BELOW_15' && dropHeight > dropHeightHighWindLimitM) {
      hits.push(ruleHit('STOCKPILE-DROP-004', 'STOP_AFFECTED_ACTIVITY', `ارتفاع تفريغ المواد (${dropHeight} م) يتجاوز الحد المسموح أثناء الرياح النشطة (${dropHeightHighWindLimitM} م)`, `خفّض ارتفاع تفريغ المواد إلى ${dropHeightHighWindLimitM} م أو أقل طوال فترة الرياح النشطة`));
    } else if (dropHeight > dropHeightNormalLimitM) {
      hits.push(ruleHit('STOCKPILE-DROP-005', 'STOP_AFFECTED_ACTIVITY', `ارتفاع تفريغ المواد (${dropHeight} م) يتجاوز الحد الاعتيادي (${dropHeightNormalLimitM} م)`, `خفّض ارتفاع تفريغ المواد إلى ${dropHeightNormalLimitM} م أو أقل`));
    }
  }

  return hits;
}

// 9.10 الأسطح غير النشطة (A4 — يشمل أيضاً عنصري حالة الأغطية واتجاه/سرعة
// الرياح من مصفوفة الأنشطة A4)
function idleSurfaceRules(
  activity: DustActivityComplianceProfile,
  windSpeedKmh: number | null
): DustRuleHit[] {
  const hits: DustRuleHit[] = [];
  const idleDays = activity.measurements.idleDays;
  const idleSurfaceMaxDays = IDLE_SURFACE_MAX_DAYS();

  if (
    idleDays !== null && idleDays !== undefined && idleDays > idleSurfaceMaxDays &&
    activity.controls.idleSurfaceStabilized === false
  ) {
    hits.push(
      ruleHit(
        'IDLE-STABILIZE-001',
        'RESTRICT_ACTIVITY',
        `سطح غير نشط لأكثر من ${idleSurfaceMaxDays} أيام دون تثبيت`,
        'ثبّت السطح غير النشط بمواد تثبيت أو أغطية واقية'
      )
    );
  }

  // حالة الأغطية غير سليمة — مخالفة بذاتها بصرف النظر عن عدد الأيام
  if (activity.controls.idleSurfaceCoverIntact === false) {
    hits.push(
      ruleHit('IDLE-COVER-002', 'RESTRICT_ACTIVITY', 'غطاء السطح غير النشط غير سليم أو تالف', 'أصلح أو استبدل غطاء السطح غير النشط التالف')
    );
  }

  // فحص الأغطية إلزامي بعد رياح >20 كم/س — حالة الغطاء مجهولة عند هذه
  // السرعة تُعامَل كمخالفة محتملة (نفس مبدأ عدم إصدار قرار أخضر مع نقص بيانات)
  const idleSurfaceCoverInspectionWindKmh = IDLE_SURFACE_COVER_INSPECTION_WIND_KMH();
  if (
    windSpeedKmh !== null && windSpeedKmh !== undefined &&
    windSpeedKmh > idleSurfaceCoverInspectionWindKmh &&
    (activity.controls.idleSurfaceCoverIntact === false || activity.controls.idleSurfaceCoverIntact === null)
  ) {
    hits.push(
      ruleHit(
        'IDLE-COVER-WIND-003',
        'FIELD_VERIFICATION_REQUIRED',
        `رياح تجاوزت ${idleSurfaceCoverInspectionWindKmh} كم/س — يلزم فحص أغطية الأسطح غير النشطة وإصلاحها فوراً`,
        'انزل للموقع وافحص أغطية الأسطح غير النشطة الآن، وأصلح أي غطاء تضرر من الرياح'
      )
    );
  }

  // exposedAreaCurrentlyIdle/stockpileAreaExists/suppressantUsedAtStockpileArea/
  // windBarriersNearStockpiles/constructionScheduledImmediatelyAfterPrep
  // تحوّلت إلى تنبيهات نصية عامة — حُذف تأثيرها من القرار. idleDays/
  // idleSurfaceStabilized/idleSurfaceCoverIntact أعلاه تبقى مدخلات حقيقية.

  return hits;
}

// نقطة الدخول الموحّدة لتطبيق قواعد النشاط التنظيمي حسب نوعه
export function applyActivityRules(
  project: DustProjectComplianceProfile,
  riskClass: DustRiskClass,
  windBand: DustWindBand,
  activity: DustActivityComplianceProfile,
  windSpeedKmh: number | null = null
): DustRuleHit[] {
  switch (activity.regulatoryActivity) {
    case 'DEMOLITION':
      return demolitionRules(activity, windBand);
    case 'CRUSHER':
      return crusherRules(project, riskClass, activity);
    case 'BATCHING_PLANT':
      return batchingPlantRules(activity);
    case 'STONE_CUTTING':
      return stoneCuttingRules(activity, windBand);
    case 'ENTRY_EXIT':
      return entryExitRules(activity, windBand);
    case 'SITE_TRAFFIC':
      return siteTrafficRules(activity, riskClass);
    case 'CD_WASTE_TRANSPORT':
      return cdWasteTransportRules(activity);
    case 'MATERIAL_HANDLING_STOCKPILE':
      return stockpileRules(riskClass, windBand, activity);
    case 'IDLE_SURFACE':
      return idleSurfaceRules(activity, windSpeedKmh);
    case 'EARTHWORKS':
      return earthworksRules(activity, windBand);
    case 'OTHER':
    default:
      return [];
  }
}
