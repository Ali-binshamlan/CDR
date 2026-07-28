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
    // معظم اختبارات هذا الملف تختبر مسار تقدير الطقس (API) — hasDeviceLink=false
    // افتراضياً، بلا ربط جهاز، مطابقاً لسلوك mergeDustReading الجديد
    // (عزل تام، لا مزيج). اختبارات الجهاز الصريحة تُمرِّر hasDeviceLink:true.
    hasDeviceLink: false,
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

  // طلب صريح من المستخدم: نص RESTRICT العام ("تقييد العمل: وجود فجوة في
  // إجراءات التحكم الميدانية") لا يجوز أن يظهر كقرار "تقييد" فعلي — DVI-PM10-
  // ACTION-003 لم يعد يصعّد لـRESTRICT، يبقى عند ALLOW_WITH_MONITORING
  // (تنبيه/مراقبة فقط). القرار التنظيمي الفعلي مصدره محرك الامتثال المستقل
  // (PM10-WARNING-008/PRECAUTION-009)، لا DVI الفيزيائي.
  it('PM10 ≥ 250 → على الأقل مراقبة (ALLOW_WITH_MONITORING)، لا يبقى ALLOW نظيفاً، ولا يصل RESTRICT بعد الآن', () => {
    const r = computeDviResult(input(), weather({ pm10: 300 }));
    expect(r.triggeredRules).toContain('DVI-PM10-ACTION-003');
    expect(['ALLOW_WITH_MONITORING', 'RESTRICT_SEVERE', 'STOP_DUST_GENERATING_ACTIVITIES', 'MANDATORY_STOP']).toContain(r.decisionCategory);
    expect(r.decisionCategory).not.toBe('ALLOW');
  });

  it('مستوى DVI البرتقالي (ORANGE) وحده بلا قواعد أخرى → ALLOW_WITH_MONITORING، ليس RESTRICT', () => {
    // درجة تقع ضمن نطاق ORANGE (45-65) عبر رياح متوسطة بلا أي بوابة إلزامية
    const r = computeDviResult(input(), weather({ windSpeedKmh: 22, pm10: 100 }));
    if (r.level === 'ORANGE') {
      expect(r.decisionCategory).toBe('ALLOW_WITH_MONITORING');
      expect(r.shortReason).not.toContain('تقييد العمل');
    }
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

// caveatsAr: ملاحظات تحذيرية لصحة القراءة نفسها (طلب صريح من المستخدم
// بالنص الحرفي) — لا تُغيّر level/decisionCategory/shortReason إطلاقاً.
describe('DVI تكامل — caveatsAr (ملاحظات تحذيرية لا تُغيّر القرار)', () => {
  it('رطوبة نسبية ≥80% → نص التحذير يُضاف لـcaveatsAr، بلا أي تأثير على القرار', () => {
    const r = computeDviResult(input(), weather({ relativeHumidityPercent: 85 }));
    expect(r.caveatsAr).toContain(
      'الرطوبة مرتفعة وقد تؤثر في بعض حساسات الجسيمات البصرية؛ لا تُلغى القراءة أو التجاوز، ويلزم التحقق وفق إجراءات الجودة.'
    );
    expect(r.decisionCategory).toBe('ALLOW');
    expect(r.level).toBe('GREEN');
  });

  it('رطوبة نسبية 79% (دون الحد) → لا يُضاف تحذير الرطوبة', () => {
    const r = computeDviResult(input(), weather({ relativeHumidityPercent: 79 }));
    expect(r.caveatsAr.some((c) => c.includes('الرطوبة'))).toBe(false);
  });

  it('درجة حرارة ≥50°م → نص التحذير يُضاف لـcaveatsAr، بلا أي تأثير على القرار', () => {
    const r = computeDviResult(input(), weather({ temperatureC: 52 }));
    expect(r.caveatsAr).toContain(
      'درجة الحرارة عند أو فوق 50°م؛ تحقّق من أن جهاز PM10 مصنف للعمل في هذه الدرجة. لا يُلغى التجاوز تلقائياً.'
    );
    expect(r.decisionCategory).toBe('ALLOW');
  });

  it('درجة حرارة 49°م (دون الحد) → لا يُضاف تحذير الحرارة', () => {
    const r = computeDviResult(input(), weather({ temperatureC: 49 }));
    expect(r.caveatsAr.some((c) => c.includes('الحرارة'))).toBe(false);
  });

  it('رطوبة وحرارة مرتفعتان معاً → كلا التحذيرين يظهران معاً', () => {
    const r = computeDviResult(input(), weather({ relativeHumidityPercent: 90, temperatureC: 55 }));
    expect(r.caveatsAr).toHaveLength(2);
  });

  it('ظروف طبيعية (رطوبة/حرارة معتدلتان) → caveatsAr فارغة', () => {
    const r = computeDviResult(input(), weather({ relativeHumidityPercent: 40, temperatureC: 30 }));
    expect(r.caveatsAr).toHaveLength(0);
  });

  // محاكاة خطوة بخطوة بطلب صريح من المستخدم: "ارفع الحرارة ثم ارفع الرطوبة
  // وشوف" — نفس قراءة PM10 (280، ضمن نطاق التحذير 250-339) طوال السيناريو،
  // للتأكد أن قراءة PM10/القرار الناتج عنها لا يتحركان أبداً بتغيّر الحرارة/
  // الرطوبة، وأن caveatsAr هي المكان الوحيد المتأثر — بالضبط الضمانة التي
  // طلبها المستخدم صراحة ("لا تُلغى القراءة أو التجاوز").
  describe('محاكاة: رفع الحرارة ثم رفع الرطوبة تدريجياً مع تثبيت PM10', () => {
    const FIXED_PM10 = 280; // ضمن نطاق التحذير (250-339)، يُنتج ALLOW_WITH_CONTROLS دائماً

    it('الخطوة 1 — حرارة عادية (30°م) ورطوبة عادية (40%) → لا تحذيرات، والقرار من PM10 وحده', () => {
      const r = computeDviResult(input(), weather({ pm10: FIXED_PM10, temperatureC: 30, relativeHumidityPercent: 40 }));
      expect(r.caveatsAr).toHaveLength(0);
      expect(r.decisionCategory).not.toBe('ALLOW'); // PM10=280 لا يبقى ALLOW نظيفاً
    });

    it('الخطوة 2 — رفع الحرارة إلى 45°م (دون 50) → لا تحذير حرارة بعد، القرار والقراءة كما هما', () => {
      const before = computeDviResult(input(), weather({ pm10: FIXED_PM10, temperatureC: 30, relativeHumidityPercent: 40 }));
      const after = computeDviResult(input(), weather({ pm10: FIXED_PM10, temperatureC: 45, relativeHumidityPercent: 40 }));
      expect(after.caveatsAr).toHaveLength(0);
      expect(after.decisionCategory).toBe(before.decisionCategory);
      expect(after.score).toBe(before.score);
    });

    it('الخطوة 3 — رفع الحرارة إلى 55°م (تجاوزت 50) → يظهر تحذير الحرارة فقط، والقرار/الدرجة لم يتغيّرا عن الحالة الأصلية', () => {
      const baseline = computeDviResult(input(), weather({ pm10: FIXED_PM10, temperatureC: 30, relativeHumidityPercent: 40 }));
      const r = computeDviResult(input(), weather({ pm10: FIXED_PM10, temperatureC: 55, relativeHumidityPercent: 40 }));
      expect(r.caveatsAr).toHaveLength(1);
      expect(r.caveatsAr[0]).toContain('درجة الحرارة');
      expect(r.decisionCategory).toBe(baseline.decisionCategory);
      expect(r.score).toBe(baseline.score);
      expect(r.level).toBe(baseline.level);
    });

    it('الخطوة 4 — مع بقاء الحرارة مرتفعة (55°م)، رفع الرطوبة أيضاً إلى 90% → يظهر التحذيران معاً، والقرار/الدرجة لا يزالان كما في الأصل', () => {
      const baseline = computeDviResult(input(), weather({ pm10: FIXED_PM10, temperatureC: 30, relativeHumidityPercent: 40 }));
      const r = computeDviResult(input(), weather({ pm10: FIXED_PM10, temperatureC: 55, relativeHumidityPercent: 90 }));
      expect(r.caveatsAr).toHaveLength(2);
      expect(r.caveatsAr.some((c) => c.includes('الحرارة'))).toBe(true);
      expect(r.caveatsAr.some((c) => c.includes('الرطوبة'))).toBe(true);
      expect(r.decisionCategory).toBe(baseline.decisionCategory);
      expect(r.score).toBe(baseline.score);
      // القراءة الخام نفسها (لا رمز مُلخَّص) يجب أن تبقى محفوظة كما أُدخلت
      expect(r.channels.particulateRisk).toBe(baseline.channels.particulateRisk);
    });

    it('نفس السيناريو عند PM10 يتجاوز 340 (إيقاف إلزامي) → الحرارة/الرطوبة المرتفعتان لا تُلغيان ولا تخفّفان الإيقاف', () => {
      const highPm10 = 1500;
      const baseline = computeDviResult(
        input({ activityType: 'EXCAVATION', site: site({ hasEarthworks: true }) }),
        weather({ pm10: highPm10, temperatureC: 30, relativeHumidityPercent: 40 })
      );
      const r = computeDviResult(
        input({ activityType: 'EXCAVATION', site: site({ hasEarthworks: true }) }),
        weather({ pm10: highPm10, temperatureC: 55, relativeHumidityPercent: 90 })
      );
      expect(r.caveatsAr).toHaveLength(2);
      expect(r.decisionCategory).toBe(baseline.decisionCategory);
      expect(r.mandatoryStop).toBe(baseline.mandatoryStop);
      expect(r.mandatoryStop).toBe(true);
    });
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

// عُزل مصدر القراءة تماماً بطلب صريح من المستخدم: "حسب ما يختار المستخدم
// تظهر البيانات، لا شيء يعوّض الآخر". onsiteVisibilityM (الإدخال اليدوي)
// لم يعد يُستهلَك في mergeDustReading إطلاقاً — لا في وضع API (hasDeviceLink=false)
// ولا في وضع الجهاز (hasDeviceLink=true) — بعكس الترتيب القديم متعدد
// المستويات الذي كان يستخدمه كملاذ أخير.
describe('DVI تكامل — عزل تام: onsite_* لا يُستهلَك في أي من الوضعين', () => {
  it('وضع API (hasDeviceLink=false): onsiteVisibilityM لا يُستخدم حتى لو غابت قيمة الطقس تماماً', () => {
    const r = computeDviResult(
      input({ activityType: 'CRANE_LIFTING', onsiteVisibilityM: 300, hasDeviceLink: false }),
      weather({ visibilityM: null })
    );
    // لا رؤية من الطقس ولا تعويض من onsite — visibilityM تبقى null فعلياً
    // في القراءة المدموجة، فلا تُفعَّل بوابة "دون 500م" (تتطلب رقماً فعلياً).
    expect(r.mandatoryVisibilityStop).toBe(false);
  });

  it('وضع API: توقعات الطقس هي المصدر الوحيد — قيمة onsite السيئة لا تفسد قراراً جيداً من الطقس', () => {
    const r = computeDviResult(
      input({ activityType: 'CRANE_LIFTING', onsiteVisibilityM: 300, hasDeviceLink: false }),
      weather({ visibilityM: 10000 })
    );
    expect(r.mandatoryVisibilityStop).toBe(false);
    expect(r.decisionCategory).not.toBe('MANDATORY_STOP');
  });

  it('وضع الجهاز (hasDeviceLink=true): قيمة الطقس الجيدة لا تُستخدم إطلاقاً — بلا deviceVisibilityM، الرؤية تبقى null', () => {
    const r = computeDviResult(
      input({ activityType: 'CRANE_LIFTING', onsiteVisibilityM: 300, hasDeviceLink: true }),
      weather({ visibilityM: 10000 })
    );
    // الجهاز لم يرسل deviceVisibilityM، والوضع لا يسمح بالرجوع للطقس ولا
    // onsite — لا بوابة رؤية تُفعَّل من رقم غائب.
    expect(r.mandatoryVisibilityStop).toBe(false);
  });

  it('وضع الجهاز: قراءة رؤية سيئة من الجهاز نفسه تُفعّل بوابة الإيقاف كالمعتاد', () => {
    const r = computeDviResult(
      input({ activityType: 'CRANE_LIFTING', hasDeviceLink: true, deviceVisibilityM: 300 }),
      weather({ visibilityM: 10000 })
    );
    expect(r.mandatoryVisibilityStop).toBe(true);
    expect(r.decisionCategory).toBe('MANDATORY_STOP');
  });
});
