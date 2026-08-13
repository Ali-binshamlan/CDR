import { describe, it, expect, vi, afterEach } from 'vitest';
import { evaluateDustVisibilityWindow } from './engine';
import { __clearWeatherCacheForTests } from './weather';
import type { DustEngineInput } from './types';

// =====================================================================
// خطأ مكتشَف ومُصلَح (طلب صريح من المستخدم — "لو جهاز حقيقي اعرضها حتى لو
// قراءاه قديمه": جهاز مرتبط = دائماً جهاز، لا fallback لطقس إطلاقاً):
// mergeDustReading كانت تسقط لعينة الطقس (Open-Meteo) حتى مع
// hasDeviceLink=true إذا كانت آخر قراءة جهاز أقدم من نافذة "الآن" المسموحة
// (isDeviceApplicableToSample) — فنشاط مرتبط بجهاز لكن قراءته قديمة كان
// يُقيَّم على تقدير طقس بديل (PM10 تقديري ضخم مثلاً) بدل قراءة الجهاز
// الفعلية، رغم أن البانر يعرض "بيانات القراءة الحالية قديمة" ثم البطاقة
// تحته تعرض أرقام API خام بثقة كاملة. الآن: worst (القرار الحي) يُعاد
// حسابه دائماً من الجهاز عندما hasDeviceLink=true وworst يمثّل "الآن" فعلياً
// — بصرف النظر عن قِدم القراءة.
//
// تصحيح إضافي (طلب صريح: "المشروع يبدأ بعد يوم، توقعات ولا قراءة الجهاز؟"):
// فرض قراءة الجهاز يقتصر على نشاط ضمن هامش 30 دقيقة من بدايته المجدولة
// (بدأ فعلاً أو سيبدأ قريباً) — نشاط مستقبلي بعيد (بعد ساعات/يوم) يبقى
// يعرض توقّع الطقس لتلك الساعة تحديداً، لا قراءة الجهاز الحالية (التي لا
// تمثّل شيئاً عن ظروف لحظة مستقبلية بعيدة).
// =====================================================================

function input(overrides: Partial<DustEngineInput> = {}): DustEngineInput {
  return {
    activityType: 'GENERAL_OUTDOOR_WORK',
    latitude: 24.7,
    longitude: 46.7,
    site: {
      hasEarthworks: false,
      internalDirtRoads: false,
      heavyEquipmentMovement: false,
      looseMaterials: false,
      largeExposedArea: false,
      drySurface: false,
      surfaceWet: false,
      wateringAvailable: false,
      stockpilesCovered: false,
      speedLimitApplied: false,
      wheelWashAvailable: false,
      dustScreensAvailable: false,
      fieldMonitoringAvailable: false,
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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  __clearWeatherCacheForTests();
});

describe('evaluateDustVisibilityWindow — جهاز مرتبط بقراءة قديمة جداً يبقى معتمَداً، لا فولباك لطقس', () => {
  // القسم 5.3/18.3 من "دليل الإصلاح الجذري لمنظومة مرقاب" — إصلاح جذري صريح
  // يُقيِّد السلوك الموثَّق أعلاه (تعليق الوصف الكامل لهذا describe): "جهاز
  // مرتبط = دائماً جهاز، لا fallback لطقس" يبقى صحيحاً لعزل المصدر (لا خلط
  // مع طقس)، لكن الآن مقيّداً بحداثة مستقلة لكل حقل حرج (رياح/رؤية) — قراءة
  // جهاز عمرها 5 ساعات بلا وقت رصد حديث لحقل معيّن تُسقِط ذلك الحقل تحديداً
  // إلى null (لا قراءة الطقس، ولا القيمة القديمة موثوقة)، لا تستمر "كما هي"
  // إلى الأبد. PM10 يبقى بمنطقه المستقل الأقدم (computeSustainedPm10Status
  // في dustEvaluation.ts يتعامل مع قِدمه بآلية استمرار/تعليق منفصلة تماماً،
  // لا freshOrNull هنا) — غير مذكور صراحة في هذا التحديث.
  it('نشاط بدأ الآن ومرتبط بجهاز، آخر قراءة جهاز عمرها ساعات وبلا وقت رصد مستقل حديث لرياح/رؤية → worst يُسقِط رياح/رؤية إلى null (القسم 5.3/18.3)، PM10 يبقى كما هو', async () => {
    // نافذة النشاط تبدأ من بداية الساعة الحالية بالضبط (لا "الآن" الدقيق)
    // لضمان وقوعها دائماً ضمن فلتر windowHours (هامش 30 دقيقة) بصرف النظر
    // عن أي دقيقة فعلية من الساعة يُشغَّل فيها الاختبار — تفادياً لعدم
    // استقرار (flakiness) غير متعلق بمنطق الإصلاح نفسه.
    const now = new Date();
    const currentHourStart = new Date(Math.floor(now.getTime() / 3600000) * 3600000);
    const currentHourIso = currentHourStart.toISOString().slice(0, 16);
    const windowStartIso = currentHourStart.toISOString();

    // الطقس التقديري يحمل قيمة PM10 ضخمة مختلفة تماماً عن الجهاز — لضمان
    // أن أي تسرّب لفرع الطقس بدل الجهاز يظهر فوراً في التوقعات.
    const forecastBody = {
      hourly: {
        time: [currentHourIso],
        visibility: [3000],
        weather_code: [0],
        wind_speed_10m: [50],
        wind_gusts_10m: [60],
        wind_direction_10m: [180],
        relative_humidity_2m: [30],
        temperature_2m: [45],
        precipitation: [0],
      },
      daily: { precipitation_sum: [0] },
    };
    const airBody = {
      hourly: { time: [currentHourIso], pm10: [1229.3], pm2_5: [124.8], dust: [900] },
    };
    mockForecastAirResponses(forecastBody, airBody);

    // قراءة جهاز حقيقية، لكن عمرها 5 ساعات (أقدم بكثير من هامش isDeviceApplicableToSample)
    const staleDeviceTime = new Date(now.getTime() - 5 * 3600000).toISOString();

    const result = await evaluateDustVisibilityWindow(
      input({
        hasDeviceLink: true,
        deviceLastReadingAt: staleDeviceTime,
        devicePm10LastReadingAt: staleDeviceTime,
        devicePm10: 45, // قيمة الجهاز الحقيقية (قديمة لكن حقيقية)
        devicePm25: 15,
        deviceWindSpeedKmh: 12,
        deviceWindGustKmh: 18,
        deviceVisibilityM: 9000,
        deviceTemperatureC: 38,
        deviceRelativeHumidityPercent: 20,
      }),
      windowStartIso,
      1
    );

    // القرار الحي يجب أن يعكس قراءة الجهاز لـPM10 (45)، لا تقدير الطقس
    // (1229.3) — PM10 بلا حداثة مستقلة هنا (منطقه منفصل تماماً).
    expect(result.worst.mergedReading.pm10).toBe(45);
    expect(result.worst.mergedReading.sources.pm10).toBe('device');
    // رياح/رؤية: لا وقت رصد مستقل (deviceWindSpeedAt/deviceVisibilityAt)
    // مُمرَّر هنا → freshOrNull يُسقِطهما إلى null (لا الطقس، ولا القيمة
    // القديمة) — القسم 5.3/18.3.
    expect(result.worst.mergedReading.windSpeedKmh).toBeNull();
    expect(result.worst.mergedReading.visibilityM).toBeNull();
    expect(result.worst.mergedReading.sources.windSpeedKmh).toBe('none');
    expect(result.worst.mergedReading.sources.visibilityM).toBe('none');
    // deviceLastReadingAt يبقى القيمة القديمة الفعلية (لعرض تحذير القِدم
    // بالواجهة)، لا يُخفى ولا يُستبدل
    expect(result.worst.mergedReading.deviceLastReadingAt).toBe(staleDeviceTime);
  });

  it('نفس القراءة القديمة لكن مع وقت رصد مستقل حديث لرياح/رؤية → القيمتان تُستخدَمان كما هما (الحداثة لكل حقل مستقلة عن deviceLastReadingAt العام)', async () => {
    const now = new Date();
    const currentHourStart = new Date(Math.floor(now.getTime() / 3600000) * 3600000);
    const currentHourIso = currentHourStart.toISOString().slice(0, 16);
    const windowStartIso = currentHourStart.toISOString();

    const forecastBody = {
      hourly: {
        time: [currentHourIso],
        visibility: [3000],
        weather_code: [0],
        wind_speed_10m: [50],
        wind_gusts_10m: [60],
        wind_direction_10m: [180],
        relative_humidity_2m: [30],
        temperature_2m: [45],
        precipitation: [0],
      },
      daily: { precipitation_sum: [0] },
    };
    const airBody = {
      hourly: { time: [currentHourIso], pm10: [1229.3], pm2_5: [124.8], dust: [900] },
    };
    mockForecastAirResponses(forecastBody, airBody);

    const staleDeviceTime = new Date(now.getTime() - 5 * 3600000).toISOString();
    const freshNowIso = now.toISOString();

    const result = await evaluateDustVisibilityWindow(
      input({
        hasDeviceLink: true,
        deviceLastReadingAt: staleDeviceTime,
        devicePm10LastReadingAt: staleDeviceTime,
        devicePm10: 45,
        devicePm25: 15,
        deviceWindSpeedKmh: 12,
        deviceWindGustKmh: 18,
        deviceWindSpeedAt: freshNowIso,
        deviceWindGustAt: freshNowIso,
        deviceVisibilityM: 9000,
        deviceVisibilityAt: freshNowIso,
        deviceTemperatureC: 38,
        deviceRelativeHumidityPercent: 20,
      }),
      windowStartIso,
      1
    );

    expect(result.worst.mergedReading.windSpeedKmh).toBe(12);
    expect(result.worst.mergedReading.visibilityM).toBe(9000);
    expect(result.worst.mergedReading.sources.windSpeedKmh).toBe('device');
    expect(result.worst.mergedReading.sources.visibilityM).toBe('device');
  });

  // خطأ مكتشَف ومُصلَح إضافي (اكتشاف المستخدم أثناء المراجعة — "قراءة الجهاز
  // تظهر الساعة 9 رغم أن آخر قراءة فعلية للجهاز قبل 10 ساعات"): كان
  // isDeviceApplicableToSample يُطبَّق على *كل* ساعة تمر عبر mergeDustReading،
  // بما فيها ساعات شبكة التوقعات (result.hourly) — فأي ساعة بالشبكة تصادف
  // وقوعها ضمن هامش "قريب من الآن" (30 دقيقة/نفس جرس الساعة) كانت تأخذ
  // قراءة الجهاز الثابتة (حتى لو قديمة جداً) بدل تقدير الطقس الصحيح لتلك
  // الساعة، فتظهر ساعة واحدة "نظيفة" وسط شبكة توقعات كلها متطرفة. الآن
  // treatAsForecast=true يفصل شبكة التوقعات تماماً عن منطق الجهاز — تستخدم
  // تقدير الطقس دائماً لكل ساعة، بصرف النظر عن قربها من "الآن".
  it('ساعة بشبكة التوقعات (hourly) تصادف قربها من "الآن" → تستخدم تقدير الطقس، لا قراءة الجهاز الثابتة', async () => {
    const now = new Date();
    const nowIso = now.toISOString();
    const currentHourIso = new Date(Math.floor(now.getTime() / 3600000) * 3600000).toISOString().slice(0, 16);
    const nextHourIso = new Date(Math.floor(now.getTime() / 3600000) * 3600000 + 3600000)
      .toISOString()
      .slice(0, 16);

    const forecastBody = {
      hourly: {
        time: [currentHourIso, nextHourIso],
        visibility: [3000, 4000],
        weather_code: [0, 0],
        wind_speed_10m: [50, 55],
        wind_gusts_10m: [60, 65],
        wind_direction_10m: [180, 190],
        relative_humidity_2m: [30, 32],
        temperature_2m: [45, 46],
        precipitation: [0, 0],
      },
      daily: { precipitation_sum: [0] },
    };
    const airBody = {
      hourly: { time: [currentHourIso, nextHourIso], pm10: [1229.3, 1221.9], pm2_5: [124.8, 129.9], dust: [900, 950] },
    };
    mockForecastAirResponses(forecastBody, airBody);

    const staleDeviceTime = new Date(now.getTime() - 10 * 3600000).toISOString();

    const result = await evaluateDustVisibilityWindow(
      input({
        hasDeviceLink: true,
        deviceLastReadingAt: staleDeviceTime,
        devicePm10LastReadingAt: staleDeviceTime,
        devicePm10: 150, // قراءة الجهاز القديمة — لا يجوز أن تظهر في shبكة التوقعات
        devicePm25: 60,
      }),
      nowIso,
      2
    );

    // كل ساعة بالشبكة (بما فيها الساعة القريبة من "الآن") يجب أن تعكس تقدير
    // الطقس الحقيقي لتلك الساعة تحديداً، لا قراءة الجهاز القديمة (150) أبداً
    for (const hour of result.hourly) {
      expect(hour.mergedReading.sources.pm10).toBe('weather');
      expect(hour.mergedReading.pm10).not.toBe(150);
    }
  });

  it('نشاط بلا جهاز (hasDeviceLink=false) في نفس الظرف → لا يتأثر بهذا الإصلاح، يبقى بانتظار تقييم (لا استدعاء API)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await evaluateDustVisibilityWindow(
      input({ hasDeviceLink: false }),
      new Date().toISOString(),
      1
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.worst.mergedReading.pm10).toBeNull();
  });

  it('نشاط مرتبط بجهاز لكن يبدأ بعد يوم كامل → worst يعرض توقّع الطقس لتلك الساعة، لا قراءة الجهاز الحالية', async () => {
    const now = new Date();
    // بداية النشاط تُثبَّت على بداية الساعة بالضبط (لا "الآن + يوم" الدقيق)
    // لضمان وقوعها بثبات ضمن فلتر windowHours (هامش 30 دقيقة)، بصرف النظر
    // عن أي دقيقة فعلية من الساعة يُشغَّل فيها الاختبار.
    const activityStart = new Date(Math.floor((now.getTime() + 24 * 3600000) / 3600000) * 3600000);
    const activityHourIso = activityStart.toISOString().slice(0, 16);

    const forecastBody = {
      hourly: {
        time: [activityHourIso],
        visibility: [7000],
        weather_code: [0],
        wind_speed_10m: [20],
        wind_gusts_10m: [25],
        wind_direction_10m: [180],
        relative_humidity_2m: [35],
        temperature_2m: [40],
        precipitation: [0],
      },
      daily: { precipitation_sum: [0] },
    };
    const airBody = {
      hourly: { time: [activityHourIso], pm10: [80], pm2_5: [30], dust: [50] }, // توقّع الطقس الفعلي لساعة النشاط
    };
    mockForecastAirResponses(forecastBody, airBody);

    const result = await evaluateDustVisibilityWindow(
      input({
        hasDeviceLink: true,
        deviceLastReadingAt: now.toISOString(), // قراءة جهاز حديثة "الآن" — لكن غير ذات صلة بنشاط بعد يوم
        devicePm10LastReadingAt: now.toISOString(),
        devicePm10: 999, // قيمة مميّزة جداً — لضمان أنها لا تظهر أبداً هنا
      }),
      activityStart.toISOString(),
      1
    );

    // worst يجب أن يعكس توقّع الطقس لساعة النشاط (80)، لا قراءة الجهاز
    // الحالية (999) رغم حداثتها — لأن النشاط لم يبدأ بعد ولن يبدأ قبل يوم كامل
    expect(result.worst.mergedReading.sources.pm10).toBe('weather');
    expect(result.worst.mergedReading.pm10).toBe(80);
    expect(result.worst.mergedReading.pm10).not.toBe(999);
  });
});
