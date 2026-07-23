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

export const RULEBOOK_VERSION = 'RCRC-NCEC-RIYADH-DUST-2026.1';

// حد الكسارة من المستقبِل الحساس: الدليل التنظيمي يذكر 200م في موضع (القسم
// 3.5، تخزين المواد) و500م في موضع آخر (القسم 3.8، مناطق الكسارات تحديداً).
// نطبّق الحد الأكثر تحفظاً (500م) للكسارة تحديداً حتى يصدر تفسير رسمي من
// الجهة — راجع ملاحظة "مرقاب" القسم 9.5.
const CRUSHER_SENSITIVE_RECEPTOR_DISTANCE_M = 500;
const CRUSHER_GENERAL_RECEPTOR_DISTANCE_M = 200;
// حد مساحة الفئة الأولى (منخفضة المخاطر) — يُستخدم في classifyProject فقط
// لتصنيف فئة المشروع حسب المساحة (القسم 6). لا علاقة له بأهلية تشغيل
// الكسارة؛ أهلية الكسارة تُحدَّد حصراً عبر riskClass النهائي في crusherRules
// (CRUSHER-CATEGORY-001)، الذي يسمح للفئة الثالثة بصرف النظر عن سبب وصول
// المشروع إليها (مساحة كبيرة، أو حركة شاحنات، أو تصريح صريح بوجود كسارة).
const CATEGORY_I_MAX_AREA_M2 = 2000;
const STOCKPILE_SENSITIVE_RECEPTOR_DISTANCE_M = 200;
const DEMOLITION_MAX_AREA_M2 = 100;
const IDLE_SURFACE_MAX_DAYS = 5;
const UNPAVED_SPEED_LIMIT_KMH = 10;
const PAVED_SPEED_LIMIT_KMH = 20;
const SPILL_CLEANUP_LIMIT_MIN = 15;
const DROP_HEIGHT_NORMAL_LIMIT_M = 1.5;
const DROP_HEIGHT_HIGH_WIND_LIMIT_M = 1;
const DEBRIS_PILE_MAX_HEIGHT_M = 3;
const IMMERSION_ZONE_MIN_LENGTH_M = 8;
const WHEEL_WASH_CYCLE_MIN_SEC = 20;
const STONE_CUTTING_WIND_STOP_KMH = 15;
// A6 — كفاءة فلاتر PM10 الدنيا في الصوامع ومحطات الخلط المغلقة (القسم
// الرابع، الفقرة "ب"؛ "الاستخراج التنظيمي من المرفق" القسم 6 — الحد المعتمد
// للاستمرار أثناء إيقاف الرياح فوق 25 كم/س).
const BATCHING_PM10_FILTER_MIN_PERCENT = 99;
// A4 — سرعة الرياح التي تستوجب فحص أغطية الأسطح غير النشطة وإصلاحها فوراً
// (مختلفة عن عتبات 15/25 كم/س العامة — خاصة بحالة الأغطية تحديداً).
const IDLE_SURFACE_COVER_INSPECTION_WIND_KMH = 20;

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
  if (windSpeedKmh < 15) return 'BELOW_15';
  if (windSpeedKmh <= 25) return 'FROM_15_TO_25';
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
  ALLOW_WITH_CONTROLS: 1,
  FIELD_VERIFICATION_REQUIRED: 2,
  RESTRICT_ACTIVITY: 3,
  STOP_AFFECTED_ACTIVITY: 4,
  MANDATORY_STOP: 5,
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
function ruleHit(
  code: string,
  severity: DustRuleHit['severity'],
  messageAr: string,
  actionAr: string
): DustRuleHit {
  return { code, severity, messageAr, actionAr };
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

  const dropHeight = activity.measurements.dropHeightM;
  if (dropHeight !== null && dropHeight !== undefined) {
    if (windBand !== 'BELOW_15' && dropHeight > DROP_HEIGHT_HIGH_WIND_LIMIT_M) {
      hits.push(
        ruleHit(
          'EARTHWORKS-DROP-002',
          'STOP_AFFECTED_ACTIVITY',
          `ارتفاع تفريغ التربة (${dropHeight} م) يتجاوز الحد المسموح أثناء الرياح النشطة (${DROP_HEIGHT_HIGH_WIND_LIMIT_M} م)`,
          `خفّض ارتفاع تفريغ التربة إلى ${DROP_HEIGHT_HIGH_WIND_LIMIT_M} م أو أقل طوال فترة الرياح النشطة`
        )
      );
    } else if (dropHeight > DROP_HEIGHT_NORMAL_LIMIT_M) {
      hits.push(
        ruleHit(
          'EARTHWORKS-DROP-003',
          'STOP_AFFECTED_ACTIVITY',
          `ارتفاع تفريغ التربة (${dropHeight} م) يتجاوز الحد الاعتيادي (${DROP_HEIGHT_NORMAL_LIMIT_M} م)`,
          `خفّض ارتفاع تفريغ التربة إلى ${DROP_HEIGHT_NORMAL_LIMIT_M} م أو أقل`
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
    hits.push(
      ruleHit(
        'DEMO-WIND-STOP-001',
        'MANDATORY_STOP',
        'إيقاف إلزامي: أعمال هدم مكشوفة أثناء رياح ≥15 كم/س (الحد الأقصى التنظيمي 15 كم/س لأعمال الهدم)',
        'أوقف أعمال الهدم المكشوفة فوراً حتى تنخفض سرعة الرياح إلى ما دون 15 كم/س، أو حوّلها لعملية مغلقة'
      )
    );
  }

  const activeArea = activity.measurements.demolitionActiveAreaM2;
  if (activeArea !== null && activeArea !== undefined && activeArea > DEMOLITION_MAX_AREA_M2) {
    hits.push(
      ruleHit(
        'DEMO-AREA-002',
        'STOP_AFFECTED_ACTIVITY',
        `مساحة الهدم النشطة (${activeArea} م²) تتجاوز الحد المسموح (${DEMOLITION_MAX_AREA_M2} م² في المرة الواحدة)`,
        `قسّم أعمال الهدم إلى مراحل بحيث لا تتجاوز المساحة النشطة ${DEMOLITION_MAX_AREA_M2} م² في المرة الواحدة`
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

  const generalDistance = autoAny ?? manualDistance;
  if (generalDistance !== null && generalDistance !== undefined && generalDistance < CRUSHER_GENERAL_RECEPTOR_DISTANCE_M) {
    hits.push(
      ruleHit(
        'CRUSHER-DISTANCE-200-002B',
        'MANDATORY_STOP',
        `مسافة الكسارة عن أقرب مستقبل حساس (${autoAny !== null && autoAny !== undefined ? 'محسوبة تلقائياً: ' : ''}${generalDistance} م) أقل من الحد الأدنى (${CRUSHER_GENERAL_RECEPTOR_DISTANCE_M} م)`,
        `أوقف تشغيل الكسارة أو انقلها لمسافة لا تقل عن ${CRUSHER_GENERAL_RECEPTOR_DISTANCE_M} م عن أقرب مستقبل حساس`
      )
    );
  }

  const residentialDistance = autoResidential ?? manualDistance;
  if (residentialDistance !== null && residentialDistance !== undefined && residentialDistance < CRUSHER_SENSITIVE_RECEPTOR_DISTANCE_M) {
    hits.push(
      ruleHit(
        'CRUSHER-DISTANCE-500-002C',
        'MANDATORY_STOP',
        `مسافة الكسارة عن سكني/مدارس/مستشفيات (${autoResidential !== null && autoResidential !== undefined ? 'محسوبة تلقائياً: ' : ''}${residentialDistance} م) أقل من الحد الأدنى (${CRUSHER_SENSITIVE_RECEPTOR_DISTANCE_M} م)`,
        `أوقف تشغيل الكسارة أو انقلها لمسافة لا تقل عن ${CRUSHER_SENSITIVE_RECEPTOR_DISTANCE_M} م عن أقرب منطقة سكنية/مدرسة/مستشفى`
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
  if (
    filterEfficiency !== null && filterEfficiency !== undefined &&
    filterEfficiency < BATCHING_PM10_FILTER_MIN_PERCENT
  ) {
    hits.push(
      ruleHit(
        'BATCHING-FILTER-002',
        'MANDATORY_STOP',
        `كفاءة فلتر الجسيمات العالقة (${filterEfficiency}%) أقل من الحد الأدنى (${BATCHING_PM10_FILTER_MIN_PERCENT}%)`,
        `استبدل أو اصلح فلتر الجسيمات العالقة حتى تصل كفاءته إلى ${BATCHING_PM10_FILTER_MIN_PERCENT}% على الأقل`
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

  // بقية ضوابط محطة الخلط (صيانة الفلاتر، فحص موانع التسرب، حظر الكنس
  // الجاف/الهواء المضغوط، رطوبة النفايات) تحوّلت إلى تنبيهات نصية عامة —
  // حُذف تأثيرها من القرار هنا. الحقول الخمسة أعلاه تبقى مدخلات حقيقية.

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
    hits.push(
      ruleHit(
        'STONECUT-WIND-STOP-003',
        'MANDATORY_STOP',
        `إيقاف إلزامي: قطع أحجار مكشوف أثناء رياح تتجاوز الحد المسموح (${STONE_CUTTING_WIND_STOP_KMH} كم/س)`,
        `أوقف القطع المكشوف فوراً حتى تنخفض سرعة الرياح إلى ما دون ${STONE_CUTTING_WIND_STOP_KMH} كم/س، أو حوّله لتشغيل مغلق`
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
      hits.push(ruleHit('ENTRY-WASHCYCLE-009', 'RESTRICT_ACTIVITY', `مدة دورة غسيل الإطارات أقل من ${WHEEL_WASH_CYCLE_MIN_SEC} ثانية لكل محور`, `اضبط مدة دورة الغسيل على ${WHEEL_WASH_CYCLE_MIN_SEC} ثانية على الأقل لكل محور`));
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
      hits.push(ruleHit('ENTRY-IMMERSION-LENGTH-012', 'RESTRICT_ACTIVITY', `طول منطقة غمر الإطارات أقل من ${IMMERSION_ZONE_MIN_LENGTH_M} أمتار`, `وسّع منطقة غمر الإطارات إلى ${IMMERSION_ZONE_MIN_LENGTH_M} أمتار على الأقل`));
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
// اللافتات/الكنس/غسيل الإطارات/التغطية تحوّلت إلى تنبيهات نصية عامة — حُذف
// تأثيرها من القرار. الحقول الرقمية العتبية الثلاثة (سرعة الطرق، زمن تنظيف
// الانسكاب) تبقى قواعد فعلية لأنها قياسات، لا تصريحات.
function siteTrafficRules(
  activity: DustActivityComplianceProfile,
  riskClass: DustRiskClass
): DustRuleHit[] {
  const hits: DustRuleHit[] = [];

  const unpaved = activity.measurements.unpavedSpeedKmh;
  if (unpaved !== null && unpaved !== undefined && unpaved > UNPAVED_SPEED_LIMIT_KMH) {
    hits.push(ruleHit('TRAFFIC-UNPAVED-002', 'RESTRICT_ACTIVITY', `سرعة الطرق غير المسفلتة (${unpaved} كم/س) تتجاوز الحد (${UNPAVED_SPEED_LIMIT_KMH} كم/س)`, `اخفض السرعة على الطرق غير المسفلتة إلى ${UNPAVED_SPEED_LIMIT_KMH} كم/س أو أقل`));
  }
  const paved = activity.measurements.pavedSpeedKmh;
  if (paved !== null && paved !== undefined && paved > PAVED_SPEED_LIMIT_KMH) {
    hits.push(ruleHit('TRAFFIC-PAVED-003', 'RESTRICT_ACTIVITY', `سرعة الطرق المسفلتة (${paved} كم/س) تتجاوز الحد (${PAVED_SPEED_LIMIT_KMH} كم/س)`, `اخفض السرعة على الطرق المسفلتة إلى ${PAVED_SPEED_LIMIT_KMH} كم/س أو أقل`));
  }
  const spillMin = activity.measurements.spillCleanupMinutes;
  if (spillMin !== null && spillMin !== undefined && spillMin > SPILL_CLEANUP_LIMIT_MIN) {
    hits.push(ruleHit('TRAFFIC-SPILL-005', 'RESTRICT_ACTIVITY', `تنظيف المواد المنسكبة تجاوز الحد الزمني (${SPILL_CLEANUP_LIMIT_MIN} دقيقة)`, `قلّص زمن تنظيف المواد المنسكبة إلى ${SPILL_CLEANUP_LIMIT_MIN} دقيقة أو أقل`));
  }

  return hits;
}

// نقل مخلفات الهدم والبناء — ضوابط الرش/التخزين/التغطية/السعة تحوّلت إلى
// تنبيهات نصية عامة — حُذف تأثيرها من القرار. ارتفاع أكوام المخلفات يبقى
// قاعدة فعلية لأنه قياس رقمي، لا تصريح.
function cdWasteTransportRules(activity: DustActivityComplianceProfile): DustRuleHit[] {
  const hits: DustRuleHit[] = [];

  const pileHeight = activity.measurements.debrisPileHeightM;
  if (pileHeight !== null && pileHeight !== undefined && pileHeight > DEBRIS_PILE_MAX_HEIGHT_M) {
    hits.push(ruleHit('CDWASTE-PILEHEIGHT-003', 'RESTRICT_ACTIVITY', `ارتفاع أكوام المخلفات (${pileHeight} م) يتجاوز الحد (${DEBRIS_PILE_MAX_HEIGHT_M} م)`, `اخفض ارتفاع أكوام المخلفات إلى ${DEBRIS_PILE_MAX_HEIGHT_M} م أو أقل`));
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
  if (distance !== null && distance !== undefined && distance < STOCKPILE_SENSITIVE_RECEPTOR_DISTANCE_M) {
    hits.push(
      ruleHit(
        'STOCKPILE-DISTANCE-002',
        'STOP_AFFECTED_ACTIVITY',
        `مسافة الأكوام/محطة الخلط من المستقبِل الحساس (${activity.measurements.stockpileDistanceToNearestReceptorAutoM !== null && activity.measurements.stockpileDistanceToNearestReceptorAutoM !== undefined ? 'محسوبة تلقائياً: ' : ''}${distance} م) أقل من ${STOCKPILE_SENSITIVE_RECEPTOR_DISTANCE_M} م`,
        `انقل الأكوام/محطة الخلط إلى مسافة لا تقل عن ${STOCKPILE_SENSITIVE_RECEPTOR_DISTANCE_M} م عن أقرب مستقبل حساس`
      )
    );
  }

  // ضوابط التغطية/الرش/الشكل/الحواجز/السيور تحوّلت إلى تنبيهات نصية عامة —
  // حُذف تأثيرها من القرار. ارتفاع التفريغ يبقى قاعدة فعلية (قياس رقمي).
  const dropHeight = activity.measurements.dropHeightM;
  if (dropHeight !== null && dropHeight !== undefined) {
    if (windBand !== 'BELOW_15' && dropHeight > DROP_HEIGHT_HIGH_WIND_LIMIT_M) {
      hits.push(ruleHit('STOCKPILE-DROP-004', 'STOP_AFFECTED_ACTIVITY', `ارتفاع تفريغ المواد (${dropHeight} م) يتجاوز الحد المسموح أثناء الرياح النشطة (${DROP_HEIGHT_HIGH_WIND_LIMIT_M} م)`, `خفّض ارتفاع تفريغ المواد إلى ${DROP_HEIGHT_HIGH_WIND_LIMIT_M} م أو أقل طوال فترة الرياح النشطة`));
    } else if (dropHeight > DROP_HEIGHT_NORMAL_LIMIT_M) {
      hits.push(ruleHit('STOCKPILE-DROP-005', 'STOP_AFFECTED_ACTIVITY', `ارتفاع تفريغ المواد (${dropHeight} م) يتجاوز الحد الاعتيادي (${DROP_HEIGHT_NORMAL_LIMIT_M} م)`, `خفّض ارتفاع تفريغ المواد إلى ${DROP_HEIGHT_NORMAL_LIMIT_M} م أو أقل`));
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

  if (
    idleDays !== null && idleDays !== undefined && idleDays > IDLE_SURFACE_MAX_DAYS &&
    activity.controls.idleSurfaceStabilized === false
  ) {
    hits.push(
      ruleHit(
        'IDLE-STABILIZE-001',
        'RESTRICT_ACTIVITY',
        `سطح غير نشط لأكثر من ${IDLE_SURFACE_MAX_DAYS} أيام دون تثبيت`,
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
  if (
    windSpeedKmh !== null && windSpeedKmh !== undefined &&
    windSpeedKmh > IDLE_SURFACE_COVER_INSPECTION_WIND_KMH &&
    (activity.controls.idleSurfaceCoverIntact === false || activity.controls.idleSurfaceCoverIntact === null)
  ) {
    hits.push(
      ruleHit(
        'IDLE-COVER-WIND-003',
        'FIELD_VERIFICATION_REQUIRED',
        `رياح تجاوزت ${IDLE_SURFACE_COVER_INSPECTION_WIND_KMH} كم/س — يلزم فحص أغطية الأسطح غير النشطة وإصلاحها فوراً`,
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
