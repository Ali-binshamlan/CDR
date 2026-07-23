import { describe, it, expect } from 'vitest';
import { evaluateDustCompliance } from './engine';
import { classifyProject, classifyWind } from './rulebook';
import { buildActivityComplianceProfile, buildComplianceContext } from './adapters';
import { haversineDistanceM, nearestReceptorDistancesM, receptorsWithinRadiusM, UNIT_RECEPTOR_RADIUS_M } from './geo';
import { computeUnitReceptors } from '@/app/lib/dustEvaluation';
import type {
  DustActivityComplianceProfile,
  DustComplianceContext,
  DustProjectComplianceProfile,
  SensitiveReceptor,
} from './types';

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

      entryPointLat: 24.7,
      entryPointLng: 46.7,
      exitPointLat: 24.7,
      exitPointLng: 46.7,
      waterTracesBeyond15mFromGate: false,

      stockpileDistanceUnder200m: false,

      debrisPileHeightM: null,
    },
    ...overrides,
  };
}

function context(overrides: Partial<DustComplianceContext> = {}): DustComplianceContext {
  return {
    project: projectProfile(),
    activity: activityProfile(),
    dviScore: 10,
    dviDecision: 'ALLOW',
    dviMandatoryStop: false,
    dviConfidenceScore: 95,
    windSpeedKmh: 10,
    windGustKmh: 15,
    windDirectionDeg: 270,
    pm10UgM3: 20,
    pm25UgM3: 12,
    dataSource: 'onsite',
    sensitiveReceptors: [],
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

  it('وراثة bowabة DVI mandatoryStop → إيقاف إلزامي', () => {
    const r = evaluateDustCompliance(context({ dviMandatoryStop: true }));
    expect(r.decisionCategory).toBe('MANDATORY_STOP');
    expect(r.triggeredRules.some((h) => h.code === 'GATE-DVI-002')).toBe(true);
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

  it('عملية مغلقة (isEnclosedOperation=true) مستثناة من بوابة إيقاف الرياح فوق 25', () => {
    // سيناريو حقيقي رصده المستخدم: نشاط هدم مغلق برياح 39.78 كم/س ظهر
    // "مسموح" رغم أن نطاق الرياح ABOVE_25 — سلوك صحيح لأن الإغلاق يمنع
    // تطاير الغبار فيُستثنى تنظيمياً من بوابة GATE-WIND-ABOVE-25-004.
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
    expect(r.triggeredRules.some((h) => h.code === 'GATE-WIND-ABOVE-25-004')).toBe(false);
  });

  it('النتيجة تحمل isEnclosedOperation=false افتراضياً لنشاط مكشوف', () => {
    const r = evaluateDustCompliance(context({ activity: activityProfile({ isEnclosedOperation: false }) }));
    expect(r.isEnclosedOperation).toBe(false);
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

  it('buildActivityComplianceProfile بلا مستقبلات حساسة → حقول المسافة التلقائية null', () => {
    const row = { regulatory_activity: 'CRUSHER', crusher_lat: 24.7, crusher_lng: 46.7 };
    const profile = buildActivityComplianceProfile(row, []);
    expect(profile.measurements.crusherDistanceToNearestReceptorAutoM).toBeNull();
    expect(profile.measurements.crusherDistanceToResidentialReceptorAutoM).toBeNull();
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

  it('محطة خلط مطابقة بالكامل → لا مخالفات', () => {
    const r = evaluateDustCompliance(
      context({ activity: activityProfile({ regulatoryActivity: 'BATCHING_PLANT' }) })
    );
    expect(r.decisionCategory).toBe('ALLOW');
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

  it('فئة ثالثة بمحطة واحدة فقط → غير مكتمل (يلزم محطتان)', () => {
    const r = evaluateDustCompliance(
      context({
        project: projectProfile({ siteAreaM2: 6000, monitoringStationCount: 1 }),
      })
    );
    const obligation = r.monitoringObligations.find((o) => o.key === 'MONITORING_STATION_COUNT');
    expect(obligation?.status).toBe('NON_COMPLIANT');
    expect(r.decisionCategory).not.toBe('ALLOW');
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
    expect(r.rulebookVersion).toBe('RCRC-NCEC-RIYADH-DUST-2026.1');
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
    confidenceScore: 90,
    confidenceLabel: 'High',
    validUntil: new Date().toISOString(),
    time: new Date().toISOString(),
  };

  it('يقرأ windGustKmh/windDirectionDeg/pm25 من rawWeatherSample عندما تتوفر (يصلح خلل as any القديم الذي كان يُرجع null دائماً)', () => {
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
        rainfallLast24hMm: 0,
        pm10: 45,
        pm25: 18,
        dustConcentration: 100,
        dataSource: 'open-meteo' as const,
        isForecastStale: false,
      },
    };
    const ctx = buildComplianceContext({}, {}, dviHourly, []);
    expect(ctx.windGustKmh).toBe(39.78);
    expect(ctx.windDirectionDeg).toBe(315);
    expect(ctx.pm25UgM3).toBe(18);
    expect(ctx.pm10UgM3).toBe(45); // لا يوجد onsite_pm10 في activityRow، فيسقط تلقائياً لقيمة العينة الخام
  });

  it('onsite_pm10 على activityRow له الأولوية على العينة الخام عند توفره', () => {
    const dviHourly = {
      ...baseDviHourly,
      rawWeatherSample: {
        visibilityM: 10000, weatherCode: 0, weatherSymbol: 'CLEAR' as const,
        windSpeedKmh: 25, windGustKmh: 30, windDirectionDeg: 90,
        relativeHumidityPercent: 20, rainfallLast24hMm: 0,
        pm10: 45, pm25: 18, dustConcentration: 100,
        dataSource: 'open-meteo' as const, isForecastStale: false,
      },
    };
    const ctx = buildComplianceContext({}, { onsite_pm10: 999 }, dviHourly, []);
    expect(ctx.pm10UgM3).toBe(999);
  });

  it('بلا rawWeatherSample (نتيجة DVI مبنية مباشرة بلا عينة خام) → الحقول الجديدة null بأمان', () => {
    const ctx = buildComplianceContext({}, {}, baseDviHourly as any, []);
    expect(ctx.windGustKmh).toBeNull();
    expect(ctx.windDirectionDeg).toBeNull();
    expect(ctx.pm25UgM3).toBeNull();
  });

  it('evaluateDustCompliance يُظهر windDirectionDeg/pm25UgM3 في evidence النهائي', () => {
    const r = evaluateDustCompliance(context({ windDirectionDeg: 180, pm25UgM3: 22 }));
    expect(r.evidence.windDirectionDeg).toBe(180);
    expect(r.evidence.pm25UgM3).toBe(22);
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
});
