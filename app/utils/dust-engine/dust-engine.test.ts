import { describe, it, expect } from 'vitest';
import { classifyCause, computeDviResult } from './engine';
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
    ...overrides,
  } as DustEngineInput;
}

describe('computeDviResult — أولوية قراءة الجهاز > onsite_* > الطقس', () => {
  it('بلا onsite_* وبلا جهاز، يعتمد على عينة الطقس فقط (سلوك قديم بلا تغيير)', () => {
    const r = computeDviResult(baseInput(), sample({ visibilityM: 5000, pm10: 40, pm25: 15, windSpeedKmh: 12, windGustKmh: 18 }));
    expect(r.visibilityKm).toBe(5);
    expect(r.effectiveWindKmh).toBeCloseTo(Math.max(12, 0.85 * 18), 5);
  });

  it('onsiteVisibilityM/onsitePm10/onsitePm25 يتغلبون على الطقس عند غياب الجهاز (سلوك قديم محفوظ)', () => {
    const input = baseInput({ onsiteVisibilityM: 800, onsitePm10: 900, onsitePm25: 300 });
    const r = computeDviResult(input, sample({ visibilityM: 10000, pm10: 20, pm25: 10 }));
    expect(r.visibilityKm).toBeCloseTo(0.8, 5);
    // نفس الحساب من computeDviResult ذاته للتأكد أن pm10 المستخدَم فعلياً هو
    // onsitePm10 (900) لا weather.pm10 (20) — عبر مقارنة بنتيجة مكافئة تُبنى
    // مباشرة من weather.pm10=900 بلا onsite إطلاقاً.
    const equivalent = computeDviResult(baseInput(), sample({ visibilityM: 800, pm10: 900, pm25: 300 }));
    expect(r.score).toBe(equivalent.score);
  });

  it('deviceVisibilityM/devicePm10/devicePm25 يتغلبون على onsite_* المحدد أيضاً (لا 2 مستوى فقط)', () => {
    const input = baseInput({
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

  it('deviceWindSpeedKmh/deviceWindGustKmh يتغلبون على قيم الطقس مباشرة (لا طبقة onsite وسطى للرياح أصلاً)', () => {
    const input = baseInput({ deviceWindSpeedKmh: 40, deviceWindGustKmh: 60 });
    const r = computeDviResult(input, sample({ windSpeedKmh: 10, windGustKmh: 15 }));
    expect(r.effectiveWindKmh).toBeCloseTo(Math.max(40, 0.85 * 60), 5);
  });

  it('حقول الجهاز null/undefined بالكامل تساوي تماماً السلوك القديم (onsite_* فقط)', () => {
    const withDeviceNulls = computeDviResult(
      baseInput({ onsiteVisibilityM: 800, onsitePm10: 900, onsitePm25: 300, deviceVisibilityM: null, devicePm10: null, devicePm25: null }),
      sample()
    );
    const withoutDeviceFields = computeDviResult(
      baseInput({ onsiteVisibilityM: 800, onsitePm10: 900, onsitePm25: 300 }),
      sample()
    );
    expect(withDeviceNulls.score).toBe(withoutDeviceFields.score);
    expect(withDeviceNulls.visibilityKm).toBe(withoutDeviceFields.visibilityKm);
  });
});
