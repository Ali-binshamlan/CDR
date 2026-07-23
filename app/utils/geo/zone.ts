// =============================================================
// أدوات جغرافية مشتركة لمنطقة المشروع (project zone) — مضلع أو دائرة.
// بلا اعتماد على turf أو أي مكتبة خارجية؛ حسابات مباشرة (هافرسين +
// ray-casting) كافية لهذا النطاق (مواقع إنشائية، لا خرائط عالمية).
// =============================================================

export interface LatLng {
  lat: number;
  lng: number;
}

export type ProjectZoneType = 'point' | 'polygon' | 'circle';

export interface ProjectZone {
  zoneType: ProjectZoneType;
  // مضلع: مصفوفة نقاط (lat/lng) — فارغة إن كانت الدائرة أو نقطة فقط
  polygon: LatLng[] | null;
  // دائرة: مركز + نصف قطر بالمتر — null إن كانت مضلعاً أو نقطة فقط
  circleCenter: LatLng | null;
  circleRadiusM: number | null;
}

const EARTH_RADIUS_M = 6371000;

// مسافة هافرسين بين نقطتين بالمتر
export function haversineDistanceM(a: LatLng, b: LatLng): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  return EARTH_RADIUS_M * c;
}

// فحص نقطة داخل دائرة (مركز + نصف قطر بالمتر)
export function isPointInCircle(point: LatLng, center: LatLng, radiusM: number): boolean {
  return haversineDistanceM(point, center) <= radiusM;
}

// فحص نقطة داخل مضلع — خوارزمية ray-casting على lat/lng مباشرة (تقريب
// كافٍ لمساحة موقع إنشائي واحد؛ لا حاجة لإسقاط جغرافي دقيق على هذا النطاق).
export function isPointInPolygon(point: LatLng, polygon: LatLng[]): boolean {
  if (polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].lng, yi = polygon[i].lat;
    const xj = polygon[j].lng, yj = polygon[j].lat;
    const intersects =
      yi > point.lat !== yj > point.lat &&
      point.lng < ((xj - xi) * (point.lat - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

// فحص موحّد: هل نقطة داخل منطقة المشروع أياً كان نوعها؟
export function isPointInProjectZone(point: LatLng, zone: ProjectZone): boolean {
  if (zone.zoneType === 'circle' && zone.circleCenter && zone.circleRadiusM) {
    return isPointInCircle(point, zone.circleCenter, zone.circleRadiusM);
  }
  if (zone.zoneType === 'polygon' && zone.polygon && zone.polygon.length >= 3) {
    return isPointInPolygon(point, zone.polygon);
  }
  // zoneType === 'point' (مشروع قديم بلا منطقة مرسومة): لا قيد فعلي.
  return true;
}

// أقرب نقطة داخل منطقة المشروع لموقع مقترح خارجها — يُستخدم لإعادة موضع
// أي عنصر (رافعة، نقطة نشاط) تلقائياً عند محاولة وضعه خارج حدود المشروع،
// بدل رفض صامت. للدائرة: نُسقط النقطة على محيط الدائرة باتجاه المركز.
// للمضلع: نقرّب من أقرب نقطة على حدوده (تقريب خطي كافٍ عملياً لمساحة
// موقع إنشائي واحد صغير نسبياً).
export function clampPointToZone(point: LatLng, zone: ProjectZone): LatLng {
  if (isPointInProjectZone(point, zone)) return point;

  if (zone.zoneType === 'circle' && zone.circleCenter && zone.circleRadiusM) {
    const center = zone.circleCenter;
    const distM = haversineDistanceM(point, center);
    if (distM === 0) return point;
    const ratio = zone.circleRadiusM / distM;
    return {
      lat: center.lat + (point.lat - center.lat) * ratio,
      lng: center.lng + (point.lng - center.lng) * ratio,
    };
  }

  if (zone.zoneType === 'polygon' && zone.polygon && zone.polygon.length >= 3) {
    let closest = zone.polygon[0];
    let minDist = Infinity;
    for (let i = 0; i < zone.polygon.length; i++) {
      const a = zone.polygon[i];
      const b = zone.polygon[(i + 1) % zone.polygon.length];
      const t = Math.max(
        0,
        Math.min(
          1,
          ((point.lat - a.lat) * (b.lat - a.lat) + (point.lng - a.lng) * (b.lng - a.lng)) /
            ((b.lat - a.lat) ** 2 + (b.lng - a.lng) ** 2 || 1)
        )
      );
      const proj = { lat: a.lat + t * (b.lat - a.lat), lng: a.lng + t * (b.lng - a.lng) };
      const d = haversineDistanceM(point, proj);
      if (d < minDist) { minDist = d; closest = proj; }
    }
    return closest;
  }

  return point;
}

// مسافة نقطة (مستقبِل حساس مثلاً) عن أقرب نقطة على حدود منطقة المشروع
// بالمتر — بعكس clampPointToZone (يُرجع نفس النقطة بلا تعديل إن كانت
// داخل المنطقة أصلاً)، هذه الدالة تُسقط دائماً على المحيط الفعلي بصرف
// النظر عن كون النقطة داخل المنطقة أو خارجها، لأن "المسافة عن الحدود"
// لمنشأة داخل حدود المشروع خطأً في البيانات يجب أن تُحسب فعلياً لا أن
// تُقرَّب بصفر. للدائرة: المسافة إلى المركز مطروحاً منها نصف القطر
// (بالقيمة المطلقة). للمضلع: نفس إسقاط المضلع الخطي المستخدم في
// clampPointToZone لكن بلا فحص "داخل/خارج" أولاً.
export function distanceToZoneBoundaryM(point: LatLng, zone: ProjectZone): number | null {
  if (zone.zoneType === 'circle' && zone.circleCenter && zone.circleRadiusM) {
    const distToCenter = haversineDistanceM(point, zone.circleCenter);
    return Math.abs(distToCenter - zone.circleRadiusM);
  }

  if (zone.zoneType === 'polygon' && zone.polygon && zone.polygon.length >= 3) {
    let minDist = Infinity;
    for (let i = 0; i < zone.polygon.length; i++) {
      const a = zone.polygon[i];
      const b = zone.polygon[(i + 1) % zone.polygon.length];
      const t = Math.max(
        0,
        Math.min(
          1,
          ((point.lat - a.lat) * (b.lat - a.lat) + (point.lng - a.lng) * (b.lng - a.lng)) /
            ((b.lat - a.lat) ** 2 + (b.lng - a.lng) ** 2 || 1)
        )
      );
      const proj = { lat: a.lat + t * (b.lat - a.lat), lng: a.lng + t * (b.lng - a.lng) };
      const d = haversineDistanceM(point, proj);
      if (d < minDist) minDist = d;
    }
    return minDist;
  }

  // zoneType === 'point' بلا هندسة فعلية مرسومة — لا حدود لحساب مسافة عنها.
  return null;
}

// مركز ثقل مضلع (لأغراض توسيط الخريطة وعرض نقطة تمثيلية)
export function polygonCentroid(polygon: LatLng[]): LatLng {
  const sum = polygon.reduce(
    (acc, p) => ({ lat: acc.lat + p.lat, lng: acc.lng + p.lng }),
    { lat: 0, lng: 0 }
  );
  return { lat: sum.lat / polygon.length, lng: sum.lng / polygon.length };
}

// نصف قطر افتراضي (متر) للمشاريع القديمة التي لديها نقطة فقط بلا منطقة
// مرسومة — يُستخدم لتوليد دائرة افتراضية حول النقطة القديمة، حتى لا تُحرَم
// هذه المشاريع من ميزة "تقييد موقع النشاط داخل منطقة المشروع".
export const DEFAULT_LEGACY_ZONE_RADIUS_M = 100;

// مساحة مضلع بالمتر المربع — إسقاط تقريبي مسطّح (equirectangular) حول خط
// عرض مركز المضلع، كافٍ عملياً لمساحة موقع إنشائي واحد صغير نسبياً (نفس
// تقريب ray-casting/haversine المعتمد في بقية هذا الملف، بلا حاجة لإسقاط
// جغرافي دقيق أو مكتبة خارجية). يستخدم صيغة "الحذاء" (Shoelace) القياسية.
export function polygonAreaM2(polygon: LatLng[]): number {
  if (polygon.length < 3) return 0;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const refLat = toRad(polygonCentroid(polygon).lat);
  const metersPerDegLat = 111320;
  const metersPerDegLng = 111320 * Math.cos(refLat);

  const points = polygon.map((p) => ({
    x: p.lng * metersPerDegLng,
    y: p.lat * metersPerDegLat,
  }));

  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    area += a.x * b.y - b.x * a.y;
  }
  return Math.abs(area) / 2;
}

// مساحة دائرة بالمتر المربع من نصف القطر
export function circleAreaM2(radiusM: number): number {
  return Math.PI * radiusM * radiusM;
}

// مساحة أي منطقة مشروع (مضلع أو دائرة) بالمتر المربع — null إن كانت
// zoneType='point' بلا هندسة فعلية مرسومة.
export function projectZoneAreaM2(zone: ProjectZone): number | null {
  if (zone.zoneType === 'polygon' && zone.polygon && zone.polygon.length >= 3) {
    return polygonAreaM2(zone.polygon);
  }
  if (zone.zoneType === 'circle' && zone.circleRadiusM) {
    return circleAreaM2(zone.circleRadiusM);
  }
  return null;
}

// يبني ProjectZone من صف مشروع خام (قد يكون بلا أي عمود zone_* بعد، أو
// بعمود zone_type + zone_geojson + zone_radius_m من الترحيل الجديد).
export function buildProjectZoneFromRow(row: {
  latitude?: number | null;
  longitude?: number | null;
  zone_type?: string | null;
  zone_polygon?: LatLng[] | null;
  zone_radius_m?: number | null;
}): ProjectZone {
  const lat = typeof row.latitude === 'number' ? row.latitude : null;
  const lng = typeof row.longitude === 'number' ? row.longitude : null;

  if (row.zone_type === 'polygon' && Array.isArray(row.zone_polygon) && row.zone_polygon.length >= 3) {
    return { zoneType: 'polygon', polygon: row.zone_polygon, circleCenter: null, circleRadiusM: null };
  }

  if (row.zone_type === 'circle' && lat !== null && lng !== null && typeof row.zone_radius_m === 'number') {
    return {
      zoneType: 'circle',
      polygon: null,
      circleCenter: { lat, lng },
      circleRadiusM: row.zone_radius_m,
    };
  }

  // مشروع قديم/بلا منطقة مرسومة: دائرة افتراضية حول النقطة القديمة إن
  // توفّرت إحداثيات، وإلا "point" بلا أي قيد.
  if (lat !== null && lng !== null) {
    return {
      zoneType: 'circle',
      polygon: null,
      circleCenter: { lat, lng },
      circleRadiusM: DEFAULT_LEGACY_ZONE_RADIUS_M,
    };
  }

  return { zoneType: 'point', polygon: null, circleCenter: null, circleRadiusM: null };
}
