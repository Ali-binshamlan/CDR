import { describe, it, expect } from 'vitest';
import { computeDviResult } from './engine';
import type { DustEngineInput, DustWeatherSample, DustSiteInputs } from './types';

// =====================================================================
// اختبارات تكامل محرك الغبار (DVI) — تُشغّل computeDviResult كاملاً
// (القنوات → الدرجة → البوابات → القرار) بعيّنة طقس اصطناعية دون شبكة.
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
    largeExposedArea: false,
    drySurface: false,
    surfaceWet: false,
    wateringAvailable: true,
    stockpilesCovered: true,
    speedLimitApplied: true,
    wheelWashAvailable: true,
    dustScreensAvailable: true,
    fieldMonitoringAvailable: true,
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
    activityType: 'GENERAL_OUTDOOR_WORK',
    latitude: 24.7,
    longitude: 46.7,
    site: site(),
    onsiteVisibilityM: null,
    onsitePm10: null,
    onsitePm25: null,
    ...overrides,
  };
}

describe('DVI تكامل — بوابات الرؤية الحرجة', () => {
  it('رؤية أقل من 500 متر لنشاط معتمد على الرؤية (رفع بالرافعة) → إيقاف إلزامي', () => {
    const r = computeDviResult(
      input({ activityType: 'CRANE_LIFTING' }),
      weather({ visibilityM: 400, weatherSymbol: 'SANDSTORM' })
    );
    expect(r.decisionCategory).toBe('MANDATORY_STOP');
    expect(r.mandatoryStop).toBe(true);
    expect(r.overridable).toBe(false);
    expect(r.triggeredRules).toContain('DVI-VISIBILITY-MANDATORY-STOP-001');
  });

  it('رؤية أقل من 500 متر لنشاط غير معتمد على الرؤية → تقييد شديد (لا إيقاف إلزامي كامل)', () => {
    const r = computeDviResult(
      input({ activityType: 'CONCRETE_POURING' }),
      weather({ visibilityM: 400, weatherSymbol: 'SANDSTORM' })
    );
    expect(r.decisionCategory).toBe('RESTRICT_SEVERE');
    expect(r.triggeredRules).toContain('DVI-VISIBILITY-MANDATORY-STOP-001');
  });

  it('mandatoryVisibilityStop = true عند رؤية دون 0.5 كم', () => {
    const r = computeDviResult(input(), weather({ visibilityM: 400 }));
    expect(r.mandatoryVisibilityStop).toBe(true);
  });
});

describe('DVI تكامل — بوابات الغبار والجسيمات', () => {
  it('PM10 ≥ 500 مع نشاط مثير للغبار (حفر) → إيقاف الأنشطة المثيرة للغبار', () => {
    const r = computeDviResult(
      input({ activityType: 'EXCAVATION', site: site({ hasEarthworks: true }) }),
      weather({ pm10: 550 })
    );
    expect(r.decisionCategory).toBe('STOP_DUST_GENERATING_ACTIVITIES');
    expect(r.mandatoryStop).toBe(true);
    expect(r.triggeredRules).toContain('DVI-DUST-ACTIVITY-STOP-004');
  });

  it('PM10 ≥ 250 → تقييد على الأقل (لا يبقى مسموحاً بلا مراقبة)', () => {
    const r = computeDviResult(input(), weather({ pm10: 300 }));
    expect(r.triggeredRules).toContain('DVI-PM10-ACTION-003');
    expect(['RESTRICT', 'RESTRICT_SEVERE', 'STOP_DUST_GENERATING_ACTIVITIES', 'MANDATORY_STOP']).toContain(r.decisionCategory);
  });

  it('رياح فعالة عالية جداً (≥55) مع مواد سائبة ونشاط نقل مواد → إيقاف', () => {
    const r = computeDviResult(
      input({ activityType: 'MATERIAL_TRANSPORT', site: site({ looseMaterials: true }) }),
      weather({ windSpeedKmh: 60, windGustKmh: 70 })
    );
    expect(r.triggeredRules).toContain('DVI-WIND-LOOSE-MATERIAL-005');
    expect(r.decisionCategory).toBe('STOP_DUST_GENERATING_ACTIVITIES');
  });
});

describe('DVI تكامل — الحالة الآمنة والقرار الأخضر', () => {
  it('طقس صافٍ + رؤية ممتازة + كل ضوابط التخفيف → أخضر / تشغيل اعتيادي', () => {
    const r = computeDviResult(input(), weather());
    expect(r.decisionCategory).toBe('ALLOW');
    expect(r.level).toBe('GREEN');
    expect(r.mandatoryStop).toBe(false);
  });

  it('shortReason يطابق القرار الفعلي (لا تناقض بين النص والقرار)', () => {
    const stopResult = computeDviResult(
      input({ activityType: 'CRANE_LIFTING' }),
      weather({ visibilityM: 300 })
    );
    // قرار إيقاف → النص يذكر الإيقاف، وليس "بيئة آمنة"
    expect(stopResult.shortReason).not.toContain('بيئة تشغيلية آمنة');

    const safeResult = computeDviResult(input(), weather());
    expect(safeResult.shortReason).toContain('آمنة');
  });
});

describe('DVI تكامل — تصعيد المستقبِلات الحساسة', () => {
  it('قرب مستشفى/سكن باتجاه الرياح مع درجة خطر معتبرة يرفع التقييد', () => {
    const near = computeDviResult(
      input({
        activityType: 'EXCAVATION',
        site: site({
          hasEarthworks: true,
          looseMaterials: true,
          drySurface: true,
          receptorType: 'HOSPITAL_SCHOOL_NURSERY_RESIDENTIAL_ADJACENT',
          receptorDistance: 'UNDER_50M',
          receptorIsDownwind: true,
          wateringAvailable: false,
          stockpilesCovered: false,
        }),
      }),
      weather({ pm10: 180, windSpeedKmh: 25 })
    );
    const far = computeDviResult(
      input({
        activityType: 'EXCAVATION',
        site: site({ hasEarthworks: true, looseMaterials: true, drySurface: true }),
      }),
      weather({ pm10: 180, windSpeedKmh: 25 })
    );
    // القرب من مستقبِل حساس باتجاه الريح يجب ألا يُنتج قراراً أخف من البعيد
    const order = ['ALLOW', 'ALLOW_WITH_MONITORING', 'RESTRICT', 'RESTRICT_SEVERE', 'STOP_DUST_GENERATING_ACTIVITIES', 'MANDATORY_STOP'];
    expect(order.indexOf(near.decisionCategory)).toBeGreaterThanOrEqual(order.indexOf(far.decisionCategory));
  });
});

describe('DVI تكامل — قياس ميداني له الأولوية على توقعات الطقس', () => {
  it('رؤية ميدانية مُدخلة (onsiteVisibilityM) تتجاوز قيمة التوقعات', () => {
    // توقعات تقول رؤية جيدة (10كم) لكن القياس الميداني 300م → يجب أن يسود القياس
    const r = computeDviResult(
      input({ activityType: 'CRANE_LIFTING', onsiteVisibilityM: 300 }),
      weather({ visibilityM: 10000 })
    );
    expect(r.mandatoryVisibilityStop).toBe(true);
    expect(r.decisionCategory).toBe('MANDATORY_STOP');
  });
});
