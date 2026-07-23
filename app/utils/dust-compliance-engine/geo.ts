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

const RESIDENTIAL_RECEPTOR_TYPES: SensitiveReceptorType[] = ['RESIDENTIAL', 'SCHOOL', 'HOSPITAL'];

// يُرجع أقرب مسافة (م) لأي مستقبل حساس، وأقرب مسافة لمستقبل
// سكني/مدرسي/صحي تحديداً (يخضع لحد تنظيمي أشد عند الكسارات).
export function nearestReceptorDistancesM(
  lat: number | null,
  lng: number | null,
  receptors: SensitiveReceptor[]
): { nearestAnyM: number | null; nearestResidentialM: number | null } {
  if (lat === null || lng === null || receptors.length === 0) {
    return { nearestAnyM: null, nearestResidentialM: null };
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
