// =============================================================
// DVI Engine — Weather + Air Quality
// المصدر: Open-Meteo (Forecast API + Air Quality API).
// ملاحظة: هذا ليس API المركز الوطني للأرصاد (NCM) الرسمي المذكور في
// المواصفة (Dust AOD 550nm, NCM warning level, sandstorm symbol)،
// لذلك عناصر مثل dustForecastRisk هنا تقديرية ومحدودة الثقة، ويجب
// استبدالها بمصدر NCM الرسمي عند توفره (نقطة تعديل واحدة أدناه).
// =============================================================

import { z } from 'zod';
import { DustWeatherSample, DustHourlySample } from './types';

// =============================================================
// جلب HTTP بموثوقية: timeout + retry + تسجيل الخطأ الفعلي — مراجعة كود
// خبير خارجي: fetch(url) المباشر بلا مهلة زمنية صريحة يعني أن استجابة بطيئة
// جداً من Open-Meteo قد تُعلّق تقييم DVI بالكامل لمدة غير محدودة (حسب مهلة
// Node الافتراضية)، وfailure عابر (503 مؤقت، انقطاع شبكي لحظي) كان يُسقط
// التقييم فوراً لبيانات فارغة بالكامل بدل محاولة ثانية سريعة. كذلك
// `.catch(() => null)` كان يبتلع سبب الفشل الفعلي صامتاً بلا أي تسجيل.
// =============================================================
const FETCH_TIMEOUT_MS = 7000;
const FETCH_RETRY_ATTEMPTS = 2;
const FETCH_RETRY_BACKOFF_MS = 300;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// تخزين مؤقت بالذاكرة لاستجابات Open-Meteo — مفتاحه الـURL الكامل (يشمل
// الإحداثيات والمدى الزمني، فكل تركيبة مختلفة لها مدخل مستقل). ضروري لأن
// دورة تقييم واحدة (evaluateProject) قد تُستدعى بشكل متكرر جداً في نافذة
// زمنية قصيرة (polling الواجهة + cron السحب الخارجي، كلاهما مستقل)، وكل
// استدعاء كان يطلب نفس توقع الطقس تقريباً من الصفر — استنفدنا حصة الطلبات
// المجانية لOpen-Meteo فعلياً (429) بسبب هذا التكرار، ما عطّل حساب DVI
// لبعض الأنشطة بالكامل. توقعات الطقس لا تتغير خلال دقائق قليلة، فتخزين
// مؤقت قصير لا يضحّي بدقة القرار عملياً.
//
// نفس الخريطة تُستخدَم أيضاً كـstale fallback: إذا فشل طلب جديد فعلياً
// (بعد كل محاولات إعادة المحاولة) ووُجد مدخل قديم منتهي الصلاحية لنفس
// الـURL، نُرجعه بدل null. بدون هذا، أي انقطاع عابر (429 مؤقت، بطء شبكي)
// كان يُسقط تقييم النشاط بالكامل (evaluateDustVisibilityWindow يرمي عند
// مصفوفة فارغة) فتختفي كل تفاصيله من الواجهة فوراً، رغم وجود قرار سابق
// صالح معروف كان يمكن الاستمرار به حتى ينجح طلب جديد.
const WEATHER_CACHE_TTL_MS = 5 * 60 * 1000;
const weatherCache = new Map<string, { expiresAt: number; data: unknown }>();

// للاختبارات فقط: كل حالة اختبار تستبدل fetch الـglobal بـmock مختلف
// لنفس تركيبة الإحداثيات/التاريخ الافتراضية، فبدون تصفير هذه الخريطة بين
// الاختبارات (afterEach) يُرجَع أول رد ناجح مخزَّن مسبقاً بدل استدعاء
// الـmock الجديد فعلياً — يكسر عزل الاختبارات عن بعضها.
export function __clearWeatherCacheForTests(): void {
  weatherCache.clear();
}

async function fetchJson(url: string): Promise<unknown | null> {
  const cached = weatherCache.get(url);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  let lastError: unknown;

  for (let attempt = 1; attempt <= FETCH_RETRY_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, {
        cache: 'no-store',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { accept: 'application/json' },
      });

      if (!response.ok) {
        throw new Error(`Weather provider returned ${response.status}: ${url}`);
      }

      const json: unknown = await response.json();
      if (!json || typeof json !== 'object') {
        throw new Error(`Invalid weather response (not an object): ${url}`);
      }

      weatherCache.set(url, { expiresAt: Date.now() + WEATHER_CACHE_TTL_MS, data: json });
      return json;
    } catch (error) {
      lastError = error;
      if (attempt < FETCH_RETRY_ATTEMPTS) {
        await delay(FETCH_RETRY_BACKOFF_MS);
      }
    }
  }

  console.error(`fetchJson failed after ${FETCH_RETRY_ATTEMPTS} attempts: ${url}`, lastError);

  // stale fallback: أفضل من إسقاط تقييم النشاط بالكامل — راجع الشرح أعلى weatherCache.
  if (cached) {
    console.error(`fetchJson: استخدام نسخة قديمة (منتهية الصلاحية) كاحتياط بعد فشل الطلب: ${url}`);
    return cached.data;
  }

  return null;
}

// =============================================================
// Zod schemas — تتحقق من شكل استجابة Open-Meteo قبل استهلاكها، بدل الثقة
// الضمنية بـ any. كل الحقول اختيارية/تقبل null لأن Open-Meteo قد يُغفل حقلاً
// كاملاً (مثال: air-quality تعطي 404/بيانات ناقصة لمناطق نائية)، ونفس سلوك
// ?? null الحالي يبقى قائماً لأي حقل غائب أو غير صالح.
// =============================================================
const nullableNumber = z.number().nullish();
const numberArray = z.array(z.number().nullable()).nullish();

const ForecastCurrentSchema = z.object({
  visibility: nullableNumber,
  weather_code: nullableNumber,
  wind_speed_10m: nullableNumber,
  wind_gusts_10m: nullableNumber,
  wind_direction_10m: nullableNumber,
  relative_humidity_2m: nullableNumber,
  temperature_2m: nullableNumber,
  precipitation: nullableNumber,
}).partial().nullish();

const ForecastHourlySchema = z.object({
  time: z.array(z.string()),
  visibility: numberArray,
  weather_code: numberArray,
  wind_speed_10m: numberArray,
  wind_gusts_10m: numberArray,
  wind_direction_10m: numberArray,
  relative_humidity_2m: numberArray,
  temperature_2m: numberArray,
  // مطر ساعي حقيقي — يُستخدم لحساب نافذة متحركة 24 ساعة (rollingRain24h)
  // بدل daily.precipitation_sum[0] (إجمالي اليوم بأكمله، ماضي+مستقبل، مطبَّق
  // خطأً على كل ساعات النافذة كاملة بصرف النظر عن عدد الأيام). راجع تعليق
  // rollingRain24h أدناه للتفاصيل الكاملة. مطلوبة أصلاً بالطلب (hourly=...,
  // precipitation) لكنها لم تكن تُستخرج من الاستجابة سابقاً.
  precipitation: numberArray,
}).partial({
  visibility: true,
  weather_code: true,
  wind_speed_10m: true,
  wind_gusts_10m: true,
  wind_direction_10m: true,
  relative_humidity_2m: true,
  temperature_2m: true,
  precipitation: true,
});

const ForecastResponseSchema = z.object({
  current: ForecastCurrentSchema,
  hourly: ForecastHourlySchema.nullish(),
  daily: z.object({
    precipitation_sum: numberArray,
  }).partial().nullish(),
}).partial();

const AirQualityCurrentSchema = z.object({
  pm10: nullableNumber,
  pm2_5: nullableNumber,
  dust: nullableNumber,
}).partial().nullish();

const AirQualityHourlySchema = z.object({
  time: z.array(z.string()),
  pm10: numberArray,
  pm2_5: numberArray,
  dust: numberArray,
}).partial({ pm10: true, pm2_5: true, dust: true });

const AirQualityResponseSchema = z.object({
  current: AirQualityCurrentSchema,
  hourly: AirQualityHourlySchema.nullish(),
}).partial();

type ForecastResponse = z.infer<typeof ForecastResponseSchema>;
type AirQualityResponse = z.infer<typeof AirQualityResponseSchema>;

// يجلب ويتحقق من استجابة عبر schema مُعطى — يُرجع null صراحة عند فشل الجلب
// (بعد retries) أو فشل التحقق من الشكل (يُسجَّل بالتفصيل)، بدل تمرير بيانات
// غير موثوقة الشكل (any) لبقية محرك DVI.
async function fetchValidated<T extends z.ZodTypeAny>(
  url: string,
  schema: T
): Promise<z.infer<T> | null> {
  const json = await fetchJson(url);
  if (json === null) return null;

  const result = schema.safeParse(json);
  if (!result.success) {
    console.error(`fetchValidated: schema mismatch for ${url}`, result.error.issues);
    return null;
  }
  return result.data;
}

// يوحّد أي طابع زمني قادم من Open-Meteo (بلا/مع لاحقة منطقة زمنية) إلى ISO
// UTC مطلق قابل للمقارنة كمفتاح Map. ضروري لأن forecast (weather) وair-quality
// نموذجان مستقلان تماماً بجدولي تحديث/تغطية مختلفين — لا ضمان أن مصفوفتي
// hourly.time للاثنين تبدآن بنفس الساعة أو بنفس طول المصفوفة، فالدمج بمؤشر
// i مشترك بينهما (كما كان سابقاً) قد يُزيح PM10 المدموج ساعة كاملة عن طقسه
// الفعلي بصمت تام دون أي خطأ. مراجعة كود خبير خارجي.
function normalizeUtcTime(value: string): string {
  const normalized = /Z$|[+-]\d{2}:\d{2}$/.test(value) ? value : `${value}:00Z`;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid timestamp: ${value}`);
  }
  return date.toISOString();
}

// خطأ مكتشَف ومُصلَح (مراجعة كود خبير خارجي): كان rainfallLast24hMm يُحسَب
// من daily.precipitation_sum[0] فقط — إجمالي هطول اليوم الأول بأكمله (ماضي
// + مستقبل ضمن نفس اليوم)، يُطبَّق حرفياً على كل ساعة بالنافذة كاملة (قد
// تمتد ليومين أو أكثر عبر hoursAhead). هذا يعني: (1) نشاط الساعة 8 صباحاً
// يتأثر بمطر متوقع 8 مساءً لم يهطل بعد — يُخفّض internalDustHazard زوراً
// بناءً على مطر مستقبلي وهمي (dampeningFactor في calculateSiteDustGeneration)،
// (2) نشاط بيومه الثاني يستخدم إجمالي اليوم الأول فقط متجاهلاً هطول يومه
// الفعلي بالكامل. الحل: نافذة متحركة 24 ساعة فعلية محسوبة من hourly.precipitation
// (بيانات ساعية حقيقية، لا تقريب من إجمالي يومي) — لكل ساعة i نجمع فقط
// قيم الساعات ضمن آخر 24 ساعة منتهية بهذه الساعة تحديداً (index وما قبله).
function rollingRain24h(
  index: number,
  times: readonly string[],
  values: readonly (number | null)[]
): number | null {
  const endMs = Date.parse(times[index]);
  let total = 0;
  let found = false;

  for (let i = index; i >= 0; i--) {
    const sampleMs = Date.parse(times[i]);
    if (endMs - sampleMs >= 24 * 60 * 60 * 1000) break;

    const value = values[i];
    if (typeof value === 'number') {
      total += value;
      found = true;
    }
  }

  return found ? total : null;
}

// خطأ مكتشَف ومُصلَح (مراجعة كود خبير خارجي): أكواد WMO 95/96/99 (عواصف رعدية)
// كانت تُصنَّف CLEAR (سماء صافية) بالخطأ — تناقض مباشر مع دلالتها الفعلية.
// THUNDERSTORM تُعامَل معاملة RAIN في القرار (classifyCause/dustForecastRisk):
// عاصفة رعدية تقلل الرؤية وليست إشارة غبار، فتصنيفها الأقرب دلالياً هو نفس
// أثر المطر على القرار، لا فئة مستقلة بمنطق قرار خاص بها.
function mapWeatherCodeToSymbol(code: number | null): DustWeatherSample['weatherSymbol'] {
  if (code === null) return 'UNKNOWN';
  // أكواد WMO المستخدمة في Open-Meteo
  if ([95, 96, 99].includes(code)) return 'THUNDERSTORM';
  if ([45, 48].includes(code)) return 'FOG';
  if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82].includes(code)) return 'RAIN';
  if ([0, 1, 2, 3].includes(code)) return 'CLEAR';
  // Open-Meteo لا يملك كود مخصص رسميًا لـ Sandstorm/Blowing Dust ضمن WMO القياسي؛
  // نعتمد بدلاً منه على تركيز الغبار (dust) من Air Quality API لتصنيف العاصفة الرملية
  // (تُطبَّق لاحقًا فوق هذه النتيجة في fetchDustWeather/fetchDustWeatherHourly).
  // كود WMO غير معروف/غير مغطى أعلاه → UNKNOWN، لا افتراض "صافية" بلا دليل.
  return 'UNKNOWN';
}

export async function fetchDustWeather(latitude: number, longitude: number): Promise<DustWeatherSample> {
  const forecastUrl =
    `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}` +
    `&current=visibility,weather_code,wind_speed_10m,wind_gusts_10m,wind_direction_10m,relative_humidity_2m,temperature_2m,precipitation` +
    `&daily=precipitation_sum&forecast_days=1&wind_speed_unit=kmh&timezone=auto`;

  const airQualityUrl =
    `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${latitude}&longitude=${longitude}` +
    `&current=pm10,pm2_5,dust&timezone=auto`;

  try {
    const [forecastData, airData] = await Promise.all([
      fetchValidated(forecastUrl, ForecastResponseSchema),
      fetchValidated(airQualityUrl, AirQualityResponseSchema),
    ]);

    if (!forecastData) {
      return {
        visibilityM: null,
        weatherCode: null,
        weatherSymbol: 'UNKNOWN',
        windSpeedKmh: null,
        windGustKmh: null,
        windDirectionDeg: null,
        relativeHumidityPercent: null,
        temperatureC: null,
        rainfallLast24hMm: null,
        pm10: null,
        pm25: null,
        dustConcentration: null,
        dataSource: 'none',
        isForecastStale: true,
      };
    }

    const weatherCode = forecastData?.current?.weather_code ?? null;
    const dustConcentration = airData?.current?.dust ?? null;

    let weatherSymbol = mapWeatherCodeToSymbol(weatherCode);
    // تصنيف تقديري للعاصفة الرملية اعتمادًا على تركيز الغبار (بديل مؤقت لرمز NCM الرسمي)
    if (dustConcentration !== null && dustConcentration >= 1000) {
      weatherSymbol = 'SANDSTORM';
    } else if (dustConcentration !== null && dustConcentration >= 350) {
      weatherSymbol = 'BLOWING_DUST';
    }

    return {
      visibilityM: forecastData?.current?.visibility ?? null,
      weatherCode,
      weatherSymbol,
      windSpeedKmh: forecastData?.current?.wind_speed_10m ?? null,
      windGustKmh: forecastData?.current?.wind_gusts_10m ?? null,
      windDirectionDeg: forecastData?.current?.wind_direction_10m ?? null,
      relativeHumidityPercent: forecastData?.current?.relative_humidity_2m ?? null,
      temperatureC: forecastData?.current?.temperature_2m ?? null,
      rainfallLast24hMm: forecastData?.daily?.precipitation_sum?.[0] ?? null,
      pm10: airData?.current?.pm10 ?? null,
      pm25: airData?.current?.pm2_5 ?? null,
      dustConcentration,
      dataSource: 'open-meteo',
      // خطأ مكتشَف ومُصلَح (مراجعة كود خبير خارجي): كانت isForecastStale
      // تُثبَّت false هنا بصرف النظر عن نجاح airData — فإذا نجح الطقس وفشل
      // طلب جودة الهواء (airRes فشل أو airData=null)، كان يظهر PM10/PM2.5/
      // dust كلها null بينما الحقل يوحي أن التوقع "حديث وكامل" بلا أي علم.
      // الآن نُعلِم صراحة أن التوقع غير كامل عندما تغيب بيانات جودة الهواء.
      isForecastStale: airData === null,
    };
  } catch (err) {
    return {
      visibilityM: null,
      weatherCode: null,
      weatherSymbol: 'UNKNOWN',
      windSpeedKmh: null,
      windGustKmh: null,
      windDirectionDeg: null,
      relativeHumidityPercent: null,
      temperatureC: null,
      rainfallLast24hMm: null,
      pm10: null,
      pm25: null,
      dustConcentration: null,
      dataSource: 'none',
      isForecastStale: true,
    };
  }
}

// =============================================================
// توقع ساعي (Hourly) — يُستخدم لتقييم نافذة زمنية كاملة لنشاط له
// وقت بدء ومدة (مثال: نشاط سيستمر 3 ساعات)، بدل الاكتفاء بلحظة الآن فقط.
// نفس فكرة fetchLiveAndHourlyWeather في محرك الرافعات، لكن بمصادر DVI
// (رؤية + هواء) بدل بيانات الرياح فقط.
// =============================================================
export async function fetchDustWeatherHourly(
  latitude: number,
  longitude: number,
  hoursAhead: number = 24,
  // وقت بداية النشاط الفعلي (ISO) — إذا مُرِّر، تُجلب بيانات الطقس لنطاق
  // التاريخ المطابق فعليًا لهذا الوقت (قد يكون يومًا مستقبليًا)، بدل
  // افتراض "اليوم وبكرة" دائمًا مع البدء من "الآن".
  anchorIso?: string
): Promise<DustHourlySample[]> {
  const anchor = anchorIso ? new Date(anchorIso) : new Date();
  const anchorMs = anchor.getTime();
  const rangeEnd = new Date(anchorMs + hoursAhead * 3600000);
  const startDateStr = anchor.toISOString().slice(0, 10);
  const endDateStr = rangeEnd.toISOString().slice(0, 10);

  // timezone=UTC (وليس auto): auto يُرجع أوقاتًا محلية (توقيت الرياض) بلا
  // أي لاحقة منطقة زمنية، فيُفسّرها new Date() لاحقًا كوقت السيرفر المحلي
  // (UTC عادةً) — انزياح +3 ساعات مؤكد. نطلب UTC صراحةً ونضيف :00Z لكل
  // طابع زمني (كما في محركي الحرارة والرافعات) ليتطابق مع anchorMs الذي
  // يأتي دائمًا UTC مطلقًا عبر riyadhLocalToUtcIso.
  const forecastUrl =
    `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}` +
    `&hourly=visibility,weather_code,wind_speed_10m,wind_gusts_10m,wind_direction_10m,relative_humidity_2m,temperature_2m,precipitation` +
    `&daily=precipitation_sum&start_date=${startDateStr}&end_date=${endDateStr}&wind_speed_unit=kmh&timezone=UTC`;

  const airQualityUrl =
    `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${latitude}&longitude=${longitude}` +
    `&hourly=pm10,pm2_5,dust&start_date=${startDateStr}&end_date=${endDateStr}&timezone=UTC`;

  try {
    const [forecastData, airData] = await Promise.all([
      fetchValidated(forecastUrl, ForecastResponseSchema),
      fetchValidated(airQualityUrl, AirQualityResponseSchema),
    ]);

    if (!forecastData || !forecastData.hourly || !Array.isArray(forecastData.hourly.time)) {
      return [];
    }

    // نستخدم hourly.precipitation (مطر ساعي حقيقي) مع rollingRain24h لحساب
    // نافذة متحركة فعلية لكل ساعة على حدة — بدل daily.precipitation_sum[0]
    // القديمة (راجع تعليق rollingRain24h أعلاه للسبب الكامل). الأوقات
    // مُطبَّعة UTC صراحة (normalizeUtcTime) قبل تمريرها لـDate.parse داخل
    // rollingRain24h — نفس سبب normalizeUtcTime في دمج air-quality: السلسلة
    // الخام بلا لاحقة منطقة زمنية قد تُفسَّر كوقت محلي في بعض البيئات.
    const hourlyTimes = forecastData.hourly.time;
    const normalizedHourlyTimes = hourlyTimes.map(normalizeUtcTime);
    const hourlyPrecipitation = forecastData.hourly.precipitation ?? [];

    // خطأ مكتشَف ومُصلَح (مراجعة كود خبير خارجي): forecast (weather) وair-quality
    // نموذجان مستقلان بجدولي تحديث/تغطية مختلفين من Open-Meteo — لا ضمان أن
    // مصفوفتي hourly.time للاثنين تبدآن بنفس الساعة أو بنفس الطول رغم تطابق
    // start_date/end_date/timezone في الطلبين. الدمج بمؤشر i مشترك بينهما
    // (airData.hourly.pm10?.[i] مقابل forecastData.hourly.time[i]) كان يفترض
    // تطابقاً ضمنياً غير مضمون فعلياً؛ أي انزياح بساعة واحدة بين المصفوفتين
    // يُلصق PM10 بساعة طقس خاطئة بصمت تام (قد ينسب عاصفة غبار فعلية لساعة
    // هادئة أو العكس، والقرار — MANDATORY_STOP عند PM10≥340 مثلاً — يعتمد
    // مباشرة على هذا الدمج). نبني الآن Map مفتاحه الوقت المُطبَّع UTC من
    // airData، ونقرأ منه بمفتاح وقت forecast لكل ساعة — تطابق فعلي بالوقت لا
    // افتراض تطابق بالمؤشر. غياب تطابق ساعة معينة يُرجع null صراحة لتلك
    // الساعة (لا قص أعمى بمؤشر مجاور قد يكون خاطئاً أيضاً).
    const airHourly = airData?.hourly ?? null;
    const airByTime = new Map<string, number>();
    for (let i = 0; i < (airHourly?.time?.length ?? 0); i++) {
      airByTime.set(normalizeUtcTime(airHourly!.time[i]), i);
    }

    const nowMs = anchorMs;
    let startIndex = 0;
    for (let i = 0; i < forecastData.hourly.time.length; i++) {
      // نضيف Z لأن الوقت الآن UTC من المصدر لكن بلا لاحقة منطقة زمنية —
      // بدونها تُقارَن كوقت سيرفر محلي مقابل anchorMs (UTC مطلق) فينزاح.
      if (new Date(`${forecastData.hourly.time[i]}:00Z`).getTime() >= nowMs - 3600000) {
        startIndex = i;
        break;
      }
    }
    const endIndex = Math.min(startIndex + hoursAhead, forecastData.hourly.time.length);

    const samples: DustHourlySample[] = [];
    for (let i = startIndex; i < endIndex; i++) {
      const weatherCode = forecastData.hourly.weather_code?.[i] ?? null;
      const time = normalizeUtcTime(forecastData.hourly.time[i]);
      const airIndex = airByTime.get(time);
      const dustConcentration = airIndex === undefined ? null : airHourly!.dust?.[airIndex] ?? null;

      let weatherSymbol = mapWeatherCodeToSymbol(weatherCode);
      if (dustConcentration !== null && dustConcentration >= 1000) {
        weatherSymbol = 'SANDSTORM';
      } else if (dustConcentration !== null && dustConcentration >= 350) {
        weatherSymbol = 'BLOWING_DUST';
      }

      samples.push({
        // Z صريحة: يضمن أن كل مستهلكي sample.time لاحقًا (تصفية النافذة،
        // getDay ليوم العمل، العرض) يفسّرونه UTC لا وقت سيرفر محلي.
        time,
        visibilityM: forecastData.hourly.visibility?.[i] ?? null,
        weatherCode,
        weatherSymbol,
        windSpeedKmh: forecastData.hourly.wind_speed_10m?.[i] ?? null,
        windGustKmh: forecastData.hourly.wind_gusts_10m?.[i] ?? null,
        windDirectionDeg: forecastData.hourly.wind_direction_10m?.[i] ?? null,
        relativeHumidityPercent: forecastData.hourly.relative_humidity_2m?.[i] ?? null,
        temperatureC: forecastData.hourly.temperature_2m?.[i] ?? null,
        rainfallLast24hMm: rollingRain24h(i, normalizedHourlyTimes, hourlyPrecipitation),
        pm10: airIndex === undefined ? null : airHourly!.pm10?.[airIndex] ?? null,
        pm25: airIndex === undefined ? null : airHourly!.pm2_5?.[airIndex] ?? null,
        dustConcentration,
        dataSource: 'open-meteo',
        // خطأ مكتشَف ومُصلَح (مراجعة كود خبير خارجي): كانت isForecastStale
        // تُثبَّت false لكل ساعة بصرف النظر عن توفر جودة الهواء لتلك الساعة
        // تحديداً — فإذا فشل طلب air-quality كاملاً، أو لم توجد ساعة مطابقة
        // لهذه الساعة تحديداً (airIndex===undefined)، يظهر PM10/PM2.5/dust
        // كلها null بينما الحقل يوحي أن التوقع "حديث وكامل" بلا أي علم.
        isForecastStale: airIndex === undefined,
      });
    }

    return samples;
  } catch (err) {
    return [];
  }
}