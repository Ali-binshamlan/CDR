import { describe, it, expect, afterEach } from 'vitest';
import { evaluateDustCompliance } from './engine';
import { classifyProject, classifyWind } from './rulebook';
import { buildActivityComplianceProfile, buildComplianceContext } from './adapters';
import { resetRuleParametersForTests, setRuleParametersForTests } from './ruleParameters';
import { haversineDistanceM, nearestReceptorDistancesM, receptorsWithinRadiusM, UNIT_RECEPTOR_RADIUS_M } from './geo';
import { computeUnitReceptors } from '@/app/lib/dustEvaluation';
import type {
  DustActivityComplianceProfile,
  DustComplianceContext,
  DustProjectComplianceProfile,
  SensitiveReceptor,
} from './types';
import type { DviMergedReading, DviHourlyEvaluation } from '@/app/utils/dust-engine/types';

// =====================================================================
// اختبارات تكامل محرك امتثال الغبار (Riyadh Dust Compliance) — تُشغّل
// evaluateDustCompliance كاملاً بعيّنات اصطناعية دون شبكة، بنفس نمط
// dust-engine.integration.test.ts.
// =====================================================================

function projectProfile(overrides: Partial<DustProjectComplianceProfile> = {}): DustProjectComplianceProfile {
  return {
    siteAreaM2: 1500,
    dailyTruckMovements: 10,
    hasOnsiteCrusher: false,
    hasOnsiteBatchingPlant: false,
    dmpApprovalStatus: 'APPROVED',
    dmpSubmittedAt: null,
    dmpApprovedAt: null,
    baselineMonitoringDays: 14,
    monitoringStationCount: 1,
    monitoringLoggingIntervalMinutes: 1,
    anemometerHeightM: 2.5,
    entryExitCamerasInstalled: true,
    cameraRetentionDays: 90,
    sensitivityMapPrepared: true,
    ...overrides,
  };
}

function activityProfile(overrides: Partial<DustActivityComplianceProfile> = {}): DustActivityComplianceProfile {
  return {
    activityGroupId: 'test-group-1',
    regulatoryActivity: 'OTHER',
    isDustGenerating: true,
    isEnclosedOperation: false,
    isActiveOrPlanned: true,
    controls: {
      dustSuppressionSystemOperational: true,
      continuousMisting: true,
      sprayCannonAvailable: true,
      dustScreensAvailable: true,
      wetCuttingActive: true,
      hepaExtractionActive: true,
      wheelWashOperational: true,
      hourlyInspectionRecorded: true,
      speedControlApplied: true,
      loadCovered: true,
      conveyorsEnclosed: true,
      foggingAvailable: true,
      idleSurfaceStabilized: true,
      silosSealed: true,
      pm10FilterEfficiencyPercent: 99.5,
      leakDetected: false,
      dryCleaningMethodUsed: false,
      idleSurfaceCoverIntact: true,
      surfaceWatered: true,

      truckRoutesDesignated: true,
      pathCoverMaterial: 'GRAVEL',
      waterSprayMethod: 'SPRAY',
      soilCompactedAfterExcavation: true,
      stabilizerUsedDuringPause: true,
      pauseDurationOver5Days: false,
      sprayUsedDuringSoilUnloading: true,
      workAreaPhased: true,

      unpavedRoadsWateredDaily: true,
      dustControlMethod: 'WATER_SPRAY',
      speedLimitSignsPosted: true,
      containersCoveredBeforeMoving: true,
      containersInspectedBeforeDeparture: true,
      loadHeightExceedsContainerLimit: false,
      adjacentRoadsSweptMechanically: true,
      sweepFrequencyBand: 'HOURLY',
      wheelWashAtExit: true,
      wheelWashMaintainedRegularly: true,
      washWaterRecycled: true,
      allLoadsCovered: true,
      trucksInspectedBeforeDeparture: true,
      loadSideCoverageAdequate: true,
      publicRoadsVacuumSweptDaily: true,
      waterUsedRoutinelyForCleaning: false,

      accessRoadPaved: true,
      tireCleaningMethod: 'WHEEL_WASH',
      sandTrapPresent: true,
      oilSeparatorPresent: true,
      washCycleDurationAdequate: true,
      wheelWashOperationMethod: 'AUTO_SENSOR',
      washWaterReused: true,
      antiSlipMeshPresent: true,
      immersionZoneLengthAdequate: true,
      collectionBasinPresent: true,
      truckPathCleanedWithin15Min: true,

      exposedAreaCurrentlyIdle: false,
      stabilizationMethod: 'POLYMERS',
      stockpileAreaExists: false,
      suppressantUsedAtStockpileArea: true,
      windBarriersNearStockpiles: true,
      constructionScheduledImmediatelyAfterPrep: true,

      centralizedStorage: true,
      distributedAcrossMultipleLocations: false,
      sprayedImmediatelyAfterUnloading: true,
      fullSubmersionOfPiles: false,
      stockpileShapeLowRounded: true,
      unusedPilesCoveredDaily: true,
      cementInSealedSilos: true,
      silosHavePm10Filters: true,
      pilesBehindWindBarriers: true,
      conveyorsUseAutoSpray: true,
      windBarriersAlignedWithPrevailingWind: true,
      barrierDistanceRatioCompliant: true,

      filterMaintenancePerformedRegularly: true,
      leakPreventionInspectedRegularly: true,
      suppressionSystemCheckedDaily: true,
      manualDrySweepingBanned: true,
      compressedAirBanned: true,
      siteCleaningMethod: 'MECHANICAL_WATER_SWEEP',
      wasteHumidityMaintainedDuringTransport: true,
      wasteLoadsCovered: true,

      sprayCannonRangeBand: 'M20',
      crushersCoveredDemolition: true,
      loadingPointsHaveSprinklers: true,
      demolitionCuttingMethod: 'WATER_FED_SAWS',
      sandblastingUsed: false,
      sandblastingInEnclosedBox: true,

      crusherUnitsFullyCovered: true,
      loadingPointsHaveSpraySystems: true,
      sprayCannonsAroundCrusher: true,
      conveyorsCoveredCrusher: true,
      dropHeightReducedAtCrusher: true,
      suctionAndFiltrationSystemsPresent: true,
      criticalScheduleApplies: false,

      cuttingResiduesCleanedAfterCompletion: true,

      debrisSprayedBeforeLoading: true,
      centralStorageArea: true,
      smallPilesDispersedMultipleLocations: false,
      dailyRemoval: true,
      coveredIfNotRemovedDaily: true,
      debrisCompacted: true,
      onlyActiveSectionSprayed: true,
      loadExceedsCapacity: false,
    },
    measurements: {
      demolitionActiveAreaM2: null,
      crusherDistanceToReceptorM: null,
      stockpileBatchingDistanceToReceptorM: null,
      stockpileLat: null,
      stockpileLng: null,
      stockpileDistanceToNearestReceptorAutoM: null,
      stockpileDistanceToResidentialReceptorAutoM: null,
      batchingLat: null,
      batchingLng: null,
      batchingDistanceToNearestReceptorAutoM: null,
      batchingDistanceToResidentialReceptorAutoM: null,
      stockpileHeightM: null,
      dropHeightM: null,
      idleDays: null,
      spillCleanupMinutes: null,
      unpavedSpeedKmh: null,
      exposedSoilAreaM2: null,
      pavedSpeedKmh: null,
      visibleTrackoutBeyond15m: false,

      crusherLat: null,
      crusherLng: null,
      crusherDistanceToNearestReceptorAutoM: null,
      crusherDistanceToResidentialReceptorAutoM: null,
      crusherDistanceToDownwindReceptorAutoM: null,

      entryPointLat: 24.7,
      entryPointLng: 46.7,
      exitPointLat: 24.7,
      exitPointLng: 46.7,
      waterTracesBeyond15mFromGate: false,

      stockpileDistanceUnder200m: false,

      debrisPileHeightM: null,
    },
    // افتراضي true (بيانات مستقبلات متوفرة في النظام) — يطابق سلوك كل
    // اختبارات هذا الملف قبل إضافة الحقل (Infinity/null كانتا تُفسَّران كما
    // هما، بلا بوابة FIELD_VERIFICATION_REQUIRED إضافية). اختبارات الفجوة
    // الجديدة (dust-compliance-engine.sensitiveReceptorsMissing.test.ts)
    // تمرر false صراحة.
    sensitiveReceptorsDataAvailable: true,
    ...overrides,
  };
}

// خطأ مكتشَف ومُصلَح (مراجعة كود مدير): كان pm10ThresholdRule يعيد اشتقاق
// "مؤكَّدة"/"معلَّقة 30 دقيقة" من pm10SustainedMinutesAbove340/250 مباشرة —
// الآن يقرأ pm10ConfirmedViolation340/pm10Suspended250For30Min الجاهزتين
// من computeSustainedPm10Status، لا يعيد الحساب. context() هنا تشتقهما
// تلقائياً من رقمي الدقائق (بنفس عتبات computeSustainedPm10Status: >2
// دقيقة للتأكيد، ≥30 دقيقة للتعليق) إن لم يُمرَّرا صراحةً بـoverrides —
// حتى تبقى كل اختبارات هذا الملف (المكتوبة أصلاً بمصطلح "الدقائق") صحيحة
// دلالياً بلا إعادة كتابة كل استدعاء context() يدوياً.
function context(overrides: Partial<DustComplianceContext> = {}): DustComplianceContext {
  const sustainedMinutesAbove340 = overrides.pm10SustainedMinutesAbove340;
  const sustainedMinutesAbove250 = overrides.pm10SustainedMinutesAbove250;
  return {
    project: projectProfile(),
    activity: activityProfile(),
    isForecastStale: false,
    dviScore: 10,
    dviDecision: 'ALLOW',
    dviMandatoryStop: false,
    dviConfidenceScore: 95,
    windSpeedKmh: 10,
    windGustKmh: 15,
    windDirectionDeg: 270,
    pm10UgM3: 20,
    pm25UgM3: 12,
    relativeHumidityPercent: 40,
    temperatureC: 30,
    visibilityM: 5000,
    dataSource: 'onsite',
    sensitiveReceptors: [],
    pm10ConfirmedViolation340:
      sustainedMinutesAbove340 !== undefined ? sustainedMinutesAbove340 > 2 : undefined,
    pm10Suspended250For30Min:
      sustainedMinutesAbove250 !== undefined ? sustainedMinutesAbove250 >= 30 : undefined,
    ...overrides,
  };
}

describe('محرك امتثال الغبار — تصنيف المشروع', () => {
  it('مساحة > 5000م² → فئة ثالثة عالية المخاطر', () => {
    const r = classifyProject(projectProfile({ siteAreaM2: 6000 }));
    expect(r.riskClass).toBe('CATEGORY_III_HIGH');
  });

  it('حركة شاحنات > 50 رحلة/يوم → فئة ثالثة حتى مع مساحة صغيرة', () => {
    const r = classifyProject(projectProfile({ siteAreaM2: 1500, dailyTruckMovements: 60 }));
    expect(r.riskClass).toBe('CATEGORY_III_HIGH');
  });

  it('وجود كسارة → فئة ثالثة', () => {
    const r = classifyProject(projectProfile({ hasOnsiteCrusher: true }));
    expect(r.riskClass).toBe('CATEGORY_III_HIGH');
  });

  it('مساحة بين 2000 و5000 → فئة ثانية متوسطة', () => {
    const r = classifyProject(projectProfile({ siteAreaM2: 3000 }));
    expect(r.riskClass).toBe('CATEGORY_II_MEDIUM');
  });

  it('مساحة أقل من 2000 وبلا محفزات أخرى → فئة أولى منخفضة', () => {
    const r = classifyProject(projectProfile({ siteAreaM2: 1000 }));
    expect(r.riskClass).toBe('CATEGORY_I_LOW');
  });

  it('حماية من التصنيف الكاذب: نقص بيانات محفز خطر عالٍ → غير مصنّف، وليس فئة منخفضة', () => {
    const r = classifyProject(projectProfile({ hasOnsiteCrusher: null }));
    expect(r.riskClass).toBe('UNCLASSIFIED');
  });
});

describe('محرك امتثال الغبار — تصنيف الرياح', () => {
  it('أقل من 15 كم/س', () => {
    expect(classifyWind(10)).toBe('BELOW_15');
  });
  it('من 15 إلى 25 كم/س', () => {
    expect(classifyWind(20)).toBe('FROM_15_TO_25');
  });
  it('أعلى من 25 كم/س', () => {
    expect(classifyWind(30)).toBe('ABOVE_25');
  });
  it('غير معروف عند غياب القيمة', () => {
    expect(classifyWind(null)).toBe('UNKNOWN');
  });

  // خطأ مكتشَف ومُصلَح (مراجعة خبير خارجي — "واجهة إدارة القواعد للعرض فقط؛
  // لا يوجد نظام حقيقي يدعم النشر"): classifyWind يجب أن يقرأ العتبات حياً
  // من getRuleParameters() (ruleParameters.ts)، لا ثوابت TypeScript مجمَّدة
  // — نشر قيمة جديدة لـWIND_GATE_ENHANCED_MIN_KMH/WIND_GATE_STOP_KMH يجب أن
  // يغيّر نتيجة classifyWind فوراً بلا إعادة نشر كود.
  describe('classifyWind يقرأ العتبات حياً من getRuleParameters (نظام إدارة القواعد)', () => {
    afterEach(() => {
      resetRuleParametersForTests();
    });

    it('تعديل WIND_GATE_ENHANCED_MIN_KMH يغيّر عتبة BELOW_15/FROM_15_TO_25 فوراً', () => {
      resetRuleParametersForTests();
      expect(classifyWind(12)).toBe('BELOW_15');
      setRuleParametersForTests({ WIND_GATE_ENHANCED_MIN_KMH: 10 });
      expect(classifyWind(12)).toBe('FROM_15_TO_25');
    });

    it('تعديل WIND_GATE_STOP_KMH يغيّر عتبة FROM_15_TO_25/ABOVE_25 فوراً', () => {
      resetRuleParametersForTests();
      expect(classifyWind(22)).toBe('FROM_15_TO_25');
      setRuleParametersForTests({ WIND_GATE_STOP_KMH: 20 });
      expect(classifyWind(22)).toBe('ABOVE_25');
    });
  });
});

describe('محرك امتثال الغبار — بوابات الأولوية القصوى', () => {
  it('DMP غير معتمدة على نشاط نشط/مخطط → إيقاف إلزامي', () => {
    const r = evaluateDustCompliance(
      context({ project: projectProfile({ dmpApprovalStatus: 'SUBMITTED' }) })
    );
    expect(r.decisionCategory).toBe('MANDATORY_STOP');
    expect(r.mandatoryStop).toBe(true);
    expect(r.triggeredRules.some((h) => h.code === 'GATE-DMP-001')).toBe(true);
  });

  it('DMP بحالة UNKNOWN (لم تُدخَل بعد) → لا إيقاف إلزامي، فقط منع ALLOW', () => {
    const r = evaluateDustCompliance(
      context({ project: projectProfile({ dmpApprovalStatus: 'UNKNOWN' }) })
    );
    expect(r.decisionCategory).not.toBe('MANDATORY_STOP');
    expect(r.triggeredRules.some((h) => h.code === 'GATE-DMP-001')).toBe(false);
    expect(r.missingCriticalInputs.some((m) => m.includes('DMP'))).toBe(true);
  });

  it('وراثة bowabة DVI mandatoryStop (خطر فيزيائي فوري، لا PM10 — رؤية حرجة/رياح شديدة) → إيقاف إلزامي فوري كما هو', () => {
    const r = evaluateDustCompliance(context({ dviMandatoryStop: true }));
    expect(r.decisionCategory).toBe('MANDATORY_STOP');
    expect(r.triggeredRules.some((h) => h.code === 'GATE-DVI-002')).toBe(true);
  });

  // ملاحظة مراجعة خارجية: "DVI يصدر إيقافاً تنظيمياً فور قراءة واحدة" —
  // dust-engine كان يُشعِل mandatoryStop من أول قراءة PM10≥340 لحظية بلا
  // أي شرط استمرار، وGATE-DVI-002 هنا كان يرث ذلك كـMANDATORY_STOP تنظيمي
  // قطعي مباشرة، متجاوزاً بالكامل عتبة "استمرار >دقيقتين" التي يشترطها
  // pm10ThresholdRule (PM10-VIOLATION-STOP-006 مقابل MRQ-PM10-BLACK-
  // PENDING-104) — لأن decisionFromRules يختار أعلى severity من كل
  // القواعد معاً، فيطغى MANDATORY_STOP من GATE-DVI-002 على STOP_AFFECTED_
  // ACTIVITY "المعلَّق" الصحيح من pm10ThresholdRule.
  describe('GATE-DVI-002 — PM10 لحظي فقط يشترط نفس دليل الاستمرار من pm10ThresholdRule', () => {
    it('dviMandatoryStop سببه PM10 فقط + لا دليل استمرار (pm10ConfirmedViolation340 غائب) → STOP_AFFECTED_ACTIVITY معلَّق، لا MANDATORY_STOP', () => {
      const r = evaluateDustCompliance(
        context({
          dviMandatoryStop: true,
          dviMandatoryStopIsPm10Only: true,
          pm10UgM3: 350,
          // لا pm10ConfirmedViolation340 صراحة — يُعامَل كـfalse (فشل آمن).
        })
      );
      expect(r.decisionCategory).toBe('STOP_AFFECTED_ACTIVITY');
      expect(r.decisionCategory).not.toBe('MANDATORY_STOP');
      expect(r.pendingConfirmation).toBe(true);
      expect(r.canOverride).toBe(false); // معلَّق يبقى غير قابل للتجاوز، فقط ليس "قطعياً"
    });

    it('dviMandatoryStop سببه PM10 فقط + دليل استمرار مؤكَّد (pm10ConfirmedViolation340=true) → MANDATORY_STOP فعلي', () => {
      const r = evaluateDustCompliance(
        context({
          dviMandatoryStop: true,
          dviMandatoryStopIsPm10Only: true,
          pm10UgM3: 350,
          pm10ConfirmedViolation340: true,
          pm10SustainedMinutesAbove340: 5,
        })
      );
      expect(r.decisionCategory).toBe('MANDATORY_STOP');
      expect(r.pendingConfirmation).toBe(false);
    });

    it('dviMandatoryStopIsPm10Only=false (خطر فيزيائي آخر مساهم، لا PM10 وحده) → إيقاف فوري كالسابق بلا اشتراط استمرار', () => {
      const r = evaluateDustCompliance(
        context({
          dviMandatoryStop: true,
          dviMandatoryStopIsPm10Only: false,
          pm10UgM3: 350,
        })
      );
      expect(r.decisionCategory).toBe('MANDATORY_STOP');
      expect(r.pendingConfirmation).toBe(false);
    });
  });

  it('تعطل نظام التثبيط على نشاط مولّد للغبار → إيقاف إلزامي', () => {
    const r = evaluateDustCompliance(
      context({
        activity: activityProfile({
          isDustGenerating: true,
          controls: { ...activityProfile().controls, dustSuppressionSystemOperational: false },
        }),
      })
    );
    expect(r.decisionCategory).toBe('MANDATORY_STOP');
  });
});

describe('محرك امتثال الغبار — الأعمال الترابية (A1)', () => {
  // EARTHWORKS-WATER-001 (رش التربة) حُذف من rulebook.ts — surfaceWatered
  // لم يعد يُدخَل عبر الواجهة (تحوّل إلى تنبيه نصي عام بقرار صريح بحذف
  // تأثيره من القرار)، فلم يعد اختباره ذا معنى.

  it('ارتفاع تفريغ التربة > 1م أثناء رياح نشطة (15-25 كم/س) → إيقاف النشاط المتأثر', () => {
    const r = evaluateDustCompliance(
      context({
        windSpeedKmh: 18,
        activity: activityProfile({
          regulatoryActivity: 'EARTHWORKS',
          measurements: { ...activityProfile().measurements, dropHeightM: 1.2 },
        }),
      })
    );
    expect(r.triggeredRules.some((h) => h.code === 'EARTHWORKS-DROP-002')).toBe(true);
  });

  it('ارتفاع تفريغ التربة > 1.5م في الوضع الاعتيادي → إيقاف النشاط المتأثر', () => {
    const r = evaluateDustCompliance(
      context({
        windSpeedKmh: 5,
        activity: activityProfile({
          regulatoryActivity: 'EARTHWORKS',
          measurements: { ...activityProfile().measurements, dropHeightM: 1.8 },
        }),
      })
    );
    expect(r.triggeredRules.some((h) => h.code === 'EARTHWORKS-DROP-003')).toBe(true);
  });

  it('رش تربة فعّال وارتفاع تفريغ ضمن الحدود → لا مخالفات', () => {
    const r = evaluateDustCompliance(
      context({ activity: activityProfile({ regulatoryActivity: 'EARTHWORKS' }) })
    );
    expect(r.decisionCategory).toBe('ALLOW');
  });
});

describe('محرك امتثال الغبار — قواعد الهدم', () => {
  it('هدم مكشوف مع رياح ≥15 كم/س → إيقاف إلزامي', () => {
    const r = evaluateDustCompliance(
      context({
        windSpeedKmh: 18,
        activity: activityProfile({ regulatoryActivity: 'DEMOLITION', isEnclosedOperation: false }),
      })
    );
    expect(r.decisionCategory).toBe('MANDATORY_STOP');
    expect(r.triggeredRules.some((h) => h.code === 'DEMO-WIND-STOP-001')).toBe(true);
  });

  it('هدم بلا رياح مرتفعة وبمساحة نشطة > 100م² → إيقاف النشاط المتأثر', () => {
    const r = evaluateDustCompliance(
      context({
        windSpeedKmh: 5,
        activity: activityProfile({
          regulatoryActivity: 'DEMOLITION',
          isEnclosedOperation: false,
          measurements: { ...activityProfile().measurements, demolitionActiveAreaM2: 150 },
        }),
      })
    );
    expect(r.decisionCategory).toBe('STOP_AFFECTED_ACTIVITY');
  });

  it('عملية هدم مغلقة (isEnclosedOperation) لا تُوقَف بسبب الرياح وحدها', () => {
    const r = evaluateDustCompliance(
      context({
        windSpeedKmh: 20,
        activity: activityProfile({ regulatoryActivity: 'DEMOLITION', isEnclosedOperation: true }),
      })
    );
    expect(r.triggeredRules.some((h) => h.code === 'DEMO-WIND-STOP-001')).toBe(false);
  });
});

// "الاستخراج التنظيمي من المرفق" القسم 5 — نطاق 15-25 كم/س يستوجب تثبيطاً
// معززاً (دون إيقاف) على أي نشاط مكشوف مولّد للغبار، بصرف النظر عن النشاط
// التنظيمي المحدد. regulatoryActivity: 'OTHER' الافتراضي يعزل القاعدة عن
// أي قاعدة نشاط أشد (كإيقاف الهدم الصارم بنفس النطاق).
describe('محرك امتثال الغبار — تثبيط معزز عام (15-25 كم/س)', () => {
  it('نشاط مكشوف مولّد للغبار عند رياح 18 كم/س → ALLOW_WITH_CONTROLS مع رسالة التثبيط المعزز', () => {
    const r = evaluateDustCompliance(context({ windSpeedKmh: 18 }));
    expect(r.decisionCategory).toBe('ALLOW_WITH_CONTROLS');
    expect(r.triggeredRules.some((h) => h.code === 'GATE-WIND-15-25-ENHANCED-005')).toBe(true);
  });

  // خطأ مكتشَف ومُصلَح: isEnclosedOperation وحده لم يعد يُعفي من بوابتي
  // الرياح — الإعفاء الوحيد محصور بمحطة الخلط (BATCHING_PLANT) بشرطيها
  // (صوامع مغلقة + فلتر PM10 كافٍ). نشاط مغلق آخر (هدم، حفر، إلخ) يتأثر
  // ببوابة 15-25 مثل أي نشاط مكشوف تماماً.
  it('نشاط مغلق (isEnclosedOperation، ليس محطة خلط) عند رياح 18 كم/س → تثبيط معزز يُطبَّق أيضاً', () => {
    const r = evaluateDustCompliance(
      context({ windSpeedKmh: 18, activity: activityProfile({ isEnclosedOperation: true }) })
    );
    expect(r.triggeredRules.some((h) => h.code === 'GATE-WIND-15-25-ENHANCED-005')).toBe(true);
  });

  it('رياح هادئة (10 كم/س) → لا تثبيط معزز', () => {
    const r = evaluateDustCompliance(context({ windSpeedKmh: 10 }));
    expect(r.triggeredRules.some((h) => h.code === 'GATE-WIND-15-25-ENHANCED-005')).toBe(false);
  });

  it('هدم مكشوف عند رياح 18 كم/س → يبقى إيقافاً إلزامياً (لا يُخفَّف بالتثبيط المعزز)', () => {
    const r = evaluateDustCompliance(
      context({
        windSpeedKmh: 18,
        activity: activityProfile({ regulatoryActivity: 'DEMOLITION', isEnclosedOperation: false }),
      })
    );
    expect(r.decisionCategory).toBe('MANDATORY_STOP');
  });
});

// حدود PM10 — 3 مستويات فقط (طلب صريح من المستخدم، توحيد عن 4 فروع سابقة
// في ACTIVE_RULE_BUNDLE=2026.2): ≤249 سماح، 250-340 تحذير+تحكم معزَّز موحَّد
// (بلا تدرّج احتراز/تقييد داخلي)، >340 معلَّق/مؤكَّد.
describe('محرك امتثال الغبار — حدود PM10 التنظيمية', () => {
  it('PM10=340 (الحد الأقصى لنطاق التحذير الموحَّد بالضبط) → ALLOW_WITH_CONTROLS، ليس مخالفة', () => {
    const r = evaluateDustCompliance(context({ pm10UgM3: 340 }));
    expect(r.decisionCategory).toBe('ALLOW_WITH_CONTROLS');
    expect(r.triggeredRules.some((h) => h.code === 'PM10-WARNING-008')).toBe(true);
  });

  it('PM10=330 (ضمن نطاق التحذير الموحَّد) → ALLOW_WITH_CONTROLS', () => {
    const r = evaluateDustCompliance(context({ pm10UgM3: 330 }));
    expect(r.decisionCategory).toBe('ALLOW_WITH_CONTROLS');
    expect(r.triggeredRules.some((h) => h.code === 'PM10-WARNING-008')).toBe(true);
  });

  it('PM10=260 (ضمن نطاق التحذير الموحَّد) → ALLOW_WITH_CONTROLS مع تحذير', () => {
    const r = evaluateDustCompliance(context({ pm10UgM3: 260 }));
    expect(r.decisionCategory).toBe('ALLOW_WITH_CONTROLS');
    expect(r.triggeredRules.some((h) => h.code === 'PM10-WARNING-008')).toBe(true);
  });

  it('PM10=345 (≥340) بلا بيانات استمرار (undefined) → معلَّق فقط (MRQ-PM10-BLACK-PENDING-104)، لا مخالفة مؤكدة', () => {
    // RCRC-PM10-340-VIOLATION-011 يتطلب استمراراً فعلياً لأكثر من دقيقتين —
    // قراءة واحدة بلا أي دليل استمرار (sustainedMinutesAbove340 غائب) لا
    // يجوز أن تصبح إيقافاً إلزامياً غير قابل للتجاوز مباشرة (فشل آمن).
    const r = evaluateDustCompliance(context({ pm10UgM3: 345 }));
    expect(r.decisionCategory).toBe('STOP_AFFECTED_ACTIVITY');
    expect(r.triggeredRules.some((h) => h.code === 'MRQ-PM10-BLACK-PENDING-104')).toBe(true);
    expect(r.triggeredRules.some((h) => h.code === 'PM10-VIOLATION-STOP-006')).toBe(false);
    // الحالة المعلَّقة يجب أن تُعلَّم صراحة حتى لا تظهر الواجهة "إيقاف
    // إلزامي نظامي" القطعية على قرار مؤقت قابل للتحول تلقائياً.
    expect(r.pendingConfirmation).toBe(true);
  });

  it('PM10=345 (≥340) استمر لأكثر من دقيقتين → مخالفة تنظيمية مؤكدة (MANDATORY_STOP، غير قابل للتجاوز)، ليست معلَّقة', () => {
    const r = evaluateDustCompliance(context({ pm10UgM3: 345, pm10SustainedMinutesAbove340: 3 }));
    expect(r.decisionCategory).toBe('MANDATORY_STOP');
    expect(r.canOverride).toBe(false);
    expect(r.triggeredRules.some((h) => h.code === 'PM10-VIOLATION-STOP-006')).toBe(true);
    expect(r.triggeredRules.some((h) => h.code === 'MRQ-PM10-BLACK-PENDING-104')).toBe(false);
    expect(r.pendingConfirmation).toBe(false);
  });

  it('PM10=345 استمر لدقيقة واحدة فقط (أقل من دقيقتين) → يبقى معلَّقاً، لا مخالفة مؤكدة بعد', () => {
    const r = evaluateDustCompliance(context({ pm10UgM3: 345, pm10SustainedMinutesAbove340: 1 }));
    expect(r.decisionCategory).toBe('STOP_AFFECTED_ACTIVITY');
    expect(r.triggeredRules.some((h) => h.code === 'MRQ-PM10-BLACK-PENDING-104')).toBe(true);
    expect(r.pendingConfirmation).toBe(true);
  });

  // خطأ مكتشَف ومُصلَح (مراجعة كود مدير): كانت المقارنتان `pm10UgM3 >= 340`
  // و`sustainedMinutesAbove340 >= 2` تُدرجان القيمة الحدّية بالضبط (340.000
  // أو 2:00.000) ضمن "مخالفة"، رغم أن النص التنظيمي "تجاوز 340" و"أكثر من
  // دقيقتين" يعني `>` صراحة لا `>=`. الاختبارات التالية تثبّت السلوك الصحيح
  // عند الحدود الأربعة بالضبط.
  it.each([
    { pm10: 340, minutes: 60, decision: 'ALLOW_WITH_CONTROLS', label: 'PM10=340 بالضبط (لم يتجاوز) بصرف النظر عن مدة الاستمرار → تحذير/تحكم معزَّز فقط، لا معلَّق ولا مؤكَّد' },
    { pm10: 340.01, minutes: 1.99, decision: 'STOP_AFFECTED_ACTIVITY', label: 'PM10 تجاوز 340 لكن الاستمرار أقل من دقيقتين → معلَّق فقط' },
    { pm10: 340.01, minutes: 2, decision: 'STOP_AFFECTED_ACTIVITY', label: 'PM10 تجاوز 340 والاستمرار 2 دقيقة بالضبط (لم يتجاوز) → معلَّق فقط، ليس مؤكَّداً بعد' },
    { pm10: 340.01, minutes: 2.01, decision: 'MANDATORY_STOP', label: 'PM10 تجاوز 340 والاستمرار تجاوز دقيقتين فعلياً → مخالفة مؤكدة' },
  ] as const)('$label', ({ pm10, minutes, decision }) => {
    const r = evaluateDustCompliance(context({ pm10UgM3: pm10, pm10SustainedMinutesAbove340: minutes }));
    expect(r.decisionCategory).toBe(decision);
  });

  // خطأ مكتشَف ومُصلَح (مراجعة كود مدير — ملاحظة #2): كانت pm10ThresholdRule
  // تُعيد اشتقاق "مؤكَّدة" من pm10SustainedMinutesAbove340 مباشرة بمعزل تام
  // عن الأدلة الحقيقية (مصدر السلسلة device فعلاً؟ آخر قراءة حديثة؟) التي
  // تُحسَب في computeSustainedPm10Status. الاختباران التاليان يثبّتان أن
  // القرار الآن يعتمد حصراً على pm10ConfirmedViolation340/
  // pm10Suspended250For30Min الجاهزتين — لا على رقم الدقائق نفسه — بتمرير
  // رقم دقائق "يوافق" على المخالفة مع تعليم صريح بأن الدليل غير كافٍ
  // (المصدر ليس جهازاً، أو القراءة قديمة)، فالقرار يجب أن يبقى معلَّقاً.
  it('sustainedMinutesAbove340 يتجاوز دقيقتين لكن pm10ConfirmedViolation340=false صراحةً (دليل غير كافٍ) → يبقى معلَّقاً، لا مخالفة مؤكدة', () => {
    const r = evaluateDustCompliance(
      context({
        pm10UgM3: 345,
        pm10SustainedMinutesAbove340: 10, // رقم يوهم بالتأكيد لو أُعيد اشتقاقه محلياً
        pm10ConfirmedViolation340: false, // لكن الدليل الفعلي (مصدر/حداثة) غير كافٍ
      })
    );
    expect(r.decisionCategory).toBe('STOP_AFFECTED_ACTIVITY');
    expect(r.pendingConfirmation).toBe(true);
    expect(r.triggeredRules.some((h) => h.code === 'PM10-VIOLATION-STOP-006')).toBe(false);
  });

  it('sustainedMinutesAbove340 أقل من دقيقتين لكن pm10ConfirmedViolation340=true صراحةً → مخالفة مؤكدة (القرار يثق بالحقل الجاهز لا بالرقم)', () => {
    const r = evaluateDustCompliance(
      context({
        pm10UgM3: 345,
        pm10SustainedMinutesAbove340: 0.5, // رقم يوهم بعدم الاكتمال لو أُعيد اشتقاقه محلياً
        pm10ConfirmedViolation340: true, // لكن الدليل الجاهز يؤكد الاستمرار الفعلي
      })
    );
    expect(r.decisionCategory).toBe('MANDATORY_STOP');
    expect(r.pendingConfirmation).toBe(false);
    expect(r.triggeredRules.some((h) => h.code === 'PM10-VIOLATION-STOP-006')).toBe(true);
  });

  // سيناريو حقيقي رصده المستخدم بالصورة: PM10=1687.6 غير مؤكَّد بعد (أقل من
  // دقيقتين استمرار)، لكن هدم مكشوف + رياح 15-25 كم/س (DEMO-WIND-STOP-001)
  // يوقف النشاط إلزامياً بشكل مستقل تماماً وفوري. القرار النهائي MANDATORY_
  // STOP قطعي (pendingConfirmation=false)، فلا يجوز أن تظهر رسالة "معلَّق...
  // بانتظار استمرار القراءة" الخاصة بـMRQ-PM10-BLACK-PENDING-104 ضمن القواعد
  // المعروضة رغم أنها فعلياً "triggered" داخلياً — تناقض مباشر بين عنوان
  // البطاقة القطعي ونص إحدى القواعد المعروضة تحته.
  it('إيقاف مؤكَّد من قاعدة أخرى (هدم+رياح) مع PM10 معلَّق بالتوازي → قاعدة PM10 المعلَّقة تُستبعد من triggeredRules/requiredActions المعروضة', () => {
    const r = evaluateDustCompliance(
      context({
        pm10UgM3: 1687.6,
        windSpeedKmh: 18,
        activity: activityProfile({ regulatoryActivity: 'DEMOLITION', isEnclosedOperation: false }),
      })
    );
    expect(r.decisionCategory).toBe('MANDATORY_STOP');
    expect(r.pendingConfirmation).toBe(false);
    expect(r.triggeredRules.some((h) => h.code === 'DEMO-WIND-STOP-001')).toBe(true);
    // القاعدة المعلَّقة لا تظهر في القوائم المعروضة رغم أنها فعّالة داخلياً
    expect(r.triggeredRules.some((h) => h.code === 'MRQ-PM10-BLACK-PENDING-104')).toBe(false);
    expect(r.requiredActions.some((a) => a.includes('احترازياً'))).toBe(false);
  });

  // خطأ مكتشَف ومُصلَح (مراجعة كود خبير خارجي — "قاعدة PM10 معلَّقة قد
  // تتغلب على توقف مؤكَّد"): بخلاف الاختبار أعلاه (DEMO-WIND-STOP-001 أشد
  // من STOP_AFFECTED_ACTIVITY فيفوز بالأولوية العددية وحدها)، هذا السيناريو
  // يبني تعادلاً حقيقياً بنفس الشدة: BATCHING-LEAK-003 (STOP_AFFECTED_ACTIVITY
  // مؤكَّد، يُدفَع عبر applyActivityRules بعد pm10ThresholdRule ترتيبياً في
  // ruleHits) وMRQ-PM10-BLACK-PENDING-104 (STOP_AFFECTED_ACTIVITY معلَّق،
  // يُدفَع قبله) — كلاهما نفس الشدة بالضبط. decidingRule = ruleHits.find(...)
  // القديمة كانت تختار قاعدة PM10 المعلَّقة لمجرد سبقها ترتيبياً، فيظهر
  // البانر "معلَّق — بانتظار التأكيد" رغم تسرب فعلي مؤكَّد من صومعة الإسمنت
  // لا علاقة له باستمرار PM10 إطلاقاً.
  it('تعادل حقيقي بنفس الشدة (STOP_AFFECTED_ACTIVITY): تسرب صومعة مؤكَّد + PM10 معلَّق بالتوازي → القاعدة المؤكَّدة تفوز، لا معلَّق', () => {
    const r = evaluateDustCompliance(
      context({
        pm10UgM3: 345,
        pm10ConfirmedViolation340: false, // معلَّق: لم يثبت استمرار >دقيقتين بعد
        activity: activityProfile({
          regulatoryActivity: 'BATCHING_PLANT',
          controls: { ...activityProfile().controls, leakDetected: true },
        }),
      })
    );
    expect(r.decisionCategory).toBe('STOP_AFFECTED_ACTIVITY');
    expect(r.triggeredRules.some((h) => h.code === 'BATCHING-LEAK-003')).toBe(true);
    // القرار يجب أن يفوز بالتفسير المؤكَّد (تسرب) لا المعلَّق (PM10) رغم
    // تعادل الشدة العددية بينهما بالضبط
    expect(r.pendingConfirmation).toBe(false);
    expect(r.shortReasonAr).toContain('تسرب');
    expect(r.shortReasonAr).not.toContain('بانتظار');
    // القاعدة المعلَّقة لا تظهر في القوائم المعروضة (نفس معاملة الاختبار أعلاه)
    expect(r.triggeredRules.some((h) => h.code === 'MRQ-PM10-BLACK-PENDING-104')).toBe(false);
  });

  it('نفس تعادل الشدة، لكن كلتا القاعدتين معلَّقتان معاً → pendingConfirmation يبقى true (لا قاعدة مؤكَّدة بينهما لتفضيلها)', () => {
    // GATE-DVI-002 بseverity=STOP_AFFECTED_ACTIVITY تُعامَل كمعلَّقة أيضاً
    // حين تكون PM10 لحظياً وحده سبب dviMandatoryStop — راجع isPendingRuleHit.
    const r = evaluateDustCompliance(
      context({
        pm10UgM3: 345,
        pm10ConfirmedViolation340: false,
        dviMandatoryStop: true,
        dviMandatoryStopIsPm10Only: true,
      })
    );
    expect(r.decisionCategory).toBe('STOP_AFFECTED_ACTIVITY');
    expect(r.pendingConfirmation).toBe(true);
  });

  it('PM10=260 (≥250) استمر 30 دقيقة متواصلة → تعليق النشاط (RCRC-PM10-30M-SUSPENSION-012)، ليس معلَّقاً (تعليق مؤكَّد لا احترازي)', () => {
    const r = evaluateDustCompliance(context({ pm10UgM3: 260, pm10SustainedMinutesAbove250: 30 }));
    expect(r.decisionCategory).toBe('STOP_AFFECTED_ACTIVITY');
    expect(r.triggeredRules.some((h) => h.code === 'RCRC-PM10-30M-SUSPENSION-012')).toBe(true);
    expect(r.pendingConfirmation).toBe(false);
  });

  it('PM10=260 (≥250) استمر 20 دقيقة فقط (أقل من 30) → لا تعليق، تحذير عادي فقط', () => {
    const r = evaluateDustCompliance(context({ pm10UgM3: 260, pm10SustainedMinutesAbove250: 20 }));
    expect(r.triggeredRules.some((h) => h.code === 'RCRC-PM10-30M-SUSPENSION-012')).toBe(false);
    expect(r.triggeredRules.some((h) => h.code === 'PM10-WARNING-008')).toBe(true);
  });

  // خطأ مكتشَف ومُصلَح (طلب صريح من المستخدم — توحيد إلى 3 مستويات فقط، لا
  // 4): كان نطاق 201-249 يُصنَّف "احتراز" (PRECAUTION) منفصلاً عن نطاق
  // التحذير 250-339. الإصلاح: normalMaxInclusive أصبح 249 — أي قراءة ≤249
  // الآن ALLOW نظيف بلا أي قاعدة PM10 مفعَّلة (لا "احتراز" وسيط)، مطابقةً
  // للوثيقة التنظيمية حرفياً (<250 → لا Trigger خاص بـPM10).
  it('PM10=220 (دون حد التحذير 250) → ALLOW نظيف، لا قاعدة PM10 مفعَّلة إطلاقاً', () => {
    const r = evaluateDustCompliance(context({ pm10UgM3: 220 }));
    expect(r.decisionCategory).toBe('ALLOW');
    expect(r.triggeredRules.some((h) => h.code.startsWith('PM10-'))).toBe(false);
    expect(r.canOverride).toBe(true);
  });

  it('PM10=200 → لا قاعدة PM10 تنظيمية مفعّلة إطلاقاً', () => {
    const r = evaluateDustCompliance(context({ pm10UgM3: 200 }));
    expect(r.triggeredRules.some((h) => h.code.startsWith('PM10-'))).toBe(false);
    expect(r.decisionCategory).toBe('ALLOW');
  });

  it('PM10=249 (أقصى نطاق السماح قبل التحذير بالضبط) → لا يزال ALLOW نظيف، ليس تحذيراً', () => {
    const r = evaluateDustCompliance(context({ pm10UgM3: 249 }));
    expect(r.decisionCategory).toBe('ALLOW');
    expect(r.triggeredRules.some((h) => h.code === 'PM10-WARNING-008')).toBe(false);
  });

  it('PM10=250 (الحد الأدنى لنطاق التحذير بالضبط) → يُفعَّل التحذير، لا سماحاً', () => {
    const r = evaluateDustCompliance(context({ pm10UgM3: 250 }));
    expect(r.decisionCategory).toBe('ALLOW_WITH_CONTROLS');
    expect(r.triggeredRules.some((h) => h.code === 'PM10-WARNING-008')).toBe(true);
  });

  it('PM10=250 استمر 30 دقيقة متواصلة → تعليق النشاط (RCRC-PM10-30M-SUSPENSION-012) — القيمة الحدّية بالضبط يجب أن تُفعِّل التعليق', () => {
    const r = evaluateDustCompliance(context({ pm10UgM3: 250, pm10SustainedMinutesAbove250: 30 }));
    expect(r.decisionCategory).toBe('STOP_AFFECTED_ACTIVITY');
    expect(r.triggeredRules.some((h) => h.code === 'RCRC-PM10-30M-SUSPENSION-012')).toBe(true);
  });

  it('PM10=339 (ضمن نطاق التحذير الموحَّد قبل حد المخالفة 340) → لا يزال ALLOW_WITH_CONTROLS', () => {
    const r = evaluateDustCompliance(context({ pm10UgM3: 339 }));
    expect(r.decisionCategory).toBe('ALLOW_WITH_CONTROLS');
    expect(r.triggeredRules.some((h) => h.code === 'PM10-WARNING-008')).toBe(true);
  });
});

describe('محرك امتثال الغبار — أعلى من 25 كم/س (بروتوكول الرياح)', () => {
  it('نشاط مكشوف مع رياح فوق 25 كم/س وبلا رصد ساعي → تقييد على الأقل', () => {
    const r = evaluateDustCompliance(
      context({
        windSpeedKmh: 30,
        activity: activityProfile({ regulatoryActivity: 'ENTRY_EXIT', controls: { ...activityProfile().controls, hourlyInspectionRecorded: false } }),
      })
    );
    // فوق 25، بروتوكول الرياح يوصي بإيقاف الأنشطة المكشوفة عموماً؛ هنا نتحقق
    // فقط أن القرار ليس ALLOW الصريح (يجب أن تُثار قاعدة تقييد/إيقاف واحدة على الأقل)
    expect(r.decisionCategory).not.toBe('ALLOW');
  });

  // خطأ مكتشَف ومُصلَح — سيناريو حقيقي رصده المستخدم: نشاط هدم مغلق برياح
  // 39.78 كم/س ظهر "مسموح" رغم أن نطاق الرياح ABOVE_25، رغم عدم وجود سند
  // تنظيمي موثَّق يُعفي أي نشاط مغلق (خلاف محطة الخلط بشرطيها) من بوابة
  // الرياح — isEnclosedOperation وحده لم يعد كافياً للإعفاء.
  it('عملية مغلقة (isEnclosedOperation=true، ليست محطة خلط) لا تُستثنى من بوابة إيقاف الرياح فوق 25', () => {
    const r = evaluateDustCompliance(
      context({
        windSpeedKmh: 39.78,
        activity: activityProfile({
          regulatoryActivity: 'DEMOLITION',
          isEnclosedOperation: true,
          // نضمن استيفاء بقية قواعد الهدم حتى لا تُثار قاعدة أخرى تحجب النتيجة
          controls: {
            ...activityProfile().controls,
            continuousMisting: true,
            sprayCannonAvailable: true,
            dustScreensAvailable: true,
          },
        }),
      })
    );
    expect(r.windBand).toBe('ABOVE_25');
    expect(r.isEnclosedOperation).toBe(true);
    expect(r.triggeredRules.some((h) => h.code === 'GATE-WIND-ABOVE-25-004')).toBe(true);
  });

  it('النتيجة تحمل isEnclosedOperation=false افتراضياً لنشاط مكشوف', () => {
    const r = evaluateDustCompliance(context({ activity: activityProfile({ isEnclosedOperation: false }) }));
    expect(r.isEnclosedOperation).toBe(false);
  });

  // خطأ مكتشَف ومُصلَح (مراجعة كود خبير خارجي — "نطاق الرياح النظامي يستخدم
  // رقمًا مشتقًا من الهبات"): windBand (بروتوكول الملحق أ) كان يُبنى من
  // effectiveWindKmh = max(سرعة، 0.85×هبة) بدل سرعة الرياح الخام — فهبة
  // عابرة كانت تكفي لتصنيف "سرعة مستدامة >25 كم/س" وتفعيل GATE-WIND-ABOVE-
  // 25-004 (إيقاف تنظيمي) بلا أي استمرار فعلي. الآن windBand مبني حصراً من
  // ctx.windSpeedKmh الخام؛ الهبات لها قاعدة سلامة منفصلة (GATE-WIND-GUST-
  // SAFETY) لا تؤثر على windBand ولا تصل شدة الإيقاف الإلزامي.
  it('سرعة رياح مستدامة 18 كم/س + هبة قصيرة 30 كم/س → windBand يبقى FROM_15_TO_25 (لا ABOVE_25 من الهبة)', () => {
    const r = evaluateDustCompliance(context({ windSpeedKmh: 18, windGustKmh: 30 }));
    expect(r.windBand).toBe('FROM_15_TO_25');
    expect(r.triggeredRules.some((h) => h.code === 'GATE-WIND-ABOVE-25-004')).toBe(false);
  });

  it('سرعة رياح مستدامة 10 كم/س + هبة قوية جداً 60 كم/س → windBand يبقى BELOW_15 (الهبة لا تُحسب ضمن السرعة النظامية)', () => {
    const r = evaluateDustCompliance(context({ windSpeedKmh: 10, windGustKmh: 60 }));
    expect(r.windBand).toBe('BELOW_15');
    expect(r.triggeredRules.some((h) => h.code === 'GATE-WIND-ABOVE-25-004')).toBe(false);
    expect(r.triggeredRules.some((h) => h.code === 'GATE-WIND-15-25-ENHANCED-005')).toBe(false);
  });

  describe('GATE-WIND-GUST-SAFETY — احتراز هبات منفصل عن بروتوكول الملحق أ', () => {
    it('هبة ≥50 كم/س لنشاط مكشوف مولّد للغبار → GATE-WIND-GUST-SAFETY يُفعَّل (تنبيه، لا إيقاف إلزامي)', () => {
      const r = evaluateDustCompliance(context({ windSpeedKmh: 10, windGustKmh: 55 }));
      expect(r.triggeredRules.some((h) => h.code === 'GATE-WIND-GUST-SAFETY')).toBe(true);
      const hit = r.triggeredRules.find((h) => h.code === 'GATE-WIND-GUST-SAFETY');
      expect(hit?.severity).toBe('ALLOW_WITH_CONTROLS');
      expect(r.decisionCategory).not.toBe('MANDATORY_STOP');
    });

    it('هبة 49.99 كم/س (تحت العتبة) → GATE-WIND-GUST-SAFETY لا يُفعَّل', () => {
      const r = evaluateDustCompliance(context({ windSpeedKmh: 10, windGustKmh: 49.99 }));
      expect(r.triggeredRules.some((h) => h.code === 'GATE-WIND-GUST-SAFETY')).toBe(false);
    });

    it('عملية مغلقة (isEnclosedOperation=true، ليست محطة خلط) لا تُستثنى من احتراز الهبات', () => {
      const r = evaluateDustCompliance(
        context({
          windSpeedKmh: 10,
          windGustKmh: 60,
          activity: activityProfile({ isEnclosedOperation: true }),
        })
      );
      expect(r.triggeredRules.some((h) => h.code === 'GATE-WIND-GUST-SAFETY')).toBe(true);
    });

    it('هبة قوية بلا نشاط مولّد للغبار (isDustGenerating=false) → لا تُفعَّل', () => {
      const r = evaluateDustCompliance(
        context({
          windSpeedKmh: 10,
          windGustKmh: 60,
          activity: activityProfile({ isDustGenerating: false }),
        })
      );
      expect(r.triggeredRules.some((h) => h.code === 'GATE-WIND-GUST-SAFETY')).toBe(false);
    });
  });

  // ربط استثناء البيتشنج بكفاءة فلتر PM10 + إحكام إغلاق الصوامع تحديداً —
  // لا يُشترط isEnclosedOperation إطلاقاً لمحطة الخلط (قد تكون مكشوفة
  // هيكلياً)، طلب صريح من المستخدم: "حتى لو كان مكشوف بس الفلاتر 99
  // والصوامع مغلق أبغاه يكون مسموح".
  it('محطة خلط بصوامع مغلقة + كفاءة فلتر ≥99% مستثناة من بوابة إيقاف الرياح فوق 25 (حتى لو مكشوفة)', () => {
    const r = evaluateDustCompliance(
      context({
        windSpeedKmh: 30,
        activity: activityProfile({
          regulatoryActivity: 'BATCHING_PLANT',
          isEnclosedOperation: false,
          controls: { ...activityProfile().controls, silosSealed: true, pm10FilterEfficiencyPercent: 99.5 },
        }),
      })
    );
    expect(r.windBand).toBe('ABOVE_25');
    expect(r.triggeredRules.some((h) => h.code === 'GATE-WIND-ABOVE-25-004')).toBe(false);
  });

  it('محطة خلط بصوامع مغلقة بكفاءة فلتر أقل من 99% لا تُستثنى من بوابة إيقاف الرياح فوق 25', () => {
    const r = evaluateDustCompliance(
      context({
        windSpeedKmh: 30,
        activity: activityProfile({
          regulatoryActivity: 'BATCHING_PLANT',
          controls: { ...activityProfile().controls, silosSealed: true, pm10FilterEfficiencyPercent: 95 },
        }),
      })
    );
    expect(r.triggeredRules.some((h) => h.code === 'GATE-WIND-ABOVE-25-004')).toBe(true);
  });

  it('محطة خلط بصوامع مغلقة بلا قيمة كفاءة فلتر مُدخلة (null) لا تُستثنى من بوابة إيقاف الرياح', () => {
    const r = evaluateDustCompliance(
      context({
        windSpeedKmh: 30,
        activity: activityProfile({
          regulatoryActivity: 'BATCHING_PLANT',
          controls: { ...activityProfile().controls, silosSealed: true, pm10FilterEfficiencyPercent: null },
        }),
      })
    );
    expect(r.triggeredRules.some((h) => h.code === 'GATE-WIND-ABOVE-25-004')).toBe(true);
  });

  it('محطة خلط بصوامع غير مغلقة (silosSealed=false) بكفاءة فلتر ≥99% لا تُستثنى من بوابة إيقاف الرياح', () => {
    const r = evaluateDustCompliance(
      context({
        windSpeedKmh: 30,
        activity: activityProfile({
          regulatoryActivity: 'BATCHING_PLANT',
          controls: { ...activityProfile().controls, silosSealed: false, pm10FilterEfficiencyPercent: 99.5 },
        }),
      })
    );
    expect(r.triggeredRules.some((h) => h.code === 'GATE-WIND-ABOVE-25-004')).toBe(true);
  });

  // الإعفاء من بوابة الرياح مقصور على محطة الخلط (BATCHING_PLANT) بشرطيها
  // فقط — نشاط هدم مغلق لا يستفيد من أي إعفاء بصرف النظر عن ضوابطه الأخرى
  // (رش مستمر، مدافع رش، شاشات غبار)، لأن isEnclosedOperation وحده لا يعفي.
  it('نشاط هدم مغلق (ليس محطة خلط) يتأثر ببوابة إيقاف الرياح رغم توفر كل ضوابط الهدم الأخرى', () => {
    const r = evaluateDustCompliance(
      context({
        windSpeedKmh: 30,
        activity: activityProfile({
          regulatoryActivity: 'DEMOLITION',
          isEnclosedOperation: true,
          controls: {
            ...activityProfile().controls,
            pm10FilterEfficiencyPercent: null,
            continuousMisting: true,
            sprayCannonAvailable: true,
            dustScreensAvailable: true,
          },
        }),
      })
    );
    expect(r.triggeredRules.some((h) => h.code === 'GATE-WIND-ABOVE-25-004')).toBe(true);
  });

  // خطأ مكتشَف ومُصلَح (مراجعة كود خبير خارجي — "إعفاء محطة الخلط مخالف
  // للمرجع"): كانت محطة الخلط (صوامع مغلقة + فلتر ≥99%) تُعفى بالكامل من كل
  // قواعد PM10 (250/340/تعليق 30 دقيقة)، بنفس شرط إعفاء بوابة الرياح >25.
  // لكن نسبة الـ99% نفسها (BATCHING_PM10_FILTER_MIN_PERCENT في rulebook.ts)
  // موثّقة تنظيمياً كـ"الحد المعتمد للاستمرار أثناء إيقاف الرياح فوق 25
  // كم/س" فقط — لا كإعفاء من عتبات تركيز PM10 المستقلة (قياس فعلي في الهواء
  // بصرف النظر عن سرعة الرياح). الاختبارات أدناه تعكس التوقعات: محطة الخلط
  // المستوفية للشرطين تبقى مستثناة من بوابتي الرياح فقط (راجع الاختبارات
  // أعلاه)، وتخضع الآن لقواعد PM10 كأي نشاط آخر.
  const exemptBatchingActivity = () =>
    activityProfile({
      regulatoryActivity: 'BATCHING_PLANT',
      isEnclosedOperation: false,
      controls: { ...activityProfile().controls, silosSealed: true, pm10FilterEfficiencyPercent: 99.5 },
      // مسافة آمنة صراحةً (BATCHING-DISTANCE-200 غير موضوع اختبار هذه
      // الحالات — تختبر فقط سلوك قواعد PM10) — بلا هذا، الافتراضي null
      // (لا إحداثيات مُدخلة) يُفعِّل BATCHING-DISTANCE-MISSING/
      // FIELD_VERIFICATION_REQUIRED ويُخفي قرار PM10 الفعلي محل الاختبار.
      measurements: { ...activityProfile().measurements, batchingDistanceToNearestReceptorAutoM: 1000 },
    });

  it('محطة خلط مغلقة بكفاءة فلتر ≥99% + PM10=1500 مستمرة >دقيقتين → مخالفة تنظيمية مؤكدة كأي نشاط آخر (لا إعفاء PM10)', () => {
    const r = evaluateDustCompliance(
      context({ pm10UgM3: 1500, pm10SustainedMinutesAbove340: 5, pm10ConfirmedViolation340: true, activity: exemptBatchingActivity() })
    );
    expect(r.triggeredRules.some((h) => h.code === 'PM10-VIOLATION-STOP-006')).toBe(true);
    expect(r.decisionCategory).toBe('MANDATORY_STOP');
  });

  it('محطة خلط مغلقة بكفاءة فلتر ≥99% + PM10=260 مستمرة 30 دقيقة → تعليق النشاط كأي نشاط آخر (لا إعفاء)', () => {
    const r = evaluateDustCompliance(
      context({
        pm10UgM3: 260,
        pm10SustainedMinutesAbove250: 30,
        pm10Suspended250For30Min: true,
        activity: exemptBatchingActivity(),
      })
    );
    expect(r.triggeredRules.some((h) => h.code === 'RCRC-PM10-30M-SUSPENSION-012')).toBe(true);
    expect(r.decisionCategory).toBe('STOP_AFFECTED_ACTIVITY');
  });

  it('محطة خلط مغلقة بكفاءة فلتر ≥99% + PM10=220 (دون حد التحذير 250) → لا قاعدة PM10 مفعَّلة كأي نشاط آخر (لا إعفاء)', () => {
    const r = evaluateDustCompliance(context({ pm10UgM3: 220, activity: exemptBatchingActivity() }));
    expect(r.triggeredRules.some((h) => h.code.startsWith('PM10-'))).toBe(false);
    expect(r.decisionCategory).toBe('ALLOW');
  });

  it('محطة خلط بصوامع مغلقة بكفاءة فلتر أقل من 99% + PM10=1500 مستمرة → مخالفة مؤكَّدة كالمعتاد (بلا تغيير)', () => {
    const r = evaluateDustCompliance(
      context({
        pm10UgM3: 1500,
        pm10SustainedMinutesAbove340: 5,
        pm10ConfirmedViolation340: true,
        activity: activityProfile({
          regulatoryActivity: 'BATCHING_PLANT',
          controls: { ...activityProfile().controls, silosSealed: true, pm10FilterEfficiencyPercent: 95 },
        }),
      })
    );
    expect(r.decisionCategory).toBe('MANDATORY_STOP');
  });

  it('محطة خلط مكشوفة (isEnclosedOperation=false) بصوامع مغلقة + فلتر ≥99% + PM10=1500 مستمرة → مخالفة مؤكَّدة (الإغلاق الهيكلي/الفلتر لا يعفيان من PM10)', () => {
    const r = evaluateDustCompliance(
      context({
        pm10UgM3: 1500,
        pm10SustainedMinutesAbove340: 5,
        pm10ConfirmedViolation340: true,
        activity: activityProfile({
          regulatoryActivity: 'BATCHING_PLANT',
          isEnclosedOperation: false,
          controls: { ...activityProfile().controls, silosSealed: true, pm10FilterEfficiencyPercent: 99.5 },
        }),
      })
    );
    expect(r.decisionCategory).toBe('MANDATORY_STOP');
  });

  // خطأ مكتشَف ومُصلَح: كان enhancedSuppressionRule (GATE-WIND-15-25-ENHANCED-005)
  // يستقبل ctx.activity.isEnclosedOperation الخام بدل isEnclosedExemptFromHighWind
  // — فمحطة خلط مكشوفة فيزيائياً لكن مستثناة فعلياً (صوامع مغلقة + فلتر
  // ≥99%) كانت لا تزال تُفعِّل هذي القاعدة عند رياح 15-25 كم/س، رغم استثنائها
  // الكامل من بوابة الرياح الأشد (>25) وقواعد PM10 معاً — تناقض: "مستثناة
  // من كل شيء" إلا هذي القاعدة تحديداً بلا سبب. طلب المستخدم الصريح: توفر
  // الشرطين (فلتر ≥99% وصوامع مغلقة) يخلي التشغيل طبيعياً دام لا إيقاف ولا
  // تثبيط إضافي مفروض بسبب الرياح وحدها.
  it('محطة خلط مكشوفة بصوامع مغلقة + فلتر ≥99% عند رياح 15-25 كم/س → لا GATE-WIND-15-25-ENHANCED-005 (استثناء كامل، لا تثبيط إضافي)', () => {
    const r = evaluateDustCompliance(
      context({
        windSpeedKmh: 18,
        activity: activityProfile({
          regulatoryActivity: 'BATCHING_PLANT',
          isEnclosedOperation: false,
          controls: { ...activityProfile().controls, silosSealed: true, pm10FilterEfficiencyPercent: 99.5 },
        }),
      })
    );
    expect(r.triggeredRules.some((h) => h.code === 'GATE-WIND-15-25-ENHANCED-005')).toBe(false);
  });

  it('محطة خلط مكشوفة بصوامع غير مغلقة عند رياح 15-25 كم/س → GATE-WIND-15-25-ENHANCED-005 يُفعَّل (الاستثناء غير مكتمل)', () => {
    const r = evaluateDustCompliance(
      context({
        windSpeedKmh: 18,
        activity: activityProfile({
          regulatoryActivity: 'BATCHING_PLANT',
          isEnclosedOperation: false,
          controls: { ...activityProfile().controls, silosSealed: false, pm10FilterEfficiencyPercent: 99.5 },
        }),
      })
    );
    expect(r.triggeredRules.some((h) => h.code === 'GATE-WIND-15-25-ENHANCED-005')).toBe(true);
  });

  // خطأ مكتشَف ومُصلَح (مراجعة كود خبير خارجي): pm10RulesExempt (كان يُخفي
  // عدّادات PM10 في الواجهة لمحطة خلط "معفاة") حُذف بالكامل من
  // DustComplianceResult — لم يعد هناك أي إعفاء PM10 يُعفى الحقل عنه.
  it('DustComplianceResult لا يحمل حقل pm10RulesExempt إطلاقاً (محذوف مع إزالة إعفاء PM10)', () => {
    const r = evaluateDustCompliance(
      context({
        pm10UgM3: 500,
        pm10SustainedMinutesAbove250: 35,
        activity: activityProfile({
          regulatoryActivity: 'BATCHING_PLANT',
          isEnclosedOperation: false,
          controls: { ...activityProfile().controls, silosSealed: true, pm10FilterEfficiencyPercent: 99.5 },
        }),
      })
    );
    expect('pm10RulesExempt' in r).toBe(false);
  });

  it('محطة خلط بصوامع غير مغلقة (silosSealed=false) بكفاءة فلتر ≥99% + PM10=1500 مستمرة → مخالفة مؤكَّدة (الصوامع لم تكن شرط إعفاء PM10 أصلاً، والآن لا إعفاء PM10 مطلقاً)', () => {
    const r = evaluateDustCompliance(
      context({
        pm10UgM3: 1500,
        pm10SustainedMinutesAbove340: 5,
        pm10ConfirmedViolation340: true,
        activity: activityProfile({
          regulatoryActivity: 'BATCHING_PLANT',
          controls: { ...activityProfile().controls, silosSealed: false, pm10FilterEfficiencyPercent: 99.5 },
        }),
      })
    );
    expect(r.decisionCategory).toBe('MANDATORY_STOP');
  });

  it('نشاط هدم مغلق (غير BATCHING_PLANT) بلا كفاءة فلتر + PM10=1500 مستمرة → مخالفة مؤكَّدة كأي نشاط (لا إعفاء PM10 لأي نشاط الآن)', () => {
    const r = evaluateDustCompliance(
      context({
        pm10UgM3: 1500,
        pm10SustainedMinutesAbove340: 5,
        pm10ConfirmedViolation340: true,
        activity: activityProfile({
          regulatoryActivity: 'DEMOLITION',
          isEnclosedOperation: true,
          controls: { ...activityProfile().controls, pm10FilterEfficiencyPercent: null },
        }),
      })
    );
    expect(r.decisionCategory).toBe('MANDATORY_STOP');
  });
});

describe('محرك امتثال الغبار — منع الاستئناف التلقائي الفوري بعد إيقاف', () => {
  it('بلا قرار سابق مسجَّل، لا قيد يُطبَّق (سلوك اليوم بلا تغيير)', () => {
    const r = evaluateDustCompliance(context({ windSpeedKmh: 10, pm10UgM3: 20 }));
    expect(r.decisionCategory).toBe('ALLOW');
  });

  it('قرار سابق MANDATORY_STOP + القراءة تحسّنت لكن الاستقرار بدأ منذ أقل من 10 دقائق → يبقى موقِفاً (لا استئناف فوري)', () => {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60000).toISOString();
    const r = evaluateDustCompliance(
      context({
        windSpeedKmh: 10,
        pm10UgM3: 20,
        previousDecisionCategory: 'MANDATORY_STOP',
        previousPendingResumeSince: fiveMinutesAgo,
      })
    );
    expect(r.decisionCategory).toBe('STOP_AFFECTED_ACTIVITY');
    // خطأ معماري مكتشَف ومُصلَح (مراجعة كود خبير خارجي — "الفصل بين القواعد
    // والقرار النهائي غير مكتمل"): كان canOverride يُشتق من decisionCategory
    // العامة فقط (STOP_AFFECTED_ACTIVITY = دائماً false)، بصرف النظر عن كون
    // السبب الفعلي مخالفة تنظيمية مؤكَّدة أم مجرد حجز زمني احترازي. حجز
    // استقرار الاستئناف (RESUME-STABILITY-HOLD) الآن قاعدة DustRuleHit فعلية
    // بـoverridable=true (راجع overridable في types.ts وengine.ts) — فهو
    // "انتظر قليلاً أكثر"، لا مخالفة قائمة بذاتها كـGATE-SUPPRESSION-003
    // (الذي يبقى overridable=false بوضوح). canOverride تعكس الآن قابلية
    // القاعدة الفعلية الحاسمة، لا فئة القرار العامة.
    expect(r.canOverride).toBe(true);
    expect(r.resumeHoldApplied).toBe(true);
    expect(r.restartConditions.some((c) => c.includes('10 دقائق'))).toBe(true);
  });

  // الحالة التي كانت مكسورة فعلياً قبل الإصلاح: previousDecisionUpdatedAt
  // (بداية الإيقاف نفسه) لم يعد يُستخدم لحساب الاستقرار إطلاقاً — لو تُرك
  // كإشارة وحيدة (بلا previousPendingResumeSince) يجب ألا يُستأنف فوراً حتى
  // لو مضى على بداية الإيقاف أكثر من 10 دقائق، لأن هذا لا يعني تراكم أي
  // دقيقة فعلية من القراءة الجيدة بعد.
  it('previousDecisionUpdatedAt قديم (15 دقيقة) لكن previousPendingResumeSince غائب → لا يُستأنف فوراً (لم يبدأ الاستقرار فعلياً بعد)', () => {
    const fifteenMinutesAgo = new Date(Date.now() - 15 * 60000).toISOString();
    const r = evaluateDustCompliance(
      context({
        windSpeedKmh: 10,
        pm10UgM3: 20,
        previousDecisionCategory: 'STOP_AFFECTED_ACTIVITY',
        previousDecisionUpdatedAt: fifteenMinutesAgo,
        previousPendingResumeSince: null,
      })
    );
    expect(r.decisionCategory).toBe('STOP_AFFECTED_ACTIVITY');
    expect(r.resumeHoldApplied).toBe(true);
  });

  it('previousPendingResumeSince منذ 15 دقيقة (أكثر من 10) + قراءة حالية جيدة → يستأنف طبيعياً', () => {
    const fifteenMinutesAgo = new Date(Date.now() - 15 * 60000).toISOString();
    const r = evaluateDustCompliance(
      context({
        windSpeedKmh: 10,
        pm10UgM3: 20,
        previousDecisionCategory: 'STOP_AFFECTED_ACTIVITY',
        previousPendingResumeSince: fifteenMinutesAgo,
      })
    );
    expect(r.decisionCategory).toBe('ALLOW');
    expect(r.resumeHoldApplied).toBe(false);
  });

  it('قرار سابق موقِف بلا previousDecisionCategory إطلاقاً → فشل آمن، لا يُطبَّق قيد', () => {
    const r = evaluateDustCompliance(
      context({
        windSpeedKmh: 10,
        pm10UgM3: 20,
        previousDecisionCategory: null,
      })
    );
    expect(r.decisionCategory).toBe('ALLOW');
  });

  // سيناريو حقيقي رصده المستخدم: إيقاف استمر 16 دقيقة بقراءات سيئة متفرقة
  // (previousDecisionUpdatedAt قديم جداً)، ثم تحسّنت القراءة الآن أخيراً —
  // previousPendingResumeSince غائب (هذه أول لحظة تحسّن) → يجب أن يُطبَّق
  // القيد لدقائق العشر القادمة، لا استئناف فوري رغم قِدَم previousDecisionUpdatedAt.
  it('إيقاف استمر طويلاً (previousDecisionUpdatedAt قديم جداً) لكن القراءة تحسّنت الآن للتو → يُطبَّق القيد من الصفر، لا استئناف فوري', () => {
    const sixteenMinutesAgo = new Date(Date.now() - 16 * 60000).toISOString();
    const r = evaluateDustCompliance(
      context({
        windSpeedKmh: 10,
        pm10UgM3: 20,
        previousDecisionCategory: 'MANDATORY_STOP',
        previousDecisionUpdatedAt: sixteenMinutesAgo,
        previousPendingResumeSince: null,
      })
    );
    expect(r.decisionCategory).toBe('STOP_AFFECTED_ACTIVITY');
    expect(r.resumeHoldApplied).toBe(true);
  });

  it('قرار سابق ALLOW (لم يكن موقِفاً أصلاً) → لا قيد حتى لو كان حديثاً جداً', () => {
    const r = evaluateDustCompliance(
      context({
        windSpeedKmh: 30, // فوق 25 — يجب أن يُوقف أنشطة مكشوفة كالمعتاد
        previousDecisionCategory: 'ALLOW',
        previousDecisionUpdatedAt: new Date().toISOString(),
      })
    );
    expect(r.decisionCategory).not.toBe('ALLOW');
  });

  // خطأ مكتشَف ومُصلَح (مراجعة كود خبير خارجي — H-07: "الاستئناف غير حتمي،
  // يستخدم Date.now() داخل محرك القرار"): كانت الدالة تستدعي Date.now()
  // مباشرة، فتُنتج نتائج مختلفة حسب لحظة الاستدعاء الفعلية حتى مع نفس
  // المدخلات بالضبط — يخالف التوصيف الصريح للدالة كـ"نقية بلا I/O". now
  // معامل صريح الآن يجعل النتيجة قابلة لإعادة الإنتاج بالكامل بمعزل عن
  // ساعة النظام الفعلية.
  it('H-07: evaluateDustCompliance حتمية بالكامل — نفس ctx + نفس now (صريح) ينتجان نفس القرار دائماً، بصرف النظر عن ساعة النظام الفعلية', () => {
    const fixedNow = new Date('2026-01-01T12:00:00.000Z').getTime();
    const fiveMinutesBeforeFixedNow = new Date(fixedNow - 5 * 60000).toISOString();
    const ctx = context({
      windSpeedKmh: 10,
      pm10UgM3: 20,
      previousDecisionCategory: 'MANDATORY_STOP',
      previousPendingResumeSince: fiveMinutesBeforeFixedNow,
    });

    const r1 = evaluateDustCompliance(ctx, fixedNow);
    const r2 = evaluateDustCompliance(ctx, fixedNow);

    expect(r1.decisionCategory).toBe(r2.decisionCategory);
    expect(r1.resumeHoldApplied).toBe(r2.resumeHoldApplied);
    expect(r1.evaluatedAt).toBe(r2.evaluatedAt);
    expect(r1.validUntil).toBe(r2.validUntil);
    // القراءة الجيدة بدأت منذ 5 دقائق فقط (أقل من RESUME_STABILITY_MINUTES=10)
    // نسبةً إلى fixedNow — يجب أن يبقى القيد مطبَّقاً بصرف النظر عن الوقت
    // الفعلي الحالي عند تشغيل هذا الاختبار.
    expect(r1.resumeHoldApplied).toBe(true);
    expect(r1.evaluatedAt).toBe(new Date(fixedNow).toISOString());
  });

  it('قرار سابق موقِف لكن القرار الجديد المحسوب موقِف أيضاً (لا تحسّن) → لا حاجة لقيد الاستئناف، يمر القرار الجديد كما هو', () => {
    const oneMinuteAgo = new Date(Date.now() - 60000).toISOString();
    const r = evaluateDustCompliance(
      context({
        windSpeedKmh: 30, // ABOVE_25 مكشوف → STOP_AFFECTED_ACTIVITY فعلي جديد (GATE-WIND-ABOVE-25-004)
        previousDecisionCategory: 'STOP_AFFECTED_ACTIVITY',
        previousDecisionUpdatedAt: oneMinuteAgo,
      })
    );
    expect(r.decisionCategory).toBe('STOP_AFFECTED_ACTIVITY');
    // السبب المعروض يجب أن يكون قاعدة الرياح الفعلية، لا رسالة "بانتظار
    // استقرار" العامة — لأن القيد الجديد لم يُطبَّق هنا أصلاً (لا تحسّن).
    expect(r.shortReasonAr).not.toContain('بانتظار استقرار');
  });

  // طلب صريح من المستخدم: إيقاف بوابة الرياح >25 (GATE-WIND-ABOVE-25-004)
  // لا يُستأنف عند عودة الرياح إلى 25 كم/س بالضبط — يلزم انخفاضها إلى أقل
  // من 25 صراحة. classifyWind يضع 25 بالضبط ضمن النطاق البرتقالي (لا
  // ABOVE_25)، فبلا هذا القيد المخصَّص كانت بوابة الرياح تتوقف عن التفعيل
  // فور وصول القراءة لـ25 بالضبط، فيُخلَط هذا خطأً مع جواز الاستئناف رغم
  // أن قاعدة الاستئناف التنظيمية أشد تحديداً من عتبة الإيقاف نفسها.
  describe('قاعدة استئناف خاصة ببوابة الرياح >25 — لا يُستأنف عند 25 كم/س بالضبط', () => {
    it('إيقاف سابق بسبب بوابة الرياح + الرياح الآن 25 كم/س بالضبط → يبقى موقِفاً (لا استئناف عند 25 بالضبط) حتى مع استيفاء قيد الاستقرار العام', () => {
      const fifteenMinutesAgo = new Date(Date.now() - 15 * 60000).toISOString();
      const r = evaluateDustCompliance(
        context({
          windSpeedKmh: 25,
          previousDecisionCategory: 'STOP_AFFECTED_ACTIVITY',
          previousDecidingRuleCode: 'GATE-WIND-ABOVE-25-004',
          previousPendingResumeSince: fifteenMinutesAgo,
        })
      );
      expect(r.decisionCategory).toBe('STOP_AFFECTED_ACTIVITY');
      // خطأ معماري مكتشَف ومُصلَح (مراجعة كود خبير خارجي — "الفصل بين القواعد
      // والقرار النهائي غير مكتمل"): هذا القيد كان يُعدِّل decisionCategory
      // مباشرة بمعزل تام عن ruleHits — الآن قاعدة DustRuleHit فعلية
      // (GATE-WIND-ABOVE-25-RESUME-HOLD) ظاهرة في triggeredRules وغير قابلة
      // للتجاوز (نفس عتبة GATE-WIND-ABOVE-25-004 الأصلية التي بنت الإيقاف).
      expect(r.triggeredRules.some((h) => h.code === 'GATE-WIND-ABOVE-25-RESUME-HOLD')).toBe(true);
      expect(r.decidingRuleCode).toBe('GATE-WIND-ABOVE-25-RESUME-HOLD');
      expect(r.canOverride).toBe(false);
    });

    it('إيقاف سابق بسبب بوابة الرياح + الرياح الآن 24.9 كم/س (أقل من 25 فعلياً) → يُستأنف طبيعياً (بعد استيفاء قيد الاستقرار العام أيضاً)', () => {
      const fifteenMinutesAgo = new Date(Date.now() - 15 * 60000).toISOString();
      const r = evaluateDustCompliance(
        context({
          windSpeedKmh: 24.9,
          previousDecisionCategory: 'STOP_AFFECTED_ACTIVITY',
          previousDecidingRuleCode: 'GATE-WIND-ABOVE-25-004',
          previousPendingResumeSince: fifteenMinutesAgo,
        })
      );
      expect(r.decisionCategory).not.toBe('STOP_AFFECTED_ACTIVITY');
    });

    it('إيقاف سابق بسبب بوابة الرياح + الرياح الآن 26 كم/س (لا تزال ABOVE_25) → يبقى موقِفاً بالبوابة نفسها كالمعتاد (لا حاجة لهذا القيد المخصَّص)', () => {
      const r = evaluateDustCompliance(
        context({
          windSpeedKmh: 26,
          previousDecisionCategory: 'STOP_AFFECTED_ACTIVITY',
          previousDecidingRuleCode: 'GATE-WIND-ABOVE-25-004',
        })
      );
      expect(r.decisionCategory).toBe('STOP_AFFECTED_ACTIVITY');
      expect(r.triggeredRules.some((h) => h.code === 'GATE-WIND-ABOVE-25-004')).toBe(true);
    });

    it('إيقاف سابق من MANDATORY_STOP (لا STOP_AFFECTED_ACTIVITY) + الرياح 25 بالضبط → لا يُطبَّق هذا القيد المخصَّص (خاص ببوابة الرياح فقط)', () => {
      const r = evaluateDustCompliance(
        context({
          windSpeedKmh: 25,
          pm10UgM3: 20,
          previousDecisionCategory: 'MANDATORY_STOP',
          previousPendingResumeSince: new Date(Date.now() - 15 * 60000).toISOString(),
        })
      );
      // القيد العام (10 دقائق استقرار) هو ما يحكم هنا، لا قيد الرياح
      // المخصَّص — استقرار 15 دقيقة كافٍ فيستأنف طبيعياً.
      expect(r.decisionCategory).toBe('ALLOW_WITH_CONTROLS');
    });

    // خطأ مكتشَف ومُصلَح (مراجعة كود خبير خارجي — "سبب الإيقاف السابق يُستنتج
    // من فئة القرار فقط"): previousStopWasWindGate كان يعتمد فقط على
    // previousDecisionCategory === 'STOP_AFFECTED_ACTIVITY'، فيُطبَّق قيد
    // بوابة الرياح المخصَّص حتى لو كان الإيقاف السابق سببه شيء آخر تماماً
    // (هنا: PM10 معلَّق MRQ-PM10-BLACK-PENDING-104). الإصلاح: previousDecidingRuleCode
    // (كود القاعدة الفعلية، لا الفئة) هو ما يُقارَن الآن.
    it('إيقاف سابق بفئة STOP_AFFECTED_ACTIVITY لكن سببه PM10 معلَّق (لا بوابة الرياح) + الرياح الآن 25 بالضبط → يُستأنف طبيعياً (قيد بوابة الرياح لا يُطبَّق)', () => {
      const fifteenMinutesAgo = new Date(Date.now() - 15 * 60000).toISOString();
      const r = evaluateDustCompliance(
        context({
          windSpeedKmh: 25,
          pm10UgM3: 20,
          previousDecisionCategory: 'STOP_AFFECTED_ACTIVITY',
          previousDecidingRuleCode: 'MRQ-PM10-BLACK-PENDING-104',
          previousPendingResumeSince: fifteenMinutesAgo,
        })
      );
      // القيد العام (10 دقائق استقرار) يُستوفى (15 دقيقة)، وقيد بوابة الرياح
      // المخصَّص لا يُطبَّق هنا لأن السبب السابق لم يكن GATE-WIND-ABOVE-25-004.
      expect(r.decisionCategory).not.toBe('STOP_AFFECTED_ACTIVITY');
    });
  });

  // خطأ مكتشَف ومُصلَح (مراجعة خبير خارجي — "فقد الرؤية قد يؤدي إلى ALLOW أو
  // يسمح باستكمال نافذة الاستئناف من إيقاف سابق"): dust-engine/engine.ts
  // (applyMandatoryGates) يتخطى بوابتي الرؤية بصمت عند visibilityKm===null
  // (جهاز مرتبط لكن القراءة غائبة/قديمة) — لا فرق بينها وبين "رؤية ممتازة"
  // في القرار الخام. dviVisibilityDataMissing (من DviEvaluationResult.
  // visibilityDataMissing عبر buildComplianceContext) يُصلح هذا على مستوى
  // محرك الامتثال: (1) يُضاف لـmissingCriticalInputs فيمنع ALLOW واثقاً،
  // (2) يمنع resumeHoldApplied من معاملة الغياب كتحسّن فعلي بعد إيقاف سابق.
  describe('dviVisibilityDataMissing — غياب قراءة الرؤية لا يُعامَل كتحسّن', () => {
    it('جهاز مرتبط، الرؤية غائبة (dviVisibilityDataMissing=true)، لا إيقاف سابق → يُضاف لـmissingCriticalInputs ويمنع ALLOW واثقاً', () => {
      const r = evaluateDustCompliance(context({ dviVisibilityDataMissing: true }));
      expect(r.missingCriticalInputs).toContain('قراءة الرؤية غير متوفرة من الجهاز');
      expect(r.decisionCategory).not.toBe('ALLOW');
    });

    it('إيقاف سابق (STOP_AFFECTED_ACTIVITY) + استقرار 15 دقيقة مستوفى + الرؤية غائبة الآن → يبقى موقوفاً (لا يُستأنف بسبب غياب البيانات)', () => {
      const fifteenMinutesAgo = new Date(Date.now() - 15 * 60000).toISOString();
      const r = evaluateDustCompliance(
        context({
          previousDecisionCategory: 'STOP_AFFECTED_ACTIVITY',
          previousPendingResumeSince: fifteenMinutesAgo,
          dviVisibilityDataMissing: true,
        })
      );
      expect(r.decisionCategory).toBe('STOP_AFFECTED_ACTIVITY');
      expect(r.triggeredRules.some((h) => h.code === 'VISIBILITY-DATA-MISSING-RESUME-HOLD')).toBe(true);
      expect(r.decidingRuleCode).toBe('VISIBILITY-DATA-MISSING-RESUME-HOLD');
      expect(r.canOverride).toBe(false);
    });

    it('إيقاف سابق + استقرار مستوفى + الرؤية متوفرة فعلياً (dviVisibilityDataMissing=false) → يُستأنف طبيعياً كالمعتاد', () => {
      const fifteenMinutesAgo = new Date(Date.now() - 15 * 60000).toISOString();
      const r = evaluateDustCompliance(
        context({
          previousDecisionCategory: 'STOP_AFFECTED_ACTIVITY',
          previousPendingResumeSince: fifteenMinutesAgo,
          dviVisibilityDataMissing: false,
        })
      );
      expect(r.decisionCategory).not.toBe('STOP_AFFECTED_ACTIVITY');
    });

    it('لا إيقاف سابق أصلاً + الرؤية غائبة الآن → لا يُطبَّق قيد الاستئناف (لا معنى له بلا إيقاف سابق)، لكن يبقى في missingCriticalInputs', () => {
      const r = evaluateDustCompliance(context({ dviVisibilityDataMissing: true }));
      expect(r.triggeredRules.some((h) => h.code === 'VISIBILITY-DATA-MISSING-RESUME-HOLD')).toBe(false);
      expect(r.missingCriticalInputs).toContain('قراءة الرؤية غير متوفرة من الجهاز');
    });
  });
});

// STONECUT-DRY-001 (قطع جاف بلا تبريد مائي/HEPA) حُذف من rulebook.ts —
// wetCuttingActive/hepaExtractionActive لم يعودا يُدخَلان عبر الواجهة، فلم
// يعد اختبارهما ذا معنى. بوابة الرياح (STONECUT-WIND-STOP-003، اختبارات
// "قطع الأحجار (إيقاف تلقائي من الرياح)" أدناه) تبقى القاعدة الفعلية
// الوحيدة المتبقية لهذا النشاط.

describe('محرك امتثال الغبار — الكسارة', () => {
  it('كسارة في مشروع ليس فئة ثالثة → إيقاف إلزامي', () => {
    const r = evaluateDustCompliance(
      context({
        project: projectProfile({ hasOnsiteCrusher: true, siteAreaM2: 3000, dailyTruckMovements: 10 }),
        activity: activityProfile({ regulatoryActivity: 'CRUSHER' }),
      })
    );
    // hasOnsiteCrusher=true يرفع فئة المشروع تلقائياً للثالثة، لذا نتحقق
    // من قاعدة المسافة بدلاً من ذلك في اختبار منفصل أدناه
    expect(r.riskClass).toBe('CATEGORY_III_HIGH');
  });

  it('مشروع مساحته أقل من 2000م² لكن hasOnsiteCrusher=true → مسموح بتشغيل الكسارة (لا قاعدة تمنع بالمساحة)', () => {
    // تصحيح: لا توجد قاعدة تنظيمية موثّقة تمنع الكسارة بناءً على المساحة
    // الفعلية للمشروع. أهلية الكسارة تُحدَّد حصراً عبر riskClass النهائي
    // (CRUSHER-CATEGORY-001) — إن وصل المشروع للفئة الثالثة عبر أي محفز
    // (بما فيه تصريح hasOnsiteCrusher نفسه)، فالكسارة مسموحة بصرف النظر
    // عن صغر المساحة.
    const r = evaluateDustCompliance(
      context({
        project: projectProfile({ hasOnsiteCrusher: true, siteAreaM2: 1750, dailyTruckMovements: 10 }),
        activity: activityProfile({
          regulatoryActivity: 'CRUSHER',
          controls: {
            ...activityProfile().controls,
            conveyorsEnclosed: true,
            foggingAvailable: true,
            sprayCannonAvailable: true,
          },
        }),
      })
    );
    expect(r.riskClass).toBe('CATEGORY_III_HIGH');
    expect(r.triggeredRules.some((h) => h.code === 'CRUSHER-CATEGORY-001')).toBe(false);
  });

  it('كسارة ضمن 500م من مستقبِل حساس → إيقاف إلزامي حتى في فئة ثالثة', () => {
    const r = evaluateDustCompliance(
      context({
        project: projectProfile({ hasOnsiteCrusher: true }),
        activity: activityProfile({
          regulatoryActivity: 'CRUSHER',
          measurements: { ...activityProfile().measurements, crusherDistanceToReceptorM: 300 },
        }),
      })
    );
    expect(r.decisionCategory).toBe('MANDATORY_STOP');
    expect(r.triggeredRules.some((h) => h.code === 'CRUSHER-DISTANCE-500-002C')).toBe(true);
  });

  it('مسافة الكسارة المحسوبة تلقائياً (auto) تفوز على الحقل اليدوي البعيد', () => {
    const r = evaluateDustCompliance(
      context({
        project: projectProfile({ hasOnsiteCrusher: true }),
        activity: activityProfile({
          regulatoryActivity: 'CRUSHER',
          measurements: {
            ...activityProfile().measurements,
            crusherDistanceToReceptorM: 900, // يدوي بعيد — يجب أن يُتجاوَز بالقيمة التلقائية الأقرب
            crusherLat: 24.7,
            crusherLng: 46.7,
            crusherDistanceToNearestReceptorAutoM: 60,
            crusherDistanceToResidentialReceptorAutoM: 60,
          },
        }),
      })
    );
    expect(r.decisionCategory).toBe('MANDATORY_STOP');
    expect(r.triggeredRules.some((h) => h.code === 'CRUSHER-DISTANCE-200-002B')).toBe(true);
    expect(r.triggeredRules.some((h) => h.code === 'CRUSHER-DISTANCE-500-002C')).toBe(true);
  });

  it('موقع الكسارة معروف وجدول المستقبلات فارغ فعلياً (Infinity تلقائية) → لا يسقط لقيمة يدوية قديمة، لا إيقاف', () => {
    // يحاكي حالة إنتاجية فعلية: نُشئ صف الكسارة بحقل مسافة يدوي (420م) قبل
    // اعتماد التحديد على الخريطة، ثم حُدِّد الموقع لاحقاً لكن الحقل اليدوي
    // القديم بقي مخزَّناً. جدول sensitive_receptors فارغ بالكامل في النظام.
    const r = evaluateDustCompliance(
      context({
        project: projectProfile({ hasOnsiteCrusher: true }),
        activity: activityProfile({
          regulatoryActivity: 'CRUSHER',
          measurements: {
            ...activityProfile().measurements,
            crusherDistanceToReceptorM: 420, // يدوي قديم، يجب ألا يُستخدم إطلاقاً
            crusherLat: 24.7,
            crusherLng: 46.7,
            crusherDistanceToNearestReceptorAutoM: Infinity,
            crusherDistanceToResidentialReceptorAutoM: Infinity,
          },
        }),
      })
    );
    expect(r.triggeredRules.some((h) => h.code === 'CRUSHER-DISTANCE-200-002B')).toBe(false);
    expect(r.triggeredRules.some((h) => h.code === 'CRUSHER-DISTANCE-500-002C')).toBe(false);
  });

  it('الكسارة بلا إحداثيات ولا مستقبلات حساسة قريبة (بعيدة يدوياً) → لا إيقاف مسافة', () => {
    const r = evaluateDustCompliance(
      context({
        project: projectProfile({ hasOnsiteCrusher: true }),
        activity: activityProfile({
          regulatoryActivity: 'CRUSHER',
          measurements: { ...activityProfile().measurements, crusherDistanceToReceptorM: 900 },
          controls: {
            ...activityProfile().controls,
            conveyorsEnclosed: true,
            foggingAvailable: true,
            sprayCannonAvailable: true,
          },
        }),
      })
    );
    expect(r.triggeredRules.some((h) => h.code === 'CRUSHER-DISTANCE-200-002B')).toBe(false);
    expect(r.triggeredRules.some((h) => h.code === 'CRUSHER-DISTANCE-500-002C')).toBe(false);
  });
});

describe('محرك امتثال الغبار — اكتشاف مستقبل حساس تلقائياً لموقع الأكوام (A5)', () => {
  it('مسافة الأكوام المحسوبة تلقائياً تفوز على تصريح المستخدم اليدوي البعيد', () => {
    const r = evaluateDustCompliance(
      context({
        activity: activityProfile({
          regulatoryActivity: 'MATERIAL_HANDLING_STOCKPILE',
          measurements: {
            ...activityProfile().measurements,
            stockpileBatchingDistanceToReceptorM: 900, // المستخدم صرّح بأنه بعيد
            stockpileLat: 24.7,
            stockpileLng: 46.7,
            stockpileDistanceToNearestReceptorAutoM: 50, // لكن الاكتشاف التلقائي من الخريطة يظهر قرباً فعلياً
          },
        }),
      })
    );
    expect(r.triggeredRules.some((h) => h.code === 'STOCKPILE-DISTANCE-002')).toBe(true);
    expect(r.decisionCategory).toBe('STOP_AFFECTED_ACTIVITY');
  });

  it('بلا إحداثيات أكوام — يُعتمَد الحقل اليدوي فقط كاحتياطي', () => {
    const r = evaluateDustCompliance(
      context({
        activity: activityProfile({
          regulatoryActivity: 'MATERIAL_HANDLING_STOCKPILE',
          measurements: {
            ...activityProfile().measurements,
            stockpileBatchingDistanceToReceptorM: 900,
            stockpileDistanceToNearestReceptorAutoM: null,
          },
        }),
      })
    );
    expect(r.triggeredRules.some((h) => h.code === 'STOCKPILE-DISTANCE-002')).toBe(false);
  });
});

describe('محرك امتثال الغبار — الدخول والخروج (تفريع طريقة تنظيف الإطارات)', () => {
  it('فرع وحدة غسيل الإطارات: نقص مصيدة الرمال أو فاصل الزيوت → تقييد', () => {
    const r = evaluateDustCompliance(
      context({
        activity: activityProfile({
          regulatoryActivity: 'ENTRY_EXIT',
          controls: {
            ...activityProfile().controls,
            tireCleaningMethod: 'WHEEL_WASH',
            sandTrapPresent: false,
            oilSeparatorPresent: false,
          },
        }),
      })
    );
    expect(r.triggeredRules.some((h) => h.code === 'ENTRY-SANDTRAP-007')).toBe(true);
    expect(r.triggeredRules.some((h) => h.code === 'ENTRY-OILSEP-008')).toBe(true);
    // فرع الغمر بالمياه لا يجب أن يُفعَّل لأن طريقة التنظيف مختلفة
    expect(r.triggeredRules.some((h) => h.code === 'ENTRY-IMMERSION-MESH-011')).toBe(false);
  });

  it('فرع غمر الإطارات بالمياه: نقص الشبكة المانعة للانزلاق أو الحوض السفلي → تقييد', () => {
    const r = evaluateDustCompliance(
      context({
        activity: activityProfile({
          regulatoryActivity: 'ENTRY_EXIT',
          controls: {
            ...activityProfile().controls,
            tireCleaningMethod: 'WATER_IMMERSION',
            antiSlipMeshPresent: false,
            collectionBasinPresent: false,
          },
        }),
      })
    );
    expect(r.triggeredRules.some((h) => h.code === 'ENTRY-IMMERSION-MESH-011')).toBe(true);
    expect(r.triggeredRules.some((h) => h.code === 'ENTRY-BASIN-013')).toBe(true);
    // فرع وحدة الغسيل لا يجب أن يُفعَّل
    expect(r.triggeredRules.some((h) => h.code === 'ENTRY-SANDTRAP-007')).toBe(false);
  });

  it('نقص إحداثيات نقطة الدخول/الخروج → يتطلب تحقق ميداني', () => {
    const r = evaluateDustCompliance(
      context({
        activity: activityProfile({
          regulatoryActivity: 'ENTRY_EXIT',
          measurements: {
            ...activityProfile().measurements,
            entryPointLat: null,
            entryPointLng: null,
            exitPointLat: null,
            exitPointLng: null,
          },
        }),
      })
    );
    expect(r.triggeredRules.some((h) => h.code === 'ENTRY-POINT-MISSING-004')).toBe(true);
    expect(r.triggeredRules.some((h) => h.code === 'ENTRY-EXITPOINT-MISSING-005')).toBe(true);
  });
});

describe('محرك امتثال الغبار — نقل مخلفات الهدم والبناء (نشاط مستقل)', () => {
  // CDWASTE-CAPACITY-007 (تجاوز السعة الاستيعابية) حُذف من rulebook.ts —
  // loadExceedsCapacity لم يعد يُدخَل عبر الواجهة، فلم يعد اختباره ذا معنى.

  it('ارتفاع أكوام المخلفات > 3م → تقييد', () => {
    const r = evaluateDustCompliance(
      context({
        activity: activityProfile({
          regulatoryActivity: 'CD_WASTE_TRANSPORT',
          measurements: { ...activityProfile().measurements, debrisPileHeightM: 4 },
        }),
      })
    );
    expect(r.triggeredRules.some((h) => h.code === 'CDWASTE-PILEHEIGHT-003')).toBe(true);
  });
});

describe('محرك امتثال الغبار — حركة الشاحنات (تغطية الحمولة إلزامية)', () => {
  it('حمولة غير مغطاة (loadCovered=false) → إيقاف النشاط المتأثر فوراً', () => {
    const r = evaluateDustCompliance(
      context({
        activity: activityProfile({
          regulatoryActivity: 'SITE_TRAFFIC',
          controls: { ...activityProfile().controls, loadCovered: false },
        }),
      })
    );
    expect(r.triggeredRules.some((h) => h.code === 'TRAFFIC-LOAD-004')).toBe(true);
    expect(r.decisionCategory).toBe('STOP_AFFECTED_ACTIVITY');
  });

  it('حمولة مغطاة (loadCovered=true) → لا قاعدة تغطية مفعّلة', () => {
    const r = evaluateDustCompliance(
      context({
        activity: activityProfile({
          regulatoryActivity: 'SITE_TRAFFIC',
          controls: { ...activityProfile().controls, loadCovered: true },
        }),
      })
    );
    expect(r.triggeredRules.some((h) => h.code === 'TRAFFIC-LOAD-004')).toBe(false);
  });

  it('حالة تغطية الحمولة غير معروفة (null) → لا تُعامَل كمخالفة مؤكدة (فشل آمن نحو عدم الافتراض)', () => {
    const r = evaluateDustCompliance(
      context({
        activity: activityProfile({
          regulatoryActivity: 'SITE_TRAFFIC',
          controls: { ...activityProfile().controls, loadCovered: null },
        }),
      })
    );
    expect(r.triggeredRules.some((h) => h.code === 'TRAFFIC-LOAD-004')).toBe(false);
  });
});

describe('محرك امتثال الغبار — قطع الأحجار (إيقاف تلقائي من الرياح)', () => {
  it('قطع مكشوف أثناء رياح 15-25 كم/س → إيقاف إلزامي تلقائي', () => {
    const r = evaluateDustCompliance(
      context({
        windSpeedKmh: 18,
        activity: activityProfile({
          regulatoryActivity: 'STONE_CUTTING',
          isEnclosedOperation: false,
          controls: { ...activityProfile().controls, wetCuttingActive: true },
        }),
      })
    );
    expect(r.triggeredRules.some((h) => h.code === 'STONECUT-WIND-STOP-003')).toBe(true);
    expect(r.decisionCategory).toBe('MANDATORY_STOP');
  });

  it('قطع مغلق (isEnclosedOperation) أثناء رياح 15-25 كم/س → لا إيقاف رياح', () => {
    const r = evaluateDustCompliance(
      context({
        windSpeedKmh: 18,
        activity: activityProfile({
          regulatoryActivity: 'STONE_CUTTING',
          isEnclosedOperation: true,
          controls: { ...activityProfile().controls, hepaExtractionActive: true, wetCuttingActive: false },
        }),
      })
    );
    expect(r.triggeredRules.some((h) => h.code === 'STONECUT-WIND-STOP-003')).toBe(false);
  });
});

describe('محرك امتثال الغبار — حساب مسافة الكسارة التلقائي (Haversine + sensitive_receptors)', () => {
  it('haversineDistanceM يحسب مسافة صحيحة تقريبياً بين نقطتين متقاربتين', () => {
    // ~0.001 درجة عرض ≈ 111 متراً تقريباً عند خط الاستواء التقريبي للرياض
    const d = haversineDistanceM(24.7, 46.7, 24.701, 46.7);
    expect(d).toBeGreaterThan(100);
    expect(d).toBeLessThan(120);
  });

  it('nearestReceptorDistancesM يُرجع null بلا إحداثيات كسارة أو بلا مستقبلات', () => {
    const r = nearestReceptorDistancesM(null, null, []);
    expect(r.nearestAnyM).toBeNull();
    expect(r.nearestResidentialM).toBeNull();
  });

  it('nearestReceptorDistancesM يميّز بين أقرب مستقبل عام وأقرب مستقبل سكني/مدرسي/صحي', () => {
    const receptors: SensitiveReceptor[] = [
      { id: 'r1', name: 'منطقة تجارية قريبة جداً', receptorType: 'OTHER', lat: 24.7001, lng: 46.7 },
      { id: 'r2', name: 'مدرسة أبعد قليلاً', receptorType: 'SCHOOL', lat: 24.702, lng: 46.7 },
    ];
    const r = nearestReceptorDistancesM(24.7, 46.7, receptors);
    expect(r.nearestAnyM).not.toBeNull();
    expect(r.nearestResidentialM).not.toBeNull();
    // أقرب مستقبل عام (تجاري) أقرب من أقرب مستقبل سكني/مدرسي في هذه العيّنة
    expect(r.nearestAnyM!).toBeLessThan(r.nearestResidentialM!);
  });

  it('buildActivityComplianceProfile يملأ حقول المسافة التلقائية من صف Supabase + قائمة مستقبلات', () => {
    const row = {
      regulatory_activity: 'CRUSHER',
      crusher_lat: 24.7,
      crusher_lng: 46.7,
    };
    const receptors: SensitiveReceptor[] = [
      { id: 'r1', name: 'سكني ملاصق', receptorType: 'RESIDENTIAL', lat: 24.7005, lng: 46.7005 },
    ];
    const profile = buildActivityComplianceProfile(row, receptors);
    expect(profile.measurements.crusherDistanceToNearestReceptorAutoM).not.toBeNull();
    expect(profile.measurements.crusherDistanceToResidentialReceptorAutoM).not.toBeNull();
  });

  it('buildActivityComplianceProfile بموقع معروف لكن بلا أي مستقبل حساس في النظام → مسافة آمنة (Infinity)، لا null', () => {
    // موقع الكسارة معروف (لا نقص بيانات) وجدول sensitive_receptors فارغ
    // فعلياً — هذه معلومة حقيقية ("لا يوجد مستقبِل معروف قريباً")، فيجب أن
    // تُترجَم لمسافة آمنة عملياً (Infinity) لا null. null هنا كان يجعل قاعدة
    // الكسارة تسقط خطأً لقيمة يدوية قديمة قد لا تعود صحيحة (راجع geo.ts)،
    // رغم عدم وجود أي سبب فعلي للإيقاف.
    const row = { regulatory_activity: 'CRUSHER', crusher_lat: 24.7, crusher_lng: 46.7 };
    const profile = buildActivityComplianceProfile(row, []);
    expect(profile.measurements.crusherDistanceToNearestReceptorAutoM).toBe(Infinity);
    expect(profile.measurements.crusherDistanceToResidentialReceptorAutoM).toBe(Infinity);
  });

  it('buildActivityComplianceProfile بلا موقع كسارة محدَّد (lat/lng فارغ) → مسافة تلقائية null (بيانات ناقصة فعلاً)', () => {
    const row = { regulatory_activity: 'CRUSHER' };
    const profile = buildActivityComplianceProfile(row, [
      { id: 'r1', name: 'سكني', receptorType: 'RESIDENTIAL', lat: 24.7005, lng: 46.7005 },
    ]);
    expect(profile.measurements.crusherDistanceToNearestReceptorAutoM).toBeNull();
    expect(profile.measurements.crusherDistanceToResidentialReceptorAutoM).toBeNull();
  });
});

describe('محرك امتثال الغبار — MRQ-DATA-TRUE-NORTH-111 (صلاحية اتجاه الرياح، معايرة الجهاز)', () => {
  const row = { regulatory_activity: 'CRUSHER', crusher_lat: 24.7, crusher_lng: 46.7 };
  const northReceptor: SensitiveReceptor[] = [
    { id: 'r1', name: 'سكني شمالي قريب', receptorType: 'RESIDENTIAL', lat: 24.705, lng: 46.7 },
  ];

  it('لا توثيق معايرة للجهاز إطلاقاً (null) → crusherDistanceToDownwindReceptorAutoM يبقى null بصرف النظر عن اتجاه الرياح', () => {
    const profile = buildActivityComplianceProfile(row, northReceptor, 180, null);
    expect(profile.measurements.crusherDistanceToDownwindReceptorAutoM).toBeNull();
  });

  it('معايرة الجهاز موثّقة صراحة كـ documented=false (غير معايَر) → يبقى null أيضاً', () => {
    const profile = buildActivityComplianceProfile(row, northReceptor, 180, { documented: false, deviationDeg: null });
    expect(profile.measurements.crusherDistanceToDownwindReceptorAutoM).toBeNull();
  });

  it('معايرة الجهاز موثّقة (documented=true) → يُحسب اتجاه الريح فعلياً ويجد المستقبِل باتجاه الريح', () => {
    const profile = buildActivityComplianceProfile(row, northReceptor, 180, { documented: true, deviationDeg: null });
    expect(profile.measurements.crusherDistanceToDownwindReceptorAutoM).not.toBeNull();
    expect(profile.measurements.crusherDistanceToDownwindReceptorAutoM).toBeLessThan(1000);
  });

  // خطأ مكتشَف ومُصلَح (مراجعة خبير خارجي — نفس البند: "الانحراف المطبق"
  // يجب أن يُصحِّح الاتجاه الخام فعلياً، لا مجرد علم وجود/غياب توثيق):
  // انحراف مغناطيسي موثَّق (deviationDeg) يُصحَّح به windDirectionDeg قبل
  // البحث عن المستقبِل باتجاه الريح — جهاز يقرأ 180° مغناطيسياً بانحراف
  // موثَّق +5° يعني اتجاهاً حقيقياً فعلياً 185°، لا 180° الخام.
  it('معايرة موثّقة بانحراف مغناطيسي (deviationDeg) → يُصحَّح الاتجاه الخام قبل البحث عن المستقبِل باتجاه الريح', () => {
    // northReceptor يقع شمال الكسارة — "باتجاه الريح" فقط إذا الريح قادمة
    // من الجنوب (windDirectionDeg=180 بمعيار "من أين تهب"، راجع الاختبار
    // أعلاه). اتجاه خام=90 (شرقي، لا يضع المستقبِل باتجاه الريح) + انحراف
    // موثَّق +90° يصحّحه فعلياً إلى 180° فيجد المستقبِل.
    const profile = buildActivityComplianceProfile(row, northReceptor, 90, { documented: true, deviationDeg: 90 });
    expect(profile.measurements.crusherDistanceToDownwindReceptorAutoM).not.toBeNull();
    expect(profile.measurements.crusherDistanceToDownwindReceptorAutoM).toBeLessThan(1000);
  });
});

describe('محرك امتثال الغبار — MRQ-RECEPTOR-DOWNWIND-120 (تصعيد الاستجابة عبر evaluateDustCompliance)', () => {
  it('مستقبِل سكني باتجاه الريح فعلياً (محاذاة موثّقة) وضمن 500م → RESTRICT_ACTIVITY', () => {
    const r = evaluateDustCompliance(
      context({
        activity: activityProfile({
          regulatoryActivity: 'CRUSHER',
          measurements: {
            ...activityProfile().measurements,
            crusherDistanceToDownwindReceptorAutoM: 300,
          },
        }),
      })
    );
    expect(r.triggeredRules.some((h) => h.code === 'MRQ-RECEPTOR-DOWNWIND-120')).toBe(true);
    expect(r.decisionCategory).not.toBe('ALLOW');
  });

  it('لا مستقبِل باتجاه الريح (Infinity) → القاعدة لا تُفعَّل', () => {
    const r = evaluateDustCompliance(
      context({
        activity: activityProfile({
          regulatoryActivity: 'CRUSHER',
          measurements: {
            ...activityProfile().measurements,
            crusherDistanceToDownwindReceptorAutoM: Infinity,
          },
        }),
      })
    );
    expect(r.triggeredRules.some((h) => h.code === 'MRQ-RECEPTOR-DOWNWIND-120')).toBe(false);
  });

  it('اتجاه الرياح غير صالح (null، محاذاة غير موثّقة) → القاعدة لا تُفعَّل إطلاقاً', () => {
    const r = evaluateDustCompliance(
      context({
        activity: activityProfile({
          regulatoryActivity: 'CRUSHER',
          measurements: {
            ...activityProfile().measurements,
            crusherDistanceToDownwindReceptorAutoM: null,
          },
        }),
      })
    );
    expect(r.triggeredRules.some((h) => h.code === 'MRQ-RECEPTOR-DOWNWIND-120')).toBe(false);
  });
});

// خطأ مكتشَف ومُصلَح (مراجعة خبير خارجي — "المستقبلات الحساسة: القائمة
// الفارغة قد تعني أن بيانات المستقبلات لم تُدخل أصلاً؛ يجب التفريق بين 'لا
// توجد مستقبلات بعد مسح مكتمل' و'لم يتم إدخال بيانات المستقبلات' — الحالة
// الثانية يجب أن تنتج FIELD_VERIFICATION_REQUIRED"): sensitiveReceptorsDataAvailable
// (adapters.ts، مشتق من طول مصفوفة sensitive_receptors العالمية) يميّز
// الآن الحالتين، بدل السماح لـInfinity وحدها بإخفاء نقص البيانات.
describe('محرك امتثال الغبار — تمييز "لا مستقبلات في النظام كله" عن "لا مستقبل قريب فعلياً"', () => {
  it('كسارة بإحداثيات معروفة + جدول sensitive_receptors فارغ عالمياً (sensitiveReceptorsDataAvailable=false) → FIELD_VERIFICATION_REQUIRED، لا ALLOW صامت', () => {
    const r = evaluateDustCompliance(
      context({
        project: projectProfile({ hasOnsiteCrusher: true }), // CATEGORY_III_HIGH — يعزل CRUSHER-CATEGORY-001
        activity: activityProfile({
          regulatoryActivity: 'CRUSHER',
          sensitiveReceptorsDataAvailable: false,
          measurements: {
            ...activityProfile().measurements,
            crusherDistanceToNearestReceptorAutoM: Infinity,
            crusherDistanceToResidentialReceptorAutoM: Infinity,
          },
        }),
      })
    );
    expect(r.triggeredRules.some((h) => h.code === 'CRUSHER-RECEPTORS-DATA-MISSING')).toBe(true);
    expect(r.decisionCategory).toBe('FIELD_VERIFICATION_REQUIRED');
  });

  it('كسارة بإحداثيات معروفة + جدول sensitive_receptors يحتوي بيانات حقيقية لكن Infinity لهذا الموقع تحديداً (sensitiveReceptorsDataAvailable=true) → لا FIELD_VERIFICATION_REQUIRED، Infinity تبقى آمنة كما كانت', () => {
    const r = evaluateDustCompliance(
      context({
        project: projectProfile({ hasOnsiteCrusher: true }),
        activity: activityProfile({
          regulatoryActivity: 'CRUSHER',
          sensitiveReceptorsDataAvailable: true,
          measurements: {
            ...activityProfile().measurements,
            crusherDistanceToNearestReceptorAutoM: Infinity,
            crusherDistanceToResidentialReceptorAutoM: Infinity,
          },
        }),
      })
    );
    expect(r.triggeredRules.some((h) => h.code === 'CRUSHER-RECEPTORS-DATA-MISSING')).toBe(false);
  });

  it('محطة خلط بإحداثيات معروفة + جدول sensitive_receptors فارغ عالمياً → FIELD_VERIFICATION_REQUIRED', () => {
    const r = evaluateDustCompliance(
      context({
        activity: activityProfile({
          regulatoryActivity: 'BATCHING_PLANT',
          sensitiveReceptorsDataAvailable: false,
          measurements: {
            ...activityProfile().measurements,
            batchingDistanceToNearestReceptorAutoM: Infinity,
          },
        }),
      })
    );
    expect(r.triggeredRules.some((h) => h.code === 'BATCHING-RECEPTORS-DATA-MISSING')).toBe(true);
    expect(r.decisionCategory).toBe('FIELD_VERIFICATION_REQUIRED');
  });

  it('كسارة بلا إحداثيات مُدخلة أصلاً (null، لا Infinity) + جدول فارغ → لا يُخلَط بين البابين، تبقى بوابة "لا إحداثيات" اليدوية وحدها إن وُجدت', () => {
    const r = evaluateDustCompliance(
      context({
        project: projectProfile({ hasOnsiteCrusher: true }),
        activity: activityProfile({
          regulatoryActivity: 'CRUSHER',
          sensitiveReceptorsDataAvailable: false,
          measurements: {
            ...activityProfile().measurements,
            crusherDistanceToNearestReceptorAutoM: null,
            crusherDistanceToResidentialReceptorAutoM: null,
          },
        }),
      })
    );
    expect(r.triggeredRules.some((h) => h.code === 'CRUSHER-RECEPTORS-DATA-MISSING')).toBe(false);
  });
});

// =====================================================================
// عرض المستقبِلات الحساسة حول وحدة الكسارة/الخلاطة تحديداً (500م من موقع
// الوحدة نفسها) بدل حدود المشروع — الوحدة قد تقع في طرف موقع كبير فيختلف
// أقرب مستقبِل لها تماماً عن أقرب مستقبِل لحدود المشروع.
// =====================================================================
describe('محرك امتثال الغبار — مستقبِلات الكسارة/الخلاطة ضمن 500م', () => {
  const receptors: SensitiveReceptor[] = [
    // ~55م شمال الوحدة
    { id: 'r-near', name: 'مدرسة ملاصقة', receptorType: 'SCHOOL', lat: 24.7005, lng: 46.7 },
    // ~333م شمال الوحدة — داخل نطاق الـ500م
    { id: 'r-mid', name: 'مسجد الحي', receptorType: 'MOSQUE', lat: 24.703, lng: 46.7 },
    // ~1.1كم شمال الوحدة — خارج نطاق الـ500م
    { id: 'r-far', name: 'مستشفى بعيد', receptorType: 'HOSPITAL', lat: 24.71, lng: 46.7 },
  ];

  it('receptorsWithinRadiusM يُرجع المستقبِلات داخل النطاق فقط، مرتبة من الأقرب', () => {
    const result = receptorsWithinRadiusM(24.7, 46.7, receptors);
    expect(result.map((r) => r.id)).toEqual(['r-near', 'r-mid']);
    // مرتبة تصاعدياً بالمسافة
    expect(result[0].distanceM).toBeLessThan(result[1].distanceM);
  });

  it('receptorsWithinRadiusM يستبعد ما هو خارج نصف القطر تماماً', () => {
    expect(receptorsWithinRadiusM(24.7, 46.7, receptors).some((r) => r.id === 'r-far')).toBe(false);
  });

  it('receptorsWithinRadiusM يُرجع مصفوفة فارغة بلا إحداثيات وحدة', () => {
    expect(receptorsWithinRadiusM(null, null, receptors)).toEqual([]);
  });

  it('نصف القطر الافتراضي هو 500م — نفس حد CRUSHER-DISTANCE-500-002C التنظيمي', () => {
    expect(UNIT_RECEPTOR_RADIUS_M).toBe(500);
  });

  it('computeUnitReceptors يبني مجموعة للكسارة من crusher_lat/lng مع علم قاعدة مُلزمة', () => {
    const rows = [{ id: 1, regulatory_activity: 'CRUSHER', crusher_lat: 24.7, crusher_lng: 46.7 }];
    const dustResults = [{ activityId: '1', activityGroupId: 'g1' }];
    const map = computeUnitReceptors(rows, dustResults, receptors);
    const groups = map.get('1')!;
    expect(groups).toHaveLength(1);
    expect(groups[0].unitType).toBe('CRUSHER');
    expect(groups[0].hasBindingDistanceRule).toBe(true);
    expect(groups[0].receptors.map((r) => r.id)).toEqual(['r-near', 'r-mid']);
  });

  it('computeUnitReceptors يبني مجموعة للخلاطة من batching_lat/lng بلا ادعاء قاعدة مُلزمة', () => {
    // لا توجد قاعدة مسافة لمحطة الخلط في batchingPlantRules — يجب ألا تُعرض
    // القائمة للمستخدم كأنها تُفعّل إيقافاً.
    const rows = [{ id: 2, regulatory_activity: 'BATCHING_PLANT', batching_lat: 24.7, batching_lng: 46.7 }];
    const dustResults = [{ activityId: '2', activityGroupId: 'g1' }];
    const groups = computeUnitReceptors(rows, dustResults, receptors).get('2')!;
    expect(groups[0].unitType).toBe('BATCHING_PLANT');
    expect(groups[0].hasBindingDistanceRule).toBe(false);
  });

  it('computeUnitReceptors يتجاهل الأنشطة التنظيمية بلا موقع وحدة مستقل (هدم مثلاً)', () => {
    const rows = [{ id: 3, regulatory_activity: 'DEMOLITION', crusher_lat: 24.7, crusher_lng: 46.7 }];
    const dustResults = [{ activityId: '3', activityGroupId: 'g1' }];
    expect(computeUnitReceptors(rows, dustResults, receptors).has('3')).toBe(false);
  });

  it('computeUnitReceptors يتجاهل كسارة بلا إحداثيات مسجّلة', () => {
    const rows = [{ id: 4, regulatory_activity: 'CRUSHER', crusher_lat: null, crusher_lng: null }];
    const dustResults = [{ activityId: '4', activityGroupId: 'g1' }];
    expect(computeUnitReceptors(rows, dustResults, receptors).has('4')).toBe(false);
  });

  it('كسارة بلا أي مستقبِل ضمن 500م → مجموعة موجودة بقائمة فارغة (لا غياب القسم)', () => {
    // الفرق مهم في الواجهة: قائمة فارغة تعني "لا يوجد جوار حساس" (رسالة
    // خضراء صريحة)، بينما غياب المجموعة يعني "لا يوجد موقع مسجّل للوحدة".
    const rows = [{ id: 5, regulatory_activity: 'CRUSHER', crusher_lat: 25.5, crusher_lng: 47.5 }];
    const dustResults = [{ activityId: '5', activityGroupId: 'g1' }];
    const groups = computeUnitReceptors(rows, dustResults, receptors).get('5')!;
    expect(groups).toHaveLength(1);
    expect(groups[0].receptors).toEqual([]);
  });
});

describe('محرك امتثال الغبار — محطات خلط الخرسانة (A6)', () => {
  it('صوامع غير محكمة الإغلاق → إيقاف إلزامي', () => {
    const r = evaluateDustCompliance(
      context({
        activity: activityProfile({
          regulatoryActivity: 'BATCHING_PLANT',
          controls: { ...activityProfile().controls, silosSealed: false },
        }),
      })
    );
    expect(r.decisionCategory).toBe('MANDATORY_STOP');
    expect(r.triggeredRules.some((h) => h.code === 'BATCHING-SILO-001')).toBe(true);
  });

  it('كفاءة فلتر أقل من 99% → إيقاف إلزامي', () => {
    const r = evaluateDustCompliance(
      context({
        activity: activityProfile({
          regulatoryActivity: 'BATCHING_PLANT',
          controls: { ...activityProfile().controls, pm10FilterEfficiencyPercent: 85 },
        }),
      })
    );
    expect(r.decisionCategory).toBe('MANDATORY_STOP');
    expect(r.triggeredRules.some((h) => h.code === 'BATCHING-FILTER-002')).toBe(true);
  });

  it('تسرب مرصود → إيقاف النشاط المتأثر', () => {
    const r = evaluateDustCompliance(
      context({
        activity: activityProfile({
          regulatoryActivity: 'BATCHING_PLANT',
          controls: { ...activityProfile().controls, leakDetected: true },
        }),
      })
    );
    expect(r.decisionCategory).toBe('STOP_AFFECTED_ACTIVITY');
    expect(r.triggeredRules.some((h) => h.code === 'BATCHING-LEAK-003')).toBe(true);
  });

  it('استخدام الكنس الجاف → تقييد النشاط', () => {
    const r = evaluateDustCompliance(
      context({
        activity: activityProfile({
          regulatoryActivity: 'BATCHING_PLANT',
          controls: { ...activityProfile().controls, dryCleaningMethodUsed: true },
        }),
      })
    );
    expect(r.triggeredRules.some((h) => h.code === 'BATCHING-DRYCLEAN-004')).toBe(true);
  });

  it('محطة خلط مطابقة بالكامل (بما فيها مسافة آمنة عن مستقبِل حساس) → لا مخالفات', () => {
    const r = evaluateDustCompliance(
      context({
        activity: activityProfile({
          regulatoryActivity: 'BATCHING_PLANT',
          measurements: { ...activityProfile().measurements, batchingDistanceToNearestReceptorAutoM: 1000 },
        }),
      })
    );
    expect(r.decisionCategory).toBe('ALLOW');
  });

  // خطأ مكتشَف ومُصلَح (مراجعة كود خبير خارجي — "قاعدة 200م لمحطة الخلط غير
  // منفذة"): المرجع التنظيمي (القسم 3.5) يمنع محطات الخلط/تخزين المواد ضمن
  // 200م من مدرسة/مستشفى/مسجد/منطقة سكنية — الإحداثيات والمسافة المحسوبة
  // تلقائياً كانتا تُجمَعان (adapters.ts/geo.ts) لكن لا قاعدة كانت تستهلكهما.
  describe('BATCHING-DISTANCE-200 — الحد الأدنى 200م عن أقرب مستقبِل حساس', () => {
    it('مسافة 199.999م (أقل من 200 بالضبط) → إيقاف إلزامي', () => {
      const r = evaluateDustCompliance(
        context({
          activity: activityProfile({
            regulatoryActivity: 'BATCHING_PLANT',
            measurements: { ...activityProfile().measurements, batchingDistanceToNearestReceptorAutoM: 199.999 },
          }),
        })
      );
      expect(r.decisionCategory).toBe('MANDATORY_STOP');
      expect(r.triggeredRules.some((h) => h.code === 'BATCHING-DISTANCE-200')).toBe(true);
    });

    it('مسافة 200م بالضبط (الحد نفسه، لا تجاوز) → لا إيقاف بسبب المسافة', () => {
      const r = evaluateDustCompliance(
        context({
          activity: activityProfile({
            regulatoryActivity: 'BATCHING_PLANT',
            measurements: { ...activityProfile().measurements, batchingDistanceToNearestReceptorAutoM: 200 },
          }),
        })
      );
      expect(r.decisionCategory).not.toBe('MANDATORY_STOP');
      expect(r.triggeredRules.some((h) => h.code === 'BATCHING-DISTANCE-200')).toBe(false);
    });

    it('مسافة 250م (أعلى من الحد) → لا مخالفة مسافة', () => {
      const r = evaluateDustCompliance(
        context({
          activity: activityProfile({
            regulatoryActivity: 'BATCHING_PLANT',
            measurements: { ...activityProfile().measurements, batchingDistanceToNearestReceptorAutoM: 250 },
          }),
        })
      );
      expect(r.triggeredRules.some((h) => h.code === 'BATCHING-DISTANCE-200')).toBe(false);
    });

    it('لا إحداثيات مُدخلة لمحطة الخلط (null، لا Infinity) → يتطلب تحقق ميداني، لا ALLOW نظيف', () => {
      const r = evaluateDustCompliance(
        context({
          activity: activityProfile({
            regulatoryActivity: 'BATCHING_PLANT',
            measurements: { ...activityProfile().measurements, batchingDistanceToNearestReceptorAutoM: null },
          }),
        })
      );
      expect(r.triggeredRules.some((h) => h.code === 'BATCHING-DISTANCE-MISSING')).toBe(true);
      expect(r.decisionCategory).toBe('FIELD_VERIFICATION_REQUIRED');
    });

    it('إحداثيات مُدخلة لكن لا مستقبِلات حساسة مسجَّلة قريباً (Infinity) → لا مخالفة، ولا تحقق ميداني (موقع مُثبَت فعلياً وآمن)', () => {
      const r = evaluateDustCompliance(
        context({
          activity: activityProfile({
            regulatoryActivity: 'BATCHING_PLANT',
            measurements: { ...activityProfile().measurements, batchingDistanceToNearestReceptorAutoM: Infinity },
          }),
        })
      );
      expect(r.triggeredRules.some((h) => h.code === 'BATCHING-DISTANCE-200')).toBe(false);
      expect(r.triggeredRules.some((h) => h.code === 'BATCHING-DISTANCE-MISSING')).toBe(false);
      expect(r.decisionCategory).toBe('ALLOW');
    });

    it('نشاط غير BATCHING_PLANT (كسارة) → القاعدة لا تُطبَّق إطلاقاً حتى لو المسافة قريبة جداً', () => {
      const r = evaluateDustCompliance(
        context({
          activity: activityProfile({
            regulatoryActivity: 'CRUSHER',
            measurements: { ...activityProfile().measurements, batchingDistanceToNearestReceptorAutoM: 50 },
          }),
        })
      );
      expect(r.triggeredRules.some((h) => h.code === 'BATCHING-DISTANCE-200')).toBe(false);
      expect(r.triggeredRules.some((h) => h.code === 'BATCHING-DISTANCE-MISSING')).toBe(false);
    });
  });
});

describe('محرك امتثال الغبار — الأسطح غير النشطة (A4)', () => {
  it('غطاء تالف → تقييد النشاط بصرف النظر عن عدد الأيام', () => {
    const r = evaluateDustCompliance(
      context({
        activity: activityProfile({
          regulatoryActivity: 'IDLE_SURFACE',
          controls: { ...activityProfile().controls, idleSurfaceCoverIntact: false },
        }),
      })
    );
    expect(r.triggeredRules.some((h) => h.code === 'IDLE-COVER-002')).toBe(true);
  });

  it('رياح > 20 كم/س وحالة الغطاء مجهولة → يتطلب تحقق ميداني', () => {
    const r = evaluateDustCompliance(
      context({
        windSpeedKmh: 22,
        activity: activityProfile({
          regulatoryActivity: 'IDLE_SURFACE',
          controls: { ...activityProfile().controls, idleSurfaceCoverIntact: null },
        }),
      })
    );
    expect(r.triggeredRules.some((h) => h.code === 'IDLE-COVER-WIND-003')).toBe(true);
  });

  it('رياح هادئة وغطاء سليم → لا مخالفات', () => {
    const r = evaluateDustCompliance(
      context({
        windSpeedKmh: 10,
        activity: activityProfile({ regulatoryActivity: 'IDLE_SURFACE' }),
      })
    );
    expect(r.decisionCategory).toBe('ALLOW');
  });
});

describe('محرك امتثال الغبار — عدد محطات الرصد حسب الفئة', () => {
  it('فئة ثانية بمحطة واحدة → مكتمل', () => {
    const r = evaluateDustCompliance(
      context({
        project: projectProfile({ siteAreaM2: 3000, monitoringStationCount: 1 }),
      })
    );
    const obligation = r.monitoringObligations.find((o) => o.key === 'MONITORING_STATION_COUNT');
    expect(obligation?.status).toBe('COMPLIANT');
  });

  it('فئة ثالثة بمحطة واحدة فقط → غير مكتمل (يلزم محطتان)، لكن للعرض التوعوي فقط — لا تؤثر على القرار', () => {
    // بطلب صريح من المستخدم: لا يمكن الجزم بأن المستخدم ضبط محطة الرصد
    // فعلياً على أرض الواقع (حقل تصريح يدوي لا قياس مباشر)، فالتزامات الرصد
    // تبقى معلومة توعوية بحتة ولا تُخفِّض القرار (على عكس رياح/PM10/مسافات
    // المبنية على قياسات حية فعلية).
    const r = evaluateDustCompliance(
      context({
        project: projectProfile({ siteAreaM2: 6000, monitoringStationCount: 1 }),
      })
    );
    const obligation = r.monitoringObligations.find((o) => o.key === 'MONITORING_STATION_COUNT');
    expect(obligation?.status).toBe('NON_COMPLIANT');
    expect(r.triggeredRules.some((h) => h.code.startsWith('MONITORING-'))).toBe(false);
  });

  it('فئة ثالثة بمحطتين → مكتمل', () => {
    const r = evaluateDustCompliance(
      context({
        project: projectProfile({ siteAreaM2: 6000, monitoringStationCount: 2 }),
      })
    );
    const obligation = r.monitoringObligations.find((o) => o.key === 'MONITORING_STATION_COUNT');
    expect(obligation?.status).toBe('COMPLIANT');
  });

  // يوثّق القاعدة الكانونية بعد توحيد "محطات الرصد" مع "أجهزة الرصد
  // الحية": الفئتان المنخفضتان (CATEGORY_I_LOW/UNCLASSIFIED) لا يُفرض
  // عليهما أي حد أدنى إطلاقاً — الالتزام يجب أن يكون NOT_APPLICABLE بصرف
  // النظر عن عدد الأجهزة (حتى صفر)، لا COMPLIANT/NON_COMPLIANT محسوباً على
  // حد وهمي. يحمي من تكرار الخطأ القديم في نسختي complianceCheck() العميلتين
  // (create/settings)، اللتين كانتا تكتبان 0 مباشرة بدل الاعتماد على نفس
  // بوابة monitoringApplies المستخدمة هنا.
  it('فئة أولى (منخفضة) بلا أجهزة رصد إطلاقاً → NOT_APPLICABLE، لا NON_COMPLIANT', () => {
    const r = evaluateDustCompliance(
      context({
        project: projectProfile({ siteAreaM2: 500, dailyTruckMovements: 5, monitoringStationCount: 0 }),
      })
    );
    const obligation = r.monitoringObligations.find((o) => o.key === 'MONITORING_STATION_COUNT');
    expect(obligation?.status).toBe('NOT_APPLICABLE');
  });

  it('مشروع غير مصنَّف (بيانات ناقصة) بلا أجهزة رصد → NOT_APPLICABLE أيضاً', () => {
    const r = evaluateDustCompliance(
      context({
        project: projectProfile({ siteAreaM2: null, dailyTruckMovements: null, monitoringStationCount: 0 }),
      })
    );
    const obligation = r.monitoringObligations.find((o) => o.key === 'MONITORING_STATION_COUNT');
    expect(obligation?.status).toBe('NOT_APPLICABLE');
  });
});

describe('محرك امتثال الغبار — فاصل تسجيل الرصد (دقيقة واحدة فقط، وليس دقيقتين)', () => {
  it('فاصل تسجيل دقيقة واحدة → مكتمل', () => {
    const r = evaluateDustCompliance(
      context({ project: projectProfile({ siteAreaM2: 3000, monitoringLoggingIntervalMinutes: 1 }) })
    );
    const obligation = r.monitoringObligations.find((o) => o.key === 'MONITORING_LOGGING_INTERVAL');
    expect(obligation?.status).toBe('COMPLIANT');
  });

  it('فاصل تسجيل دقيقتين → غير مكتمل (المستند يعتمد دقيقة واحدة فقط رغم ورود "كل دقيقتين" في ملخصات سابقة)', () => {
    const r = evaluateDustCompliance(
      context({ project: projectProfile({ siteAreaM2: 3000, monitoringLoggingIntervalMinutes: 2 }) })
    );
    const obligation = r.monitoringObligations.find((o) => o.key === 'MONITORING_LOGGING_INTERVAL');
    expect(obligation?.status).toBe('NON_COMPLIANT');
  });
});

describe('محرك امتثال الغبار — كاميرات الدخول/الخروج (تركيب + مدة احتفاظ 90 يوماً)', () => {
  it('كاميرات مركّبة بمدة احتفاظ 90 يوماً → مكتمل', () => {
    const r = evaluateDustCompliance(
      context({ project: projectProfile({ siteAreaM2: 3000, entryExitCamerasInstalled: true, cameraRetentionDays: 90 }) })
    );
    const obligation = r.monitoringObligations.find((o) => o.key === 'ENTRY_EXIT_CAMERAS');
    expect(obligation?.status).toBe('COMPLIANT');
  });

  it('كاميرات مركّبة لكن مدة الاحتفاظ أقل من 90 يوماً → غير مكتمل', () => {
    const r = evaluateDustCompliance(
      context({ project: projectProfile({ siteAreaM2: 3000, entryExitCamerasInstalled: true, cameraRetentionDays: 30 }) })
    );
    const obligation = r.monitoringObligations.find((o) => o.key === 'ENTRY_EXIT_CAMERAS');
    expect(obligation?.status).toBe('NON_COMPLIANT');
  });

  it('كاميرات غير مركّبة → غير مكتمل بصرف النظر عن مدة الاحتفاظ', () => {
    const r = evaluateDustCompliance(
      context({ project: projectProfile({ siteAreaM2: 3000, entryExitCamerasInstalled: false, cameraRetentionDays: 90 }) })
    );
    const obligation = r.monitoringObligations.find((o) => o.key === 'ENTRY_EXIT_CAMERAS');
    expect(obligation?.status).toBe('NON_COMPLIANT');
  });
});

describe('محرك امتثال الغبار — الثقة ومنع القرار الأخضر عند نقص البيانات', () => {
  it('نقص بيانات حرجة (مساحة الموقع مجهولة) يمنع ALLOW → تحقق ميداني بدلاً منه', () => {
    const r = evaluateDustCompliance(
      context({
        project: projectProfile({ siteAreaM2: null }),
      })
    );
    expect(r.decisionCategory).not.toBe('ALLOW');
    expect(r.missingCriticalInputs.length).toBeGreaterThan(0);
  });

  it('ثقة أقل من 70 تمنع ALLOW حتى مع بيانات كاملة ظاهرياً', () => {
    const r = evaluateDustCompliance(
      context({
        dviConfidenceScore: 40,
        windSpeedKmh: null, // يخصم ثقة إضافية بشدة
      })
    );
    expect(r.confidenceScore).toBeLessThan(70);
    expect(r.decisionCategory).not.toBe('ALLOW');
  });

  // نفس السيناريو أعلاه لكن بمعزل عن missingCriticalInputs (windSpeedKmh هنا
  // متوفر) — يعزل مسار الثقة المنخفضة تحديداً عن مسار نقص البيانات الحرجة
  // (كلاهما ينتج FIELD_VERIFICATION_REQUIRED لكن بقاعدة مختلفة تماماً).
  it('ثقة منخفضة فقط (dviConfidenceScore) بلا أي نقص بيانات حرجة → LOW-CONFIDENCE-VERIFICATION قاعدة فعلية ظاهرة، قابلة للتجاوز', () => {
    const r = evaluateDustCompliance(context({ dviConfidenceScore: 40 }));
    expect(r.confidenceScore).toBeLessThan(70);
    expect(r.missingCriticalInputs.length).toBe(0);
    expect(r.decisionCategory).toBe('FIELD_VERIFICATION_REQUIRED');
    // خطأ معماري مكتشَف ومُصلَح (مراجعة كود خبير خارجي — "الفصل بين القواعد
    // والقرار النهائي غير مكتمل"): تحويل ALLOW→FIELD_VERIFICATION_REQUIRED
    // بسبب الثقة المنخفضة كان يُعدِّل decisionCategory مباشرة بمعزل تام عن
    // ruleHits — لا يظهر في triggeredRules، ولا decidingRuleCode يفسّر
    // السبب الفعلي. الآن قاعدة DustRuleHit فعلية (LOW-CONFIDENCE-VERIFICATION)
    // تظهر في القوائم المعروضة للمستخدم كأي قاعدة أخرى.
    expect(r.triggeredRules.some((h) => h.code === 'LOW-CONFIDENCE-VERIFICATION')).toBe(true);
    expect(r.decidingRuleCode).toBe('LOW-CONFIDENCE-VERIFICATION');
    expect(r.canOverride).toBe(true);
  });

  it('بيانات كاملة وثقة عالية وبلا مخالفات → ALLOW', () => {
    const r = evaluateDustCompliance(context());
    expect(r.decisionCategory).toBe('ALLOW');
    expect(r.confidenceScore).toBeGreaterThanOrEqual(70);
  });
});

describe('محرك امتثال الغبار — عدم كسر بنية النتيجة', () => {
  it('rulebookVersion وengineType ثابتان في كل نتيجة', () => {
    const r = evaluateDustCompliance(context());
    expect(r.engineType).toBe('RIYADH_DUST_COMPLIANCE');
    expect(r.rulebookVersion).toBe('RCRC-NCEC-RIYADH-DUST-2026.2');
  });

  // خطأ مكتشَف ومُصلَح (مراجعة مستخدم — "ليش التايمر ينعاد إذا سويت تحديث
  // للصفحة"): العدّاد التنازلي في Compliancewidgetcard.tsx كان يفترض لحظة
  // "الآن" المحلية بالمتصفح كمرجع لحساب استمرار PM10 — خاطئ عند إعادة تحميل
  // الصفحة (المكوّن يُعاد بناؤه، فتتأخر لحظة "أول عرض" عن حساب الخادم
  // الفعلي). evaluatedAt هو المرجع الصحيح الآن — يثبت هذا الاختبار أنه
  // موجود دائماً في كل نتيجة وقريب فعلياً من لحظة الاستدعاء (لا قيمة ثابتة/
  // فارغة/بعيدة زمنياً).
  it('evaluatedAt موجود في كل نتيجة ويعكس وقت الاستدعاء الفعلي (لا قيمة ثابتة/بعيدة)', () => {
    const before = Date.now();
    const r = evaluateDustCompliance(context());
    const after = Date.now();
    expect(r.evaluatedAt).toBeTruthy();
    const evaluatedAtMs = new Date(r.evaluatedAt).getTime();
    expect(evaluatedAtMs).toBeGreaterThanOrEqual(before);
    expect(evaluatedAtMs).toBeLessThanOrEqual(after);
  });

  it('canOverride = false عند MANDATORY_STOP', () => {
    const r = evaluateDustCompliance(context({ dviMandatoryStop: true }));
    expect(r.canOverride).toBe(false);
  });
});

describe('buildComplianceContext — تمرير العينة الخام (rawWeatherSample) لـ evidence', () => {
  const baseDviHourly = {
    indicatorType: 'DVI' as const,
    dviBase: 10,
    score: 10,
    level: 'GREEN' as const,
    causeClassification: 'UNKNOWN' as const,
    decisionCategory: 'ALLOW' as const,
    decisionLabelAr: 'مسموح',
    mandatoryStop: false,
    overridable: true,
    stopBasis: 'NONE' as const,
    confirmationState: 'NOT_APPLICABLE' as const,
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
      receptorImpact: 0,
      receptorSensitivityMultiplier: 1,
      mitigationScore: 0,
      mitigationReductionFactor: 1,
    },
    visibilityKm: 10,
    effectiveWindKmh: 29.66,
    visibilityDataMissing: false,
    visibilityConstraint: false,
    mandatoryVisibilityStop: false,
    respiratoryPPERequired: false,
    dustExposureHigh: false,
    outdoorWorkRestriction: false,
    triggeredRules: [],
    requiredActions: [],
    shortReason: '',
    topRiskDrivers: [],
    riskReducers: [],
    caveatsAr: [],
    confidenceScore: 90,
    confidenceLabel: 'High',
    validUntil: new Date().toISOString(),
    time: new Date().toISOString(),
    rawWeatherSample: {
      visibilityM: 10000,
      weatherCode: 0,
      weatherSymbol: 'CLEAR' as const,
      windSpeedKmh: 25,
      windGustKmh: null,
      windDirectionDeg: null,
      relativeHumidityPercent: null,
      temperatureC: null,
      rainfallLast24hMm: null,
      pm10: null,
      pm25: null,
      dustConcentration: null,
      dataSource: 'open-meteo' as const,
      isForecastStale: false,
    },
  } satisfies Omit<DviHourlyEvaluation, 'mergedReading'>;

  // مصدر مشترك لهذه المجموعة — mergedReading (لا rawWeatherSample مباشرة)
  // هو ما يُقرأ الآن فعلياً لـ windGustKmh/windDirectionDeg/pm10/pm25/
  // الرطوبة/الحرارة، بعد إصلاح تضارب سلسلة أولوية الامتثال مع DVI (راجع
  // خطة "إعادة ترتيب أولوية قراءات الغبار/الطقس").
  function mergedReadingFixture(overrides: Partial<DviMergedReading> = {}): DviMergedReading {
    return {
      windSpeedKmh: 25,
      windGustKmh: 39.78,
      windDirectionDeg: 315,
      pm10: 45,
      pm25: 18,
      visibilityM: 10000,
      relativeHumidityPercent: 20,
      temperatureC: 30,
      deviceLastReadingAt: null,
      devicePm10LastReadingAt: null,
      sources: {
        windSpeedKmh: 'weather',
        windGustKmh: 'weather',
        windDirectionDeg: 'weather',
        pm10: 'weather',
        pm25: 'weather',
        visibilityM: 'weather',
        relativeHumidityPercent: 'weather',
        temperatureC: 'weather',
      },
      ...overrides,
    };
  }

  it('يقرأ windGustKmh/windDirectionDeg/pm10/pm25/الرطوبة/الحرارة من mergedReading عندما تتوفر', () => {
    const dviHourly = {
      ...baseDviHourly,
      rawWeatherSample: {
        visibilityM: 10000,
        weatherCode: 0,
        weatherSymbol: 'CLEAR' as const,
        windSpeedKmh: 25,
        windGustKmh: 39.78,
        windDirectionDeg: 315,
        relativeHumidityPercent: 20,
        temperatureC: 30,
        rainfallLast24hMm: 0,
        pm10: 45,
        pm25: 18,
        dustConcentration: 100,
        dataSource: 'open-meteo' as const,
        isForecastStale: false,
      },
      mergedReading: mergedReadingFixture(),
    };
    const ctx = buildComplianceContext({}, {}, dviHourly, []);
    expect(ctx.windGustKmh).toBe(39.78);
    expect(ctx.windDirectionDeg).toBe(315);
    expect(ctx.pm25UgM3).toBe(18);
    expect(ctx.pm10UgM3).toBe(45);
    expect(ctx.relativeHumidityPercent).toBe(20);
    expect(ctx.temperatureC).toBe(30);
    expect(ctx.dataSource).toBe('open-meteo');
  });

  // الفرضية معكوسة الآن بالكامل عن السلوك القديم: الجهاز يفوز على
  // mergedReading.pm10 المدموج مسبقاً من DVI (الذي هو نفسه بالفعل نتيجة
  // أولوية جهاز > طقس > onsite) — لم يعد activityRow.onsite_pm10 يُقرأ
  // مباشرة هنا بمعزل عن الجهاز كما كان قديماً.
  it('pm10UgM3 يعكس mergedReading.pm10 (الذي قد يكون من الجهاز)، لا onsite_pm10 مباشرة بمعزل عنه', () => {
    const dviHourly = {
      ...baseDviHourly,
      rawWeatherSample: {
        visibilityM: 10000, weatherCode: 0, weatherSymbol: 'CLEAR' as const,
        windSpeedKmh: 25, windGustKmh: 30, windDirectionDeg: 90,
        relativeHumidityPercent: 20, temperatureC: 30, rainfallLast24hMm: 0,
        pm10: 45, pm25: 18, dustConcentration: 100,
        dataSource: 'open-meteo' as const, isForecastStale: false,
      },
      // الجهاز فاز بـ pm10=260 (لا 999 اليدوي ولا 45 الطقس) — يثبت أن
      // القراءة المدموجة فعلياً هي المصدر، لا onsite_pm10 من activityRow.
      mergedReading: mergedReadingFixture({ pm10: 260, sources: { ...mergedReadingFixture().sources, pm10: 'device' } }),
    };
    const ctx = buildComplianceContext({}, { onsite_pm10: 999 }, dviHourly, []);
    expect(ctx.pm10UgM3).toBe(260);
    expect(ctx.dataSource).toBe('device');
  });

  it('mergedReading يفتقد pm10 (none) و onsite_pm10 موجود على activityRow → pm10UgM3 يبقى null (لا رجوع مباشر لـ onsite_pm10 خارج الدمج)', () => {
    const dviHourly = {
      ...baseDviHourly,
      mergedReading: mergedReadingFixture({ pm10: null, sources: { ...mergedReadingFixture().sources, pm10: 'none' } }),
    };
    const ctx = buildComplianceContext({}, { onsite_pm10: 999 }, dviHourly, []);
    expect(ctx.pm10UgM3).toBeNull();
  });

  it('بلا mergedReading (نتيجة DVI مبنية مباشرة بلا دمج) → الحقول الجديدة null بأمان', () => {
    const ctx = buildComplianceContext({}, {}, baseDviHourly, []);
    expect(ctx.windGustKmh).toBeNull();
    expect(ctx.windDirectionDeg).toBeNull();
    expect(ctx.pm25UgM3).toBeNull();
    expect(ctx.relativeHumidityPercent).toBeNull();
    expect(ctx.temperatureC).toBeNull();
    expect(ctx.dataSource).toBe('none');
  });

  // خطأ مكتشَف ومُصلَح (مراجعة كود خبير خارجي — "نطاق الرياح النظامي يستخدم
  // رقمًا مشتقًا من الهبات"): كان هذا الاختبار يثبّت عمداً أن ctx.windSpeedKmh
  // يحمل dviResult.effectiveWindKmh (max(سرعة، 0.85×هبة)) بدل السرعة الخام
  // — فهبة عابرة واحدة كانت كافية لتصنيف "سرعة الرياح" النظامية (بروتوكول
  // الملحق أ) فوق 25 كم/س وتفعيل إيقاف تنظيمي بلا أي استمرار فعلي. عُكس
  // التوقع بالكامل: windSpeedKmh يحمل الآن merged.windSpeedKmh الخام حصراً؛
  // effectiveWindKmh يبقى محصوراً في DVI الفيزيائي الداخلي (dust-engine)،
  // والهبات لها قاعدة سلامة منفصلة (GATE-WIND-GUST-SAFETY عبر windGustKmh)
  // لا علاقة لها ببروتوكول الملحق أ.
  it('windSpeedKmh يحمل merged.windSpeedKmh الخام، لا effectiveWindKmh المشتق من الهبات', () => {
    const dviHourly = {
      ...baseDviHourly,
      effectiveWindKmh: 29.66, // رقم مخاطر DVI الداخلي — يجب ألا يظهر هنا
      mergedReading: mergedReadingFixture({ windSpeedKmh: 18 }),
    };
    const ctx = buildComplianceContext({}, {}, dviHourly, []);
    expect(ctx.windSpeedKmh).toBe(18);
    expect(ctx.windSpeedKmh).not.toBe(29.66);
  });

  it("dataSource يُرجع 'device' إن فاز الجهاز بأي حقل، حتى لو حقول أخرى من الطقس", () => {
    const dviHourly = {
      ...baseDviHourly,
      mergedReading: mergedReadingFixture({
        windGustKmh: 12,
        sources: { ...mergedReadingFixture().sources, windGustKmh: 'device', pm10: 'weather' },
      }),
    };
    const ctx = buildComplianceContext({}, {}, dviHourly, []);
    expect(ctx.dataSource).toBe('device');
  });

  // deviceLastReadingAt: undefined صراحةً (لا null) عندما لا يوجد ربط
  // جهاز أصلاً — يميّز "لا محطة" عن "محطة بلا قراءة بعد" في الواجهة
  // (راجع buildStalenessAdvisory في Compliancewidgetcard.tsx).
  it('dataSource=open-meteo (لا ربط جهاز) → deviceLastReadingAt يبقى undefined', () => {
    const dviHourly = { ...baseDviHourly, mergedReading: mergedReadingFixture() };
    const ctx = buildComplianceContext({}, {}, dviHourly, []);
    expect(ctx.dataSource).toBe('open-meteo');
    expect(ctx.deviceLastReadingAt).toBeUndefined();
  });

  it('dataSource=device مع قراءة جهاز موجودة → deviceLastReadingAt ينقل القيمة الفعلية', () => {
    const readingTime = '2026-07-28T09:00:00.000Z';
    const dviHourly = {
      ...baseDviHourly,
      mergedReading: mergedReadingFixture({
        pm10: 260,
        sources: { ...mergedReadingFixture().sources, pm10: 'device' },
        deviceLastReadingAt: readingTime,
      }),
    };
    const ctx = buildComplianceContext({}, {}, dviHourly, []);
    expect(ctx.dataSource).toBe('device');
    expect(ctx.deviceLastReadingAt).toBe(readingTime);
  });

  it('dataSource=device لكن deviceLastReadingAt=null (جهاز مرتبط بلا أي قراءة بعد) → يبقى null لا undefined', () => {
    const dviHourly = {
      ...baseDviHourly,
      mergedReading: mergedReadingFixture({
        pm10: null,
        sources: { ...mergedReadingFixture().sources, pm10: 'device' },
        deviceLastReadingAt: null,
      }),
    };
    const ctx = buildComplianceContext({}, {}, dviHourly, []);
    expect(ctx.dataSource).toBe('device');
    expect(ctx.deviceLastReadingAt).toBeNull();
  });

  it('evaluateDustCompliance يُظهر windDirectionDeg/pm25UgM3 في evidence النهائي', () => {
    const r = evaluateDustCompliance(context({ windDirectionDeg: 180, pm25UgM3: 22 }));
    expect(r.evidence.windDirectionDeg).toBe(180);
    expect(r.evidence.pm25UgM3).toBe(22);
  });

  // خطأ مكتشَف ومُصلَح: كان اتجاه الرياح المستخدَم لحساب المستقبِل باتجاه
  // الريح (crusherDistanceToDownwindReceptorAutoM، عبر buildActivityComplianceProfile)
  // يُقرأ من rawWeatherSample (عينة الطقس الخام قبل الدمج)، بينما الدليل
  // المعروض فعلياً للمستخدم (evidence.windDirectionDeg) هو merged.windDirectionDeg
  // (بعد أولوية جهاز > طقس). حين تتعارض قراءة الجهاز والطقس باتجاه الرياح،
  // كان الحساب يستخدم اتجاهاً غير المعروض على الشاشة — قد يُرجع Infinity
  // (لا مستقبِل باتجاه الريح الخاطئ) رغم مستقبِل حقيقي باتجاه الريح الصحيح
  // المعروض، فتضيع قاعدة MRQ-RECEPTOR-DOWNWIND-120 بصمت.
  it('اتجاه الرياح المستخدَم لحساب المستقبِل باتجاه الريح يطابق اتجاه الجهاز المعروض (merged)، لا اتجاه الطقس الخام المتعارض', () => {
    const receptorNorthOfCrusher: SensitiveReceptor[] = [
      // شمال الكسارة تماماً — "باتجاه الريح" فقط لو الريح قادمة من الجنوب
      // (windDirectionDeg=180 بمعيار "من أين تهب")، لا من الشمال (0°).
      { id: 'r1', name: 'سكني شمالي', receptorType: 'RESIDENTIAL', lat: 24.705, lng: 46.7 },
    ];
    const dviHourly = {
      ...baseDviHourly,
      rawWeatherSample: {
        visibilityM: 10000, weatherCode: 0, weatherSymbol: 'CLEAR' as const,
        windSpeedKmh: 10, windGustKmh: 15,
        // اتجاه الطقس الخام = 0 (جنوبي) — لا يضع المستقبِل الشمالي باتجاه الريح.
        windDirectionDeg: 0,
        relativeHumidityPercent: 20, temperatureC: 30, rainfallLast24hMm: 0,
        pm10: 45, pm25: 18, dustConcentration: 100,
        dataSource: 'open-meteo' as const, isForecastStale: false,
      },
      // اتجاه الجهاز المدموج = 180 (شمالي) — يضع المستقبِل الشمالي باتجاه
      // الريح فعلياً. هذا هو الاتجاه المعروض فعلياً في evidence.windDirectionDeg.
      mergedReading: mergedReadingFixture({ windDirectionDeg: 180, sources: { ...mergedReadingFixture().sources, windDirectionDeg: 'device' } }),
    };
    const row = { regulatory_activity: 'CRUSHER', crusher_lat: 24.7, crusher_lng: 46.7 };
    const ctx = buildComplianceContext(
      {},
      row,
      dviHourly,
      receptorNorthOfCrusher,
      undefined,
      undefined,
      { documented: true, deviationDeg: null }
    );
    // الدليل المعروض يعكس اتجاه الجهاز (180)، ونفس الاتجاه هو ما استُخدم
    // فعلياً لحساب المستقبِل باتجاه الريح — فيجده (ليس Infinity).
    expect(ctx.windDirectionDeg).toBe(180);
    expect(ctx.activity.measurements.crusherDistanceToDownwindReceptorAutoM).not.toBe(Infinity);
    expect(ctx.activity.measurements.crusherDistanceToDownwindReceptorAutoM).not.toBeNull();
  });

  // خطأ مكتشَف ومُصلَح: كان تسجيل pm10_readings_history (في dustEvaluation.ts)
  // يعتمد على preliminaryCtx.dataSource (تلخيص عام لأعلى مصدر فاز بأي حقل،
  // device يفوز أولاً) بدل preliminaryCtx.pm10Source (مصدر PM10 تحديداً). في
  // حالة رياح من الجهاز وPM10 من الطقس معاً، dataSource يصبح 'device' فيُظن
  // خطأً أن PM10 "من الجهاز" (لا يُسجَّل هنا لأنه يُسجَّل عند الاستقبال) بينما
  // فعلياً جاء من الطقس ولم يُسجَّل في أي مكان. pm10Source (من merged.sources.pm10
  // مباشرة) هو الحقل الصحيح لاتخاذ هذا القرار.
  it('pm10Source يعكس مصدر PM10 تحديداً بمعزل عن dataSource العام — رياح من الجهاز وPM10 من الطقس معاً', () => {
    const dviHourly = {
      ...baseDviHourly,
      rawWeatherSample: {
        visibilityM: 10000, weatherCode: 0, weatherSymbol: 'CLEAR' as const,
        windSpeedKmh: 10, windGustKmh: 15, windDirectionDeg: 90,
        relativeHumidityPercent: 20, temperatureC: 30, rainfallLast24hMm: 0,
        pm10: 45, pm25: 18, dustConcentration: 100,
        dataSource: 'open-meteo' as const, isForecastStale: false,
      },
      mergedReading: mergedReadingFixture({
        windSpeedKmh: 25, // من الجهاز
        pm10: 45, // من الطقس
        sources: {
          ...mergedReadingFixture().sources,
          windSpeedKmh: 'device',
          pm10: 'weather',
        },
      }),
    };
    const ctx = buildComplianceContext({}, {}, dviHourly, []);
    // dataSource العام يفوز بـ'device' (ظهر بحقل windSpeedKmh)...
    expect(ctx.dataSource).toBe('device');
    // ...لكن pm10Source يبقى 'weather' فعلياً، بمعزل تام عن dataSource العام.
    expect(ctx.pm10Source).toBe('weather');
  });

  it('pm10Source=device حين يفوز الجهاز بحقل PM10 تحديداً', () => {
    const dviHourly = {
      ...baseDviHourly,
      mergedReading: mergedReadingFixture({
        pm10: 260,
        sources: { ...mergedReadingFixture().sources, pm10: 'device' },
      }),
    };
    const ctx = buildComplianceContext({}, {}, dviHourly, []);
    expect(ctx.pm10Source).toBe('device');
  });

  it('pm10Source=undefined بلا mergedReading (نتيجة DVI مبنية مباشرة بلا دمج)', () => {
    const ctx = buildComplianceContext({}, {}, baseDviHourly, []);
    expect(ctx.pm10Source).toBeUndefined();
  });
});

// عدم تكرار النص بين "القواعد المفعّلة" (triggeredRules) و"الإجراءات
// المطلوبة" (requiredActions): كانت requiredActions تُبنى سابقاً من نفس
// messageAr، فتظهر الجملة نفسها مرتين في بطاقة الامتثال بلا فائدة للمستخدم.
describe('محرك امتثال الغبار — فصل وصف المخالفة عن الإجراء التصحيحي', () => {
  it('كل قاعدة مفعّلة لها actionAr غير فارغ ومختلف عن messageAr', () => {
    const r = evaluateDustCompliance(
      context({
        dviMandatoryStop: true,
        windSpeedKmh: 30,
        activity: activityProfile({
          regulatoryActivity: 'EARTHWORKS',
          controls: { ...activityProfile().controls, surfaceWatered: false },
        }),
      })
    );

    expect(r.triggeredRules.length).toBeGreaterThan(0);
    for (const rule of r.triggeredRules) {
      expect(rule.actionAr.trim().length).toBeGreaterThan(0);
      expect(rule.actionAr).not.toBe(rule.messageAr);
    }
  });

  // خطأ مكتشَف ومُصلَح (مراجعة كود خبير خارجي — H-06.1: "استبعاد قواعد
  // ALLOW_WITH_CONTROLS من requiredActions مطلقاً"): كان الفلتر يستبعد كل
  // قاعدة بشدة ALLOW_WITH_CONTROLS بصرف النظر عن استقلال actionAr عن
  // messageAr فعلياً — فيُخفي الإجراء التصحيحي الأهم تشغيلياً (مثال: تنبيه
  // PM10 الاستباقي) عن قسم "الإجراءات المطلوبة".
  it('H-06.1: قاعدة ALLOW_WITH_CONTROLS (تحذير PM10) → actionAr يظهر في requiredActions، لا يُستبعَد', () => {
    const r = evaluateDustCompliance(context({ pm10UgM3: 260 })); // نطاق 250-340: PM10-WARNING-008
    expect(r.decisionCategory).toBe('ALLOW_WITH_CONTROLS');
    expect(r.triggeredRules.some((h) => h.code === 'PM10-WARNING-008')).toBe(true);
    expect(r.requiredActions.some((a) => a.includes('التثبيط المعزز'))).toBe(true);
  });

  it('لا تتقاطع الإجراءات المطلوبة مع نصوص القواعد المفعّلة إطلاقاً', () => {
    const r = evaluateDustCompliance(
      context({
        dviMandatoryStop: true,
        windSpeedKmh: 30,
        activity: activityProfile({
          regulatoryActivity: 'DEMOLITION',
          controls: { ...activityProfile().controls, dustScreensAvailable: false },
        }),
      })
    );

    const ruleMessages = new Set(r.triggeredRules.map((rule) => rule.messageAr));
    for (const action of r.requiredActions) {
      expect(ruleMessages.has(action)).toBe(false);
    }
  });

  it('الإيقاف الموروث من الخطورة الفيزيائية له شرط استئناف يشرح متى يزول السبب', () => {
    const r = evaluateDustCompliance(context({ dviMandatoryStop: true }));

    expect(r.mandatoryStop).toBe(true);
    expect(
      r.restartConditions.some((c) => c.includes('الرؤية') || c.includes('حالة الجو'))
    ).toBe(true);
  });

  // خطأ مكتشَف ومُصلَح (مراجعة كود خبير خارجي — H-06.2: "شرط انخفاض الرياح
  // تحت 15 يُضاف حتى لقرار سببه PM10/مسافة/DMP"): كان restartConditions
  // يضيف "انخفاض سرعة الرياح إلى ما دون 15 كم/س" بفحص windBand الحالي وحده
  // (windBand !== 'BELOW_15')، بصرف النظر عن كون الرياح سبب الإيقاف الفعلي.
  // نشاط موقوف بسبب مخالفة مسافة كسارة (لا علاقة له بالرياح) كان يعرض شرط
  // استئناف مضلِّل لو الرياح مرتفعة صدفةً بنفس اللحظة. الآن الشرط يُضاف فقط
  // إن كانت قاعدة رياح فعلية (بوابة >25، هدم/قطع أحجار مكشوف) هي القاعدة
  // الفائزة فعلياً. رياح هادئة هنا (10 كم/س، تحت 15) تعزل السيناريو تماماً
  // عن بوابة الرياح — isEnclosedOperation لم يعد يُعفي منها أصلاً (خلاف
  // محطة الخلط بشرطيها)، فرياح مرتفعة كانت ستُفعِّل GATE-WIND-ABOVE-25-004
  // فعلياً وتُبطل نية هذا الاختبار (عزل مسافة الكسارة عن الرياح).
  it('H-06.2: إيقاف بسبب مسافة كسارة (لا رياح، رياح هادئة) → لا يُضاف شرط "انخفاض الرياح" لأنه ليس سبب الإيقاف الفعلي', () => {
    const r = evaluateDustCompliance(
      context({
        windSpeedKmh: 10, // هادئة عمداً — تعزل السيناريو عن بوابة الرياح تماماً
        project: projectProfile({ hasOnsiteCrusher: true }),
        activity: activityProfile({
          regulatoryActivity: 'CRUSHER',
          isEnclosedOperation: true,
          measurements: { ...activityProfile().measurements, crusherDistanceToReceptorM: 300 },
        }),
      })
    );
    expect(r.decisionCategory).toBe('MANDATORY_STOP');
    expect(r.triggeredRules.some((h) => h.code === 'CRUSHER-DISTANCE-500-002C')).toBe(true);
    expect(r.triggeredRules.some((h) => h.code === 'GATE-WIND-ABOVE-25-004')).toBe(false);
    expect(r.restartConditions.some((c) => c.includes('انخفاض سرعة الرياح'))).toBe(false);
  });

  it('H-06.2: إيقاف بسبب بوابة الرياح >25 فعلياً → شرط "انخفاض الرياح" يظهر كما هو متوقَّع', () => {
    const r = evaluateDustCompliance(
      context({
        windSpeedKmh: 30,
        activity: activityProfile({ isEnclosedOperation: false, isDustGenerating: true }),
      })
    );
    expect(r.triggeredRules.some((h) => h.code === 'GATE-WIND-ABOVE-25-004')).toBe(true);
    expect(r.restartConditions.some((c) => c.includes('انخفاض سرعة الرياح'))).toBe(true);
  });
});

// خطأ مكتشَف ومُصلَح — طلب صريح من المستخدم: "ليه ما يقول تنبيه استباقي
// الأجواء غير المناسبة... اتوقع انه يستثني قاعدة PM10". buildPlanningForecastResult
// (يُستدعى عبر evaluateDustCompliance(ctx, now, isPlanning=true)) كانت
// isFavorable فيها تفحص dviDecision (رياح/رؤية فيزيائية) فقط، بلا أي فحص
// لتركيز PM10 المتوقّع — فتوقّع PM10 ضخم (أكبر من حد المخالفة 340 بأضعاف)
// كان ينتج "الأجواء المتوقعة تصلح للنشاط" طالما dviDecision=ALLOW، لكل
// الأنشطة (لا خاص بمحطة الخلط).
describe('evaluateDustCompliance — PLANNING: PM10 المتوقّع يُدرَج ضمن "هل تصلح الأجواء؟"', () => {
  it('dviDecision=ALLOW لكن pm10UgM3 مرتفع جداً + isPlanning=true → "لا تصلح"، decisionCategory يبقى ALLOW (لا إيقاف إلزامي)', () => {
    const r = evaluateDustCompliance(context({ dviDecision: 'ALLOW', pm10UgM3: 1315 }), Date.now(), true);

    expect(r.decisionCategory).toBe('ALLOW'); // لا إيقاف إلزامي على تقدير مهما بلغت القيمة
    expect(r.mandatoryStop).toBe(false);
    expect(r.shortReasonAr).toContain('لا تصلح للنشاط');
    expect(r.shortReasonAr).toContain('1315');
    expect(r.shortReasonAr).toContain('تركيز الغبار');
  });

  it('dviDecision=ALLOW وpm10UgM3 تحت حد التحذير (251) + isPlanning=true → "تصلح للنشاط"', () => {
    const r = evaluateDustCompliance(context({ dviDecision: 'ALLOW', pm10UgM3: 100 }), Date.now(), true);

    expect(r.shortReasonAr).toContain('تصلح للنشاط');
    expect(r.shortReasonAr).not.toContain('لا تصلح للنشاط');
  });

  it('pm10UgM3=null (لا بيانات) + dviDecision=ALLOW + isPlanning=true → يبقى "تصلح للنشاط" (فشل آمن، لا افتراض ارتفاع بلا دليل)', () => {
    const r = evaluateDustCompliance(context({ dviDecision: 'ALLOW', pm10UgM3: null }), Date.now(), true);

    expect(r.shortReasonAr).toContain('تصلح للنشاط');
  });
});

// القسم 18.6 من "دليل الإصلاح الجذري لمنظومة مرقاب": "Forecast قديم: التخطيط
// يظهر نتيجة Stale". isForecastStale=true (Open-Meteo فشل/انقطع لهذه الساعة،
// راجع weather.ts) يجب أن يعرض تحذير قِدم صريح، لا "تصلح"/"لا تصلح" بثقة
// كاملة على تقدير طقس فاشل أصلاً — decisionCategory/mandatoryStop يبقيان
// بلا تغيير (لا إيقاف إلزامي على تقدير، نفس مبدأ isPlanning=true دائماً).
describe('evaluateDustCompliance — PLANNING: توقّع طقس قديم (isForecastStale) يظهر تحذيراً صريحاً (القسم 18.6)', () => {
  it('isForecastStale=true + isPlanning=true → نص تحذير قِدم صريح، لا "تصلح"/"لا تصلح" العادي', () => {
    const r = evaluateDustCompliance(context({ dviDecision: 'ALLOW', pm10UgM3: 100, isForecastStale: true }), Date.now(), true);

    expect(r.decisionCategory).toBe('ALLOW');
    expect(r.mandatoryStop).toBe(false);
    expect(r.shortReasonAr).toContain('قديمة');
    expect(r.shortReasonAr).not.toContain('تصلح للنشاط');
  });

  it('isForecastStale=true حتى مع PM10 مرتفع جداً → لا إيقاف إلزامي، فقط تحذير قِدم (لا "لا تصلح" المرتبط بـPM10)', () => {
    const r = evaluateDustCompliance(context({ dviDecision: 'ALLOW', pm10UgM3: 1315, isForecastStale: true }), Date.now(), true);

    expect(r.decisionCategory).toBe('ALLOW');
    expect(r.mandatoryStop).toBe(false);
    expect(r.shortReasonAr).toContain('قديمة');
  });

  it('isForecastStale=false (طقس حديث) → السلوك المعتاد (تصلح/لا تصلح)، لا تحذير قِدم', () => {
    const r = evaluateDustCompliance(context({ dviDecision: 'ALLOW', pm10UgM3: 100, isForecastStale: false }), Date.now(), true);

    expect(r.shortReasonAr).toContain('تصلح للنشاط');
    expect(r.shortReasonAr).not.toContain('قديمة');
  });
});
