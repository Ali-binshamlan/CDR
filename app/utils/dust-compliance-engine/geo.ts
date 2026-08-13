// =============================================================
// Riyadh Dust Compliance Engine — Geo
// حساب المسافة بين نقطتين (Haversine) لتحديد بُعد الكسارة عن أقرب
// مستقبِل حساس تلقائياً بدل سؤال المستخدم مباشرة (طلب صريح في مستند
// "تجهيز الموقع وأعمال الحفر.pdf" لأسئلة المسافة 200م/500م).
// =============================================================

import type { SensitiveReceptor, SensitiveReceptorType } from './types';

const EARTH_RADIUS_M = 6371000;

export function haversineDistanceM(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_M * c;
}

// اتجاه (bearing) نقطة الوصول من نقطة الأصل، بالدرجات (0-360، 0=شمال حقيقي،
// 90=شرق...) — يلزم لتحديد هل مستقبِل حساس "باتجاه الريح" فعلياً (راجع
// MRQ-RECEPTOR-DOWNWIND-120)، لا مجرد قريب بالمسافة المستقيمة بصرف النظر
// عن الاتجاه.
export function bearingDegrees(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const toDeg = (rad: number) => (rad * 180) / Math.PI;
  const dLng = toRad(lng2 - lng1);
  const y = Math.sin(dLng) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLng);
  const bearing = toDeg(Math.atan2(y, x));
  return (bearing + 360) % 360;
}

// أصغر فرق زاوية بين اتجاهين (0-180) — يتعامل بشكل صحيح مع دوران360/0
// (مثال: الفرق بين 350 و10 هو 20، لا 340).
export function angularDifferenceDegrees(a: number, b: number): number {
  const diff = Math.abs(a - b) % 360;
  return diff > 180 ? 360 - diff : diff;
}

// هامش التسامح الزاوي لاعتبار مستقبِل "باتجاه الريح" (downwind) — قطاع
// ±45° حول اتجاه هبوب الرياح الفعلي (لا اتجاه مصدرها)، يغطي ربع الدائرة
// تقريباً في اتجاه الريح، وهو نطاق معقول عملياً لا يتطلب محاذاة دقيقة تماماً.
export const DOWNWIND_TOLERANCE_DEGREES = 45;

// هل نقطة الوصول تقع "باتجاه الريح" (downwind) من نقطة الأصل؟
// windDirectionDeg يُقاس تقليدياً كـ"الاتجاه القادمة منه الريح" (meteorological
// convention)، فاتجاه الهبوب الفعلي (نحو أين تذهب) هو windDirectionDeg+180.
export function isDownwind(
  originLat: number,
  originLng: number,
  targetLat: number,
  targetLng: number,
  windDirectionFromDeg: number,
  toleranceDeg: number = DOWNWIND_TOLERANCE_DEGREES
): boolean {
  const targetBearing = bearingDegrees(originLat, originLng, targetLat, targetLng);
  const windBlowingTowardDeg = (windDirectionFromDeg + 180) % 360;
  return angularDifferenceDegrees(targetBearing, windBlowingTowardDeg) <= toleranceDeg;
}

const RESIDENTIAL_RECEPTOR_TYPES: SensitiveReceptorType[] = ['RESIDENTIAL', 'SCHOOL', 'HOSPITAL'];

// يُرجع أقرب مسافة (م) لأي مستقبل حساس، وأقرب مسافة لمستقبل
// سكني/مدرسي/صحي تحديداً (يخضع لحد تنظيمي أشد عند الكسارات).
//
// "لا نعرف الموقع" (lat/lng فارغ) تختلف جوهرياً عن "الموقع معروف وجدول
// المستقبِلات فارغ فعلياً": الأولى تعني "لا يمكن الحساب إطلاقاً" (null —
// يُبقي المستدعي على القيمة اليدوية القديمة كاحتياط معقول)، لكن الثانية
// معلومة حقيقية ("لا يوجد أي مستقبِل معروف قريباً") يجب أن تُترجَم لمسافة
// آمنة عملياً (Infinity) لا null — وإلا فإن رجوع null هنا كان يجعل قاعدة
// الكسارة تسقط تلقائياً إلى قيمة يدوية قديمة قد لا تعود صحيحة رغم أن
// الحساب التلقائي (بلا أي مستقبِل في النظام) لا يعطي أي سبب فعلي للإيقاف —
// يسبب هذا بالضبط تناقضاً بين قاعدة الإيقاف وقائمة "لا توجد مستقبِلات
// قريبة" المعروضة للمستخدم في نفس الشاشة.
export function nearestReceptorDistancesM(
  lat: number | null,
  lng: number | null,
  receptors: SensitiveReceptor[]
): { nearestAnyM: number | null; nearestResidentialM: number | null } {
  if (lat === null || lng === null) {
    return { nearestAnyM: null, nearestResidentialM: null };
  }
  if (receptors.length === 0) {
    return { nearestAnyM: Infinity, nearestResidentialM: Infinity };
  }

  let nearestAnyM: number | null = null;
  let nearestResidentialM: number | null = null;

  for (const receptor of receptors) {
    const distance = haversineDistanceM(lat, lng, receptor.lat, receptor.lng);
    if (nearestAnyM === null || distance < nearestAnyM) nearestAnyM = distance;
    if (RESIDENTIAL_RECEPTOR_TYPES.includes(receptor.receptorType)) {
      if (nearestResidentialM === null || distance < nearestResidentialM) nearestResidentialM = distance;
    }
  }

  return { nearestAnyM, nearestResidentialM };
}

// أقرب مسافة (م) لمستقبِل حساس (سكني/مدرسي/صحي) يقع فعلياً "باتجاه الريح"
// من نقطة الأصل — MRQ-RECEPTOR-DOWNWIND-120. يُرجع null إن كان اتجاه
// الرياح غير متوفر (windDirectionFromDeg=null) أو الموقع غير معروف، أو
// Infinity إن لم يوجد أي مستقبِل ضمن قطاع اتجاه الريح (لا خطر اتجاهي
// حالياً، بصرف النظر عن وجود مستقبِلات في اتجاهات أخرى).
export function nearestDownwindReceptorDistanceM(
  lat: number | null,
  lng: number | null,
  windDirectionFromDeg: number | null,
  receptors: SensitiveReceptor[]
): number | null {
  if (lat === null || lng === null || windDirectionFromDeg === null) return null;

  const downwindResidential = receptors.filter(
    (r) =>
      RESIDENTIAL_RECEPTOR_TYPES.includes(r.receptorType) &&
      isDownwind(lat, lng, r.lat, r.lng, windDirectionFromDeg)
  );
  if (downwindResidential.length === 0) return Infinity;

  return Math.min(...downwindResidential.map((r) => haversineDistanceM(lat, lng, r.lat, r.lng)));
}

// نصف قطر عرض المستقبِلات حول وحدة الكسارة/الخلاطة — 500م هو نفس الحد
// التنظيمي الأشد المطبَّق في قاعدتي CRUSHER-DISTANCE-002 و
// BATCHING-DISTANCE-002 (راجع rulebook.ts)، فيرى المستخدم بالضبط
// المستقبِلات التي تُفعِّل تلك القاعدة، لا نطاقاً أوسع أو أضيق يوهمه بأن
// القرار مبني على شيء آخر.
export const UNIT_RECEPTOR_RADIUS_M = 500;

export interface ReceptorWithinRadius {
  id: string;
  name: string;
  receptorType: SensitiveReceptorType;
  distanceM: number;
}

// يُرجع كل المستقبِلات الحساسة ضمن نصف قطر محدد من نقطة وحدة (كسارة/خلاطة)،
// مرتبة من الأقرب. يختلف عن nearestReceptorDistancesM التي تُرجع أقرب مسافة
// فقط: هنا نحتاج القائمة كاملة للعرض، لا رقماً واحداً للقاعدة.
export function receptorsWithinRadiusM(
  lat: number | null,
  lng: number | null,
  receptors: SensitiveReceptor[],
  radiusM: number = UNIT_RECEPTOR_RADIUS_M
): ReceptorWithinRadius[] {
  if (lat === null || lng === null) return [];

  return receptors
    .map((receptor) => ({
      id: receptor.id,
      name: receptor.name,
      receptorType: receptor.receptorType,
      distanceM: haversineDistanceM(lat, lng, receptor.lat, receptor.lng),
    }))
    .filter((r) => r.distanceM <= radiusM)
    .sort((a, b) => a.distanceM - b.distanceM);
}
