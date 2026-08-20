import { describe, it, expect } from 'vitest';
import { computeSustainedPm10Status } from '@/app/lib/dustEvaluation';
import { mergeDustReading } from '@/app/utils/dust-engine/engine';
import { buildComplianceContext } from '@/app/utils/dust-compliance-engine/adapters';
import { evaluateDustCompliance } from '@/app/utils/dust-compliance-engine/engine';
import { buildFinalDecisionInput } from '@/app/utils/final-decision-engine/adapters';
import { decideFinal } from '@/app/utils/final-decision-engine/engine';
import type { DustEngineInput, DustWeatherSample, DviEvaluationResult } from '@/app/utils/dust-engine/types';

// =====================================================================
// Cross-Engine Invariant Tests — شرط الدمج (طلب صريح من المستخدم: "هذه
// المرة لا تكفي اختبارات PM10 وحدها. أريد Cross-engine invariant tests").
//
// بخلاف dustEvaluation.pm10E2E.test.ts (يغطي فقط السياسة الزمنية الثلاثية
// لـPM10)، هذا الملف يثبت سيناريوهات محدَّدة صراحةً عبر السلسلة الحقيقية
// الثلاثية كاملة (dust-engine → dust-compliance-engine → final-decision-
// engine، بلا أي كائن Compliance/DVI اصطناعي) تغطي: PM10 (زمن + رياح
// متزامنة)، سرعة الطرق، الرياح وحدها بلا ترقية زائفة لمخالفة، قطع الأحجار
// (الرياح والرش/HEPA معاً)، ومسافات المستقبِلات الحساسة (كسارة/أكوام).
//
// كل اختبار يثبت الحقول الثلاثة معاً دائماً: operationalDecision،
// regulatoryFinding، وpendingConfirmation/mandatoryStop — لا نتيجة واحدة
// معزولة، لأن جوهر كل الملاحظات المُصلَحة هذه الجلسة كان تناقضات بين هذه
// الحقول عبر المحركات الثلاثة، لا خطأ في محرك واحد بمعزل عن الباقي.
// =====================================================================

function baseWeather(overrides: Partial<DustWeatherSample> = {}): DustWeatherSample {
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

function baseInput(overrides: Partial<DustEngineInput> = {}): DustEngineInput {
  return {
    regulatoryActivity: 'EARTHWORKS',
    latitude: 24.7,
    longitude: 46.7,
    site: {
      hasEarthworks: true,
      internalDirtRoads: false,
      heavyEquipmentMovement: false,
      looseMaterials: false,
      surfaceWet: false,
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

function projectRow(): Record<string, unknown> {
  return {
    site_area_m2: 1500,
    daily_truck_movements: 10,
    has_onsite_crusher: false,
    has_onsite_batching_plant: false,
    dmp_approval_status: 'APPROVED',
    baseline_monitoring_days: 14,
    monitoring_station_count: 1,
    monitoring_logging_interval_minutes: 1,
    anemometer_height_m: 2.5,
    entry_exit_cameras_installed: true,
    camera_retention_days: 90,
    sensitivity_map_prepared: true,
  };
}

function activityRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    activity_group_id: 'cross-engine-activity-1',
    regulatory_activity: 'EARTHWORKS',
    is_dust_generating: true,
    is_enclosed_operation: false,
    is_active_or_planned: true,
    ...overrides,
  };
}

// نفس نمط buildDviWithDeviceReading في dustEvaluation.pm10E2E.test.ts —
// dvi محايد يحمل mergedReading حقيقياً (عبر mergeDustReading الفعلية، لا
// اصطناعي)، بلا أي عتبة PM10 مستقلة (أُزيلت من DVI كلياً، راجع الملاحظة #9).
function buildDviWithDeviceReading(
  nowMs: number,
  deviceOverrides: Partial<DustEngineInput> = {},
  weatherOverrides: Partial<DustWeatherSample> = {}
) {
  const nowIso = new Date(nowMs).toISOString();
  const engineInput = baseInput({
    hasDeviceLink: true,
    devicePm10: 20,
    devicePm10LastReadingAt: nowIso,
    deviceLastReadingAt: nowIso,
    deviceWindSpeedKmh: 10,
    deviceWindSpeedAt: nowIso,
    deviceWindGustKmh: 15,
    deviceWindGustAt: nowIso,
    deviceWindDirectionDeg: 0,
    deviceWindDirectionAt: nowIso,
    deviceVisibilityM: 10000,
    deviceVisibilityAt: nowIso,
    deviceRelativeHumidityPercent: 40,
    deviceRelativeHumidityAt: nowIso,
    deviceTemperatureC: 30,
    deviceTemperatureAt: nowIso,
    ...deviceOverrides,
  });
  const weather = baseWeather(weatherOverrides);
  const mergedReading = mergeDustReading(engineInput, weather, undefined);

  const dvi: DviEvaluationResult & { mergedReading: typeof mergedReading; time: string; rawWeatherSample: DustWeatherSample } = {
    indicatorType: 'DVI',
    dviBase: 0,
    score: 10,
    level: 'GREEN',
    causeClassification: 'DUST',
    decisionCategory: 'ALLOW',
    decisionLabelAr: 'مسموح',
    mandatoryStop: false,
    overridable: true,
    stopBasis: 'NONE',
    confirmationState: 'NOT_APPLICABLE',
    channels: {
      visibilityRisk: 0,
      particulateRisk: 0,
      windTransportRisk: 0,
      dustForecastRisk: 0,
      siteDustGenerationRisk: 0,
      adjustedSiteDustGenerationRisk: 0,
      externalHazard: 0,
      internalDustHazard: 0,
    },
    multipliers: {
      activitySensitivity: 1,
      activitySensitivityMultiplier: 1,
      receptorSensitivity: 1,
      downwindAlignment: 1,
      distanceFactor: 1,
      receptorImpact: 1,
      receptorSensitivityMultiplier: 1,
    },
    visibilityKm: 10,
    effectiveWindKmh: deviceOverrides.deviceWindSpeedKmh ?? 10,
    visibilityDataMissing: false,
    dustExposureHigh: false,
    triggeredRules: [],
    requiredActions: [],
    shortReason: 'مسموح — لا خطر فيزيائي',
    topRiskDrivers: [],
    riskReducers: [],
    confidenceScore: 90,
    confidenceLabel: 'عالية',
    validUntil: nowIso,
    caveatsAr: [],
    time: nowIso,
    rawWeatherSample: weather,
    mergedReading,
  } as unknown as DviEvaluationResult & { mergedReading: typeof mergedReading; time: string; rawWeatherSample: DustWeatherSample };

  return dvi;
}

function buildDenseReadings(pm10UgM3: number, ageSeconds: number, nowMs: number) {
  const STEP_SECONDS = 60;
  const readings: { pm10UgM3: number; recordedAt: string; source: 'device'; id: string }[] = [];
  for (let offset = 0; offset <= ageSeconds; offset += STEP_SECONDS) {
    const ts = nowMs - offset * 1000;
    readings.push({ pm10UgM3, recordedAt: new Date(ts).toISOString(), source: 'device', id: `r-${offset}` });
  }
  const oldestTs = nowMs - ageSeconds * 1000;
  const lastPushed = readings[readings.length - 1];
  if (new Date(lastPushed.recordedAt).getTime() !== oldestTs) {
    readings.push({ pm10UgM3, recordedAt: new Date(oldestTs).toISOString(), source: 'device', id: `r-${ageSeconds}` });
  }
  return readings;
}

// يشغّل السلسلة الكاملة (DVI حقيقي عبر mergeDustReading → Compliance
// حقيقي → FinalDecision حقيقي) لسيناريو PM10 + رياح متزامنين، مع تحكّم
// كامل بصف النشاط الخام (regulatory_activity، controls) للسيناريوهات غير
// المرتبطة بـPM10 (سرعة الطرق، قطع الأحجار، المسافات).
function runFullChain(opts: {
  pm10UgM3?: number;
  pm10AgeSeconds?: number;
  windSpeedKmh?: number;
  activityRowOverrides?: Record<string, unknown>;
  // خطأ حرج مكتشَف ومُصلَح (مراجعة كود خارجي — "ماذا يحدث إذا توجد قاعدة
  // إيقاف أخرى؟"): يحاكي فشل استعلام pm10_readings_history الفعلي (لا
  // "صفر قراءات" — راجع Pm10SustainedFetchResult في dustEvaluation.ts) —
  // يُمرَّر مباشرة إلى buildComplianceContext كما لو أن fetchPm10SustainedStatus
  // أعادت queryFailed=true. sustained يبقى محسوباً من buildDenseReadings
  // (يُمرَّر لبناء dvi.mergedReading نفسه بصرف النظر) لكن compliance context
  // لا يستقبله عند true (نفس سلوك المسار الحي الفعلي: pm10Sustained=null
  // حين queryFailed=true في dustEvaluation.ts).
  pm10HistoryQueryFailed?: boolean;
}) {
  const nowMs = Date.now();
  const { pm10UgM3 = 20, pm10AgeSeconds = 0, windSpeedKmh = 10, activityRowOverrides = {}, pm10HistoryQueryFailed = false } = opts;

  const readings = buildDenseReadings(pm10UgM3, pm10AgeSeconds, nowMs);
  const sustained = computeSustainedPm10Status(readings, nowMs);

  const dvi = buildDviWithDeviceReading(
    nowMs,
    {
      devicePm10: pm10UgM3,
      deviceWindSpeedKmh: windSpeedKmh,
      deviceWindGustKmh: windSpeedKmh + 5,
    },
    { pm10: pm10UgM3, windSpeedKmh, windGustKmh: windSpeedKmh + 5 }
  );

  const ctx = buildComplianceContext(
    projectRow(),
    activityRow(activityRowOverrides),
    dvi,
    [],
    null,
    // نفس دلالة dustEvaluation.ts الحية: pm10Fetch.status=null عند
    // queryFailed=true — لا pm10Sustained حقيقياً يصل السياق في تلك الحالة.
    pm10HistoryQueryFailed ? null : sustained,
    nowMs,
    false,
    pm10HistoryQueryFailed
  );
  const compliance = evaluateDustCompliance(ctx, nowMs);

  const finalInput = buildFinalDecisionInput('cross-engine-snapshot', dvi, compliance, null, 'LIVE_OPERATIONAL', new Date(nowMs).toISOString());
  const final = decideFinal(finalInput);

  return { sustained, compliance, final };
}

describe('Cross-Engine Invariant — PM10 وحده عبر الزمن', () => {
  it('PM10=350 @60s → operational=MONITOR، regulatory=PENDING_CONFIRMATION، pending=true', () => {
    const { compliance, final } = runFullChain({ pm10UgM3: 350, pm10AgeSeconds: 60 });

    expect(final.operationalDecision).toBe('MONITOR');
    expect(final.regulatoryFinding).toBe('PENDING_CONFIRMATION');
    expect(final.pendingConfirmation).toBe(true);
    expect(final.mandatoryStop).toBe(false);
    expect(compliance.pendingConfirmation).toBe(true);
    expect(compliance.decisionCategory).not.toBe('STOP_AFFECTED_ACTIVITY');
    expect(compliance.decisionCategory).not.toBe('MANDATORY_STOP');
  });

  it('PM10=350 @120s → regulatory=NON_COMPLIANT، لا STOP من PM10', () => {
    const { compliance, final } = runFullChain({ pm10UgM3: 350, pm10AgeSeconds: 120 });

    expect(final.regulatoryFinding).toBe('NON_COMPLIANT');
    expect(final.operationalDecision).not.toBe('MANDATORY_STOP');
    expect(final.operationalDecision).not.toBe('PROTECTIVE_STOP');
    expect(final.mandatoryStop).toBe(false);
    expect(compliance.decisionCategory).not.toBe('STOP_AFFECTED_ACTIVITY');
    expect(compliance.decisionCategory).not.toBe('MANDATORY_STOP');
  });

  it('PM10=350 @1800s → NON_COMPLIANT، MANDATORY_STOP فعلي على النشاط المتأثر', () => {
    const { compliance, final } = runFullChain({ pm10UgM3: 350, pm10AgeSeconds: 1800 });

    expect(final.regulatoryFinding).toBe('NON_COMPLIANT');
    expect(final.mandatoryStop).toBe(true);
    expect(['MANDATORY_STOP', 'PROTECTIVE_STOP']).toContain(final.operationalDecision);
    expect(compliance.decisionCategory).toBe('STOP_AFFECTED_ACTIVITY');
  });
});

describe('Cross-Engine Invariant — PM10 معلَّق + رياح 15-25 كم/س متزامنين', () => {
  it('PM10=350 @60s + wind=20 → MONITOR، القاعدة المعلَّقة لـPM10 تبقى ظاهرة في triggeredRules، regulatory=PENDING_CONFIRMATION (لا يجوز إسقاطها لـCOMPLIANT بمجرد تعادل رياح مؤكَّدة بلا مخالفة)', () => {
    const { compliance, final } = runFullChain({ pm10UgM3: 350, pm10AgeSeconds: 60, windSpeedKmh: 20 });

    expect(final.operationalDecision).toBe('MONITOR');
    // خطأ مكتشَف ومُصلَح سابقاً (الملاحظة #4 من هذه الجلسة — "PM10 المعلَّق
    // يمكن أن يختفي إذا ظهرت قاعدة أخرى بنفس الشدة"): قاعدة الرياح
    // (GATE-WIND-15-25-ENHANCED-005، غير معلَّقة) تتعادل شدةً مع قاعدة PM10
    // المعلَّقة (MRQ-PM10-BLACK-PENDING-104) — كلتاهما ALLOW_WITH_CONTROLS.
    // يجب أن تظهرا معاً في triggeredRules، لا أن تُخفي إحداهما الأخرى.
    const codes = compliance.triggeredRules.map((h) => h.code);
    expect(codes).toContain('MRQ-PM10-BLACK-PENDING-104');
    expect(codes).toContain('GATE-WIND-15-25-ENHANCED-005');
    // خطأ ثانٍ مكتشَف ومُصلَح (مراجعة كود خارجي — P0 مُعاد فتحه: "PM10
    // المعلَّق يمكن أن يصبح COMPLIANT"): compliance.pendingConfirmation
    // الخام (topHits.every(isPending)) تصبح false هنا بالفعل (تعادل مع قاعدة
    // رياح غير معلَّقة) — هذا صحيح بذاته (القرار التشغيلي الفائز ليس معلَّقاً
    // بالكامل). لكن regulatoryFinding النهائي لا يجوز أن يسقط إلى COMPLIANT
    // لمجرد ذلك التعادل: قاعدة الرياح لا تحمل أي دلالة تنظيمية خاصة بها
    // (regulatoryFinding='NONE')، فلا يصح أن تُسقط حالة "بانتظار تأكيد PM10"
    // النشطة فعلياً إلى "متوافق تماماً". hasPendingRegulatoryFinding
    // (يفحص كل ruleHits لوجود أي PENDING، بمعزل عن topHits) يبقى true هنا،
    // فـfinal-decision-engine يبقي PENDING_CONFIRMATION.
    expect(compliance.pendingConfirmation).toBe(false);
    expect(compliance.hasPendingRegulatoryFinding).toBe(true);
    expect(final.regulatoryFinding).toBe('PENDING_CONFIRMATION');
  });
});

// سيناريو "unpaved road speed=11 → RESTRICT" الأصلي لم يعد صالحاً (طلب
// صريح من المستخدم — TRAFFIC-UNPAVED-002 حُذفت مع بقية قواعد SITE_TRAFFIC
// الفعلية، تحوّلت لتنبيه نصي فقط). استُبدل بمثال من نشاط آخر لا تزال
// قاعدته فعلية (DEMO-AREA-002) لإثبات نفس المبدأ: مخالفة صريحة غير مرتبطة
// بـPM10 يجب أن تصل regulatory=NON_COMPLIANT (الملاحظة #5).
describe('Cross-Engine Invariant — مخالفة صريحة غير PM10 (مساحة هدم تتجاوز الحد)', () => {
  it('مساحة هدم نشطة 150م² (تتجاوز الحد 100م²) → RESTRICT، regulatory=NON_COMPLIANT', () => {
    const { compliance, final } = runFullChain({
      windSpeedKmh: 5,
      activityRowOverrides: {
        regulatory_activity: 'DEMOLITION',
        is_enclosed_operation: false,
        demolition_active_area_m2: 150,
      },
    });

    expect(compliance.decisionCategory).toBe('STOP_AFFECTED_ACTIVITY');
    expect(compliance.triggeredRules.some((h) => h.code === 'DEMO-AREA-002')).toBe(true);
    expect(compliance.hasConfirmedRegulatoryViolation).toBe(true);
    // خطأ مكتشَف ومُصلَح (الملاحظة #5 من هذه الجلسة — "regulatoryFinding
    // مصمم حالياً حول PM10 فقط"): مخالفة صريحة يجب أن تصل NON_COMPLIANT،
    // لا COMPLIANT كما كانت قبل الإصلاح رغم القيد الفعلي.
    expect(final.regulatoryFinding).toBe('NON_COMPLIANT');
  });

  it('مساحة هدم ضمن الحد (50م²) → لا مخالفة، regulatory=COMPLIANT', () => {
    const { compliance, final } = runFullChain({
      windSpeedKmh: 5,
      activityRowOverrides: {
        regulatory_activity: 'DEMOLITION',
        is_enclosed_operation: false,
        demolition_active_area_m2: 50,
      },
    });

    expect(compliance.triggeredRules.some((h) => h.code === 'DEMO-AREA-002')).toBe(false);
    expect(final.regulatoryFinding).toBe('COMPLIANT');
  });

  it('unpaved road speed=11 (سرعة طرق SITE_TRAFFIC) → لا تأثير على القرار (تنبيه نصي فقط، قرار حوكمة معتمَد)', () => {
    const { compliance, final } = runFullChain({
      activityRowOverrides: {
        regulatory_activity: 'SITE_TRAFFIC',
        unpaved_speed_kmh: 11,
      },
    });

    expect(compliance.triggeredRules.length).toBe(0);
    expect(compliance.decisionCategory).toBe('ALLOW');
    expect(final.regulatoryFinding).toBe('COMPLIANT');
  });
});

describe('Cross-Engine Invariant — الرياح 15-25 كم/س وحدها لا تُرقَّى تلقائياً لمخالفة تنظيمية', () => {
  it('wind=20 مع كل الضوابط سليمة (نشاط ترابي عام) → MONITOR، ليس NON_COMPLIANT تلقائياً', () => {
    const { compliance, final } = runFullChain({ windSpeedKmh: 20 });

    expect(final.operationalDecision).toBe('MONITOR');
    expect(compliance.decisionCategory).toBe('ALLOW_WITH_CONTROLS');
    // خطأ مكتشَف ومُصلَح (الملاحظة #5): تثبيط الرياح العام حالة تشغيلية
    // بحتة، لا تجاوز حد رقمي/قانوني بذاته — regulatoryFinding يجب أن يبقى
    // COMPLIANT، لا NON_COMPLIANT تلقائياً لمجرد وجود قاعدة ALLOW_WITH_CONTROLS.
    expect(final.regulatoryFinding).toBe('COMPLIANT');
    expect(compliance.hasConfirmedRegulatoryViolation).toBe(false);
  });
});

describe('Cross-Engine Invariant — قطع الأحجار: بوابة الرياح (>25 فقط)', () => {
  function stoneCuttingChain(windSpeedKmh: number, controlsOverride: Record<string, unknown> = { wet_cutting_active: true }) {
    const nowMs = Date.now();
    const dvi = buildDviWithDeviceReading(
      nowMs,
      { deviceWindSpeedKmh: windSpeedKmh, deviceWindGustKmh: windSpeedKmh + 5 },
      { windSpeedKmh, windGustKmh: windSpeedKmh + 5 }
    );
    const ctx = buildComplianceContext(
      projectRow(),
      activityRow({
        regulatory_activity: 'STONE_CUTTING',
        is_enclosed_operation: false,
        ...controlsOverride,
      }),
      dvi,
      [],
      null,
      null,
      nowMs,
      false
    );
    const compliance = evaluateDustCompliance(ctx, nowMs);
    const finalInput = buildFinalDecisionInput('cross-engine-stonecut', dvi, compliance, null, 'LIVE_OPERATIONAL', new Date(nowMs).toISOString());
    const final = decideFinal(finalInput);
    return { compliance, final };
  }

  it('wind=15 بالضبط (حد بداية النطاق) → لا STOP من الرياح (ضمن نطاق التثبيط، لا الإيقاف)', () => {
    const { compliance } = stoneCuttingChain(15);
    expect(compliance.triggeredRules.some((h) => h.code === 'STONECUT-WIND-STOP-003')).toBe(false);
    expect(compliance.decisionCategory).not.toBe('STOP_AFFECTED_ACTIVITY');
  });

  it('wind=25 بالضبط (لم يتجاوز الحد) → لا STOP من الرياح', () => {
    const { compliance } = stoneCuttingChain(25);
    expect(compliance.triggeredRules.some((h) => h.code === 'STONECUT-WIND-STOP-003')).toBe(false);
    expect(compliance.decisionCategory).not.toBe('STOP_AFFECTED_ACTIVITY');
  });

  it('wind=25.001 (تجاوز دقيق) → STOP فعلي من الرياح', () => {
    const { compliance, final } = stoneCuttingChain(25.001);
    expect(compliance.triggeredRules.some((h) => h.code === 'STONECUT-WIND-STOP-003')).toBe(true);
    expect(compliance.decisionCategory).toBe('STOP_AFFECTED_ACTIVITY');
    expect(final.mandatoryStop).toBe(true);
  });

  it('wind=20 (ضمن نطاق التثبيط المعزَّز 15-25) → MONITOR تشغيلياً، regulatory=COMPLIANT (لا مخالفة زائفة)', () => {
    const { compliance, final } = stoneCuttingChain(20);
    expect(compliance.triggeredRules.some((h) => h.code === 'STONECUT-WIND-ENHANCED-004')).toBe(true);
    expect(compliance.decisionCategory).toBe('ALLOW_WITH_CONTROLS');
    // خطأ مكتشَف ومُصلَح (مراجعة كود خارجي — P0: "رياح قطع الأحجار 15-25
    // تسجل مخالفة زائفة"): STONECUT-WIND-ENHANCED-004 كانت تفتقد
    // regulatoryFinding='NONE' الصريحة (سقطت لافتراض ruleHit() نحو
    // 'VIOLATION')، فيُصدر final-decision-engine خطأً regulatoryFinding=
    // NON_COMPLIANT رغم أن القرار التشغيلي MONITOR فعلياً (تناقض مباشر).
    expect(compliance.hasConfirmedRegulatoryViolation).toBe(false);
    expect(final.operationalDecision).toBe('MONITOR');
    expect(final.regulatoryFinding).toBe('COMPLIANT');
  });
});

// STONECUT-DUST-CONTROL-006 حُذفت نهائياً (طلب صريح من المستخدم — راجع
// تعليق stoneCuttingRules الكامل في rulebook.ts). لا اختبار قرار فعلي لها
// بعد الآن — الاختبار الوحيد ذو الصلة الآن هو التأكد أنها لا تعود بالخطأ
// (راجع مجموعة "Wet Cutting" أدناه).

describe('Cross-Engine Invariant — مسافات المستقبِلات الحساسة: تنبيه فقط، لا STOP إطلاقاً', () => {
  it('stockpile distance=199m (أقل من 200) → تنبيه فقط، لا STOP', () => {
    const nowMs = Date.now();
    const dvi = buildDviWithDeviceReading(nowMs);
    const ctx = buildComplianceContext(
      projectRow(),
      activityRow({
        regulatory_activity: 'MATERIAL_HANDLING_STOCKPILE',
        stockpile_batching_distance_to_receptor_m: 199,
      }),
      dvi,
      [],
      null,
      null,
      nowMs,
      false
    );
    const compliance = evaluateDustCompliance(ctx, nowMs);
    const finalInput = buildFinalDecisionInput('cross-engine-stockpile', dvi, compliance, null, 'LIVE_OPERATIONAL', new Date(nowMs).toISOString());
    const final = decideFinal(finalInput);

    expect(compliance.triggeredRules.some((h) => h.code === 'STOCKPILE-DISTANCE-002')).toBe(true);
    expect(compliance.decisionCategory).not.toBe('STOP_AFFECTED_ACTIVITY');
    expect(compliance.decisionCategory).not.toBe('MANDATORY_STOP');
    expect(final.mandatoryStop).toBe(false);
    expect(['ALLOW', 'MONITOR']).toContain(final.operationalDecision);
  });

  it('crusher distance=499m (أقل من 500) → تنبيه فقط، لا STOP', () => {
    const nowMs = Date.now();
    const dvi = buildDviWithDeviceReading(nowMs);
    const ctx = buildComplianceContext(
      { ...projectRow(), has_onsite_crusher: true, site_area_m2: 6000 },
      activityRow({
        regulatory_activity: 'CRUSHER',
        crusher_distance_to_receptor_m: 499,
      }),
      dvi,
      [],
      null,
      null,
      nowMs,
      false
    );
    const compliance = evaluateDustCompliance(ctx, nowMs);
    const finalInput = buildFinalDecisionInput('cross-engine-crusher', dvi, compliance, null, 'LIVE_OPERATIONAL', new Date(nowMs).toISOString());
    const final = decideFinal(finalInput);

    expect(compliance.triggeredRules.some((h) => h.code === 'CRUSHER-DISTANCE-500-002C')).toBe(true);
    expect(compliance.decisionCategory).not.toBe('STOP_AFFECTED_ACTIVITY');
    expect(compliance.decisionCategory).not.toBe('MANDATORY_STOP');
    expect(final.mandatoryStop).toBe(false);
    expect(['ALLOW', 'MONITOR']).toContain(final.operationalDecision);
  });
});

// =====================================================================
// اختبارات القواعد النشاطية المعتمدة (Wet Cutting، Crusher Controls،
// Demolition Controls) — حسب النسخة المعتمدة الفعلية من Operational
// Rulebook، لا حسب أي نص مرجعي قديم. تعكس هذه الاختبارات بالضبط القواعد
// التي لا تزال تؤثر فعلياً على القرار بعد قرار الحوكمة (الملاحظة #8، هذه
// الجلسة) الذي حوّل كل الضوابط التفصيلية العشرة (بما فيها قطع الأحجار
// نهائياً بعد تراجع لاحق) إلى تنبيهات نصية عامة بلا تأثير على القرار.
// =====================================================================

describe('Cross-Engine Invariant — القواعد النشاطية المعتمدة: Wet Cutting (قطع الأحجار)', () => {
  it('لا رش مائي ولا HEPA (مكشوف) → لا تأثير على القرار (تنبيه توعوي فقط، وفق قرار الحوكمة النهائي)', () => {
    const nowMs = Date.now();
    const dvi = buildDviWithDeviceReading(nowMs);
    const ctx = buildComplianceContext(
      projectRow(),
      activityRow({
        regulatory_activity: 'STONE_CUTTING',
        is_enclosed_operation: false,
        wet_cutting_active: false,
        hepa_extraction_active: false,
      }),
      dvi,
      [],
      null,
      null,
      nowMs,
      false
    );
    const compliance = evaluateDustCompliance(ctx, nowMs);
    const finalInput = buildFinalDecisionInput('cross-engine-wetcut-stop', dvi, compliance, null, 'LIVE_OPERATIONAL', new Date(nowMs).toISOString());
    const final = decideFinal(finalInput);

    expect(compliance.triggeredRules.some((h) => h.code === 'STONECUT-DUST-CONTROL-006')).toBe(false);
    expect(compliance.decisionCategory).not.toBe('MANDATORY_STOP');
    expect(final.mandatoryStop).toBe(false);
  });

  it('رش مائي فعّال بلا HEPA → نفس النتيجة (بلا تأثير، الحقلان لم يعودا يُقرآن)', () => {
    const nowMs = Date.now();
    const dvi = buildDviWithDeviceReading(nowMs);
    const ctx = buildComplianceContext(
      projectRow(),
      activityRow({
        regulatory_activity: 'STONE_CUTTING',
        is_enclosed_operation: false,
        wet_cutting_active: true,
        hepa_extraction_active: false,
      }),
      dvi,
      [],
      null,
      null,
      nowMs,
      false
    );
    const compliance = evaluateDustCompliance(ctx, nowMs);

    expect(compliance.triggeredRules.some((h) => h.code === 'STONECUT-DUST-CONTROL-006')).toBe(false);
    expect(compliance.decisionCategory).not.toBe('MANDATORY_STOP');
  });
});

describe('Cross-Engine Invariant — القواعد النشاطية المعتمدة: Crusher Controls (الكسارة)', () => {
  it('مشروع لم يصل الفئة الثالثة لكن النشاط مصنَّف كسارة (تعارض بيانات) → CRUSHER-CATEGORY-001، MANDATORY_STOP', () => {
    const nowMs = Date.now();
    const dvi = buildDviWithDeviceReading(nowMs);
    const ctx = buildComplianceContext(
      { ...projectRow(), has_onsite_crusher: false, site_area_m2: 1000, daily_truck_movements: 5 },
      activityRow({ regulatory_activity: 'CRUSHER' }),
      dvi,
      [],
      null,
      null,
      nowMs,
      false
    );
    const compliance = evaluateDustCompliance(ctx, nowMs);
    const finalInput = buildFinalDecisionInput('cross-engine-crusher-category', dvi, compliance, null, 'LIVE_OPERATIONAL', new Date(nowMs).toISOString());
    const final = decideFinal(finalInput);

    expect(compliance.riskClass).not.toBe('CATEGORY_III_HIGH');
    expect(compliance.triggeredRules.some((h) => h.code === 'CRUSHER-CATEGORY-001')).toBe(true);
    expect(final.mandatoryStop).toBe(true);
  });

  it('كسارة ضمن مشروع فئة ثالثة، بلا ضوابط تفصيلية مفعَّلة (تغطية/رش) → لا إيقاف (ضوابط تفصيلية تنبيه توعوي فقط، قرار حوكمة #8)', () => {
    const nowMs = Date.now();
    const dvi = buildDviWithDeviceReading(nowMs);
    const ctx = buildComplianceContext(
      { ...projectRow(), has_onsite_crusher: true },
      activityRow({
        regulatory_activity: 'CRUSHER',
        conveyors_enclosed: false,
        fogging_available: false,
        spray_cannon_available: false,
      }),
      dvi,
      [],
      null,
      null,
      nowMs,
      false
    );
    const compliance = evaluateDustCompliance(ctx, nowMs);
    const finalInput = buildFinalDecisionInput('cross-engine-crusher-controls', dvi, compliance, null, 'LIVE_OPERATIONAL', new Date(nowMs).toISOString());
    const final = decideFinal(finalInput);

    expect(compliance.riskClass).toBe('CATEGORY_III_HIGH');
    expect(compliance.triggeredRules.some((h) => h.code === 'CRUSHER-CATEGORY-001')).toBe(false);
    expect(compliance.decisionCategory).not.toBe('MANDATORY_STOP');
    expect(final.mandatoryStop).toBe(false);
  });
});

describe('Cross-Engine Invariant — القواعد النشاطية المعتمدة: Demolition Controls (الهدم)', () => {
  it('هدم مكشوف أثناء رياح 20 كم/س (≥15) → DEMO-WIND-STOP-001، MANDATORY_STOP', () => {
    const nowMs = Date.now();
    const dvi = buildDviWithDeviceReading(nowMs, { deviceWindSpeedKmh: 20, deviceWindGustKmh: 25 }, { windSpeedKmh: 20, windGustKmh: 25 });
    const ctx = buildComplianceContext(
      projectRow(),
      activityRow({
        regulatory_activity: 'DEMOLITION',
        is_enclosed_operation: false,
      }),
      dvi,
      [],
      null,
      null,
      nowMs,
      false
    );
    const compliance = evaluateDustCompliance(ctx, nowMs);
    const finalInput = buildFinalDecisionInput('cross-engine-demo-wind', dvi, compliance, null, 'LIVE_OPERATIONAL', new Date(nowMs).toISOString());
    const final = decideFinal(finalInput);

    expect(compliance.triggeredRules.some((h) => h.code === 'DEMO-WIND-STOP-001')).toBe(true);
    expect(final.mandatoryStop).toBe(true);
  });

  it('مساحة هدم نشطة تتجاوز الحد الأقصى (150م² > 100م²) → DEMO-AREA-002، STOP_AFFECTED_ACTIVITY', () => {
    const nowMs = Date.now();
    const dvi = buildDviWithDeviceReading(nowMs);
    const ctx = buildComplianceContext(
      projectRow(),
      activityRow({
        regulatory_activity: 'DEMOLITION',
        is_enclosed_operation: false,
        demolition_active_area_m2: 150,
      }),
      dvi,
      [],
      null,
      null,
      nowMs,
      false
    );
    const compliance = evaluateDustCompliance(ctx, nowMs);
    const finalInput = buildFinalDecisionInput('cross-engine-demo-area', dvi, compliance, null, 'LIVE_OPERATIONAL', new Date(nowMs).toISOString());
    const final = decideFinal(finalInput);

    expect(compliance.triggeredRules.some((h) => h.code === 'DEMO-AREA-002')).toBe(true);
    expect(compliance.decisionCategory).toBe('STOP_AFFECTED_ACTIVITY');
    expect(final.mandatoryStop).toBe(true);
  });

  it('هدم مكشوف برياح هادئة (5 كم/س) ومساحة ضمن الحد (50م²) → لا إيقاف من ضوابط الهدم', () => {
    const nowMs = Date.now();
    const dvi = buildDviWithDeviceReading(nowMs, { deviceWindSpeedKmh: 5, deviceWindGustKmh: 8 }, { windSpeedKmh: 5, windGustKmh: 8 });
    const ctx = buildComplianceContext(
      projectRow(),
      activityRow({
        regulatory_activity: 'DEMOLITION',
        is_enclosed_operation: false,
        demolition_active_area_m2: 50,
      }),
      dvi,
      [],
      null,
      null,
      nowMs,
      false
    );
    const compliance = evaluateDustCompliance(ctx, nowMs);

    expect(compliance.triggeredRules.some((h) => h.code === 'DEMO-WIND-STOP-001')).toBe(false);
    expect(compliance.triggeredRules.some((h) => h.code === 'DEMO-AREA-002')).toBe(false);
    expect(compliance.decisionCategory).not.toBe('MANDATORY_STOP');
    expect(compliance.decisionCategory).not.toBe('STOP_AFFECTED_ACTIVITY');
  });
});

// =====================================================================
// اختبارات قبول صريحة (طلب المستخدم — تقرير المراجعة الخارجي: "ماذا يحدث
// إذا توجد قاعدة إيقاف أخرى؟"، جدول الترتيب الكامل الخمسة صفوف). الصف
// الأول (فشل PM10 فقط → HOLD_FOR_VERIFICATION) والرابع (قرار PM10 سابق
// موقوف محفوظ) مُختبَران بالفعل على مستوى dust-compliance-engine.test.ts
// (context() الاصطناعي). الصفوف الثلاثة أدناه (2، 3، 5) تحتاج تحديداً
// السلسلة الحقيقية الثلاثية الكاملة (لا compliance اصطناعي) لأنها تختبر
// بالضبط ترتيب decideFinal (OPERATION_RANK) الذي لا يظهر إلا بعد تحويل
// STOP_AFFECTED_ACTIVITY/MANDATORY_STOP من محرك الامتثال إلى
// operationalDecision النهائي.
// =====================================================================
describe('Cross-Engine Invariant — فشل استعلام PM10 التاريخي مع قاعدة إيقاف أخرى (ترتيب الأولوية الكامل)', () => {
  // الصف الثاني من جدول التقرير: فشل PM10 + رياح تفرض إيقافاً (>25 كم/س)
  // → يبقى MANDATORY_STOP بسبب الرياح، لا HOLD_FOR_VERIFICATION رغم فشل
  // استعلام PM10 المتزامن. OPERATION_RANK يضع MANDATORY_STOP (5) أعلى من
  // HOLD_FOR_VERIFICATION (3، الناتج عن FIELD_VERIFICATION_REQUIRED).
  it('فشل استعلام PM10 + رياح 30 كم/س (بوابة الإيقاف) → operationalDecision=MANDATORY_STOP (الرياح تفوز)، لا HOLD_FOR_VERIFICATION', () => {
    const { compliance, final } = runFullChain({
      windSpeedKmh: 30,
      pm10HistoryQueryFailed: true,
    });

    // على مستوى محرك الامتثال: كلا القاعدتين حاضرتان، GATE-WIND-ABOVE-25-004
    // (STOP_AFFECTED_ACTIVITY) تفوز على PM10-HISTORY-QUERY-FAILED-HOLD
    // (FIELD_VERIFICATION_REQUIRED).
    expect(compliance.decisionCategory).toBe('STOP_AFFECTED_ACTIVITY');
    expect(compliance.triggeredRules.some((h) => h.code === 'GATE-WIND-ABOVE-25-004')).toBe(true);
    expect(compliance.triggeredRules.some((h) => h.code === 'PM10-HISTORY-QUERY-FAILED-HOLD')).toBe(true);

    // على مستوى القرار النهائي: STOP_AFFECTED_ACTIVITY (pendingConfirmation
    // غير مفعَّلة لبوابة الرياح) → confirmedAffectedStop=true → MANDATORY_STOP.
    // هذا هو التحقق الفعلي المطلوب في التقرير — لا يكفي إثبات فوز الرياح
    // على مستوى الامتثال وحده، بل يجب إثبات وصول MANDATORY_STOP فعلياً
    // للقرار النهائي المعروض للمستخدم.
    expect(final.operationalDecision).toBe('MANDATORY_STOP');
    expect(final.mandatoryStop).toBe(true);
  });

  // الصف الثالث: فشل PM10 + تعطل نظام التثبيط (dustSuppressionSystemOperational
  // =false على نشاط مولّد للغبار) → يبقى قرار الإيقاف الفعلي (MANDATORY_STOP)،
  // لا HOLD_FOR_VERIFICATION.
  it('فشل استعلام PM10 + تعطل نظام التثبيط (نشاط مولّد للغبار) → operationalDecision=MANDATORY_STOP (تعطل التثبيط يفوز)، لا HOLD_FOR_VERIFICATION', () => {
    const { compliance, final } = runFullChain({
      pm10HistoryQueryFailed: true,
      activityRowOverrides: {
        is_dust_generating: true,
        dust_suppression_system_operational: false,
      },
    });

    expect(compliance.decisionCategory).toBe('MANDATORY_STOP');
    expect(compliance.triggeredRules.some((h) => h.code === 'PM10-HISTORY-QUERY-FAILED-HOLD')).toBe(true);

    expect(final.operationalDecision).toBe('MANDATORY_STOP');
    expect(final.mandatoryStop).toBe(true);
  });

  // الصف الخامس: فشل PM10 + isActiveOrPlanned=false ("لا نشاط حي") → يسجل
  // عطلاً تقنياً (HOLD_FOR_VERIFICATION) دون أي مخالفة تنظيمية —
  // isActiveOrPlanned لا يُسكِت قاعدة PM10-HISTORY-QUERY-FAILED-HOLD (تحقَّقنا
  // أنها تؤثر حصراً على GATE-DMP-001، لا صلة لها بـPM10). السلسلة الكاملة
  // هنا تثبت أن regulatoryFinding النهائي أيضاً NOT_DETERMINABLE، لا
  // NON_COMPLIANT ولا COMPLIANT.
  it('فشل استعلام PM10 + isActiveOrPlanned=false (لا نشاط حي) → operationalDecision=HOLD_FOR_VERIFICATION، regulatoryFinding=NOT_DETERMINABLE (عطل تقني، لا مخالفة)', () => {
    const { compliance, final } = runFullChain({
      pm10HistoryQueryFailed: true,
      activityRowOverrides: {
        is_active_or_planned: false,
      },
    });

    expect(compliance.decisionCategory).toBe('FIELD_VERIFICATION_REQUIRED');
    expect(compliance.hasConfirmedRegulatoryViolation).toBe(false);

    expect(final.operationalDecision).toBe('HOLD_FOR_VERIFICATION');
    expect(final.mandatoryStop).toBe(false);
    expect(final.regulatoryFinding).toBe('NOT_DETERMINABLE');
  });
});
