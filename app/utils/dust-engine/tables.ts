// =============================================================
// DVI Engine — Lookup Tables (مستخرجة حرفيًا من جداول المواصفة)
// =============================================================

import { DistanceBand, DviLevel, ReceptorType, RegulatoryDustActivityKey } from './types';

// جدول 1: الرؤية الأفقية بالمتر أو الكيلومتر → VisibilityRisk
export function visibilityRisk(visibilityKm: number): number {
  if (visibilityKm >= 10) return 0;
  if (visibilityKm >= 5) return 15;
  if (visibilityKm >= 3) return 30;
  if (visibilityKm >= 1) return 60;
  if (visibilityKm >= 0.5) return 85;
  return 100;
}

// جدول 2: تركيز الجسيمات العالقة PM10 → PM10Risk
// طلب مستخدم صريح: الفئات الثلاث تحت حد التحذير التنظيمي (250، راجع
// PM10_WARNING_UG_M3 في dust-compliance-engine/rulebook.ts) دُمجت في فئة
// واحدة بأدنى درجة (10) — كل قراءة تحت 250 "آمنة" بنفس الوزن، بدل التدرّج
// السابق (10/25/45 لـ<100/<150/<250) الذي كان يرفع خطر DVI تدريجياً قبل
// الوصول لحد التحذير التنظيمي الفعلي بأي معنى عملي.
export function pm10Risk(pm10: number): number {
  if (pm10 < 250) return 10;
  if (pm10 < 500) return 70;
  return 90;
}

// جدول 3: تركيز الجسيمات العالقة PM2.5 → PM25Risk
export function pm25Risk(pm25: number): number {
  if (pm25 < 35) return 10;
  if (pm25 < 75) return 35;
  if (pm25 < 150) return 55;
  if (pm25 < 250) return 75;
  return 95;
}

// جدول 4: الرياح السطحية المؤثرة وسرعة الهبات → WindTransportRisk
export function windTransportRisk(effectiveWindKmh: number): number {
  if (effectiveWindKmh < 15) return 0;
  if (effectiveWindKmh < 25) return 10;
  if (effectiveWindKmh < 35) return 30;
  if (effectiveWindKmh < 45) return 60;
  if (effectiveWindKmh < 55) return 85;
  return 100;
}

// جدول 5: حساسية الأنشطة التنظيمية التسعة الفعلية (طلب مستخدم صريح: توحيد
// كامل) — رقم مستقل لكل نشاط، بدل التشارك القسري القديم عبر ActivityCategory
// الوسيط المحذوف (مثال: DEMOLITION/CRUSHER/STONE_CUTTING كانت الثلاثة تتقاسم
// نفس رقم HEAVY_EQUIPMENT_MOVEMENT=0.65 رغم اختلاف خطورتها الفعلية عن
// الغبار). القيم مبنية على طبيعة كل نشاط الفعلية (استمرارية الانبعاث، دقة
// الجسيمات، اعتماده على الرؤية):
//   CRUSHER (0.75): انبعاث غبار مستمر ومباشر أثناء التشغيل بالكامل.
//   EARTHWORKS (0.75): حفر/ردم/تسوية — يثير التربة مباشرة، استمرار طويل.
//   DEMOLITION (0.7): غبار كثيف لكن متقطع (دفعات هدم، لا انبعاث ثابت).
//   CD_WASTE_TRANSPORT (0.65): نقل مخلفات — غبار ثانوي من حمولة مكشوفة.
//   STONE_CUTTING (0.65): جسيمات دقيقة عالية الخطورة صحياً لكن موضعية النطاق.
//   BATCHING_PLANT (0.6): مصدر إسمنت/خرسانة، غالباً جزئي الإغلاق.
//   MATERIAL_HANDLING_STOCKPILE (0.6): تحميل/تنزيل/تخزين — دفعات متقطعة.
//   SITE_TRAFFIC (0.55): حركة مركبات — غبار ثانوي (إثارة تربة الطريق)، لا مصدر مباشر.
//   IDLE_SURFACE (0.4): سطح غير نشط بلا عمل فعلي — أقل الأنشطة التسعة حساسية.
export const ACTIVITY_SENSITIVITY: Record<RegulatoryDustActivityKey, number> = {
  CRUSHER: 0.75,
  EARTHWORKS: 0.75,
  DEMOLITION: 0.7,
  CD_WASTE_TRANSPORT: 0.65,
  STONE_CUTTING: 0.65,
  BATCHING_PLANT: 0.6,
  MATERIAL_HANDLING_STOCKPILE: 0.6,
  SITE_TRAFFIC: 0.55,
  IDLE_SURFACE: 0.4,
};

// قائمة الأنشطة المعتمدة كليًا على الرؤية الأفقية المباشرة والتواصل البصري.
// طلب مستخدم صريح لكل نشاط: CRUSHER/DEMOLITION/STONE_CUTTING (كلاهما معاً
// رؤية+غبار — تشغيل آلي مستمر/هدم دفعي/قطع يدوي دقيق، كل واحد يحتاج تنسيقاً
// بصرياً مباشراً وينتج غباراً فعلياً في آن واحد).
export const VISIBILITY_DEPENDENT_ACTIVITIES: RegulatoryDustActivityKey[] = [
  'CRUSHER',
  'DEMOLITION',
  'STONE_CUTTING',
];

// قائمة الأنشطة المسببة والمثيرة للغبار والأتربة بطبيعتها التشغيلية.
// EARTHWORKS/SITE_TRAFFIC مضافان لهذه القائمة أيضاً (لا اعتماد رؤية).
// MATERIAL_HANDLING_STOCKPILE/BATCHING_PLANT/CD_WASTE_TRANSPORT/IDLE_SURFACE
// لا ينتميان لأي من القائمتين.
export const DUST_GENERATING_ACTIVITIES: RegulatoryDustActivityKey[] = [
  'CRUSHER',
  'DEMOLITION',
  'STONE_CUTTING',
  'EARTHWORKS',
  'SITE_TRAFFIC',
];

// جدول 6: حساسية المستقبلات الحساسة المحيطة بالموقع
export const RECEPTOR_SENSITIVITY: Record<ReceptorType, number> = {
  HOSPITAL_SCHOOL_NURSERY_RESIDENTIAL_ADJACENT: 1.0,
  HIGH_TRAFFIC_PUBLIC_ROAD: 0.75,
  COMMERCIAL_AREA: 0.5,
  INDUSTRIAL_AREA: 0.2,
  NONE_NEARBY: 0.0,
};

// جدول 7: عامل نطاق المسافة الفاصلة للمستقبل البيئي المحيط
export const DISTANCE_FACTOR: Record<DistanceBand, number> = {
  UNDER_50M: 1.0,
  M50_100: 0.7,
  M100_250: 0.4,
  M250_500: 0.1,
  OVER_500M: 0.0,
};

// جدول 8: قيم مؤشر خطر توقعات الغبار الافتراضية
export const DUST_FORECAST_RISK = {
  NONE: 0,
  LIGHT: 20,
  MODERATE: 50,
  HEAVY: 85,
  SANDSTORM: 100,
};

// تحويل الاسكور الإجمالي المستخرج إلى مستوى خطر لوني مناسب
export function dviLevelFromScore(score: number): DviLevel {
  if (score < 25) return 'GREEN';
  if (score < 45) return 'YELLOW';
  if (score < 65) return 'ORANGE';
  if (score < 80) return 'RED';
  if (score < 92) return 'DARK_RED';
  return 'BLACK';
}

// جدول 10: تصنيف الثقة الميدانية في القرار بناءً على اكتمال المعطيات
export function confidenceLabel(confidenceScore: number): string {
  if (confidenceScore >= 90) return 'قرار قوي ومطابق ميدانياً';
  if (confidenceScore >= 80) return 'قرار موثوق';
  if (confidenceScore >= 70) return 'قرار جيد مع مراقبة القراءات';
  return 'يتطلب تحقق ميداني فوري (بيانات ناقصة)';
}

// جدول 11: ترجمة القرارات التشغيلية النهائية الصادرة من المحرك والبوابات الإلزامية للواجهة العربية
export const DVI_DECISION_LABEL_AR: Record<string, string> = {
  ALLOW: 'تشغيل عادي',
  ALLOW_WITH_MONITORING: 'تشغيل مع المراقبة والمتابعة',
  RESTRICT: 'تقييد النشاط وتفعيل أنظمة الرش',
  RESTRICT_SEVERE: 'تقييد شديد للعمليات والمعدات',
  STOP_DUST_GENERATING_ACTIVITIES: 'إيقاف الأعمال المثيرة للغبار',
  STOP_VISIBILITY_DEPENDENT_ACTIVITIES: 'إيقاف الأنشطة المعتمدة على الرؤية',
  MANDATORY_STOP: 'إيقاف إلزامي فوري للنشاط',
};