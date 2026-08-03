import type { ProviderConnector, ProviderCredentials, NormalizedReading, VendorStation } from './types';

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

// ProviderCredentials هو Record<string, string> (كل الحقول القادمة من
// JSONB نصوص دائماً) — telemetry_keys قد يغيب فعلياً من الكائن (لا نضيف
// خاصية اختيارية متعارضة مع نوع الفهرس، نتحقق من وجوده وقت القراءة بدلاً
// من ذلك عبر resolveKeyMap).
type ThingsboardCredentials = ProviderCredentials & {
  base_url: string; // مثال: https://thingsboard.cloud
  username: string;
  password: string;
};

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

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

async function login(credentials: ThingsboardCredentials): Promise<string> {
  const baseUrl = normalizeBaseUrl(credentials.base_url);
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: credentials.username, password: credentials.password }),
    signal: AbortSignal.timeout(7000),
    cache: 'no-store',
  });
  if (!response.ok) {
    throw new Error(`فشل تسجيل الدخول (HTTP ${response.status})`);
  }
  const data = await response.json();
  if (!data?.token) throw new Error('لم يُرجع الخادم توكن مصادقة');
  return data.token as string;
}

export const thingsboardConnector: ProviderConnector = {
  id: 'thingsboard',
  displayName: 'ThingsBoard',
  credentialFields: [
    { key: 'base_url', label: 'رابط المنصة (مثال: https://thingsboard.cloud)', type: 'text', required: true },
    { key: 'username', label: 'اسم المستخدم / البريد الإلكتروني', type: 'text', required: true },
    { key: 'password', label: 'كلمة المرور', type: 'password', required: true },
    {
      key: 'telemetry_keys',
      label: 'أسماء حقول القياس (اختياري، مفصولة بفواصل — windSpeed,windGust,windDirection,pm10,pm25,visibility,humidity,temperature)',
      type: 'text',
      required: false,
    },
  ],

  async testConnection(credentials: ProviderCredentials): Promise<{ success: boolean; errorMessage?: string }> {
    try {
      await login(credentials as ThingsboardCredentials);
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'تعذّر الاتصال بـThingsBoard';
      return { success: false, errorMessage: message };
    }
  },

  async listStations(credentials: ProviderCredentials): Promise<VendorStation[]> {
    const creds = credentials as ThingsboardCredentials;
    const token = await login(creds);
    const baseUrl = normalizeBaseUrl(creds.base_url);

    const response = await fetch(`${baseUrl}/api/tenant/devices?pageSize=100&page=0`, {
      headers: { 'X-Authorization': `Bearer ${token}` },
      signal: AbortSignal.timeout(7000),
      cache: 'no-store',
    });
    if (!response.ok) throw new Error(`فشل جلب قائمة الأجهزة (HTTP ${response.status})`);

    const data = await response.json();
    const items: any[] = data?.data ?? [];
    return items.map((d) => ({
      vendorStationId: d.id?.id ?? d.id,
      vendorStationName: d.name ?? d.id?.id ?? 'جهاز بلا اسم',
    }));
  },

  async fetchLatestReading(credentials: ProviderCredentials, vendorStationId: string): Promise<NormalizedReading | null> {
    const creds = credentials as ThingsboardCredentials;
    const token = await login(creds);
    const baseUrl = normalizeBaseUrl(creds.base_url);
    const keyMap = resolveKeyMap(creds);
    const tbKeys = Object.keys(keyMap).join(',');

    const response = await fetch(
      `${baseUrl}/api/plugins/telemetry/DEVICE/${vendorStationId}/values/timeseries?keys=${encodeURIComponent(tbKeys)}`,
      {
        headers: { 'X-Authorization': `Bearer ${token}` },
        signal: AbortSignal.timeout(7000),
        cache: 'no-store',
      }
    );
    if (!response.ok) throw new Error(`فشل جلب القراءة (HTTP ${response.status})`);

    const data = await response.json();
    if (!data || Object.keys(data).length === 0) return null;

    const reading: Partial<NormalizedReading> = {};
    let latestTs: number | null = null;

    for (const [tbKey, points] of Object.entries(data)) {
      const field = keyMap[tbKey];
      if (!field) continue;
      const point = Array.isArray(points) ? points[0] : null;
      if (!point || typeof point.value === 'undefined') continue;
      const numValue = Number(point.value);
      if (!Number.isFinite(numValue)) continue;
      (reading as Record<string, number>)[field] = numValue;
      const ts = Number(point.ts);
      if (Number.isFinite(ts) && (latestTs === null || ts > latestTs)) latestTs = ts;
    }

    if (Object.keys(reading).length === 0) return null;
    reading.observedAtIso = latestTs ? new Date(latestTs).toISOString() : new Date().toISOString();
    return reading as NormalizedReading;
  },
};
