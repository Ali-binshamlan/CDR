import { describe, it, expect, vi, afterEach } from 'vitest';
import { evaluateDustVisibilityWindow } from './engine';
import { __clearWeatherCacheForTests } from './weather';
import type { DustEngineInput } from './types';

// =====================================================================
// خطأ مكتشَف ومُصلَح (مراجعة كود خبير خارجي — "أسوأ حالة عينة تركيبية لم
// تحدث"): كانت evaluateDustVisibilityWindow تبني windowEval.worst (القرار
// الممثل للنشاط بأكمله في كل الواجهة) من aggregateWorstCaseSample — عينة
// اصطناعية تنتقي أقل رؤية من ساعة، وأعلى PM10 من ساعة أخرى، وأعلى رياح من
// ساعة ثالثة، ثم تُعيد حساب DVI على هذا المزيج الذي لم يحدث فعلياً بأي لحظة
// واحدة. الآن تُختار أسوأ *ساعة فعلية كاملة* واحدة عبر pickWorstActualHour،
// ويُرمى استثناء DATA_UNAVAILABLE بدل السقوط الصامت لأول ساعات خارج النافذة
// عند غياب بيانات مطابقة.
// =====================================================================

function input(overrides: Partial<DustEngineInput> = {}): DustEngineInput {
  return {
    regulatoryActivity: 'IDLE_SURFACE',
    latitude: 24.7,
    longitude: 46.7,
    site: {
      hasEarthworks: false,
      internalDirtRoads: false,
      heavyEquipmentMovement: false,
      looseMaterials: false,
      surfaceWet: false,
      receptorType: 'NONE_NEARBY',
      receptorDistance: 'OVER_500M',
      receptorIsDownwind: false,
      visibleDustPlumeReported: false,
      openConcretePour: false,
    },
    onsiteVisibilityM: null,
    onsitePm10: null,
    onsitePm25: null,
    hasDeviceLink: false,
    ...overrides,
  };
}

function mockForecastAirResponses(forecastBody: unknown, airBody: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const isAirQuality = url.includes('air-quality-api');
      return {
        ok: true,
        json: async () => (isAirQuality ? airBody : forecastBody),
      } as Response;
    })
  );
}

// بيانات محاكاة مبنية على مرساة زمنية مُمرَّرة — windowStartIso/"الآن" يجب
// أن يقعا فعلياً ضمن ساعات الاستجابة المُحاكاة، وإلا يُرمى DATA_UNAVAILABLE
// بغض النظر عن الغرض الفعلي من الاختبار (فحص قيمة timeout، لا محتوى النتيجة).
function buildHourlySamplesAround(anchorIso: string) {
  const anchorHourMs = Math.floor(new Date(anchorIso).getTime() / 3600000) * 3600000;
  const times = [-1, 0, 1, 2, 3].map((h) => new Date(anchorHourMs + h * 3600000).toISOString().slice(0, 16));
  const n = times.length;
  return {
    forecast: {
      hourly: {
        time: times,
        visibility: Array(n).fill(9000),
        weather_code: Array(n).fill(0),
        wind_speed_10m: Array(n).fill(10),
        wind_gusts_10m: Array(n).fill(15),
        wind_direction_10m: Array(n).fill(180),
        relative_humidity_2m: Array(n).fill(30),
        temperature_2m: Array(n).fill(35),
        precipitation: Array(n).fill(0),
      },
      daily: { precipitation_sum: [0] },
    },
    air: {
      hourly: { time: times, pm10: Array(n).fill(50), pm2_5: Array(n).fill(20), dust: Array(n).fill(10) },
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  __clearWeatherCacheForTests();
});

// ثلاث ساعات متتالية تشكّل نافذة نشاط مدتها 3 ساعات — كل قيمها مختلفة عمداً
// حتى نتأكد أن "أسوأ ساعة" تُختار كوحدة كاملة، لا مزيج مُركَّب من ثلاثتها.
const THREE_HOUR_FORECAST = {
  hourly: {
    time: ['2026-07-29T10:00', '2026-07-29T11:00', '2026-07-29T12:00'],
    visibility: [9000, 400, 8000], // أسوأ رؤية عند الساعة 11:00 فقط
    weather_code: [0, 0, 0],
    wind_speed_10m: [10, 12, 45], // أسوأ رياح عند الساعة 12:00 فقط
    wind_gusts_10m: [15, 17, 60],
    wind_direction_10m: [180, 190, 200],
    relative_humidity_2m: [30, 32, 34],
    temperature_2m: [35, 36, 37],
    precipitation: [0, 0, 0],
  },
  daily: { precipitation_sum: [0] },
};
const THREE_HOUR_AIR = {
  hourly: {
    time: ['2026-07-29T10:00', '2026-07-29T11:00', '2026-07-29T12:00'],
    pm10: [50, 60, 500], // أسوأ PM10 عند الساعة 12:00 فقط (نفس ساعة الرياح الشديدة)
    pm2_5: [20, 25, 200],
    dust: [10, 15, 400],
  },
};

describe('evaluateDustVisibilityWindow — worst يجب أن يكون ساعة فعلية واحدة، لا مزيج مُركَّب', () => {
  it('worst.time يطابق ساعة حقيقية واحدة من ضمن ساعات النافذة، لا وقت الساعة الأولى مع قيم من ساعات أخرى', async () => {
    mockForecastAirResponses(THREE_HOUR_FORECAST, THREE_HOUR_AIR);

    // hasDeviceLink=true: هذا الاختبار يفحص منطق اختيار "أسوأ ساعة فعلية"
    // من بيانات Open-Meteo — يتطلب استدعاء API فعلياً، بخلاف نشاط بلا جهاز
    // (يُمنع عنه الاستدعاء كلياً الآن، راجع buildAwaitingEvaluationWindow
    // في engine.ts). طلب صريح من المستخدم — راجع dust-engine-no-device.test.ts
    // لاختبارات مسار "بلا جهاز" المخصصة.
    const result = await evaluateDustVisibilityWindow(input({ hasDeviceLink: true }), '2026-07-29T10:00:00Z', 3);

    // أسوأ ساعة فعلية هنا هي 12:00 (رياح 45 + PM10=500 معاً بنفس اللحظة)
    // — لا 10:00 (وقت أول ساعة كما كان يفعل الكود القديم عبر windowSamples[0])
    expect(result.worst.time).toBe('2026-07-29T12:00:00.000Z');

    // rawWeatherSample يجب أن يطابق تماماً القيم الحقيقية لتلك الساعة الواحدة
    // (12:00): رياح 45 وPM10=500 معاً — لا مزيج (رؤية من 11:00 + رياح من 12:00
    // كما كان سيحدث مع aggregateWorstCaseSample القديمة).
    expect(result.worst.rawWeatherSample.windSpeedKmh).toBe(45);
    expect(result.worst.rawWeatherSample.pm10).toBe(500);
    expect(result.worst.rawWeatherSample.visibilityM).toBe(8000); // رؤية 12:00 نفسها، لا 400 من 11:00

    // يجب أن تكون هذه الساعة فعلياً ضمن الساعات المُعادة في hourly أيضاً —
    // لا عينة منفصلة غير متسقة مع الشبكة الساعية المعروضة للمستخدم.
    const matchingHour = result.hourly.find((h) => h.time === result.worst.time);
    expect(matchingHour).toBeDefined();
    expect(matchingHour?.rawWeatherSample.pm10).toBe(500);
  });

  it('يرمي DATA_UNAVAILABLE بدل التقريب بساعات خارج النافذة عندما لا توجد ساعة مطابقة فعلياً', async () => {
    // نافذة النشاط بعيدة جداً عن الساعات المُرجَعة فعلياً من fetch (فجوة
    // تفوق أي هامش نصف ساعة) — يحاكي حالة يرجع فيها المزود ساعات لا تغطي
    // النافذة المطلوبة رغم أفق الجلب المحسوب لتغطيتها.
    const farForecast = {
      hourly: {
        time: ['2026-07-25T00:00'], // بعيدة تماماً عن نافذة 2026-07-29
        visibility: [10000],
        weather_code: [0],
        wind_speed_10m: [10],
        wind_gusts_10m: [15],
        wind_direction_10m: [180],
        relative_humidity_2m: [30],
        temperature_2m: [35],
        precipitation: [0],
      },
      daily: { precipitation_sum: [0] },
    };
    const farAir = { hourly: { time: ['2026-07-25T00:00'], pm10: [50], pm2_5: [20], dust: [10] } };
    mockForecastAirResponses(farForecast, farAir);

    await expect(
      evaluateDustVisibilityWindow(input({ hasDeviceLink: true }), '2026-07-29T10:00:00Z', 3)
    ).rejects.toThrow('DATA_UNAVAILABLE');
  });

  // خطأ تشغيلي مكتشَف — مراجعة كود خبير خارجي: "المسار التشغيلي الحي ما زال
  // ينتظر Open-Meteo". نشاط حي بجهاز مرتبط لا يحتاج انتظار مهلة الشبكة
  // الكاملة (worst يُعاد بناؤه من الجهاز بصرف النظر عن نتيجة هذا الطلب) —
  // يجب أن يستخدم مهلة مختصرة (3 ثوانٍ) بدل الافتراضية (7 ثوانٍ).

  it('نشاط حي الآن بجهاز مرتبط يستخدم مهلة شبكة مختصرة (3 ثوانٍ)', async () => {
    const nowIso = new Date().toISOString();
    const { forecast, air } = buildHourlySamplesAround(nowIso);
    const abortTimeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    mockForecastAirResponses(forecast, air);

    await evaluateDustVisibilityWindow(input({ hasDeviceLink: true }), nowIso, 3);

    expect(abortTimeoutSpy).toHaveBeenCalledWith(3000);
  });

  it('نشاط توقّعي بعيد (لم يبدأ بعد) يستخدم مهلة الشبكة الكاملة', async () => {
    const farFutureIso = new Date(Date.now() + 5 * 3600000).toISOString();
    const { forecast, air } = buildHourlySamplesAround(farFutureIso);
    const abortTimeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    mockForecastAirResponses(forecast, air);

    await evaluateDustVisibilityWindow(input({ hasDeviceLink: true }), farFutureIso, 3);

    expect(abortTimeoutSpy).not.toHaveBeenCalledWith(3000);
    expect(abortTimeoutSpy).toHaveBeenCalledWith(7000);
  });

  // طلب مستخدم صريح نهائي ("القراءات تبدأ مع بداية النشاط وتقف مع نهاية
  // النشاط — ألغِ هامش الساعتين نهائياً"): نشاط سيبدأ خلال ساعة واحدة (كان
  // "حياً" سابقاً ضمن هامش الساعتين المُلغى) لم يعد يُعامَل حياً الآن —
  // مهلة الشبكة الكاملة الطبيعية (7 ثوانٍ)، لا المختصرة (3 ثوانٍ).
  it('نشاط سيبدأ خلال ساعة واحدة (لم يبدأ بعد بالضبط، بلا هامش) يستخدم مهلة الشبكة الكاملة', async () => {
    const soonIso = new Date(Date.now() + 3600000).toISOString();
    const { forecast, air } = buildHourlySamplesAround(soonIso);
    const abortTimeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    mockForecastAirResponses(forecast, air);

    await evaluateDustVisibilityWindow(input({ hasDeviceLink: true }), soonIso, 3);

    expect(abortTimeoutSpy).not.toHaveBeenCalledWith(3000);
    expect(abortTimeoutSpy).toHaveBeenCalledWith(7000);
  });

  // طلب مستخدم صريح نهائي (حد نهاية جديد لم يكن موجوداً أصلاً: planned_time
  // + duration): نشاط بدأ منذ فترة أطول من مدته المجدولة (انتهى فعلياً) لم
  // يعد يُعامَل حياً — قبل هذا الإصلاح كان يبقى "حياً" إلى الأبد بعد البدء.
  it('نشاط انتهى فعلياً (بدأ قبل مدته المجدولة بالكامل) يستخدم مهلة الشبكة الكاملة، لا المختصرة', async () => {
    const endedStartIso = new Date(Date.now() - 5 * 3600000).toISOString(); // بدأ منذ 5 ساعات
    const { forecast, air } = buildHourlySamplesAround(endedStartIso);
    const abortTimeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    mockForecastAirResponses(forecast, air);

    // مدة النشاط 3 ساعات — انتهى فعلياً قبل ساعتين
    await evaluateDustVisibilityWindow(input({ hasDeviceLink: true }), endedStartIso, 3);

    expect(abortTimeoutSpy).not.toHaveBeenCalledWith(3000);
    expect(abortTimeoutSpy).toHaveBeenCalledWith(7000);
  });
});

// خطأ مكتشَف ومُصلَح (سؤال مستخدم مباشر: "لو النشاط مستمر يومين كل يوم 8
// ساعات، هل الجهاز يوقف قراءته في هذه الفترة؟"): نشاط متعدد الأيام
// (dailyDurationHours أقل من durationHours الإجمالية) كان يُعامَل كفترة
// متصلة واحدة بلا وعي بالفجوة الليلية بين أيام العمل — نفس الخلل الذي
// حلّته isDustProfileWithinDailyWindow (dustEvaluation.ts) في أماكن أخرى.
// isActivityLiveNowDailyAware (دالة داخلية في engine.ts) تحلّه هنا أيضاً.
describe('evaluateDustVisibilityWindow — نشاط متعدد الأيام (dailyDurationHours): الفجوة الليلية ليست "حية"', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // نشاط يبدأ الأحد 08:00 بتوقيت الرياض، يومان بدوام 8 ساعات (duration=16،
  // dailyDurationHours=8)، أيام العمل كل الأسبوع (workDaysList كاملة) —
  // "الآن" مضبوطة على منتصف الليل بين اليومين (الأحد 23:00 بتوقيت الرياض)،
  // خارج نافذة أي من اليومين [08:00-16:00].
  it('منتصف الليل بين يومي العمل (خارج نافذة الدوام لكلا اليومين) → مهلة الشبكة الكاملة (ليس حياً)', async () => {
    vi.useFakeTimers();
    // الأحد 2026-08-09 08:00 بتوقيت الرياض = 05:00Z
    const startIso = '2026-08-09T05:00:00.000Z';
    // نفس اليوم 23:00 بتوقيت الرياض = 20:00Z — بعد نهاية دوام اليوم الأول
    // (08:00-16:00) وقبل بداية دوام اليوم الثاني (الاثنين 08:00) بكثير.
    vi.setSystemTime(new Date('2026-08-09T20:00:00.000Z'));

    const { forecast, air } = buildHourlySamplesAround('2026-08-09T20:00:00.000Z');
    const abortTimeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    mockForecastAirResponses(forecast, air);

    await evaluateDustVisibilityWindow(
      input({
        hasDeviceLink: true,
        dailyDurationHours: 8,
        workDaysList: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'],
      }),
      startIso,
      16
    );

    expect(abortTimeoutSpy).not.toHaveBeenCalledWith(3000);
    expect(abortTimeoutSpy).toHaveBeenCalledWith(7000);
  });

  it('ضمن ساعات دوام اليوم الثاني فعلياً (اليوم التالي 10:00 بتوقيت الرياض) → مهلة مختصرة (حي فعلاً)', async () => {
    vi.useFakeTimers();
    const startIso = '2026-08-09T05:00:00.000Z'; // الأحد 08:00 بتوقيت الرياض
    // الاثنين 2026-08-10 10:00 بتوقيت الرياض = 07:00Z — ضمن دوام اليوم
    // الثاني [08:00-16:00 بتوقيت الرياض] فعلياً.
    vi.setSystemTime(new Date('2026-08-10T07:00:00.000Z'));

    const { forecast, air } = buildHourlySamplesAround('2026-08-10T07:00:00.000Z');
    const abortTimeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    mockForecastAirResponses(forecast, air);

    // الغرض هنا فحص قيمة weatherTimeoutMs (تُحدَّد وتُستهلَك قبل أي محاولة
    // بناء worst) — الاستجابة المُحاكاة (5 ساعات حول الاثنين 07:00Z) لا
    // تغطي كامل نافذة الـ16 ساعة للنشاط (تبدأ الأحد 05:00Z)، فقد يُرمى
    // DATA_UNAVAILABLE لاحقاً في pickWorstActualHour — غير ذي صلة بما
    // نختبره هنا؛ نلتقطه بلا فحص محتواه.
    await evaluateDustVisibilityWindow(
      input({
        hasDeviceLink: true,
        dailyDurationHours: 8,
        workDaysList: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'],
      }),
      startIso,
      16
    ).catch(() => {});

    expect(abortTimeoutSpy).toHaveBeenCalledWith(3000);
  });

  it('بلا dailyDurationHours (undefined) → فشل آمن نحو فترة متصلة واحدة (منتصف الليل يبقى "حياً"، السلوك القديم)', async () => {
    vi.useFakeTimers();
    const startIso = '2026-08-09T05:00:00.000Z';
    vi.setSystemTime(new Date('2026-08-09T20:00:00.000Z')); // نفس منتصف الليل أعلاه

    const { forecast, air } = buildHourlySamplesAround('2026-08-09T20:00:00.000Z');
    const abortTimeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    mockForecastAirResponses(forecast, air);

    await evaluateDustVisibilityWindow(input({ hasDeviceLink: true }), startIso, 16);

    expect(abortTimeoutSpy).toHaveBeenCalledWith(3000);
  });
});
