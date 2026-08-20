import { describe, it, expect } from 'vitest';
import { computeDviResult } from './engine';
import type { DustEngineInput, DustSiteInputs, DustWeatherSample } from './types';

// =====================================================================
// طلب مستخدم صريح: largeExposedArea/drySurface (كانتا 10%+10% من وزن
// siteDustGenerationRisk) حُذفتا نهائياً — خصائص موقع فيزيائية بحتة (مساحة
// كبيرة/سطح جاف) لا علاقة لها بنوع النشاط منطقياً، بخلاف hasEarthworks/
// internalDirtRoads/heavyEquipmentMovement/looseMaterials (كل واحد منها
// تعريفه هو طبيعة نشاط تنظيمي محدد بالضبط). الوزن (20% مجتمعة) أُعيد توزيعه
// نسبياً على الأربعة الباقية (×1.25 لكل وزن أصلي):
//   hasEarthworks: 0.25 → 0.3125
//   internalDirtRoads: 0.2 → 0.25
//   heavyEquipmentMovement: 0.2 → 0.25
//   looseMaterials: 0.15 → 0.1875
// (المجموع يبقى 1.0 دائماً). هذه الاختبارات تثبت الأوزان الجديدة مباشرة عبر
// channels.siteDustGenerationRisk (= 100×مجموع الحقول المفعَّلة×أوزانها).
// =====================================================================

function weather(overrides: Partial<DustWeatherSample> = {}): DustWeatherSample {
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

function site(overrides: Partial<DustSiteInputs> = {}): DustSiteInputs {
  return {
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
    ...overrides,
  };
}

function input(overrides: Partial<DustEngineInput> = {}): DustEngineInput {
  return {
    regulatoryActivity: 'IDLE_SURFACE',
    latitude: 24.7,
    longitude: 46.7,
    site: site(),
    onsiteVisibilityM: null,
    onsitePm10: null,
    onsitePm25: null,
    hasDeviceLink: false,
    ...overrides,
  };
}

describe('calculateSiteDustGeneration — الأوزان الأربعة بعد حذف largeExposedArea/drySurface', () => {
  it('كل الحقول false → siteDustGenerationRisk = 0', () => {
    const r = computeDviResult(input(), weather());
    expect(r.channels.siteDustGenerationRisk).toBe(0);
  });

  // القيمة الخام 31.25 (0.3125×100) تُقرَّب لأقرب رقم عشري واحد في channels
  // (Math.round(x*10)/10 في computeDviResult) — 31.3 هي القيمة المتوقَّعة
  // المعروضة فعلياً، لا خطأ تقريب.
  it('hasEarthworks=true وحده → siteDustGenerationRisk = 31.3 (0.3125×100 مقرَّبة)', () => {
    const r = computeDviResult(input({ site: site({ hasEarthworks: true }) }), weather());
    expect(r.channels.siteDustGenerationRisk).toBeCloseTo(31.3, 5);
  });

  it('internalDirtRoads=true وحده → siteDustGenerationRisk = 25 (0.25×100)', () => {
    const r = computeDviResult(input({ site: site({ internalDirtRoads: true }) }), weather());
    expect(r.channels.siteDustGenerationRisk).toBeCloseTo(25, 5);
  });

  it('heavyEquipmentMovement=true وحده → siteDustGenerationRisk = 25 (0.25×100)', () => {
    const r = computeDviResult(input({ site: site({ heavyEquipmentMovement: true }) }), weather());
    expect(r.channels.siteDustGenerationRisk).toBeCloseTo(25, 5);
  });

  it('looseMaterials=true وحده → siteDustGenerationRisk = 18.8 (0.1875×100 مقرَّبة)', () => {
    const r = computeDviResult(input({ site: site({ looseMaterials: true }) }), weather());
    expect(r.channels.siteDustGenerationRisk).toBeCloseTo(18.8, 5);
  });

  it('الأربعة كلها true معاً → siteDustGenerationRisk = 100 (المجموع الكامل)', () => {
    const r = computeDviResult(
      input({
        site: site({
          hasEarthworks: true,
          internalDirtRoads: true,
          heavyEquipmentMovement: true,
          looseMaterials: true,
        }),
      }),
      weather()
    );
    expect(r.channels.siteDustGenerationRisk).toBeCloseTo(100, 5);
  });
});
