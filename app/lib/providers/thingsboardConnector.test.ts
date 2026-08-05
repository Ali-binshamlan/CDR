import { describe, it, expect, vi, beforeEach } from 'vitest';

// القسم 5.4/18.4 من "دليل الإصلاح الجذري لمنظومة مرقاب": الموصل يجب أن يحمل
// كل حقل قياس بوقت رصده المستقل (fields[metric].observedAtIso)، لا وقتاً
// واحداً مشتركاً للحمولة كلها مبنياً على أحدث حقل — راجع تعليق القسم 5.4
// الكامل في thingsboardConnector.ts. نموّه safeFetch (الحدود الشبكية الوحيدة
// هنا) بردود قابلة للتحكم لكل استدعاء (login ثم /values/timeseries).
type FetchCall = { url: string; init?: RequestInit & { timeoutMs?: number } };
const fetchCalls: FetchCall[] = [];
let timeseriesBody: Record<string, Array<{ ts: number; value: unknown }>> = {};

function jsonResponse(body: unknown, contentType = 'application/json'): Response {
  const text = JSON.stringify(body);
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? contentType : null) },
    text: async () => text,
  } as unknown as Response;
}

vi.mock('./safeUrl', () => ({
  safeFetch: async (url: string, init?: RequestInit & { timeoutMs?: number }) => {
    fetchCalls.push({ url, init });
    if (url.includes('/api/auth/login')) {
      return jsonResponse({ token: 'test-jwt-token' });
    }
    if (url.includes('/values/timeseries')) {
      return jsonResponse(timeseriesBody);
    }
    throw new Error(`unexpected URL in test: ${url}`);
  },
}));

const ORIGIN = 'https://thingsboard.example.test';
const CREDENTIALS = { username: 'u', password: 'p', telemetry_keys: 'windSpeed,windGust,windDirection,pm10,pm25,visibility,humidity,temperature' };
const VENDOR_STATION_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

describe('thingsboardConnector.fetchLatestReading — وقت مستقل لكل حقل (القسم 5.4/18.4)', () => {
  beforeEach(() => {
    fetchCalls.length = 0;
    timeseriesBody = {};
  });

  it('PM10 عند 08:00 وحرارة عند 10:00 → كل حقل يحتفظ بوقته الخاص، لا وقت مشترك', async () => {
    const { thingsboardConnector } = await import('./thingsboardConnector');
    const pm10Ts = new Date('2026-08-04T08:00:00.000Z').getTime();
    const tempTs = new Date('2026-08-04T10:00:00.000Z').getTime();
    timeseriesBody = {
      pm10: [{ ts: pm10Ts, value: 45 }],
      temperature: [{ ts: tempTs, value: 38 }],
    };

    const reading = await thingsboardConnector.fetchLatestReading(ORIGIN, CREDENTIALS, VENDOR_STATION_ID);

    expect(reading).not.toBeNull();
    expect(reading!.fields?.pm10?.observedAtIso).toBe(new Date(pm10Ts).toISOString());
    expect(reading!.fields?.temperatureC?.observedAtIso).toBe(new Date(tempTs).toISOString());
    // observedAtIso العام (fallback توافقي فقط) = أحدث نقطة، لا يُستخدم لأي
    // قرار — لكن يجب ألا "يُسرّب" وقت الحرارة الأحدث على أنه وقت PM10 نفسه
    // داخل fields.
    expect(reading!.fields?.pm10?.observedAtIso).not.toBe(reading!.observedAtIso);
  });

  it('تغيّر الحرارة فقط بين استدعاءين → لا ينشئ نقطة PM10 جديدة (PM10 غائب من الحمولة الثانية)', async () => {
    const { thingsboardConnector } = await import('./thingsboardConnector');
    timeseriesBody = { temperature: [{ ts: Date.now(), value: 40 }] };

    const reading = await thingsboardConnector.fetchLatestReading(ORIGIN, CREDENTIALS, VENDOR_STATION_ID);

    expect(reading).not.toBeNull();
    expect(reading!.fields?.pm10).toBeUndefined();
    expect(reading!.fields?.temperatureC).toBeDefined();
  });

  it('لا يستخدم Date.now()/وقت استلام الطلب كـfallback — نقطة بـts غير رقمي (نص) تُرفض بالكامل', async () => {
    const { thingsboardConnector } = await import('./thingsboardConnector');
    // JSON.stringify(NaN) === 'null' فيتحوّل إلى 0 عبر Number(null) عند فك
    // الترميز (0 رقم "صالح" فنياً — ليس ما يقيسه هذا الاختبار). نص غير رقمي
    // فعلي يبقى NaN بعد فك الترميز أيضاً، فيختبر رفض ts فعلياً غير موثوق.
    timeseriesBody = {
      pm10: [{ ts: 'invalid-timestamp' as unknown as number, value: 45 }],
      windSpeed: [{ ts: Date.now(), value: 20 }],
    };

    const reading = await thingsboardConnector.fetchLatestReading(ORIGIN, CREDENTIALS, VENDOR_STATION_ID);

    expect(reading).not.toBeNull();
    expect(reading!.fields?.pm10).toBeUndefined();
    expect(reading!.fields?.windSpeedKmh).toBeDefined();
  });

  it('كل الحقول غائبة/غير صالحة → يعيد null بدل حمولة فارغة بوقت مُختلَق', async () => {
    const { thingsboardConnector } = await import('./thingsboardConnector');
    timeseriesBody = {};

    const reading = await thingsboardConnector.fetchLatestReading(ORIGIN, CREDENTIALS, VENDOR_STATION_ID);

    expect(reading).toBeNull();
  });
});

// القسم 15.1/18.7 — "تحقق من vendorStationId ضد Path Traversal": vendorStationId
// يُبنى مباشرة داخل مسار URL (`/values/timeseries?keys=...` عبر device id في
// المسار) — قيمة تحمل `../` أو مسافات/أحرفاً خاصة يجب أن تُرفَض قبل أي طلب
// شبكة، لا أن تُمرَّر كما هي لبناء رابط.
describe('thingsboardConnector.fetchLatestReading — رفض vendorStationId غير UUID (Path Traversal، القسم 15.1/18.7)', () => {
  beforeEach(() => {
    fetchCalls.length = 0;
    timeseriesBody = {};
  });

  it('vendorStationId يحمل ../ (محاولة Path Traversal) → يُرفَض قبل أي طلب شبكة', async () => {
    const { thingsboardConnector } = await import('./thingsboardConnector');
    await expect(
      thingsboardConnector.fetchLatestReading(ORIGIN, CREDENTIALS, '../../../etc/passwd')
    ).rejects.toThrow(/UUID/);
    expect(fetchCalls).toHaveLength(0);
  });

  it('vendorStationId نص حر غير UUID → يُرفَض قبل أي طلب شبكة', async () => {
    const { thingsboardConnector } = await import('./thingsboardConnector');
    await expect(thingsboardConnector.fetchLatestReading(ORIGIN, CREDENTIALS, 'not-a-uuid')).rejects.toThrow(/UUID/);
    expect(fetchCalls).toHaveLength(0);
  });

  it('vendorStationId UUID صالح → يمر بلا رفض', async () => {
    const { thingsboardConnector } = await import('./thingsboardConnector');
    timeseriesBody = { pm10: [{ ts: Date.now(), value: 45 }] };
    await expect(thingsboardConnector.fetchLatestReading(ORIGIN, CREDENTIALS, VENDOR_STATION_ID)).resolves.not.toBeNull();
  });
});

// القسم 15.1/18.7 — "حد أقصى لحجم الاستجابة ومحتوى Content-Type متوقع":
// readJsonWithLimit (thingsboardConnector.ts) يرفض Content-Type غير
// application/json، وحجماً يتجاوز MAX_RESPONSE_BYTES (2MB) — سواء عبر رأس
// Content-Length أو طول النص الفعلي المستلَم (دفاع مزدوج لو غاب الرأس أو
// كذب).
describe('thingsboardConnector.fetchLatestReading — حد الحجم وContent-Type (القسم 15.1/18.7)', () => {
  it('Content-Type غير application/json → يُرفَض', async () => {
    vi.resetModules();
    vi.doMock('./safeUrl', () => ({
      safeFetch: async (url: string) => {
        if (url.includes('/api/auth/login')) return jsonResponse({ token: 'test-jwt-token' });
        return {
          ok: true,
          status: 200,
          headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'text/html' : null) },
          text: async () => '<html>not json</html>',
        } as unknown as Response;
      },
    }));
    const { thingsboardConnector } = await import('./thingsboardConnector');
    await expect(thingsboardConnector.fetchLatestReading(ORIGIN, CREDENTIALS, VENDOR_STATION_ID)).rejects.toThrow(/نوع محتوى/);
    vi.doUnmock('./safeUrl');
    vi.resetModules();
  });

  it('Content-Length يتجاوز الحد الأقصى (2MB) → يُرفَض بلا قراءة النص كاملاً', async () => {
    vi.resetModules();
    vi.doMock('./safeUrl', () => ({
      safeFetch: async (url: string) => {
        if (url.includes('/api/auth/login')) return jsonResponse({ token: 'test-jwt-token' });
        return {
          ok: true,
          status: 200,
          headers: {
            get: (name: string) => {
              const lower = name.toLowerCase();
              if (lower === 'content-type') return 'application/json';
              if (lower === 'content-length') return String(3 * 1024 * 1024);
              return null;
            },
          },
          text: async () => '{}',
        } as unknown as Response;
      },
    }));
    const { thingsboardConnector } = await import('./thingsboardConnector');
    await expect(thingsboardConnector.fetchLatestReading(ORIGIN, CREDENTIALS, VENDOR_STATION_ID)).rejects.toThrow(/حجم استجابة/);
    vi.doUnmock('./safeUrl');
    vi.resetModules();
  });
});
