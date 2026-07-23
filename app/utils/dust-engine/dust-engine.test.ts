import { describe, it, expect } from 'vitest';
import { classifyCause } from './engine';
import type { DustWeatherSample } from './types';

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
