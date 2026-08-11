// =============================================================
// اكتشاف تلقائي للمستقبِلات الحساسة (مدارس/مستشفيات/مساجد/سكني) القريبة
// من منطقة المشروع عبر Overpass API (خدمة مجانية تابعة لـ OpenStreetMap،
// بلا مفتاح) — بدل الاعتماد الحصري على جدول sensitive_receptors اليدوي
// الذي قد يبقى فارغاً بلا أي إدخال بشري.
//
// خطأ مكتشَف ومُصلَح (المستخدم لاحظ تناقضاً: بطاقة الامتثال تعرض مسجداً
// حقيقياً على 7م من كسارة عبر OSM، بينما القاعدة التنظيمية الرسمية أعلاها
// تقول "لا توجد بيانات مستقبلات" لأن sensitive_receptors فارغ فعلياً):
// اكتشاف OSM يبقى ممنوعاً من إصدار مخالفة/إيقاف تنظيمي مُلزم مباشرة (مصدر
// مجتمعي مفتوح غير موثَّق الدقة) — لكنه أصبح الآن يُستخدم أيضاً في
// crusher-precheck/batching-precheck (قبل الحفظ) لمنع المستخدم من إكمال
// حفظ نشاط قرب معلَم اكتُشف عبر OSM دون تحقق يدوي أولاً (buildOsmProximityWarning
// أدناه) — طلب صريح: "امنع المستخدم من انشاء النشاط فقط"، لا مخالفة تلقائية.
// الاستخدام التوعوي الأصلي (بطاقة "المستقبِلات القريبة") يبقى كما هو.
// =============================================================

import type { SensitiveReceptorType } from '@/app/utils/dust-compliance-engine/types';
import { nearestReceptorDistancesM } from '@/app/utils/dust-compliance-engine/geo';

export interface DiscoveredReceptor {
  id: string;
  name: string;
  receptorType: SensitiveReceptorType;
  // مركز العنصر (centroid عند way/relation، أو النقطة نفسها عند node) —
  // يبقى موجوداً دائماً كقيمة احتياطية، لكن لا يجوز استخدامه وحده لحساب
  // "أقرب مسافة" لعناصر landuse=residential الكبيرة (أحياء كاملة قد تمتد
  // كيلومترات) — راجع boundary أدناه.
  lat: number;
  lng: number;
  // معالم الحدود الفعلية لعنصر way (كل عقد المضلع/الخط، من "out geom;") —
  // متوفرة فقط لعناصر way/relation، غير موجودة لعناصر node (مبنى مفرد/
  // نقطة). عند توفرها، أقرب مسافة فعلية للعنصر يجب أن تُحسب كأقرب مسافة
  // لأي نقطة على boundary، لا للمركز فقط — وإلا فمركز حي سكني كبير قد يبدو
  // بعيداً رغم أن حافته الفعلية قريبة جداً من الموقع المقيَّم.
  boundary?: { lat: number; lng: number }[];
}

const OVERPASS_ENDPOINT = 'https://overpass-api.de/api/interpreter';

// شكل مبسّط لعنصر واحد من استجابة Overpass ("out geom;") — فقط الحقول
// التي يقرأها الكود أدناه فعلياً (type/id/lat/lon/tags/geometry)، لا كل
// حقول Overpass API الموسّعة (لا فائدة من نوع شامل لبيانات خارجية لا
// نستهلك منها إلا هذا الجزء).
interface OverpassElement {
  type: string;
  id: number | string;
  lat?: number;
  lon?: number;
  tags?: Record<string, string>;
  geometry?: { lat: number; lon: number }[];
}

interface OverpassResponse {
  elements?: OverpassElement[];
}

// ذاكرة مؤقتة داخل العملية (in-memory) لنتائج Overpass — موقع المشروع لا
// يتغيّر عملياً بعد التأسيس، فلا داعي لاستدعاء الخدمة العامة مجدداً في كل
// مرة يفتح فيها صاحب المشروع لوحته (كانت ستُستدعى عند كل GET). المفتاح
// مقرَّب لأقرب ~10م (5 خانات عشرية) لتفادي تكرار الاستدعاء لفروق تقريب
// تافهة في نفس الموقع تقريباً. المدة ساعة واحدة كافية عملياً (لا تغيّر متوقع
// في مدارس/مستشفيات OSM خلال ساعة) دون إبقاء الذاكرة قديمة لأيام.
const CACHE_TTL_MS = 60 * 60 * 1000;
const cache = new Map<string, { expiresAt: number; data: DiscoveredReceptor[] }>();

function cacheKey(lat: number, lng: number, radiusM: number): string {
  return `${lat.toFixed(5)},${lng.toFixed(5)},${radiusM}`;
}

// وسوم OSM المقابلة لكل نوع مستقبِل حساس — أمثلة شائعة فقط (ليست شاملة كل
// تصنيفات OSM) بما يكفي لتغطية المدارس/المستشفيات/المساجد/السكني.
const OSM_TAG_TO_RECEPTOR_TYPE: { filter: string; type: SensitiveReceptorType }[] = [
  { filter: 'amenity=school', type: 'SCHOOL' },
  { filter: 'amenity=kindergarten', type: 'SCHOOL' },
  { filter: 'amenity=university', type: 'SCHOOL' },
  { filter: 'amenity=college', type: 'SCHOOL' },
  { filter: 'amenity=hospital', type: 'HOSPITAL' },
  { filter: 'amenity=clinic', type: 'HOSPITAL' },
  { filter: 'amenity=doctors', type: 'HOSPITAL' },
  { filter: 'amenity=place_of_worship', type: 'MOSQUE' },
  { filter: 'landuse=residential', type: 'RESIDENTIAL' },
];

function buildOverpassQuery(centerLat: number, centerLng: number, radiusM: number): string {
  // node/way/relation حول نقطة مركزية بدائرة نصف قطرها radiusM — أبسط
  // وأدق من صندوق محيط (bounding box) لأننا نريد بالضبط "ضمن Xم"، والتصفية
  // النهائية بالمسافة الدقيقة عن حدود المشروع تحدث لاحقاً في route.ts على
  // أي حال، فهذا فقط لتضييق نطاق البحث الأولي.
  const clauses = OSM_TAG_TO_RECEPTOR_TYPE.map(({ filter }) => {
    const [key, value] = filter.split('=');
    return `
      node["${key}"="${value}"](around:${radiusM},${centerLat},${centerLng});
      way["${key}"="${value}"](around:${radiusM},${centerLat},${centerLng});
    `;
  }).join('\n');

  // "out geom;" (بدل "out center tags;" السابقة) يُرجع كامل معالم كل way
  // (geometry: [{lat, lon}, ...]) بجانب مركزه — ضروري لحساب أقرب مسافة
  // فعلية لعناصر كبيرة مثل landuse=residential، لا مسافة المركز فقط
  // (راجع تعليق DiscoveredReceptor.boundary).
  return `
    [out:json][timeout:15];
    (
      ${clauses}
    );
    out geom;
  `;
}

function classifyOsmTags(tags: Record<string, string> | undefined): SensitiveReceptorType | null {
  if (!tags) return null;
  if (tags.amenity === 'school' || tags.amenity === 'kindergarten' || tags.amenity === 'university' || tags.amenity === 'college') {
    return 'SCHOOL';
  }
  if (tags.amenity === 'hospital' || tags.amenity === 'clinic' || tags.amenity === 'doctors') {
    return 'HOSPITAL';
  }
  if (tags.amenity === 'place_of_worship') {
    return 'MOSQUE';
  }
  if (tags.landuse === 'residential') {
    return 'RESIDENTIAL';
  }
  return null;
}

// اسم افتراضي عربي عند غياب name/name:ar في OSM — أفضل من عرض "بلا اسم"
const FALLBACK_NAME_AR: Record<SensitiveReceptorType, string> = {
  SCHOOL: 'مدرسة (بلا اسم مسجَّل)',
  HOSPITAL: 'منشأة صحية (بلا اسم مسجَّل)',
  RESIDENTIAL: 'منطقة سكنية',
  MOSQUE: 'مسجد (بلا اسم مسجَّل)',
  OTHER: 'منشأة (بلا اسم مسجَّل)',
};

// يبحث عن مستقبِلات حساسة حول نقطة مركزية عبر Overpass API. يُرجع مصفوفة
// فارغة بصمت عند أي فشل شبكي (مهلة/انقطاع) بدل رمي خطأ — هذه ميزة عرض
// إضافية، فشلها لا يجوز أن يُسقط تحميل صفحة المشروع بأكملها.
export async function fetchNearbySensitiveReceptorsFromOsm(
  centerLat: number,
  centerLng: number,
  radiusM: number
): Promise<DiscoveredReceptor[]> {
  const key = cacheKey(centerLat, centerLng, radiusM);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  try {
    const query = buildOverpassQuery(centerLat, centerLng, radiusM);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);

    const response = await fetch(OVERPASS_ENDPOINT, {
      method: 'POST',
      // خادم Overpass (Apache) يرفض بعض الطلبات بـ 406 Not Acceptable إن
      // غاب رأس Accept أو User-Agent الصريح — قيمة fetch الافتراضية في
      // Node (بلا هذين الرأسين) تُرفَض، رغم أن نفس الطلب عبر curl (الذي
      // يرسل Accept: */* افتراضياً) ينجح. نضيفهما صراحة لتفادي هذا الرفض.
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': '*/*',
        'User-Agent': 'mirqab-app/1.0 (dust-compliance-sensitive-receptors)',
      },
      body: `data=${encodeURIComponent(query)}`,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!response.ok) return [];

    const json: OverpassResponse = await response.json();
    const elements: OverpassElement[] = Array.isArray(json?.elements) ? json.elements : [];

    const results: DiscoveredReceptor[] = [];
    for (const el of elements) {
      const receptorType = classifyOsmTags(el.tags);
      if (!receptorType) continue;

      // node: lat/lon مباشرة. way/relation مع "out geom;": لا يوجد حقل
      // center جاهز (ذاك خاص بـ"out center;" فقط) — نحسب centroid تقريبياً
      // من متوسط نقاط geometry كقيمة احتياطية للعرض فقط؛ الحساب الدقيق
      // لأقرب مسافة يعتمد على boundary الكاملة أدناه، لا هذا المتوسط.
      const geometryPoints: { lat: number; lon: number }[] = Array.isArray(el.geometry) ? el.geometry : [];
      let lat: number | undefined = typeof el.lat === 'number' ? el.lat : undefined;
      let lng: number | undefined = typeof el.lon === 'number' ? el.lon : undefined;
      if ((lat === undefined || lng === undefined) && geometryPoints.length > 0) {
        const sum = geometryPoints.reduce((acc, p) => ({ lat: acc.lat + p.lat, lng: acc.lng + p.lon }), { lat: 0, lng: 0 });
        lat = sum.lat / geometryPoints.length;
        lng = sum.lng / geometryPoints.length;
      }
      if (typeof lat !== 'number' || typeof lng !== 'number') continue;

      const name = el.tags?.['name:ar'] || el.tags?.name || FALLBACK_NAME_AR[receptorType];
      const boundary = geometryPoints.length > 0
        ? geometryPoints.map((p) => ({ lat: p.lat, lng: p.lon }))
        : undefined;

      results.push({
        id: `osm-${el.type}-${el.id}`,
        name,
        receptorType,
        lat,
        lng,
        boundary,
      });
    }
    cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, data: results });
    return results;
  } catch {
    return [];
  }
}

// يجلب معالم OSM القريبة ويبني رسالة تحذير عربية جاهزة إن وُجد أقرب واحد
// منها ضمن thresholdM — مستخرَجة من crusher-precheck/batching-precheck
// (كانتا تكرران نفس منطق "أقرب معلَم + بناء الرسالة" بالضبط). null إن لم
// يوجد أي معلَم ضمن الحد (لا تحذير)، أو عند فشل الجلب من Overpass (فشل آمن
// موروث من fetchNearbySensitiveReceptorsFromOsm نفسها).
export async function buildOsmProximityWarning(
  lat: number,
  lng: number,
  thresholdM: number
): Promise<string | null> {
  const osmReceptors = await fetchNearbySensitiveReceptorsFromOsm(lat, lng, thresholdM);
  if (osmReceptors.length === 0) return null;

  let nearestName = '';
  let nearestDistanceM = Infinity;
  for (const r of osmReceptors) {
    const { nearestAnyM } = nearestReceptorDistancesM(lat, lng, [
      { id: r.id, name: r.name, receptorType: r.receptorType, lat: r.lat, lng: r.lng },
    ]);
    if (nearestAnyM !== null && nearestAnyM < nearestDistanceM) {
      nearestDistanceM = nearestAnyM;
      nearestName = r.name;
    }
  }
  if (nearestDistanceM === Infinity || nearestDistanceM >= thresholdM) return null;

  return `تحذير: تم اكتشاف معلَم قريب محتمل الحساسية عبر خرائط OpenStreetMap ("${nearestName}"، على بُعد ${Math.round(nearestDistanceM)} م تقريباً) — بيانات غير رسمية تتطلب تحققاً ميدانياً. أدخِل هذا المستقبِل في سجل المستقبلات الحساسة الرسمي إن ثبت وجوده فعلياً، أو أكِّد المسافة يدوياً قبل المتابعة`;
}
