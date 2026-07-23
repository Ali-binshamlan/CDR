// =============================================================
// اكتشاف تلقائي للمستقبِلات الحساسة (مدارس/مستشفيات/مساجد/سكني) القريبة
// من منطقة المشروع عبر Overpass API (خدمة مجانية تابعة لـ OpenStreetMap،
// بلا مفتاح) — بدل الاعتماد على جدول sensitive_receptors اليدوي الذي قد
// يبقى فارغاً بلا أي إدخال بشري. هذا الاستخدام عرضي فقط (بطاقة الامتثال
// "المستقبِلات القريبة")، ولا يُستخدم كمُدخل لقواعد الامتثال الفعلية
// (مسافة الكسارة/الأكوام) — تلك تبقى تعتمد على جدول sensitive_receptors
// المُدار يدوياً، لتفادي بناء قرار تنظيمي مُلزم على بيانات OSM غير موثّقة
// أو غير دقيقة.
// =============================================================

import type { SensitiveReceptorType } from '@/app/utils/dust-compliance-engine/types';

export interface DiscoveredReceptor {
  id: string;
  name: string;
  receptorType: SensitiveReceptorType;
  lat: number;
  lng: number;
}

const OVERPASS_ENDPOINT = 'https://overpass-api.de/api/interpreter';

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

  return `
    [out:json][timeout:15];
    (
      ${clauses}
    );
    out center tags;
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

    const json: any = await response.json();
    const elements: any[] = Array.isArray(json?.elements) ? json.elements : [];

    const results: DiscoveredReceptor[] = [];
    for (const el of elements) {
      const receptorType = classifyOsmTags(el.tags);
      if (!receptorType) continue;

      // node: lat/lon مباشرة. way/relation: center.lat/center.lon (بفضل "out center")
      const lat = typeof el.lat === 'number' ? el.lat : el.center?.lat;
      const lng = typeof el.lon === 'number' ? el.lon : el.center?.lon;
      if (typeof lat !== 'number' || typeof lng !== 'number') continue;

      const name = el.tags?.['name:ar'] || el.tags?.name || FALLBACK_NAME_AR[receptorType];

      results.push({
        id: `osm-${el.type}-${el.id}`,
        name,
        receptorType,
        lat,
        lng,
      });
    }
    cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, data: results });
    return results;
  } catch {
    return [];
  }
}
