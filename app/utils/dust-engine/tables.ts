// =============================================================
// DVI Engine — Lookup Tables (مستخرجة حرفيًا من جداول المواصفة)
// =============================================================

import { ActivityCategory, DistanceBand, DviLevel, ReceptorType } from './types';

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
export function pm10Risk(pm10: number): number {
  if (pm10 < 100) return 10;
  if (pm10 < 150) return 25;
  if (pm10 < 250) return 45;
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

// جدول 5: حساسية الأنشطة المختلفة للغبار وتدني مستويات الرؤية
export const ACTIVITY_SENSITIVITY: Record<ActivityCategory, number> = {
  CRANE_LIFTING: 0.9,
  WORK_AT_HEIGHT: 0.85,
  STEEL_ERECTION: 0.85,
  FACADE_INSTALLATION: 0.8,
  HEAVY_EQUIPMENT_MOVEMENT: 0.65,
  MATERIAL_TRANSPORT: 0.7,
  EXCAVATION: 0.75,
  BACKFILLING: 0.75,
  GRADING: 0.75,
  SOIL_TRANSPORT: 0.75,
  COMPACTION: 0.6,
  ROAD_WORKS: 0.6,
  ASPHALT_PAVING: 0.5,
  EXTERNAL_PAINTING: 0.9,
  COATING: 0.85,
  WATERPROOFING: 0.7,
  CONCRETE_POURING: 0.55,
  GENERAL_OUTDOOR_WORK: 0.5,
  MEP_EXTERNAL_WORK: 0.6,
  LANDSCAPING: 0.4,
  INDOOR_WORK: 0.0,
  OFFICE_WORK: 0.0,
};

// قائمة الأنشطة المعتمدة كليًا على الرؤية الأفقية المباشرة والتواصل البصري
export const VISIBILITY_DEPENDENT_ACTIVITIES: ActivityCategory[] = [
  'CRANE_LIFTING',
  'WORK_AT_HEIGHT',
  'STEEL_ERECTION',
  'FACADE_INSTALLATION',
  'HEAVY_EQUIPMENT_MOVEMENT',
];

// قائمة الأنشطة المسببة والمثيرة للغبار والأتربة بطبيعتها التشغيلية
export const DUST_GENERATING_ACTIVITIES: ActivityCategory[] = [
  'EXCAVATION',
  'BACKFILLING',
  'GRADING',
  'SOIL_TRANSPORT',
  'COMPACTION',
  'ROAD_WORKS',
];

// جدول 6: حساسية المستقبلات الحساسة المحيطة بالموقع
export const RECEPTOR_SENSITIVITY: Record<ReceptorType, number> = {
  HOSPITAL_SCHOOL_NURSERY_RESIDENTIAL_ADJACENT: 1.0,
  HIGH_TRAFFIC_PUBLIC_ROAD: 0.75,
  COMMERCIAL_AREA: 0.5,
  INDUSTRIAL_AREA: 0.2,
  NONE_NEARBY: 0.0,
};

// القاموس العربي لأسماء الأنشطة (مطلوب لواجهات الإدخال وعرض المكونات)
export const ACTIVITY_LABEL_AR: Record<ActivityCategory, string> = {
  CRANE_LIFTING: 'رفع برافعة',
  WORK_AT_HEIGHT: 'عمل على ارتفاع',
  STEEL_ERECTION: 'تركيب هياكل معدنية',
  FACADE_INSTALLATION: 'أعمال واجهات',
  HEAVY_EQUIPMENT_MOVEMENT: 'حركة معدات ثقيلة',
  MATERIAL_TRANSPORT: 'نقل مواد / حركة شاحنات',
  EXCAVATION: 'أعمال حفر',
  BACKFILLING: 'أعمال ردم',
  GRADING: 'أعمال تسوية',
  SOIL_TRANSPORT: 'نقل تربة',
  COMPACTION: 'أعمال دمك',
  ROAD_WORKS: 'أعمال طرق',
  ASPHALT_PAVING: 'رصف أسفلت',
  EXTERNAL_PAINTING: 'دهان خارجي',
  COATING: 'أعمال طلاء/تغليف',
  WATERPROOFING: 'أعمال عزل',
  CONCRETE_POURING: 'صب خرسانة',
  GENERAL_OUTDOOR_WORK: 'عمل عام خارجي',
  MEP_EXTERNAL_WORK: 'أعمال ميكانيكا/كهرباء خارجية',
  LANDSCAPING: 'أعمال تنسيق مواقع',
  INDOOR_WORK: 'عمل داخلي',
  OFFICE_WORK: 'عمل إداري/مكتبي',
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

// جدول 9: ترجمة مستويات الخطر اللونية إلى نصوص واضحة ومباشرة للموقع
export const DVI_LEVEL_LABEL_AR: Record<DviLevel, string> = {
  GREEN: 'تشغيل آمن وطبيعي',
  YELLOW: 'مراقبة وتيقظ ميداني',
  ORANGE: 'تطبيق ضوابط تقليل الغبار',
  RED: 'تقييد الأنشطة الحساسة للرؤية',
  DARK_RED: 'خطر وغبار كثيف',
  BLACK: 'إيقاف العمليات إجبارياً',
};

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