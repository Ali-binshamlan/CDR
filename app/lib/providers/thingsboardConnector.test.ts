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

// خطأ مكتشَف ومُصلَح (مراجعة خبير خارجي — التقرير النهائي: "العينة كل
// دقيقتين لا تكفي — الصفحة 82 من المرجع التنظيمي تشترط بيانات PM10 لمدة
// دقيقة وفترة تسجيل لا تتجاوز دقيقة. مع فجوة استمرارية 90 ثانية، فإن عينة
// واحدة كل دقيقتين لن تؤكد المخالفة أبداً؛ يمكن النقل كل دقيقتين فقط إذا
// احتوت الإرسالية على جميع عينات الدقيقة بطوابعها المستقلة"): fetchLatestReading
// وحدها (نقطة واحدة فقط) لا تكفي رياضياً حين دورة السحب (~دقيقتان) أبطأ من
// فجوة الاستمرارية المسموحة (90 ثانية، ACTIVE_RULE_BUNDLE.pm10.evidence.
// maxContinuityGapMs). fetchReadingsSince تجلب كل العينات منذ لحظة محدَّدة.
describe('thingsboardConnector.fetchReadingsSince — كل العينات منذ آخر سحب، لا نقطة واحدة فقط', () => {
  beforeEach(() => {
    // القسم السابق (حد الحجم/Content-Type) ينتهي بـvi.resetModules() —
    // يُسقِط تسجيل vi.mock('./safeUrl', ...) العلوي لكل import() لاحق في
    // نفس الملف. إعادة تسجيله صراحةً هنا يضمن عزل هذا القسم عن ذلك التأثير
    // الجانبي بصرف النظر عن ترتيب تشغيل الاختبارات.
    vi.resetModules();
    vi.doMock('./safeUrl', () => ({
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
    fetchCalls.length = 0;
    timeseriesBody = {};
  });

  it('يطلب startTs/endTs في الرابط (endTs=untilMs الصريحة، لا Date.now() داخلية)', async () => {
    const { thingsboardConnector } = await import('./thingsboardConnector');
    const sinceMs = Date.now() - 120_000;
    const untilMs = Date.now();
    timeseriesBody = { pm10: [{ ts: sinceMs + 30_000, value: 350 }] };

    await thingsboardConnector.fetchReadingsSince!(ORIGIN, CREDENTIALS, VENDOR_STATION_ID, sinceMs, untilMs);

    const dataCall = fetchCalls.find((c) => c.url.includes('/values/timeseries'));
    expect(dataCall).toBeDefined();
    expect(dataCall!.url).toContain(`startTs=${sinceMs}`);
    expect(dataCall!.url).toContain(`endTs=${untilMs}`);
    expect(dataCall!.url).toContain('orderBy=ASC');
  });

  it('ثلاث عينات PM10 خلال الدقيقتين الماضيتين (بفارق 45 ثانية بينها) → تُرجَع 3 قراءات مستقلة، لا قراءة واحدة فقط', async () => {
    const { thingsboardConnector } = await import('./thingsboardConnector');
    const now = Date.now();
    const ts1 = now - 90_000;
    const ts2 = now - 45_000;
    const ts3 = now;
    timeseriesBody = {
      pm10: [
        { ts: ts1, value: 345 },
        { ts: ts2, value: 350 },
        { ts: ts3, value: 355 },
      ],
    };

    const result = await thingsboardConnector.fetchReadingsSince!(ORIGIN, CREDENTIALS, VENDOR_STATION_ID, now - 120_000, now);

    expect(result.readings).toHaveLength(3);
    expect(result.readings[0].pm10).toBe(345);
    expect(result.readings[1].pm10).toBe(350);
    expect(result.readings[2].pm10).toBe(355);
    expect(result.hasMore).toBe(false);
    expect(result.coveredThroughMs).toBe(now);
    // ترتيب تصاعدي (الأقدم أولاً) — يضمن تحديث last_*_at بشكل صحيح تراكمياً.
    expect(new Date(result.readings[0].observedAtIso as string).getTime()).toBeLessThan(
      new Date(result.readings[2].observedAtIso as string).getTime()
    );
  });

  it('نقاط PM10 وحرارة بنفس الثانية تقريباً → تُجمَّع في قراءة واحدة (نفس اللحظة)، لا قراءتين منفصلتين', async () => {
    const { thingsboardConnector } = await import('./thingsboardConnector');
    const now = Date.now();
    const sameSecond = Math.floor(now / 1000) * 1000;
    timeseriesBody = {
      pm10: [{ ts: sameSecond, value: 300 }],
      temperature: [{ ts: sameSecond + 200, value: 35 }], // نفس الثانية (بعد التقريب لأقرب ثانية)
    };

    const result = await thingsboardConnector.fetchReadingsSince!(ORIGIN, CREDENTIALS, VENDOR_STATION_ID, now - 120_000, now);

    expect(result.readings).toHaveLength(1);
    expect(result.readings[0].pm10).toBe(300);
    expect(result.readings[0].temperatureC).toBe(35);
  });

  it('لا نقاط ضمن النافذة الزمنية → مصفوفة فارغة (لا null، بخلاف fetchLatestReading)، coveredThroughMs=untilMs', async () => {
    const { thingsboardConnector } = await import('./thingsboardConnector');
    const now = Date.now();
    timeseriesBody = {};

    const result = await thingsboardConnector.fetchReadingsSince!(ORIGIN, CREDENTIALS, VENDOR_STATION_ID, now - 120_000, now);

    expect(result.readings).toEqual([]);
    expect(result.hasMore).toBe(false);
    expect(result.coveredThroughMs).toBe(now);
  });

  it('vendorStationId غير UUID → يُرفَض قبل أي طلب شبكة', async () => {
    const { thingsboardConnector } = await import('./thingsboardConnector');
    await expect(
      thingsboardConnector.fetchReadingsSince!(ORIGIN, CREDENTIALS, 'not-a-uuid', Date.now() - 120_000, Date.now())
    ).rejects.toThrow(/UUID/);
  });

  // اختبارات قبول صريحة (طلب المستخدم — تقرير المراجعة الخارجي: "نافذة عشر
  // دقائق وحدود ThingsBoard تقطع البيانات بصمت"): بلوغ MAX_POINTS_PER_KEY
  // (200) يجب أن يُعيد hasMore=true وcoveredThroughMs عند آخر نقطة مؤكَّدة
  // فعلاً، لا untilMs كاملة — بخلاف السلوك السابق الذي كان يقتطع بصمت.
  describe('اقتطاع حدود ThingsBoard يُعلَن صراحةً (hasMore/coveredThroughMs — اختبار قبول صريح)', () => {
    it('مفتاح واحد يبلغ MAX_POINTS_PER_KEY (200 نقطة) → hasMore=true، coveredThroughMs = وقت آخر نقطة مُستلَمة مطروحاً 1ms', async () => {
      const { thingsboardConnector } = await import('./thingsboardConnector');
      const now = Date.now();
      const sinceMs = now - 10 * 60_000;
      // 200 نقطة PM10 بفارق ثانية واحدة بينها بدءاً من sinceMs — تبلغ الحد
      // بالضبط (points.length >= MAX_POINTS_PER_KEY)، رغم أن النافذة
      // المطلوبة (10 دقائق = 600 ثانية) تحتوي فعلياً على نقاط لاحقة لم تُرسَل
      // في هذه الاستجابة (محاكاة قطع ThingsBoard الفعلي عبر limit=200).
      const points = Array.from({ length: 200 }, (_, i) => ({ ts: sinceMs + i * 1000, value: 300 + i }));
      timeseriesBody = { pm10: points };

      const result = await thingsboardConnector.fetchReadingsSince!(ORIGIN, CREDENTIALS, VENDOR_STATION_ID, sinceMs, now);

      expect(result.hasMore).toBe(true);
      const lastPointTs = points[points.length - 1].ts;
      expect(result.coveredThroughMs).toBe(lastPointTs - 1);
      // كل النقاط المُستلَمة فعلياً موجودة في readings — الاقتطاع لا يُسقِط
      // ما وصل فعلاً، فقط يمنع المؤشر من التقدم فوق ما لم يصل.
      expect(result.readings).toHaveLength(200);
    });

    it('لا اقتطاع (أقل من الحد بكثير) → hasMore=false، coveredThroughMs=untilMs كاملة', async () => {
      const { thingsboardConnector } = await import('./thingsboardConnector');
      const now = Date.now();
      const sinceMs = now - 120_000;
      timeseriesBody = { pm10: [{ ts: sinceMs + 10_000, value: 340 }] };

      const result = await thingsboardConnector.fetchReadingsSince!(ORIGIN, CREDENTIALS, VENDOR_STATION_ID, sinceMs, now);

      expect(result.hasMore).toBe(false);
      expect(result.coveredThroughMs).toBe(now);
    });

    it('مفتاحان: أحدهما يبلغ الحد (200) والآخر لا → coveredThroughMs يعتمد المفتاح المقتطَع (الأقدم اقتطاعاً)', async () => {
      const { thingsboardConnector } = await import('./thingsboardConnector');
      const now = Date.now();
      const sinceMs = now - 10 * 60_000;
      const pm10Points = Array.from({ length: 200 }, (_, i) => ({ ts: sinceMs + i * 1000, value: 300 + i }));
      const windPoints = [{ ts: sinceMs + 5_000, value: 12 }];
      timeseriesBody = { pm10: pm10Points, windSpeed: windPoints };

      const result = await thingsboardConnector.fetchReadingsSince!(ORIGIN, CREDENTIALS, VENDOR_STATION_ID, sinceMs, now);

      expect(result.hasMore).toBe(true);
      expect(result.coveredThroughMs).toBe(pm10Points[pm10Points.length - 1].ts - 1);
      // نقطة الرياح (لم تبلغ حدها) تبقى ضمن readings كاملة رغم اقتطاع PM10.
      const windReading = result.readings.find((r) => typeof r.windSpeedKmh === 'number');
      expect(windReading).toBeDefined();
    });
  });

  // اختبار قبول صريح (نفس التقرير — "التجميع على مستوى الثانية قد يستبدل
  // نقطتين داخل الثانية نفسها"): نقطتان لنفس الحقل (pm10) بنفس الثانية يجب
  // أن تُصبحا قراءتين منفصلتين، لا أن تستبدل الثانية الأولى بصمت.
  describe('تصادم التجميع على مستوى الثانية لا يُسقِط نقاطاً (اختبار قبول صريح)', () => {
    it('نقطتا PM10 بفارق 500ms (نفس الثانية بعد التقريب) → قراءتان منفصلتان، لا استبدال', async () => {
      const { thingsboardConnector } = await import('./thingsboardConnector');
      const now = Date.now();
      const sinceMs = now - 120_000;
      const sameSecond = Math.floor(sinceMs / 1000) * 1000;
      timeseriesBody = {
        pm10: [
          { ts: sameSecond, value: 340 },
          { ts: sameSecond + 500, value: 360 },
        ],
      };

      const result = await thingsboardConnector.fetchReadingsSince!(ORIGIN, CREDENTIALS, VENDOR_STATION_ID, sinceMs, now);

      const pm10Values = result.readings.map((r) => r.pm10).filter((v): v is number => typeof v === 'number');
      expect(pm10Values.sort((a, b) => a - b)).toEqual([340, 360]);
    });
  });
});
