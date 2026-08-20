import { describe, it, expect } from 'vitest';
import { computeDviResult } from './engine';
import type { DustEngineInput, DustWeatherSample } from './types';

// طلب صريح من المستخدم — "محطة الخلط لا تنتج غبار": محطة خلط خرسانة معفاة
// (isEnclosedDustExempt=true، راجع تعليق DustEngineInput الكامل في types.ts)
// يجب أن تظهر "مسموح — تشغيل اعتيادي" (GREEN) مع طقس ممتاز، بصرف النظر عن
// مضاعف حساسية CONCRETE_POURING (0.55) أو قرب مستقبِل حساس — قبل هذا
// الإصلاح كانت تبقى في نطاق YELLOW/ORANGE ("قابل للتنفيذ مع مراقبة") حتى
// مع طقس مثالي، لأن الاستثناء كان يؤثر فقط على شارة بوابة الرياح المعروضة،
// لا على score/level الأساسي لمحرك DVI نفسه.

const EXCELLENT_WEATHER: DustWeatherSample = {
  visibilityM: 10000,
  weatherCode: 0,
  weatherSymbol: 'CLEAR',
  windSpeedKmh: 12,
  windGustKmh: 15,
  windDirectionDeg: 180,
  relativeHumidityPercent: 21,
  temperatureC: 39,
  rainfallLast24hMm: 0,
  pm10: 20,
  pm25: 10,
  dustConcentration: 0,
  dataSource: 'open-meteo',
  isForecastStale: false,
};

function buildInput(overrides: Partial<DustEngineInput> = {}): DustEngineInput {
  return {
    regulatoryActivity: 'BATCHING_PLANT',
    latitude: 24.7,
    longitude: 46.7,
    site: {
      // خصائص موقع نمطية لمحطة خلط مكشوفة فعلياً بلا إجراءات تحكم — كل
      // عوامل توليد الغبار الأربعة الحالية مفعَّلة حتى يرتفع internalDustHazard
      // بما يكفي فعلياً فوق حد GREEN (25) رغم طقس ممتاز، وهو الفارق الذي يُثبت
      // أن isEnclosedDustExempt يُصفِّره صراحة (لا يعتمد الاختبار على
      // الطقس وحده لإثبات المشكلة).
      hasEarthworks: true,
      internalDirtRoads: true,
      heavyEquipmentMovement: true,
      looseMaterials: true,
      surfaceWet: false,
      // أسوأ حالة جوار ممكنة — مستقبِل حساس (مدرسة/مستشفى) قريب جداً باتجاه الريح
      receptorType: 'HOSPITAL_SCHOOL_NURSERY_RESIDENTIAL_ADJACENT',
      receptorDistance: 'UNDER_50M',
      receptorIsDownwind: true,
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

describe('محطة الخلط المعفاة (isEnclosedDustExempt) — طقس ممتاز يجب أن ينتج GREEN/ALLOW', () => {
  it('بلا الاستثناء: نشاط CONCRETE_POURING بجانب مدرسة يبقى فوق GREEN رغم الطقس الممتاز', () => {
    const result = computeDviResult(buildInput(), EXCELLENT_WEATHER);
    expect(result.level).not.toBe('GREEN');
  });

  it('مع الاستثناء (isEnclosedDustExempt=true): نفس الطقس والجوار ينتج GREEN/ALLOW', () => {
    const result = computeDviResult(buildInput({ isEnclosedDustExempt: true }), EXCELLENT_WEATHER);
    expect(result.level).toBe('GREEN');
    expect(result.decisionCategory).toBe('ALLOW');
  });

  it('الاستثناء لا يُسقِط بوابة فيزيائية إلزامية حقيقية (رؤية حرجة)', () => {
    // CONCRETE_POURING ليس ضمن VISIBILITY_DEPENDENT_ACTIVITIES — رؤية أقل
    // من 0.5كم تفرض RESTRICT_SEVERE (لا MANDATORY_STOP) لهذا النوع تحديداً،
    // نفس سلوك applyMandatoryGates الأصلي بلا أي تغيير من isEnclosedDustExempt.
    // البوابة الفيزيائية (رؤية حرجة) تبقى فعّالة رغم الاستثناء — هذا هو
    // المطلوب اختباره هنا: لا سقوط لـALLOW/GREEN حين الرؤية خطرة فعلياً.
    const criticalVisibility: DustWeatherSample = { ...EXCELLENT_WEATHER, visibilityM: 300 };
    const result = computeDviResult(buildInput({ isEnclosedDustExempt: true }), criticalVisibility);
    expect(result.decisionCategory).toBe('RESTRICT_SEVERE');
    expect(result.level).not.toBe('GREEN');
  });
});
