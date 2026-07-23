// =============================================================
// محلّل KML بسيط بلا مكتبات خارجية — يعتمد على DOMParser المتوفر
// أصلاً في المتصفح. يستخرج أول Polygon (outerBoundaryIs) في الملف
// كمنطقة مشروع. لا يدعم MultiGeometry متعددة الأجزاء أو Placemarks
// متعددة — نأخذ أول مضلع صالح فقط لأن منطقة المشروع شكل واحد.
// =============================================================

import type { LatLng } from './zone';

export interface ParsedKmlResult {
  polygon: LatLng[];
  /** اسم الـ Placemark إن وُجد، لعرضه للمستخدم كتأكيد */
  name: string | null;
}

export class KmlParseError extends Error {}

// يحوّل نص إحداثيات KML الخام ("lng,lat,alt lng,lat,alt ...") إلى نقاط
// LatLng — الترتيب في KML هو lng,lat (عكس الاتفاق الشائع في التطبيق).
function parseCoordinatesText(raw: string): LatLng[] {
  return raw
    .trim()
    .split(/\s+/)
    .map((triplet) => {
      const [lngStr, latStr] = triplet.split(',');
      const lng = Number(lngStr);
      const lat = Number(latStr);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      return { lat, lng };
    })
    .filter((p): p is LatLng => p !== null);
}

export function parseKmlPolygon(kmlText: string): ParsedKmlResult {
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(kmlText, 'text/xml');
  } catch {
    throw new KmlParseError('تعذّر قراءة الملف — تأكد أنه ملف KML صالح.');
  }

  if (doc.querySelector('parsererror')) {
    throw new KmlParseError('الملف ليس بصيغة XML/KML صحيحة.');
  }

  // أول Polygon داخل أول Placemark يحتوي عليه — نتجاهل LineString/Point
  const placemarks = Array.from(doc.getElementsByTagName('Placemark'));
  for (const placemark of placemarks) {
    const outerBoundary = placemark.getElementsByTagName('outerBoundaryIs')[0];
    const coordsEl = outerBoundary
      ? outerBoundary.getElementsByTagName('coordinates')[0]
      : placemark.getElementsByTagName('Polygon')[0]?.getElementsByTagName('coordinates')[0];

    if (!coordsEl?.textContent) continue;

    const points = parseCoordinatesText(coordsEl.textContent);
    // KML يكرر النقطة الأولى في النهاية لإغلاق المضلع — نزيلها إن كانت
    // مطابقة تماماً لتفادي تكرارها في ProjectZone.polygon.
    if (
      points.length >= 4 &&
      points[0].lat === points[points.length - 1].lat &&
      points[0].lng === points[points.length - 1].lng
    ) {
      points.pop();
    }

    if (points.length < 3) continue;

    const nameEl = placemark.getElementsByTagName('name')[0];
    return { polygon: points, name: nameEl?.textContent?.trim() || null };
  }

  throw new KmlParseError('لم يُعثر على مضلع (Polygon) صالح داخل ملف KML. تأكد من أن الملف يحتوي على منطقة مرسومة، وليس نقطة أو خط فقط.');
}

export interface ParsedKmlPoint {
  lat: number;
  lng: number;
  label: string | null;
}

// يستخرج كل Placemark من نوع Point في ملف KML — يُستخدم لاستيراد مواقع
// محطات رصد متعددة دفعة واحدة (بعكس parseKmlPolygon الذي يأخذ أول مضلع
// واحد فقط، لأن منطقة المشروع شكل واحد بينما محطات الرصد عدة نقاط).
export function parseKmlPoints(kmlText: string): ParsedKmlPoint[] {
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(kmlText, 'text/xml');
  } catch {
    throw new KmlParseError('تعذّر قراءة الملف — تأكد أنه ملف KML صالح.');
  }

  if (doc.querySelector('parsererror')) {
    throw new KmlParseError('الملف ليس بصيغة XML/KML صحيحة.');
  }

  const points: ParsedKmlPoint[] = [];
  const placemarks = Array.from(doc.getElementsByTagName('Placemark'));
  for (const placemark of placemarks) {
    const coordsEl = placemark.getElementsByTagName('Point')[0]?.getElementsByTagName('coordinates')[0];
    if (!coordsEl?.textContent) continue;

    const parsed = parseCoordinatesText(coordsEl.textContent);
    if (parsed.length === 0) continue;

    const nameEl = placemark.getElementsByTagName('name')[0];
    points.push({ lat: parsed[0].lat, lng: parsed[0].lng, label: nameEl?.textContent?.trim() || null });
  }

  if (points.length === 0) {
    throw new KmlParseError('لم يُعثر على أي نقاط (Point) صالحة داخل ملف KML.');
  }

  return points;
}
