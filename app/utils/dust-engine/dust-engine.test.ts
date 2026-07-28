import { describe, it, expect } from 'vitest';
import { classifyCause, computeDviResult, mergeDustReading } from './engine';
import type { DustEngineInput, DustWeatherSample } from './types';

// عيّنة طقس أساسية "صافية" — كل اختبار يعدّل ما يلزم لسبب محدد
function sample(overrides: Partial<DustWeatherSample> = {}): DustWeatherSample {
  return {
    visibilityM: 10000,
    weatherCode: null,
    weatherSymbol: 'CLEAR',
    windSpeedKmh: 10,
    windGustKmh: 15,
    windDirectionDeg: 0,
    relativeHumidityPercent: 40,
    temperatureC: 30,
    rainfallLast24hMm: 0,
    pm10: 20,
    pm25: 10,
    dustConcentration: 10,
    dataSource: 'open-meteo',
    isForecastStale: false,
    ...overrides,
  };
}

describe('classifyCause — تصنيف سبب ضعف الرؤية', () => {
  it('يصنّف عاصفة رملية كـ DUST', () => {
    expect(classifyCause(sample({ weatherSymbol: 'SANDSTORM' }), 20)).toBe('DUST');
  });

  it('يصنّف غباراً متطايراً كـ DUST', () => {
    expect(classifyCause(sample({ weatherSymbol: 'BLOWING_DUST' }), 20)).toBe('DUST');
  });

  it('يصنّف PM10 مرتفعاً جداً (≥150) كـ DUST حتى بلا رمز طقس غباري', () => {
    expect(classifyCause(sample({ weatherSymbol: 'CLEAR' }), 200)).toBe('DUST');
  });

  it('يصنّف الضباب كـ FOG', () => {
    expect(classifyCause(sample({ weatherSymbol: 'FOG' }), 30)).toBe('FOG');
  });

  it('يصنّف رطوبة عالية جداً (≥95%) بلا غبار كـ FOG', () => {
    expect(classifyCause(sample({ weatherSymbol: 'CLEAR', relativeHumidityPercent: 97 }), 20)).toBe('FOG');
  });

  it('يصنّف المطر كـ RAIN_REDUCED_VISIBILITY', () => {
    expect(classifyCause(sample({ weatherSymbol: 'RAIN' }), 20)).toBe('RAIN_REDUCED_VISIBILITY');
  });

  it('يصنّف وجود هطول مطري خلال 24 ساعة كـ RAIN_REDUCED_VISIBILITY', () => {
    expect(classifyCause(sample({ weatherSymbol: 'CLEAR', rainfallLast24hMm: 5 }), 20)).toBe('RAIN_REDUCED_VISIBILITY');
  });

  it('يصنّف اجتماع سببين (غبار + مطر) كـ MIXED', () => {
    expect(classifyCause(sample({ weatherSymbol: 'SANDSTORM', rainfallLast24hMm: 3 }), 200)).toBe('MIXED');
  });

  it('يصنّف طقساً صافياً بلا مؤشرات كـ UNKNOWN', () => {
    expect(classifyCause(sample({ weatherSymbol: 'CLEAR' }), 20)).toBe('UNKNOWN');
  });

  it('رطوبة عالية مع غبار كثيف (pm10≥100) لا تُحسب FOG (الغبار له الأولوية)', () => {
    // fogSignal مشروط بـ pm10 < 100، فمع pm10=200 يبقى DUST فقط لا MIXED
    expect(classifyCause(sample({ weatherSymbol: 'CLEAR', relativeHumidityPercent: 97 }), 200)).toBe('DUST');
  });
});

// -----------------------------------------------------------------------
// computeDviResult — أولوية 3 مستويات: قراءة جهاز حية > onsite_* يدوي >
// تقدير الطقس (Open-Meteo). راجع خطة "ربط أجهزة الرصد بالمشاريع".
// -----------------------------------------------------------------------
function baseInput(overrides: Partial<DustEngineInput> = {}): DustEngineInput {
  return {
    activityType: 'GENERAL_OUTDOOR_WORK',
    latitude: 24.7136,
    longitude: 46.6753,
    site: {
      hasEarthworks: false,
      internalDirtRoads: false,
      heavyEquipmentMovement: false,
      looseMaterials: false,
      largeExposedArea: false,
      drySurface: false,
      surfaceWet: false,
      wateringAvailable: true,
      stockpilesCovered: true,
      speedLimitApplied: true,
      wheelWashAvailable: true,
      dustScreensAvailable: true,
      fieldMonitoringAvailable: true,
      receptorType: 'NONE',
      receptorDistance: 'FAR',
      receptorIsDownwind: false,
      visibleDustPlumeReported: false,
      openConcretePour: false,
    },
    hasDeviceLink: false,
    ...overrides,
  } as DustEngineInput;
}

// عزل تام بطلب صريح من المستخدم: "حسب ما يختار المستخدم تظهر البيانات،
// لا شيء يعوّض الآخر". hasDeviceLink=true → الجهاز حصراً (لا تعويض من
// الطقس أو onsite_* لأي حقل غائب). hasDeviceLink=false → الطقس حصراً (لا
// تعويض من onsite_*). onsite_* لم يعد يُستهلَك في mergeDustReading إطلاقاً.
describe('computeDviResult — عزل تام: جهاز فقط أو طقس فقط، بلا مزيج', () => {
  it('hasDeviceLink=false بلا onsite_*، يعتمد على عينة الطقس فقط (سلوك قديم بلا تغيير)', () => {
    const r = computeDviResult(baseInput({ hasDeviceLink: false }), sample({ visibilityM: 5000, pm10: 40, pm25: 15, windSpeedKmh: 12, windGustKmh: 18 }));
    expect(r.visibilityKm).toBe(5);
    expect(r.effectiveWindKmh).toBeCloseTo(Math.max(12, 0.85 * 18), 5);
  });

  it('hasDeviceLink=false: onsite_* لا يُستخدم إطلاقاً حتى لو كان أدق من الطقس', () => {
    const input = baseInput({ hasDeviceLink: false, onsiteVisibilityM: 800, onsitePm10: 900, onsitePm25: 300 });
    const r = computeDviResult(input, sample({ visibilityM: 10000, pm10: 20, pm25: 10 }));
    expect(r.visibilityKm).toBeCloseTo(10, 5);
    const equivalent = computeDviResult(baseInput({ hasDeviceLink: false }), sample({ visibilityM: 10000, pm10: 20, pm25: 10 }));
    expect(r.score).toBe(equivalent.score);
  });

  it('hasDeviceLink=false: حتى لو غابت قيمة الطقس تماماً (null)، onsite_* لا يعوّضها — تبقى null', () => {
    const input = baseInput({ hasDeviceLink: false, onsiteVisibilityM: 800, onsitePm10: 900, onsitePm25: 300 });
    const r = computeDviResult(input, sample({ visibilityM: null, pm10: null, pm25: null }));
    const equivalent = computeDviResult(baseInput({ hasDeviceLink: false }), sample({ visibilityM: null, pm10: null, pm25: null }));
    expect(r.visibilityKm).toBe(equivalent.visibilityKm);
    expect(r.score).toBe(equivalent.score);
  });

  it('hasDeviceLink=true: كل الحقول من الجهاز حصراً — قيم الطقس/onsite لا تُستهلَك مهما كانت', () => {
    const input = baseInput({
      hasDeviceLink: true,
      onsiteVisibilityM: 800,
      onsitePm10: 900,
      onsitePm25: 300,
      deviceVisibilityM: 400,
      devicePm10: 1500,
      devicePm25: 500,
    });
    const r = computeDviResult(input, sample({ visibilityM: 10000, pm10: 20, pm25: 10 }));
    expect(r.visibilityKm).toBeCloseTo(0.4, 5);
  });

  it('hasDeviceLink=true: deviceWindSpeedKmh/deviceWindGustKmh فقط، بلا أي تعويض من الطقس', () => {
    const input = baseInput({ hasDeviceLink: true, deviceWindSpeedKmh: 40, deviceWindGustKmh: 60 });
    const r = computeDviResult(input, sample({ windSpeedKmh: 10, windGustKmh: 15 }));
    expect(r.effectiveWindKmh).toBeCloseTo(Math.max(40, 0.85 * 60), 5);
  });

  it('hasDeviceLink=true: حقل غائب من الجهاز (deviceWindSpeedKmh=null) يبقى null، لا يسقط لقيمة الطقس', () => {
    const withDevice = computeDviResult(baseInput({ hasDeviceLink: true, deviceWindSpeedKmh: null }), sample({ windSpeedKmh: 10, windGustKmh: 15 }));
    const withoutWeatherAtAll = computeDviResult(baseInput({ hasDeviceLink: true, deviceWindSpeedKmh: null }), sample({ windSpeedKmh: null, windGustKmh: null }));
    // effectiveWindKmh يعتمد فقط على null بصرف النظر عن قيمة weather —
    // النتيجتان يجب أن تتطابقا لأن weather غير مُستهلَك إطلاقاً هنا.
    expect(withDevice.effectiveWindKmh).toBe(withoutWeatherAtAll.effectiveWindKmh);
    expect(withDevice.effectiveWindKmh).toBeNull();
  });

  it('اتجاه الرياح من الجهاز يظهر في mergedReading عند hasDeviceLink=true', () => {
    const withDevice = computeDviResult(baseInput({ hasDeviceLink: true, deviceWindDirectionDeg: 270 }), sample({ windDirectionDeg: 90 }));
    const merged = mergeDustReading(baseInput({ hasDeviceLink: true, deviceWindDirectionDeg: 270 }), sample({ windDirectionDeg: 90 }));
    expect(merged.windDirectionDeg).toBe(270);
    expect(merged.sources.windDirectionDeg).toBe('device');
    // لا تأثير على الدرجة/القرار — لا صيغة في DVI تستهلك الاتجاه.
    const withoutDevice = computeDviResult(baseInput({ hasDeviceLink: false }), sample({ windDirectionDeg: 90 }));
    expect(withDevice.score).not.toBeUndefined();
    expect(withoutDevice.score).not.toBeUndefined();
  });

  it('اتجاه الرياح من الطقس يُستخدم عند hasDeviceLink=false', () => {
    const merged = mergeDustReading(baseInput({ hasDeviceLink: false }), sample({ windDirectionDeg: 90 }));
    expect(merged.windDirectionDeg).toBe(90);
    expect(merged.sources.windDirectionDeg).toBe('weather');
  });

  it('الرطوبة والحرارة من الجهاز فقط عند hasDeviceLink=true — بلا تعويض من الطقس', () => {
    const merged = mergeDustReading(
      baseInput({ hasDeviceLink: true, deviceRelativeHumidityPercent: 85, deviceTemperatureC: 55 }),
      sample({ relativeHumidityPercent: 30, temperatureC: 25 })
    );
    expect(merged.relativeHumidityPercent).toBe(85);
    expect(merged.temperatureC).toBe(55);
    expect(merged.sources.relativeHumidityPercent).toBe('device');
    expect(merged.sources.temperatureC).toBe('device');
  });

  it('الرطوبة والحرارة من الطقس فقط عند hasDeviceLink=false', () => {
    const merged = mergeDustReading(baseInput({ hasDeviceLink: false }), sample({ relativeHumidityPercent: 30, temperatureC: 25 }));
    expect(merged.relativeHumidityPercent).toBe(30);
    expect(merged.temperatureC).toBe(25);
    expect(merged.sources.relativeHumidityPercent).toBe('weather');
    expect(merged.sources.temperatureC).toBe('weather');
  });

  it('hasDeviceLink=true مع حقول جهاز null/undefined بالكامل → كل شيء null، لا سقوط للطقس', () => {
    const withDeviceNulls = computeDviResult(
      baseInput({ hasDeviceLink: true, deviceVisibilityM: null, devicePm10: null, devicePm25: null }),
      sample({ visibilityM: 5000, pm10: 40, pm25: 15 })
    );
    expect(withDeviceNulls.visibilityKm).toBeNull();
  });
});

// خطأ مكتشَف ومُصلَح: كان حساب الثقة (calculateConfidence) يفحص sample
// (عينة الطقس الخام) بدل merged (القراءة الفعلية بعد أولوية device>weather>
// onsite). فحين يوفّر الجهاز كل القياسات وتغيب بيانات الطقس تماماً، كانت
// الثقة تُخصَم زوراً حتى لو التقييم مبني فعلياً على بيانات جهاز كاملة.
describe('computeDviResult — confidenceScore يعتمد على القراءة المدموجة (merged) لا عينة الطقس الخام', () => {
  it('hasDeviceLink=true وكل قياسات الجهاز متوفرة، وعينة الطقس فارغة تماماً → ثقة كاملة (100)، لا خصم', () => {
    const input = baseInput({
      hasDeviceLink: true,
      deviceVisibilityM: 8000,
      deviceWindSpeedKmh: 15,
      deviceWindGustKmh: 20,
      devicePm10: 40,
      devicePm25: 15,
    });
    // عينة طقس فارغة تماماً (كأن API الطقس فشل أو لا يوجد اتصال) — لا يجوز
    // أن تؤثر على الثقة إطلاقاً ما دام الجهاز غطّى كل الحقول المطلوبة.
    const emptyWeather = sample({ visibilityM: null, windSpeedKmh: null, pm10: null, pm25: null, isForecastStale: false });
    const r = computeDviResult(input, emptyWeather);
    expect(r.confidenceScore).toBe(100);
  });

  it('hasDeviceLink=true لكن الجهاز نفسه ينقصه PM10/PM2.5 → خصم فعلي (25) رغم توفر طقس كامل (غير مُستهلَك)', () => {
    const input = baseInput({
      hasDeviceLink: true,
      deviceVisibilityM: 8000,
      deviceWindSpeedKmh: 15,
      devicePm10: null,
      devicePm25: null,
    });
    const fullWeather = sample({ pm10: 999, pm25: 999 }); // طقس كامل لكن غير مُستهلَك (عزل تام)
    const r = computeDviResult(input, fullWeather);
    expect(r.confidenceScore).toBe(75); // 100 - 25 (لا PM10/PM2.5 فعلياً من الجهاز)
  });

  it('hasDeviceLink=false مع طقس فارغ تماماً → خصم فعلي (نفس السلوك القديم بلا تغيير)', () => {
    const input = baseInput({ hasDeviceLink: false });
    const emptyWeather = sample({ visibilityM: null, windSpeedKmh: null, pm10: null, pm25: null });
    const r = computeDviResult(input, emptyWeather);
    expect(r.confidenceScore).toBeLessThan(100);
  });
});

// خطأ مكتشَف ومُصلَح: كان mergeDustReading يستخدم قراءة الجهاز الثابتة
// (input.device*) لأي عينة، بصرف النظر عن وقتها الفعلي — فكل ساعة توقّع
// مستقبلية (evaluateDustVisibilityHourly/WorkDayHourly) لنشاط مرتبط بجهاز
// كانت تُعيد قراءة "الآن" حرفياً، وكأن الجهاز يتنبأ بالمستقبل. sampleTimeIso
// (المعامل الثالث) يفصل عينة "الآن" (ضمن هامش تحمّل) عن عينة مستقبلية
// بعيدة — الأخيرة يجب أن تسقط لعينة الطقس (توقّع حقيقي)، لا الجهاز.
describe('mergeDustReading/computeDviResult — لا يُعاد استخدام قراءة الجهاز الثابتة لساعات مستقبلية بعيدة', () => {
  it('sampleTimeIso قريب من الآن (ضمن 30 دقيقة) → يُستخدَم الجهاز كالمعتاد', () => {
    const input = baseInput({ hasDeviceLink: true, devicePm10: 300, deviceWindSpeedKmh: 15 });
    const nearNowIso = new Date(Date.now() + 5 * 60000).toISOString();
    const merged = mergeDustReading(input, sample({ pm10: 20, windSpeedKmh: 5 }), nearNowIso);
    expect(merged.pm10).toBe(300);
    expect(merged.sources.pm10).toBe('device');
  });

  it('sampleTimeIso بعيد في المستقبل (بعد 12 ساعة) → يسقط لعينة الطقس رغم hasDeviceLink=true', () => {
    const input = baseInput({ hasDeviceLink: true, devicePm10: 300, deviceWindSpeedKmh: 15 });
    const futureIso = new Date(Date.now() + 12 * 3600000).toISOString();
    const merged = mergeDustReading(input, sample({ pm10: 20, windSpeedKmh: 5 }), futureIso);
    expect(merged.pm10).toBe(20);
    expect(merged.sources.pm10).toBe('weather');
    expect(merged.windSpeedKmh).toBe(5);
    expect(merged.sources.windSpeedKmh).toBe('weather');
  });

  it('sampleTimeIso بعيد في الماضي (قبل 12 ساعة) → يسقط لعينة الطقس أيضاً (ليس المستقبل فقط)', () => {
    const input = baseInput({ hasDeviceLink: true, devicePm10: 300 });
    const pastIso = new Date(Date.now() - 12 * 3600000).toISOString();
    const merged = mergeDustReading(input, sample({ pm10: 20 }), pastIso);
    expect(merged.pm10).toBe(20);
    expect(merged.sources.pm10).toBe('weather');
  });

  it('sampleTimeIso غائب تماماً (استدعاء evaluateDustVisibility للحظة الآن) → يُستخدَم الجهاز كالمعتاد (سلوك قديم بلا تغيير)', () => {
    const input = baseInput({ hasDeviceLink: true, devicePm10: 300 });
    const merged = mergeDustReading(input, sample({ pm10: 20 }));
    expect(merged.pm10).toBe(300);
    expect(merged.sources.pm10).toBe('device');
  });

  it('hasDeviceLink=false: sampleTimeIso مستقبلي لا يغيّر شيئاً (الطقس مصدر أصلاً)', () => {
    const input = baseInput({ hasDeviceLink: false });
    const futureIso = new Date(Date.now() + 12 * 3600000).toISOString();
    const merged = mergeDustReading(input, sample({ pm10: 20 }), futureIso);
    expect(merged.pm10).toBe(20);
    expect(merged.sources.pm10).toBe('weather');
  });
});

// caveatsAr يجب أن يعكس القيمة المدموجة فعلياً حسب الوضع الفعال (جهاز أو
// طقس)، لا مزيجاً بينهما.
describe('computeDviResult — caveatsAr يتفاعل مع القراءة المدموجة حسب الوضع الفعال', () => {
  it('hasDeviceLink=true: رطوبة الجهاز مرتفعة (≥80%) → التحذير يظهر رغم رطوبة طقس منخفضة (غير مُستهلَكة)', () => {
    const r = computeDviResult(
      baseInput({ hasDeviceLink: true, deviceRelativeHumidityPercent: 85 }),
      sample({ relativeHumidityPercent: 40 })
    );
    expect(r.caveatsAr.some((c) => c.includes('الرطوبة'))).toBe(true);
  });

  it('hasDeviceLink=true: حرارة الجهاز مرتفعة (≥50°م) → التحذير يظهر رغم حرارة طقس منخفضة (غير مُستهلَكة)', () => {
    const r = computeDviResult(
      baseInput({ hasDeviceLink: true, deviceTemperatureC: 55 }),
      sample({ temperatureC: 25 })
    );
    expect(r.caveatsAr.some((c) => c.includes('الحرارة'))).toBe(true);
  });

  it('hasDeviceLink=false: رطوبة الجهاز المرتفعة (لو وُجدت خطأً) لا تُستهلَك — التحذير من الطقس فقط', () => {
    const r = computeDviResult(
      baseInput({ hasDeviceLink: false, deviceRelativeHumidityPercent: 85 }),
      sample({ relativeHumidityPercent: 40 })
    );
    expect(r.caveatsAr.some((c) => c.includes('الرطوبة'))).toBe(false);
  });
});
