// =============================================================
// DVI Engine — Weather + Air Quality
// المصدر: Open-Meteo (Forecast API + Air Quality API).
// ملاحظة: هذا ليس API المركز الوطني للأرصاد (NCM) الرسمي المذكور في
// المواصفة (Dust AOD 550nm, NCM warning level, sandstorm symbol)،
// لذلك عناصر مثل dustForecastRisk هنا تقديرية ومحدودة الثقة، ويجب
// استبدالها بمصدر NCM الرسمي عند توفره (نقطة تعديل واحدة أدناه).
// =============================================================

import { DustWeatherSample, DustHourlySample } from './types';

function mapWeatherCodeToSymbol(code: number | null): DustWeatherSample['weatherSymbol'] {
  if (code === null) return 'UNKNOWN';
  // أكواد WMO المستخدمة في Open-Meteo
  if (code === 95 || code === 96 || code === 99) return 'CLEAR'; // عواصف رعدية (لا علاقة بالغبار مباشرة)
  if ([45, 48].includes(code)) return 'FOG';
  if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82].includes(code)) return 'RAIN';
  // Open-Meteo لا يملك كود مخصص رسميًا لـ Sandstorm/Blowing Dust ضمن WMO القياسي؛
  // نعتمد بدلاً منه على تركيز الغبار (dust) من Air Quality API لتصنيف العاصفة الرملية.
  return 'CLEAR';
}

export async function fetchDustWeather(latitude: number, longitude: number): Promise<DustWeatherSample> {
  const forecastUrl =
    `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}` +
    `&current=visibility,weather_code,wind_speed_10m,wind_gusts_10m,wind_direction_10m,relative_humidity_2m,precipitation` +
    `&daily=precipitation_sum&forecast_days=1&wind_speed_unit=kmh&timezone=auto`;

  const airQualityUrl =
    `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${latitude}&longitude=${longitude}` +
    `&current=pm10,pm2_5,dust&timezone=auto`;

  try {
    const [forecastRes, airRes] = await Promise.all([
      fetch(forecastUrl).catch(() => null),
      fetch(airQualityUrl).catch(() => null),
    ]);

    const forecastData = forecastRes && forecastRes.ok ? await forecastRes.json() : null;
    const airData = airRes && airRes.ok ? await airRes.json() : null;

    if (!forecastData) {
      return {
        visibilityM: null,
        weatherCode: null,
        weatherSymbol: 'UNKNOWN',
        windSpeedKmh: null,
        windGustKmh: null,
        windDirectionDeg: null,
        relativeHumidityPercent: null,
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
      rainfallLast24hMm: forecastData?.daily?.precipitation_sum?.[0] ?? null,
      pm10: airData?.current?.pm10 ?? null,
      pm25: airData?.current?.pm2_5 ?? null,
      dustConcentration,
      dataSource: 'open-meteo',
      isForecastStale: false,
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
    `&hourly=visibility,weather_code,wind_speed_10m,wind_gusts_10m,wind_direction_10m,relative_humidity_2m,precipitation` +
    `&daily=precipitation_sum&start_date=${startDateStr}&end_date=${endDateStr}&wind_speed_unit=kmh&timezone=UTC`;

  const airQualityUrl =
    `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${latitude}&longitude=${longitude}` +
    `&hourly=pm10,pm2_5,dust&start_date=${startDateStr}&end_date=${endDateStr}&timezone=UTC`;

  try {
    const [forecastRes, airRes] = await Promise.all([
      fetch(forecastUrl).catch(() => null),
      fetch(airQualityUrl).catch(() => null),
    ]);

    const forecastData = forecastRes && forecastRes.ok ? await forecastRes.json() : null;
    const airData = airRes && airRes.ok ? await airRes.json() : null;

    if (!forecastData || !forecastData.hourly || !Array.isArray(forecastData.hourly.time)) {
      return [];
    }

    // تقريب معقول: نستخدم مجموع أمطار اليوم كمؤشر تخميد للغبار طوال ساعات
    // ذلك اليوم، بدل نافذة متحركة دقيقة لكل ساعة (غير متوفرة من المصدر).
    const rainfallToday = forecastData?.daily?.precipitation_sum?.[0] ?? null;

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
      const dustConcentration = airData?.hourly?.dust?.[i] ?? null;

      let weatherSymbol = mapWeatherCodeToSymbol(weatherCode);
      if (dustConcentration !== null && dustConcentration >= 1000) {
        weatherSymbol = 'SANDSTORM';
      } else if (dustConcentration !== null && dustConcentration >= 350) {
        weatherSymbol = 'BLOWING_DUST';
      }

      samples.push({
        // Z صريحة: يضمن أن كل مستهلكي sample.time لاحقًا (تصفية النافذة،
        // getDay ليوم العمل، العرض) يفسّرونه UTC لا وقت سيرفر محلي.
        time: `${forecastData.hourly.time[i]}:00Z`,
        visibilityM: forecastData.hourly.visibility?.[i] ?? null,
        weatherCode,
        weatherSymbol,
        windSpeedKmh: forecastData.hourly.wind_speed_10m?.[i] ?? null,
        windGustKmh: forecastData.hourly.wind_gusts_10m?.[i] ?? null,
        windDirectionDeg: forecastData.hourly.wind_direction_10m?.[i] ?? null,
        relativeHumidityPercent: forecastData.hourly.relative_humidity_2m?.[i] ?? null,
        rainfallLast24hMm: rainfallToday,
        pm10: airData?.hourly?.pm10?.[i] ?? null,
        pm25: airData?.hourly?.pm2_5?.[i] ?? null,
        dustConcentration,
        dataSource: 'open-meteo',
        isForecastStale: false,
      });
    }

    return samples;
  } catch (err) {
    return [];
  }
}