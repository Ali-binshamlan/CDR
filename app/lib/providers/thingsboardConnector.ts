import type { ProviderConnector, ProviderCredentials, NormalizedReading, NormalizedMetricPoint, VendorStation } from './types';
import { safeFetch } from './safeUrl';

// Connector حقيقي لـThingsBoard (منصة IoT عامة، لا شركة قياس هواء محددة) —
// المستخدم يملك حسابه الخاص (مثال: thingsboard.cloud) وأجهزته المسجَّلة
// عنده، ويحدد بنفسه أسماء حقول القياس (telemetry keys) لكل جهاز عند إرساله
// البيانات (عبر Postman أو أي عميل push آخر يرسل مباشرة لـThingsBoard).
//
// آلية المصادقة: JWT token مؤقت (POST /api/auth/login بـusername/password)،
// صالح لفترة محدودة (~ساعتين افتراضياً في ThingsBoard) — لا يُخزَّن التوكن
// نفسه في credentials؛ كل استدعاء (testConnection/listStations/
// fetchLatestReading) يسجّل دخولاً جديداً بنفسه (بسيط وموثوق أكثر من تخزين/
// تجديد توكن منتهي الصلاحية عبر استدعاءات cron متباعدة كل دقيقتين — التكلفة
// الإضافية لتسجيل دخول جديد بكل استدعاء cron ضئيلة عملياً).
//
// أسماء حقول القياس قابلة للتخصيص بالكامل (credentials.telemetry_keys، نص
// مفصول بفواصل مثل "pm10,pm25,windSpeed,windDirection,humidity,temperature")
// لأن ThingsBoard لا يفرض أي اتفاقية تسمية — المستخدم يحدد ما يرسله جهازه.
//
// خطأ أمني مكتشَف ومُصلَح (القسم 15.1 من "دليل الإصلاح الجذري لمنظومة
// مرقاب"): base_url لم يعد جزءاً من credentials — يصل الآن كمعامل origin
// منفصل، مُحلاًّ حصراً من provider_instances المعتمدة (سجل يديره مسؤول
// النظام، لا نص حر من المستخدم). كل طلب شبكة يمر عبر safeFetch (manual
// redirect + فحص SSRF كامل على كل قفزة تحويل)، لا fetch() مباشر.
type ThingsboardCredentials = ProviderCredentials & {
  username: string;
  password: string;
};

// خطأ أمني مكتشَف ومُصلَح (القسم 15.1 — "تحقق vendorStationId كـUUID أو
// الصيغة الرسمية المعتمدة"): ThingsBoard device id هو UUID دائماً — رفض أي
// قيمة أخرى قبل بناء المسار يمنع حقن مسار (path traversal/injection) عبر
// vendorStationId المخزَّن في provider_connections.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// حد أقصى لحجم الاستجابة (بايتات) — القسم 15.1: "حد أقصى لحجم الاستجابة
// ومحتوى Content-Type متوقع، Timeout قصير". يمنع استجابة ضخمة غير متوقعة
// (خبيثة أو معطوبة) من استهلاك الذاكرة بلا حدود.
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024; // 2MB
// خطة ThingsBoard المجانية أظهرت تذبذباً حقيقياً في وقت الاستجابة أثناء
// الاختبار الفعلي (تجاوز 7 ثوانٍ عدة مرات، وصل أحياناً 12+ ثانية) — 7000
// كانت قصيرة بما يكفي لتسبيب فشل سحب متكرر حتى مع استخدام حقيقي، لا فقط
// محلياً. رُفعت إلى 15000 لتحمّل هذا التذبذب.
const REQUEST_TIMEOUT_MS = 15000;

// خريطة الاسم الافتراضي المتوقَّع لكل حقل موحَّد — المستخدم يقدر يغيّرها
// عبر credentials.telemetry_keys بنفس الترتيب (windSpeedKmh,windGustKmh,
// windDirectionDeg,pm10,pm25,visibilityM,relativeHumidityPercent,temperatureC).
const NORMALIZED_FIELD_ORDER: Array<keyof NormalizedReading> = [
  'windSpeedKmh',
  'windGustKmh',
  'windDirectionDeg',
  'pm10',
  'pm25',
  'visibilityM',
  'relativeHumidityPercent',
  'temperatureC',
];

const DEFAULT_TELEMETRY_KEYS = ['windSpeed', 'windGust', 'windDirection', 'pm10', 'pm25', 'visibility', 'humidity', 'temperature'];

function resolveKeyMap(credentials: ThingsboardCredentials): Record<string, keyof NormalizedReading> {
  const rawKeys = credentials.telemetry_keys?.trim()
    ? credentials.telemetry_keys.split(',').map((k) => k.trim())
    : DEFAULT_TELEMETRY_KEYS;

  const map: Record<string, keyof NormalizedReading> = {};
  NORMALIZED_FIELD_ORDER.forEach((field, i) => {
    if (rawKeys[i]) map[rawKeys[i]] = field;
  });
  return map;
}

function normalizeOrigin(origin: string): string {
  return origin.replace(/\/+$/, '');
}

// حد أقصى لحجم الاستجابة قبل تحليل JSON — يقرأ body كنص بحد أقصى، يرفض
// استجابة أكبر بدل تحميلها كاملة بالذاكرة أولاً.
async function readJsonWithLimit(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    throw new Error(`نوع محتوى غير متوقَّع من المنصة: ${contentType || 'غير محدَّد'}`);
  }
  const contentLength = response.headers.get('content-length');
  if (contentLength && Number(contentLength) > MAX_RESPONSE_BYTES) {
    throw new Error('حجم استجابة المنصة يتجاوز الحد المسموح');
  }
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new Error('حجم استجابة المنصة يتجاوز الحد المسموح');
  }
  return JSON.parse(text);
}

async function login(origin: string, credentials: ThingsboardCredentials): Promise<string> {
  const baseUrl = normalizeOrigin(origin);
  const response = await safeFetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: credentials.username, password: credentials.password }),
    timeoutMs: REQUEST_TIMEOUT_MS,
  });
  if (!response.ok) {
    throw new Error(`فشل تسجيل الدخول (HTTP ${response.status})`);
  }
  const data = (await readJsonWithLimit(response)) as { token?: string };
  if (!data?.token) throw new Error('لم يُرجع الخادم توكن مصادقة');
  return data.token;
}

export const thingsboardConnector: ProviderConnector = {
  id: 'thingsboard',
  displayName: 'ThingsBoard',
  requiresProviderInstance: true,
  credentialFields: [
    { key: 'username', label: 'اسم المستخدم / البريد الإلكتروني', type: 'text', required: true },
    { key: 'password', label: 'كلمة المرور', type: 'password', required: true },
    {
      key: 'telemetry_keys',
      label: 'أسماء حقول القياس (اختياري، مفصولة بفواصل — windSpeed,windGust,windDirection,pm10,pm25,visibility,humidity,temperature)',
      type: 'text',
      required: false,
    },
  ],

  async testConnection(origin: string, credentials: ProviderCredentials): Promise<{ success: boolean; errorMessage?: string }> {
    try {
      await login(origin, credentials as ThingsboardCredentials);
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'تعذّر الاتصال بـThingsBoard';
      return { success: false, errorMessage: message };
    }
  },

  async listStations(origin: string, credentials: ProviderCredentials): Promise<VendorStation[]> {
    const creds = credentials as ThingsboardCredentials;
    const token = await login(origin, creds);
    const baseUrl = normalizeOrigin(origin);

    const response = await safeFetch(`${baseUrl}/api/tenant/devices?pageSize=100&page=0`, {
      headers: { 'X-Authorization': `Bearer ${token}` },
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    if (!response.ok) throw new Error(`فشل جلب قائمة الأجهزة (HTTP ${response.status})`);

    const data = (await readJsonWithLimit(response)) as { data?: { id: { id: string } | string; name?: string }[] };
    // خطأ أمني مكتشَف ومُصلَح (القسم 15.1 — "حد أقصى لعدد المحطات والنقاط
    // في الرد"): يمنع استجابة بآلاف العناصر من إغراق الذاكرة/الواجهة.
    const items = (data?.data ?? []).slice(0, 500);
    return items.map((d) => {
      const idValue = typeof d.id === 'string' ? d.id : d.id?.id;
      return {
        vendorStationId: idValue,
        vendorStationName: d.name ?? idValue ?? 'جهاز بلا اسم',
      };
    });
  },

  async fetchLatestReading(origin: string, credentials: ProviderCredentials, vendorStationId: string): Promise<NormalizedReading | null> {
    if (!UUID_PATTERN.test(vendorStationId)) {
      throw new Error('vendorStationId غير صالح — يجب أن يكون UUID');
    }

    const creds = credentials as ThingsboardCredentials;
    const token = await login(origin, creds);
    const baseUrl = normalizeOrigin(origin);
    const keyMap = resolveKeyMap(creds);
    const tbKeys = Object.keys(keyMap).join(',');

    const response = await safeFetch(
      `${baseUrl}/api/plugins/telemetry/DEVICE/${encodeURIComponent(vendorStationId)}/values/timeseries?keys=${encodeURIComponent(tbKeys)}`,
      {
        headers: { 'X-Authorization': `Bearer ${token}` },
        timeoutMs: REQUEST_TIMEOUT_MS,
      }
    );
    if (!response.ok) throw new Error(`فشل جلب القراءة (HTTP ${response.status})`);

    const data = (await readJsonWithLimit(response)) as Record<string, unknown>;
    if (!data || Object.keys(data).length === 0) return null;

    // خطأ مكتشَف ومُصلَح (القسم 5.4/8.2 من "دليل الإصلاح الجذري لمنظومة
    // مرقاب" — "ThingsBoard ينسب أحدث timestamp إلى جميع الحقول"): الموصل
    // كان يجمع أكبر timestamp بين كل الحقول (PM10/الرياح/الحرارة/إلخ) ثم
    // يضعه في observedAtIso واحد للحمولة كلها — حرارة حديثة يمكن أن تجعل
    // PM10 عمره ساعة يبدو حديثاً، وتُنشئ سلسلة استمرار زائفة أو تُسقط
    // تحديثاً حقيقياً على أنه duplicate. الإصلاح: كل حقل يحمل وقته الخاص في
    // fields (NormalizedMetricPoint) — لا وقت واحد مشترك. observedAtIso
    // العام يبقى fallback توافقي (أحدث نقطة، للمستهلكين القدامى الذين لم
    // يقرأوا fields بعد) — لا يُستخدم في منطق القرار بعد إضافة fields.
    const reading: Partial<NormalizedReading> = {};
    const fields: Partial<Record<string, NormalizedMetricPoint>> = {};
    let latestTs: number | null = null;

    // حد أقصى لعدد النقاط المعالَجة — دفاع إضافي حتى لو تجاوزت الاستجابة
    // حد الحجم أعلاه بقليل قبل الرفض.
    let pointsProcessed = 0;
    const MAX_POINTS = 1000;

    for (const [tbKey, points] of Object.entries(data)) {
      if (pointsProcessed >= MAX_POINTS) break;
      const field = keyMap[tbKey];
      if (!field) continue;
      const point = Array.isArray(points) ? points[0] : null;
      pointsProcessed++;
      if (!point || typeof point.value === 'undefined') continue;
      const numValue = Number(point.value);
      if (!Number.isFinite(numValue)) continue;
      const ts = Number(point.ts);
      if (!Number.isFinite(ts)) continue; // نقطة بلا وقت موثوق تُرفض — لا تدخل القرار
      (reading as Record<string, number>)[field] = numValue;
      fields[field] = { value: numValue, observedAtIso: new Date(ts).toISOString() };
      if (latestTs === null || ts > latestTs) latestTs = ts;
    }

    if (Object.keys(fields).length === 0) return null;
    reading.fields = fields as NormalizedReading['fields'];
    // fallback فقط لمستهلكين قدامى يقرأون observedAtIso العام (مثال: مفتاح
    // idempotency في provider-pull/route.ts) — لا تُستخدَم قيمة هذا الحقل
    // لأي قرار بعد إضافة fields أعلاه. latestTs مضمون غير null هنا (fields
    // غير فارغة، وكل عنصر فيها اجتاز فحص Number.isFinite(ts) أعلاه).
    reading.observedAtIso = new Date(latestTs as number).toISOString();
    return reading as NormalizedReading;
  },

  // خطأ مكتشَف ومُصلَح (مراجعة خبير خارجي — التقرير النهائي: "العينة كل
  // دقيقتين لا تكفي؛ يمكن النقل كل دقيقتين فقط إذا احتوت الإرسالية على جميع
  // عينات الدقيقة بطوابعها المستقلة"): fetchLatestReading أعلاه تطلب أحدث
  // نقطة واحدة فقط لكل مفتاح (limit=1 ضمنياً عبر values/timeseries بلا
  // startTs/endTs) — بفارق دورة سحب أبطأ من فجوة الاستمرارية المسموحة (90
  // ثانية)، عينة واحدة كل دقيقتين لا تستطيع أبداً إثبات استمرار PM10.
  // fetchReadingsSince تستخدم endpoint history/timeseries (بـstartTs/endTs)
  // بدل values/timeseries — يُرجع ThingsBoard كل النقاط المسجَّلة فعلياً
  // خلال tha النافذة الزمنية، لا نقطة واحدة فقط. كل نقطة زمنية مختلفة عبر
  // كل المفاتيح تُجمَّع في NormalizedReading مستقل بطابعها الخاص (تقريب
  // الطوابع لأقرب ثانية لتجميع نقاط قريبة من مفاتيح مختلفة كأنها "نفس
  // اللحظة" — نفس مبدأ observedAtIso المشترك سابقاً، لكن هنا للتجميع فقط،
  // لا لتحديد وقت الحفظ الفعلي، الذي يبقى محسوباً من fields المستقلة).
  async fetchReadingsSince(
    origin: string,
    credentials: ProviderCredentials,
    vendorStationId: string,
    sinceMs: number
  ): Promise<NormalizedReading[]> {
    if (!UUID_PATTERN.test(vendorStationId)) {
      throw new Error('vendorStationId غير صالح — يجب أن يكون UUID');
    }

    const creds = credentials as ThingsboardCredentials;
    const token = await login(origin, creds);
    const baseUrl = normalizeOrigin(origin);
    const keyMap = resolveKeyMap(creds);
    const tbKeys = Object.keys(keyMap).join(',');

    const endTs = Date.now();
    // حد أقصى لعدد النقاط المطلوبة لكل مفتاح — دفاع ضد إرسالية كثيفة غير
    // متوقَّعة (نفس فلسفة MAX_POINTS في fetchLatestReading أعلاه).
    const MAX_POINTS_PER_KEY = 200;

    const response = await safeFetch(
      `${baseUrl}/api/plugins/telemetry/DEVICE/${encodeURIComponent(vendorStationId)}/values/timeseries` +
        `?keys=${encodeURIComponent(tbKeys)}&startTs=${sinceMs}&endTs=${endTs}&limit=${MAX_POINTS_PER_KEY}&orderBy=ASC`,
      {
        headers: { 'X-Authorization': `Bearer ${token}` },
        timeoutMs: REQUEST_TIMEOUT_MS,
      }
    );
    if (!response.ok) throw new Error(`فشل جلب القراءات (HTTP ${response.status})`);

    const data = (await readJsonWithLimit(response)) as Record<string, { ts: number; value: string }[]>;
    if (!data || Object.keys(data).length === 0) return [];

    // تجميع كل النقاط (عبر كل المفاتيح) بحسب طابعها الزمني — نقاط بفارق
    // أقل من ثانية واحدة تُعامَل كأنها "نفس اللحظة" (نفس دقة ThingsBoard
    // الافتراضية لدفعات القراءة)، تفادياً لتشظّي كل حقل إلى قراءة منفصلة
    // تماماً حين ترسل المحطة كل الحقول معاً في نفس اللحظة عملياً.
    const byTimestampSecond = new Map<number, Partial<Record<keyof NormalizedReading, { value: number; ts: number }>>>();
    let pointsProcessed = 0;
    const MAX_TOTAL_POINTS = 1000;

    for (const [tbKey, points] of Object.entries(data)) {
      const field = keyMap[tbKey];
      if (!field || !Array.isArray(points)) continue;
      for (const point of points) {
        if (pointsProcessed >= MAX_TOTAL_POINTS) break;
        pointsProcessed++;
        if (!point || typeof point.value === 'undefined') continue;
        const numValue = Number(point.value);
        if (!Number.isFinite(numValue)) continue;
        const ts = Number(point.ts);
        if (!Number.isFinite(ts)) continue;
        const bucketKey = Math.floor(ts / 1000);
        const bucket = byTimestampSecond.get(bucketKey) ?? {};
        bucket[field] = { value: numValue, ts };
        byTimestampSecond.set(bucketKey, bucket);
      }
    }

    const readings: NormalizedReading[] = [];
    for (const bucket of byTimestampSecond.values()) {
      const reading: Partial<NormalizedReading> = {};
      const fields: Partial<Record<string, NormalizedMetricPoint>> = {};
      let latestTs: number | null = null;
      for (const [field, point] of Object.entries(bucket) as [keyof NormalizedReading, { value: number; ts: number }][]) {
        (reading as Record<string, number>)[field] = point.value;
        fields[field] = { value: point.value, observedAtIso: new Date(point.ts).toISOString() };
        if (latestTs === null || point.ts > latestTs) latestTs = point.ts;
      }
      if (Object.keys(fields).length === 0 || latestTs === null) continue;
      reading.fields = fields as NormalizedReading['fields'];
      reading.observedAtIso = new Date(latestTs).toISOString();
      readings.push(reading as NormalizedReading);
    }

    // ترتيب زمني تصاعدي — provider-pull يكتبها بهذا الترتيب (الأقدم أولاً)
    // حتى تتراكم last_*_at بشكل صحيح (كل كتابة أحدث من التي قبلها).
    readings.sort((a, b) => new Date(a.observedAtIso as string).getTime() - new Date(b.observedAtIso as string).getTime());
    return readings;
  },
};
