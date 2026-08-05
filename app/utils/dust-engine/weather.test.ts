import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchDustWeatherHourly, fetchDustWeather, __clearWeatherCacheForTests } from './weather';

// =====================================================================
// خطأ مكتشَف ومُصلَح (مراجعة كود خبير خارجي): forecast (weather) وair-quality
// نموذجان مستقلان من Open-Meteo — كان الدمج السابق يفترض تطابق مؤشر i
// مشترك بين مصفوفتي hourly.time للاثنين بلا أي تحقق فعلي. هذه الاختبارات
// تحاكي حالة اختلاف بداية السلسلتين (air-quality متأخرة ساعة عن forecast)
// وتتأكد أن PM10/PM2.5/dust يُدمجان بمطابقة الوقت الفعلي، لا بالمؤشر.
// =====================================================================

function mockFetchResponses(forecastBody: unknown, airBody: unknown) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const isAirQuality = url.includes('air-quality-api');
    return {
      ok: true,
      json: async () => (isAirQuality ? airBody : forecastBody),
    } as Response;
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  __clearWeatherCacheForTests();
});

describe('fetchDustWeatherHourly — دمج forecast وair-quality بمطابقة الوقت', () => {
  it('يدمج PM10 بالساعة الصحيحة حتى لو بدأت سلسلة air-quality متأخرة ساعة عن forecast', async () => {
    const forecastBody = {
      hourly: {
        time: ['2026-07-29T12:00', '2026-07-29T13:00', '2026-07-29T14:00'],
        visibility: [10000, 9000, 8000],
        weather_code: [0, 0, 0],
        wind_speed_10m: [10, 12, 14],
        wind_gusts_10m: [15, 17, 19],
        wind_direction_10m: [180, 190, 200],
        relative_humidity_2m: [30, 32, 34],
        temperature_2m: [35, 36, 37],
      },
      daily: { precipitation_sum: [0] },
    };

    // air-quality تبدأ من 13:00 فقط (لا 12:00) — انزياح ساعة واحدة كامل عن forecast
    const airBody = {
      hourly: {
        time: ['2026-07-29T13:00', '2026-07-29T14:00'],
        pm10: [500, 600], // قيم مميزة لساعتي 13:00 و14:00 تحديداً
        pm2_5: [50, 60],
        dust: [100, 200],
      },
    };

    mockFetchResponses(forecastBody, airBody);

    const samples = await fetchDustWeatherHourly(24.7, 46.7, 24, '2026-07-29T12:00:00Z');

    expect(samples).toHaveLength(3);

    // 12:00 forecast: لا توجد ساعة air-quality مطابقة → PM10 يجب أن يكون null
    // (لا قيمة من ساعة مجاورة أخرى بالخطأ — كانت سابقًا تُقرأ [i]=airData[0]=500 خطأً)
    expect(samples[0].time).toBe('2026-07-29T12:00:00.000Z');
    expect(samples[0].pm10).toBeNull();
    expect(samples[0].pm25).toBeNull();
    expect(samples[0].dustConcentration).toBeNull();

    // 13:00 forecast يجب أن يُدمج مع 13:00 air-quality (PM10=500)، لا مع
    // مؤشر [1] الخاطئ في air-quality (الذي كان سيُعطي 600 لو استمر الدمج بالمؤشر)
    expect(samples[1].time).toBe('2026-07-29T13:00:00.000Z');
    expect(samples[1].pm10).toBe(500);
    expect(samples[1].pm25).toBe(50);
    expect(samples[1].dustConcentration).toBe(100);

    // 14:00 forecast يُدمج مع 14:00 air-quality (PM10=600)
    expect(samples[2].time).toBe('2026-07-29T14:00:00.000Z');
    expect(samples[2].pm10).toBe(600);
    expect(samples[2].pm25).toBe(60);
    expect(samples[2].dustConcentration).toBe(200);
  });

  it('يدمج بشكل طبيعي عندما تتطابق سلسلتا الوقت من البداية', async () => {
    const forecastBody = {
      hourly: {
        time: ['2026-07-29T12:00', '2026-07-29T13:00'],
        visibility: [10000, 9000],
        weather_code: [0, 0],
        wind_speed_10m: [10, 12],
        wind_gusts_10m: [15, 17],
        wind_direction_10m: [180, 190],
        relative_humidity_2m: [30, 32],
        temperature_2m: [35, 36],
      },
      daily: { precipitation_sum: [0] },
    };
    const airBody = {
      hourly: {
        time: ['2026-07-29T12:00', '2026-07-29T13:00'],
        pm10: [150, 250],
        pm2_5: [15, 25],
        dust: [10, 20],
      },
    };

    mockFetchResponses(forecastBody, airBody);

    const samples = await fetchDustWeatherHourly(24.7, 46.7, 24, '2026-07-29T12:00:00Z');

    expect(samples[0].pm10).toBe(150);
    expect(samples[1].pm10).toBe(250);
  });
});

// =====================================================================
// خطأ مكتشَف ومُصلَح (مراجعة كود خبير خارجي): أكواد WMO 95/96/99 (عواصف
// رعدية) كانت تُصنَّف CLEAR (سماء صافية) بالخطأ — تناقض مباشر مع دلالتها.
// كذلك أكواد غير معروفة/غير مغطاة كانت تسقط لـCLEAR افتراضياً بدل UNKNOWN.
// =====================================================================
describe('mapWeatherCodeToSymbol (عبر fetchDustWeather) — تصنيف رمز الطقس', () => {
  function weatherWithCode(code: number) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('air-quality-api')) {
          return { ok: true, json: async () => ({ current: { pm10: 10, pm2_5: 5, dust: 5 } }) } as Response;
        }
        return {
          ok: true,
          json: async () => ({ current: { weather_code: code }, daily: { precipitation_sum: [0] } }),
        } as Response;
      })
    );
    return fetchDustWeather(24.7, 46.7);
  }

  it.each([95, 96, 99])('كود WMO %i (عاصفة رعدية) → THUNDERSTORM لا CLEAR', async (code) => {
    const result = await weatherWithCode(code);
    expect(result.weatherSymbol).toBe('THUNDERSTORM');
  });

  it.each([0, 1, 2, 3])('كود WMO %i (سماء صافية/غائمة جزئياً) → CLEAR', async (code) => {
    const result = await weatherWithCode(code);
    expect(result.weatherSymbol).toBe('CLEAR');
  });

  it('كود WMO غير معروف/غير مغطى → UNKNOWN، لا افتراض CLEAR بلا دليل', async () => {
    const result = await weatherWithCode(9999);
    expect(result.weatherSymbol).toBe('UNKNOWN');
  });
});

// =====================================================================
// خطأ مكتشَف ومُصلَح (مراجعة كود خبير خارجي): fetch مباشر بلا timeout/retry
// وبلا أي تحقق من شكل الاستجابة (any) — كان .catch(() => null) يبتلع سبب
// الفشل الفعلي صامتاً، وفشل عابر واحد (503 مؤقت) يُسقط التقييم فوراً بلا
// محاولة ثانية. الاختبارات هنا تتحقق من: (1) استرداد تلقائي بعد فشل أول
// عابر (retry)، (2) عدم رمي استثناء وإرجاع fallback آمن عند فشل شكل
// الاستجابة (Zod schema mismatch)، بدل تمرير بيانات غير موثوقة الشكل.
// =====================================================================
describe('fetchJson/fetchValidated — retry وschema validation', () => {
  const currentWeatherBody = {
    current: {
      visibility: 10000,
      weather_code: 0,
      wind_speed_10m: 10,
      wind_gusts_10m: 15,
      wind_direction_10m: 180,
      relative_humidity_2m: 30,
      temperature_2m: 35,
      precipitation: 0,
    },
    daily: { precipitation_sum: [0] },
  };
  const currentAirBody = { current: { pm10: 120, pm2_5: 40, dust: 50 } };

  it('يسترد تلقائياً (retry) بعد فشل أول عابر لطلب الطقس، بدل إسقاط التقييم فوراً', async () => {
    let forecastCallCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('air-quality-api')) {
          return { ok: true, json: async () => currentAirBody } as Response;
        }
        forecastCallCount++;
        if (forecastCallCount === 1) {
          // فشل أول محاولة (503 مؤقت) — يجب أن تُعاد المحاولة تلقائياً
          return { ok: false, status: 503, json: async () => ({}) } as Response;
        }
        return { ok: true, json: async () => currentWeatherBody } as Response;
      })
    );

    const result = await fetchDustWeather(24.7, 46.7);

    expect(forecastCallCount).toBe(2); // محاولة فاشلة + محاولة ناجحة
    expect(result.windSpeedKmh).toBe(10);
    expect(result.pm10).toBe(120);
    expect(result.isForecastStale).toBe(false);
  });

  it('يرجع بيانات فارغة آمنة بدل استثناء عندما تفشل كل المحاولات', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) } as Response))
    );

    const result = await fetchDustWeather(24.7, 46.7);

    expect(result.dataSource).toBe('none');
    expect(result.isForecastStale).toBe(true);
    expect(result.windSpeedKmh).toBeNull();
  });

  it('يرفض استجابة لا تطابق الشكل المتوقع (Zod) ويرجع fallback آمن بدل تمريرها كما هي', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('air-quality-api')) {
          // pm10 نص بدل رقم — يجب أن يُرفَض بالتحقق ويُعامَل كفشل جلب كامل
          return { ok: true, json: async () => ({ current: { pm10: 'invalid', pm2_5: 40, dust: 50 } }) } as Response;
        }
        return { ok: true, json: async () => currentWeatherBody } as Response;
      })
    );

    const result = await fetchDustWeather(24.7, 46.7);

    // الطقس نجح والتحقق من شكله صحيح، فيبقى متاحاً
    expect(result.windSpeedKmh).toBe(10);
    // air-quality فشل التحقق من شكله بالكامل → يُعامَل كغياب تام لبيانات الهواء
    expect(result.pm10).toBeNull();
    expect(result.isForecastStale).toBe(true);
  });

  it('لا يعلّق الطلب إلى أجل غير مسمى — يُمرَّر AbortSignal مبني على مهلة زمنية', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return { ok: true, json: async () => currentWeatherBody } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    await fetchDustWeather(24.7, 46.7);

    expect(fetchMock).toHaveBeenCalled();
  });
});

// =====================================================================
// خطأ مكتشَف ومُصلَح (مراجعة كود خبير خارجي): rainfallLast24hMm كان يُحسَب
// من daily.precipitation_sum[0] فقط (إجمالي اليوم الأول بأكمله) ويُطبَّق
// حرفياً على كل ساعة بالنافذة كاملة — حتى لو امتدت ليومين، وحتى لو المطر
// اليومي متوقع لاحقاً بنفس اليوم ولم يهطل بعد. الآن نستخدم rollingRain24h
// (نافذة متحركة 24 ساعة فعلية من hourly.precipitation).
// =====================================================================
describe('rainfallLast24hMm — نافذة متحركة 24 ساعة من hourly.precipitation', () => {
  it('مطر متوقع مساءً لا يؤثر على ساعات الصباح المبكرة لنفس اليوم (لا نافذة كاملة 24 ساعة بعد)', async () => {
    const forecastBody = {
      hourly: {
        time: ['2026-07-29T06:00', '2026-07-29T07:00', '2026-07-29T08:00'],
        visibility: [10000, 10000, 10000],
        weather_code: [0, 0, 0],
        wind_speed_10m: [10, 10, 10],
        wind_gusts_10m: [15, 15, 15],
        wind_direction_10m: [180, 180, 180],
        relative_humidity_2m: [30, 30, 30],
        temperature_2m: [35, 35, 35],
        // لا مطر فعلي حتى الساعة 08:00 — الـ20 ملم يقع لاحقاً بنفس اليوم (20:00)
        precipitation: [0, 0, 0],
      },
      daily: { precipitation_sum: [20] }, // إجمالي اليوم يشمل مطراً لم يهطل بعد
    };
    const airBody = { hourly: { time: [], pm10: [], pm2_5: [], dust: [] } };

    mockFetchResponses(forecastBody, airBody);

    const samples = await fetchDustWeatherHourly(24.7, 46.7, 3, '2026-07-29T06:00:00Z');

    // السلوك القديم كان يعطي rainfallLast24hMm=20 (من daily[0]) لكل ساعة هنا
    // رغم أن المطر الفعلي لم يهطل بعد — الآن يجب أن يكون 0 (النافذة المتحركة
    // ترى فقط قيم precipitation الساعية الفعلية حتى هذه اللحظة).
    expect(samples[0].rainfallLast24hMm).toBe(0);
    expect(samples[1].rainfallLast24hMm).toBe(0);
    expect(samples[2].rainfallLast24hMm).toBe(0);
  });

  it('يجمع فقط الساعات ضمن آخر 24 ساعة فعلية، ويتجاهل ساعات أقدم من ذلك', async () => {
    const forecastBody = {
      hourly: {
        // 26 ساعة: أول ساعتين (00:00, 01:00) خارج نافذة 24 ساعة المنتهية
        // بالساعة الأخيرة (01:00 اليوم التالي)
        time: [
          '2026-07-29T00:00', '2026-07-29T01:00', '2026-07-29T02:00', '2026-07-29T03:00',
          '2026-07-29T04:00', '2026-07-29T05:00', '2026-07-29T06:00', '2026-07-29T07:00',
          '2026-07-29T08:00', '2026-07-29T09:00', '2026-07-29T10:00', '2026-07-29T11:00',
          '2026-07-29T12:00', '2026-07-29T13:00', '2026-07-29T14:00', '2026-07-29T15:00',
          '2026-07-29T16:00', '2026-07-29T17:00', '2026-07-29T18:00', '2026-07-29T19:00',
          '2026-07-29T20:00', '2026-07-29T21:00', '2026-07-29T22:00', '2026-07-29T23:00',
          '2026-07-30T00:00', '2026-07-30T01:00',
        ],
        visibility: new Array(26).fill(10000),
        weather_code: new Array(26).fill(0),
        wind_speed_10m: new Array(26).fill(10),
        wind_gusts_10m: new Array(26).fill(15),
        wind_direction_10m: new Array(26).fill(180),
        relative_humidity_2m: new Array(26).fill(30),
        temperature_2m: new Array(26).fill(35),
        // 5ملم بالساعة 00:00 (اليوم الأول، خارج النافذة عند نهاية المصفوفة)
        // و3ملم بالساعة 01:00 (نفس اليوم، خارج النافذة أيضاً) و2ملم بالساعة
        // 02:00 (أول ساعة ضمن النافذة المتحركة لآخر عنصر 01:00 اليوم التالي)
        precipitation: [5, 3, 2, ...new Array(23).fill(0)],
      },
      daily: { precipitation_sum: [10] },
    };
    const airBody = { hourly: { time: [], pm10: [], pm2_5: [], dust: [] } };

    mockFetchResponses(forecastBody, airBody);

    const samples = await fetchDustWeatherHourly(24.7, 46.7, 26, '2026-07-29T00:00:00Z');

    expect(samples).toHaveLength(26);
    // آخر ساعة (2026-07-30T01:00) — نافذة 24 ساعة المنتهية بها تبدأ من
    // 2026-07-29T02:00 (شاملة) فما بعد؛ ساعتا 00:00/01:00 لليوم الأول تقعان
    // خارجها تماماً (فارق ≥24 ساعة)، فقط 2ملم من الساعة 02:00 تدخل ضمنها.
    const lastSample = samples[samples.length - 1];
    expect(lastSample.time).toBe('2026-07-30T01:00:00.000Z');
    expect(lastSample.rainfallLast24hMm).toBe(2);

    // ساعة 03:00 (index=3): نافذتها المتحركة تشمل 00:00..03:00 بالكامل
    // (فارق <24 ساعة) → 5+3+2+0=10
    const hour03 = samples[3];
    expect(hour03.time).toBe('2026-07-29T03:00:00.000Z');
    expect(hour03.rainfallLast24hMm).toBe(10);
  });

  it('يرجع null عندما لا تتوفر بيانات hourly.precipitation إطلاقاً (لا يفترض صفراً)', async () => {
    const forecastBody = {
      hourly: {
        time: ['2026-07-29T06:00'],
        visibility: [10000],
        weather_code: [0],
        wind_speed_10m: [10],
        wind_gusts_10m: [15],
        wind_direction_10m: [180],
        relative_humidity_2m: [30],
        temperature_2m: [35],
        // precipitation غائبة تماماً من الاستجابة
      },
      daily: { precipitation_sum: [0] },
    };
    const airBody = { hourly: { time: [], pm10: [], pm2_5: [], dust: [] } };

    mockFetchResponses(forecastBody, airBody);

    const samples = await fetchDustWeatherHourly(24.7, 46.7, 1, '2026-07-29T06:00:00Z');
    expect(samples[0].rainfallLast24hMm).toBeNull();
  });
});

// =====================================================================
// خطأ تشغيلي مكتشَف — مراجعة كود خبير خارجي: "المسار التشغيلي الحي ما زال
// ينتظر Open-Meteo". fetchDustWeatherHourly(..., liveTimeoutMs) يجب أن يمرر
// المهلة المختصرة فعلياً إلى AbortSignal.timeout المستخدَم في fetch (راجع
// weatherTimeoutMs في engine.ts) — بلا هذا التمرير، evaluateDustVisibilityWindow
// كانت ستحسب isLiveNow بلا أي أثر فعلي على مهلة الشبكة.
// =====================================================================
describe('fetchDustWeatherHourly — تمرير مهلة مختصرة لنشاط حي بجهاز مرتبط', () => {
  it('يستخدم AbortSignal.timeout بالقيمة المُمرَّرة عبر liveTimeoutMs', async () => {
    const abortTimeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    mockFetchResponses(
      { hourly: { time: [], visibility: [], weather_code: [], wind_speed_10m: [], wind_gusts_10m: [], wind_direction_10m: [], relative_humidity_2m: [], temperature_2m: [] }, daily: { precipitation_sum: [] } },
      { hourly: { time: [], pm10: [], pm2_5: [], dust: [] } }
    );

    await fetchDustWeatherHourly(24.7, 46.7, 1, '2026-07-29T06:00:00Z', 3000);

    expect(abortTimeoutSpy).toHaveBeenCalledWith(3000);
  });

  it('يستخدم المهلة الافتراضية الكاملة عند عدم تمرير liveTimeoutMs', async () => {
    const abortTimeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    mockFetchResponses(
      { hourly: { time: [], visibility: [], weather_code: [], wind_speed_10m: [], wind_gusts_10m: [], wind_direction_10m: [], relative_humidity_2m: [], temperature_2m: [] }, daily: { precipitation_sum: [] } },
      { hourly: { time: [], pm10: [], pm2_5: [], dust: [] } }
    );

    await fetchDustWeatherHourly(24.7, 46.7, 1, '2026-07-29T06:00:00Z');

    expect(abortTimeoutSpy).not.toHaveBeenCalledWith(3000);
    expect(abortTimeoutSpy).toHaveBeenCalledWith(7000);
  });
});
