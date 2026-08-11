// =============================================================
// Riyadh Dust Compliance Engine — Adapters
// تحويل صف Supabase الخام (project + project_dust_profiles) + نتيجة
// DVI الجاهزة (DviEvaluationResult) إلى DustComplianceContext موحّد.
// بنفس نمط buildDustInput في app/lib/craneEvaluation.ts.
// =============================================================

import type { DviEvaluationResult, DviHourlyEvaluation } from '@/app/utils/dust-engine/types';
import type {
  DustActivityComplianceProfile,
  DustComplianceContext,
  DustProjectComplianceProfile,
  DmpApprovalStatus,
  Pm10EvidenceState,
  RegulatoryDustActivity,
  SensitiveReceptor,
  SensitiveReceptorType,
} from './types';
import { nearestReceptorDistancesM, nearestDownwindReceptorDistanceM } from './geo';
import { LIVE_FIELD_FRESHNESS_MS } from '@/app/utils/rule-bundles/field-freshness';

function toNullableNumber(value: unknown): number | null {
  return typeof value === 'number' && !Number.isNaN(value) ? value : null;
}

function toNullableBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

export function buildProjectComplianceProfile(project: Record<string, unknown> | null | undefined): DustProjectComplianceProfile {
  return {
    siteAreaM2: toNullableNumber(project?.site_area_m2),
    dailyTruckMovements: toNullableNumber(project?.daily_truck_movements),
    hasOnsiteCrusher: toNullableBoolean(project?.has_onsite_crusher),
    hasOnsiteBatchingPlant: toNullableBoolean(project?.has_onsite_batching_plant),

    dmpApprovalStatus: (project?.dmp_approval_status as DmpApprovalStatus) ?? 'UNKNOWN',
    dmpSubmittedAt: (project?.dmp_submitted_at as string | null) ?? null,
    dmpApprovedAt: (project?.dmp_approved_at as string | null) ?? null,

    baselineMonitoringDays: toNullableNumber(project?.baseline_monitoring_days),
    monitoringStationCount: toNullableNumber(project?.monitoring_station_count),
    monitoringLoggingIntervalMinutes: toNullableNumber(project?.monitoring_logging_interval_minutes),
    anemometerHeightM: toNullableNumber(project?.anemometer_height_m),
    entryExitCamerasInstalled: toNullableBoolean(project?.entry_exit_cameras_installed),
    cameraRetentionDays: toNullableNumber(project?.camera_retention_days),
    sensitivityMapPrepared: toNullableBoolean(project?.sensitivity_map_prepared),
  };
}

// خطأ مكتشَف ومُصلَح (مراجعة خبير خارجي — "توثيق الشمال الحقيقي موضوع على
// مستوى المشروع، بينما يجب أن يكون مرتبطاً بكل محطة أو حساس اتجاه رياح"):
// كان trueNorthAlignmentDocumented معاملاً boolean فرداً مصدره
// projects.true_north_alignment_documented (عمود واحد لكل المشروع). الآن
// كائن كامل مصدره project_devices (الجهاز الفعلي المرتبط بالنشاط تحديداً،
// راجع migration 202608060001) — كل جهاز يحمل توثيقه الخاص، ويحمل أيضاً
// deviationDeg (الانحراف بين الشمال المغناطيسي المقروء والحقيقي) ليُطبَّق
// على windDirectionDeg الخام قبل استخدامه، لا فقط علم وجود/غياب.
export interface DeviceTrueNorthCalibration {
  documented: boolean | null;
  deviationDeg: number | null;
}

export function buildActivityComplianceProfile(
  row: Record<string, unknown> | null | undefined,
  sensitiveReceptors: SensitiveReceptor[] = [],
  // اتجاه الرياح الفعلي المُدمَج (بعد أولوية جهاز > طقس > onsite — نفس
  // الاتجاه المعروض فعلياً للمستخدم في evidence.windDirectionDeg، لا عينة
  // الطقس الخام قبل الدمج) وتوثيق معايرة الشمال الحقيقي للجهاز المرتبط —
  // تُستخدمان فقط لحساب crusherDistanceToDownwindReceptorAutoM
  // (MRQ-RECEPTOR-DOWNWIND-120). windDirectionDeg يُتجاهَل كلياً إن لم تُوثَّق
  // معايرة الجهاز (فشل آمن نحو "غير صالح"، راجع MRQ-DATA-TRUE-NORTH-111) —
  // بلا ذلك يُبنى قرار تنظيمي على اتجاه رياح قد يكون غير معايَر أصلاً (شمال
  // مغناطيسي/تقريبي). deviationDeg (إن وُجد) يُصحَّح به الاتجاه الخام قبل
  // الاستخدام — انحراف مغناطيسي موثَّق يبقى صالحاً للاستخدام بعد تصحيحه، لا
  // "غير صالح" بالكامل كما كانت الحالة الثنائية القديمة تفرضه ضمنياً.
  windDirectionDeg: number | null = null,
  deviceTrueNorthCalibration: DeviceTrueNorthCalibration | null = null
): DustActivityComplianceProfile {
  const regulatoryActivity: RegulatoryDustActivity = (row?.regulatory_activity as RegulatoryDustActivity) ?? 'OTHER';

  const crusherLat = toNullableNumber(row?.crusher_lat);
  const crusherLng = toNullableNumber(row?.crusher_lng);
  const { nearestAnyM, nearestResidentialM } = nearestReceptorDistancesM(crusherLat, crusherLng, sensitiveReceptors);
  const isAlignmentDocumented = deviceTrueNorthCalibration?.documented === true;
  const correctedWindDirectionDeg =
    windDirectionDeg !== null && deviceTrueNorthCalibration?.deviationDeg
      ? ((windDirectionDeg + deviceTrueNorthCalibration.deviationDeg) % 360 + 360) % 360
      : windDirectionDeg;
  const validWindDirectionDeg = isAlignmentDocumented ? correctedWindDirectionDeg : null;
  const crusherDownwindM = nearestDownwindReceptorDistanceM(crusherLat, crusherLng, validWindDirectionDeg, sensitiveReceptors);

  const stockpileLat = toNullableNumber(row?.stockpile_lat);
  const stockpileLng = toNullableNumber(row?.stockpile_lng);
  const stockpileNearest = nearestReceptorDistancesM(stockpileLat, stockpileLng, sensitiveReceptors);

  const batchingLat = toNullableNumber(row?.batching_lat);
  const batchingLng = toNullableNumber(row?.batching_lng);
  const batchingNearest = nearestReceptorDistancesM(batchingLat, batchingLng, sensitiveReceptors);

  return {
    activityGroupId: (row?.activity_group_id as string | undefined) ?? `dust-${row?.id}`,
    regulatoryActivity,
    isDustGenerating: (row?.is_dust_generating as boolean | undefined) ?? true,
    isEnclosedOperation: toNullableBoolean(row?.is_enclosed_operation) ?? false,
    isActiveOrPlanned: (row?.is_active_or_planned as boolean | undefined) ?? true,
    controls: {
      dustSuppressionSystemOperational: toNullableBoolean(row?.dust_suppression_system_operational),
      continuousMisting: toNullableBoolean(row?.continuous_misting),
      sprayCannonAvailable: toNullableBoolean(row?.spray_cannon_available),
      dustScreensAvailable: toNullableBoolean(row?.dust_screens_available),
      wetCuttingActive: toNullableBoolean(row?.wet_cutting_active),
      hepaExtractionActive: toNullableBoolean(row?.hepa_extraction_active),
      wheelWashOperational: toNullableBoolean(row?.wheel_wash_operational),
      hourlyInspectionRecorded: toNullableBoolean(row?.hourly_inspection_recorded),
      speedControlApplied: toNullableBoolean(row?.speed_control_applied),
      loadCovered: toNullableBoolean(row?.load_covered),
      conveyorsEnclosed: toNullableBoolean(row?.conveyors_enclosed),
      foggingAvailable: toNullableBoolean(row?.fogging_available),
      idleSurfaceStabilized: toNullableBoolean(row?.idle_surface_stabilized),
      silosSealed: toNullableBoolean(row?.silos_sealed),
      pm10FilterEfficiencyPercent: toNullableNumber(row?.pm10_filter_efficiency_percent),
      leakDetected: toNullableBoolean(row?.leak_detected),
      dryCleaningMethodUsed: toNullableBoolean(row?.dry_cleaning_method_used),
      idleSurfaceCoverIntact: toNullableBoolean(row?.idle_surface_cover_intact),
      surfaceWatered: toNullableBoolean(row?.surface_watered),

      truckRoutesDesignated: toNullableBoolean(row?.truck_routes_designated),
      pathCoverMaterial: (row?.path_cover_material as DustActivityComplianceProfile['controls']['pathCoverMaterial']) ?? null,
      waterSprayMethod: (row?.water_spray_method as DustActivityComplianceProfile['controls']['waterSprayMethod']) ?? null,
      soilCompactedAfterExcavation: toNullableBoolean(row?.soil_compacted_after_excavation),
      stabilizerUsedDuringPause: toNullableBoolean(row?.stabilizer_used_during_pause),
      pauseDurationOver5Days: toNullableBoolean(row?.pause_duration_over_5_days),
      sprayUsedDuringSoilUnloading: toNullableBoolean(row?.spray_used_during_soil_unloading),
      workAreaPhased: toNullableBoolean(row?.work_area_phased),

      unpavedRoadsWateredDaily: toNullableBoolean(row?.unpaved_roads_watered_daily),
      dustControlMethod: (row?.dust_control_method as DustActivityComplianceProfile['controls']['dustControlMethod']) ?? null,
      speedLimitSignsPosted: toNullableBoolean(row?.speed_limit_signs_posted),
      containersCoveredBeforeMoving: toNullableBoolean(row?.containers_covered_before_moving),
      containersInspectedBeforeDeparture: toNullableBoolean(row?.containers_inspected_before_departure),
      loadHeightExceedsContainerLimit: toNullableBoolean(row?.load_height_exceeds_container_limit),
      adjacentRoadsSweptMechanically: toNullableBoolean(row?.adjacent_roads_swept_mechanically),
      sweepFrequencyBand: (row?.sweep_frequency_band as DustActivityComplianceProfile['controls']['sweepFrequencyBand']) ?? null,
      wheelWashAtExit: toNullableBoolean(row?.wheel_wash_at_exit),
      wheelWashMaintainedRegularly: toNullableBoolean(row?.wheel_wash_maintained_regularly),
      washWaterRecycled: toNullableBoolean(row?.wash_water_recycled),
      allLoadsCovered: toNullableBoolean(row?.all_loads_covered),
      trucksInspectedBeforeDeparture: toNullableBoolean(row?.trucks_inspected_before_departure),
      loadSideCoverageAdequate: toNullableBoolean(row?.load_side_coverage_adequate),
      publicRoadsVacuumSweptDaily: toNullableBoolean(row?.public_roads_vacuum_swept_daily),
      waterUsedRoutinelyForCleaning: toNullableBoolean(row?.water_used_routinely_for_cleaning),

      accessRoadPaved: toNullableBoolean(row?.access_road_paved),
      tireCleaningMethod: (row?.tire_cleaning_method as DustActivityComplianceProfile['controls']['tireCleaningMethod']) ?? null,
      sandTrapPresent: toNullableBoolean(row?.sand_trap_present),
      oilSeparatorPresent: toNullableBoolean(row?.oil_separator_present),
      washCycleDurationAdequate: toNullableBoolean(row?.wash_cycle_duration_adequate),
      wheelWashOperationMethod: (row?.wheel_wash_operation_method as DustActivityComplianceProfile['controls']['wheelWashOperationMethod']) ?? null,
      washWaterReused: toNullableBoolean(row?.wash_water_reused),
      antiSlipMeshPresent: toNullableBoolean(row?.anti_slip_mesh_present),
      immersionZoneLengthAdequate: toNullableBoolean(row?.immersion_zone_length_adequate),
      collectionBasinPresent: toNullableBoolean(row?.collection_basin_present),
      truckPathCleanedWithin15Min: toNullableBoolean(row?.truck_path_cleaned_within_15_min),

      exposedAreaCurrentlyIdle: toNullableBoolean(row?.exposed_area_currently_idle),
      stabilizationMethod: (row?.stabilization_method as DustActivityComplianceProfile['controls']['stabilizationMethod']) ?? null,
      stockpileAreaExists: toNullableBoolean(row?.stockpile_area_exists),
      suppressantUsedAtStockpileArea: toNullableBoolean(row?.suppressant_used_at_stockpile_area),
      windBarriersNearStockpiles: toNullableBoolean(row?.wind_barriers_near_stockpiles),
      constructionScheduledImmediatelyAfterPrep: toNullableBoolean(row?.construction_scheduled_immediately_after_prep),

      centralizedStorage: toNullableBoolean(row?.centralized_storage),
      distributedAcrossMultipleLocations: toNullableBoolean(row?.distributed_across_multiple_locations),
      sprayedImmediatelyAfterUnloading: toNullableBoolean(row?.sprayed_immediately_after_unloading),
      fullSubmersionOfPiles: toNullableBoolean(row?.full_submersion_of_piles),
      stockpileShapeLowRounded: toNullableBoolean(row?.stockpile_shape_low_rounded),
      unusedPilesCoveredDaily: toNullableBoolean(row?.unused_piles_covered_daily),
      cementInSealedSilos: toNullableBoolean(row?.cement_in_sealed_silos),
      silosHavePm10Filters: toNullableBoolean(row?.silos_have_pm10_filters),
      pilesBehindWindBarriers: toNullableBoolean(row?.piles_behind_wind_barriers),
      conveyorsUseAutoSpray: toNullableBoolean(row?.conveyors_use_auto_spray),
      windBarriersAlignedWithPrevailingWind: toNullableBoolean(row?.wind_barriers_aligned_with_prevailing_wind),
      barrierDistanceRatioCompliant: toNullableBoolean(row?.barrier_distance_ratio_compliant),

      filterMaintenancePerformedRegularly: toNullableBoolean(row?.filter_maintenance_performed_regularly),
      leakPreventionInspectedRegularly: toNullableBoolean(row?.leak_prevention_inspected_regularly),
      suppressionSystemCheckedDaily: toNullableBoolean(row?.suppression_system_checked_daily),
      manualDrySweepingBanned: toNullableBoolean(row?.manual_dry_sweeping_banned),
      compressedAirBanned: toNullableBoolean(row?.compressed_air_banned),
      siteCleaningMethod: (row?.site_cleaning_method as DustActivityComplianceProfile['controls']['siteCleaningMethod']) ?? null,
      wasteHumidityMaintainedDuringTransport: toNullableBoolean(row?.waste_humidity_maintained_during_transport),
      wasteLoadsCovered: toNullableBoolean(row?.waste_loads_covered),

      sprayCannonRangeBand: (row?.spray_cannon_range_band as DustActivityComplianceProfile['controls']['sprayCannonRangeBand']) ?? null,
      crushersCoveredDemolition: toNullableBoolean(row?.crushers_covered_demolition),
      loadingPointsHaveSprinklers: toNullableBoolean(row?.loading_points_have_sprinklers),
      demolitionCuttingMethod: (row?.demolition_cutting_method as DustActivityComplianceProfile['controls']['demolitionCuttingMethod']) ?? null,
      sandblastingUsed: toNullableBoolean(row?.sandblasting_used),
      sandblastingInEnclosedBox: toNullableBoolean(row?.sandblasting_in_enclosed_box),

      crusherUnitsFullyCovered: toNullableBoolean(row?.crusher_units_fully_covered),
      loadingPointsHaveSpraySystems: toNullableBoolean(row?.loading_points_have_spray_systems),
      sprayCannonsAroundCrusher: toNullableBoolean(row?.spray_cannons_around_crusher),
      conveyorsCoveredCrusher: toNullableBoolean(row?.conveyors_covered_crusher),
      dropHeightReducedAtCrusher: toNullableBoolean(row?.drop_height_reduced_at_crusher),
      suctionAndFiltrationSystemsPresent: toNullableBoolean(row?.suction_and_filtration_systems_present),
      criticalScheduleApplies: toNullableBoolean(row?.critical_schedule_applies),

      cuttingResiduesCleanedAfterCompletion: toNullableBoolean(row?.cutting_residues_cleaned_after_completion),

      debrisSprayedBeforeLoading: toNullableBoolean(row?.debris_sprayed_before_loading),
      centralStorageArea: toNullableBoolean(row?.central_storage_area),
      smallPilesDispersedMultipleLocations: toNullableBoolean(row?.small_piles_dispersed_multiple_locations),
      dailyRemoval: toNullableBoolean(row?.daily_removal),
      coveredIfNotRemovedDaily: toNullableBoolean(row?.covered_if_not_removed_daily),
      debrisCompacted: toNullableBoolean(row?.debris_compacted),
      onlyActiveSectionSprayed: toNullableBoolean(row?.only_active_section_sprayed),
      loadExceedsCapacity: toNullableBoolean(row?.load_exceeds_capacity),
    },
    measurements: {
      demolitionActiveAreaM2: toNullableNumber(row?.demolition_active_area_m2),
      crusherDistanceToReceptorM: toNullableNumber(row?.crusher_distance_to_receptor_m),
      stockpileBatchingDistanceToReceptorM: toNullableNumber(row?.stockpile_batching_distance_to_receptor_m),
      stockpileHeightM: toNullableNumber(row?.stockpile_height_m),
      dropHeightM: toNullableNumber(row?.drop_height_m),
      idleDays: toNullableNumber(row?.idle_days),
      spillCleanupMinutes: toNullableNumber(row?.spill_cleanup_minutes),
      unpavedSpeedKmh: toNullableNumber(row?.unpaved_speed_kmh),
      pavedSpeedKmh: toNullableNumber(row?.paved_speed_kmh),
      visibleTrackoutBeyond15m: toNullableBoolean(row?.visible_trackout_beyond_15m),
      exposedSoilAreaM2: toNullableNumber(row?.exposed_soil_area_m2),

      crusherLat,
      crusherLng,
      crusherDistanceToNearestReceptorAutoM: nearestAnyM,
      crusherDistanceToResidentialReceptorAutoM: nearestResidentialM,
      crusherDistanceToDownwindReceptorAutoM: crusherDownwindM,

      entryPointLat: toNullableNumber(row?.entry_point_lat),
      entryPointLng: toNullableNumber(row?.entry_point_lng),
      exitPointLat: toNullableNumber(row?.exit_point_lat),
      exitPointLng: toNullableNumber(row?.exit_point_lng),
      waterTracesBeyond15mFromGate: toNullableBoolean(row?.water_traces_beyond_15m_from_gate),

      stockpileLat,
      stockpileLng,
      stockpileDistanceToNearestReceptorAutoM: stockpileNearest.nearestAnyM,
      stockpileDistanceToResidentialReceptorAutoM: stockpileNearest.nearestResidentialM,
      stockpileDistanceUnder200m: toNullableBoolean(row?.stockpile_distance_under_200m),

      batchingLat,
      batchingLng,
      batchingDistanceToNearestReceptorAutoM: batchingNearest.nearestAnyM,
      batchingDistanceToResidentialReceptorAutoM: batchingNearest.nearestResidentialM,

      debrisPileHeightM: toNullableNumber(row?.debris_pile_height_m),
    },
    // خطأ مكتشَف ومُصلَح (مراجعة خبير خارجي — راجع تعليق الحقل الكامل في
    // types.ts): مشتق من طول المصفوفة العالمية الممرَّرة فعلياً من مصدر
    // الجلب (sensitive_receptors كاملاً، لا مُصفّاة حسب موقع النشاط بعد —
    // nearestReceptorDistancesM/nearestDownwindReceptorDistanceM أعلاه هما
    // من يُصفّيان حسب المسافة). طول صفر هنا يعني "لا يوجد أي مستقبِل حساس
    // مسجَّل في النظام كله بعد"، لا "لا مستقبِل قريب من هذا الموقع تحديداً".
    sensitiveReceptorsDataAvailable: sensitiveReceptors.length > 0,
  };
}

// dviResult هو windowEval.worst (DviEvaluationResult) الجاهز من computeDustResults —
// لا إعادة حساب هنا إطلاقاً، فقط قراءة الحقول المطلوبة.
// dviResult هو windowEval.worst (DviHourlyEvaluation فعلياً في وقت التشغيل،
// يحمل rawWeatherSample) — النوع هنا DviEvaluationResult|DviHourlyEvaluation
// لقبول كليهما (اختبارات الوحدة تبني DviEvaluationResult مباشرة بلا عينة خام).
export function buildComplianceContext(
  project: Record<string, unknown> | null | undefined,
  activityRow: Record<string, unknown> | null | undefined,
  dviResult: DviEvaluationResult | DviHourlyEvaluation,
  sensitiveReceptors: SensitiveReceptor[] = [],
  // آخر قرار امتثال مسجَّل لنفس activity_group_id (من
  // current_dust_compliance_decisions) — يُستخدم لمنع الاستئناف التلقائي
  // الفوري بعد إيقاف (راجع RESUME_STABILITY_MINUTES في engine.ts). اختياري
  // ويبقى undefined في أي مسار لا يجلبه (مثل الشبكة الساعية التوقّعية)،
  // فلا يُطبَّق أي قيد هناك تلقائياً. pending_resume_since منفصل تماماً عن
  // updated_at — راجع previousPendingResumeSince في types.ts للسبب الكامل.
  previousDecision?: {
    decision: string;
    updated_at: string;
    pending_resume_since?: string | null;
    deciding_rule_code?: string | null;
    // خطأ مكتشَف ومُصلَح (راجع تعليق previousEvaluationUpdatedAt الكامل في
    // types.ts): updated_at أعلاه محمَّل بدلالة "منذ متى بدأ الإيقاف" (stopped_
    // since ?? updated_at) — raw_updated_at الخام (بلا استبدال) منفصل تماماً،
    // لاكتشاف فجوة تقييم فقط. اختياري: undefined = لا فحص فجوة (توافقي).
    raw_updated_at?: string | null;
  } | null,
  // استمرار PM10 عبر الزمن (الكائن الكامل المُرجَع من computeSustainedPm10Status
  // في dustEvaluation.ts، لا الرقمين المُجرَّدين فقط) — اختياري، undefined
  // يعني "لا بيانات استمرار" فيسلك المحرك مساره الاحتياطي الآمن (معاملة
  // القراءة كأنها لحظية فقط). isConfirmedViolation340/isSuspended250For30Min
  // محسوبتان هناك بكل الأدلة اللازمة (المصدر، حداثة القراءة) — يُمرَّران هنا
  // كما هما، بلا إعادة اشتقاق في rulebook.ts (راجع pm10ConfirmedViolation340
  // في types.ts للسبب الكامل).
  pm10Sustained?: {
    sustainedMinutesAbove340: number;
    sustainedMinutesAbove250: number;
    isConfirmedViolation340: boolean;
    isSuspended250For30Min: boolean;
    evidenceReadingIds?: string[];
  } | null,
  // توثيق معايرة الشمال الحقيقي للجهاز الفعلي المرتبط بهذا النشاط (لا
  // المشروع كله — راجع تعليق buildActivityComplianceProfile الكامل).
  // اختياري: undefined/null يعني "لا جهاز مرتبط أو لا توثيق مسجَّل"، فيُعامَل
  // اتجاه الرياح كغير صالح لقاعدة المستقبِل باتجاه الريح (فشل آمن).
  deviceTrueNorthCalibration?: DeviceTrueNorthCalibration | null,
  // خطأ مكتشَف ومُصلَح (مراجعة كود خارجي — راجع تعليق Pm10EvidenceState
  // الكامل في types.ts): وقت "الآن" المستخدَم لحساب حداثة قراءة PM10 —
  // Date.now() افتراضياً (توافقي مع كل الاستدعاءات القديمة)، لكن المستدعي
  // يجب أن يمرّر نفس اللحظة الممرَّرة لاحقاً لـ evaluateDustCompliance(ctx, now)
  // صراحة (لا يترك القيمة الافتراضية) حتى يمكن إعادة حساب نفس القرار لاحقاً
  // (Replay/تدقيق) بنفس النتيجة تماماً — استدعاءان منفصلان لـ Date.now() في
  // نفس التقييم قد يقعان على جانبين مختلفين من حد 4 دقائق نظرياً.
  evaluatedAtMs: number = Date.now(),
  // خطأ مكتشَف ومُصلَح (راجع تعليق previousDecisionQueryFailed الكامل في
  // types.ts): true فقط عندما فشل استعلام current_dust_compliance_decisions
  // فعلياً (لا "لا صف موجود") — مستقل عن previousDecision نفسه (قد يكون
  // null في كلتا الحالتين، الفشل هو ما يميّزهما). افتراضي false (توافقي).
  previousDecisionQueryFailed: boolean = false
): DustComplianceContext {
  // القراءة المدموجة فعلياً (بعد أولوية جهاز > طقس > onsite — راجع
  // mergeDustReading في dust-engine/engine.ts) متوفرة فقط إن كان dviResult
  // فعلياً DviHourlyEvaluation (الحالة الحقيقية دائماً في مسار التشغيل
  // الفعلي عبر windowEval.worst).
  //
  // كل حقول القراءة هنا تُقرأ الآن من mergedReading نفسه الذي حسبه DVI
  // فعلاً — بدل اشتقاق سلسلة أولوية منفصلة هنا كانت متضاربة معه (بعض
  // الحقول قديماً كانت تتجاهل الجهاز كلياً، وPM10 كان يُفضِّل onsite على كل
  // شيء آخر). هذا هو سبب تناقضات "بانر أخضر مقابل بطاقة حمراء" التي أُصلحت
  // سابقاً — قراءة واحدة موحَّدة بدل مصدرين قد يختلفان.
  //
  // خطأ مكتشَف ومُصلَح: كان اتجاه الرياح المستخدَم لحساب المستقبِل باتجاه
  // الريح (crusherDistanceToDownwindReceptorAutoM أدناه) يُقرأ من rawSample
  // (عينة الطقس الخام قبل الدمج)، بينما الدليل المعروض فعلياً للمستخدم
  // (evidence.windDirectionDeg في engine.ts) هو merged.windDirectionDeg —
  // فحين تكون قراءة الجهاز والطقس متعارضتين باتجاه الرياح (مثال: جهاز=0°،
  // طقس=180°)، كان الحساب يستخدم اتجاهاً غير الاتجاه المعروض فعلياً على
  // الشاشة، فقد يُرجع Infinity (لا مستقبِل باتجاه الريح الخاطئ) رغم وجود
  // مستقبِل حقيقي باتجاه الريح الصحيح المعروض، فتضيع قاعدة
  // MRQ-RECEPTOR-DOWNWIND-120 بصمت. استخدام merged?.windDirectionDeg هنا
  // يضمن اتساق الاتجاه المستخدَم في الحساب مع الاتجاه المعروض للمستخدم دائماً.
  const merged = (dviResult as Partial<DviHourlyEvaluation>).mergedReading;
  // القسم 18.6 من "دليل الإصلاح الجذري لمنظومة مرقاب" — "Forecast قديم:
  // التخطيط يظهر نتيجة Stale": rawWeatherSample.isForecastStale (weather.ts،
  // يُضبَط true عند فشل/انقطاع Open-Meteo، راجع fetchJson) لم يكن يصل محرك
  // الامتثال إطلاقاً من قبل — DustComplianceContext لم يحمل هذا الحقل. لا
  // معنى له إلا لمسار PLANNING (Live مبني من الجهاز مباشرة، بلا rawWeatherSample
  // ذات صلة أصلاً — راجع evaluateLiveOperationalDecision).
  const isForecastStale = (dviResult as Partial<DviHourlyEvaluation>).rawWeatherSample?.isForecastStale === true;
  const mergedWindDirectionDeg = toNullableNumber(merged?.windDirectionDeg);

  // dataSource للعرض فقط: أعلى مصدر فاز فعلياً عبر أي حقل من حقول
  // mergedReading.sources، بترتيب device > open-meteo > onsite > none. لا
  // يوجد مصدر واحد "صحيح" لكل الحقول دائماً (مثال: جهاز يرسل رياح فقط،
  // فالرطوبة تبقى من الطقس رغم وجود جهاز فعلي) — هذا أفضل تلخيص ممكن.
  const sourceValues = merged ? Object.values(merged.sources) : [];
  const dataSource: DustComplianceContext['dataSource'] = sourceValues.includes('device')
    ? 'device'
    : sourceValues.includes('weather')
    ? 'open-meteo'
    : sourceValues.includes('onsite')
    ? 'onsite'
    : 'none';

  const pm10RawUgM3 = toNullableNumber(merged?.pm10);
  const pm10SourceValue = merged?.sources.pm10;
  // خطأ مكتشَف ومُصلَح (مراجعة كود خارجي — راجع تعليق Pm10EvidenceState
  // الكامل في types.ts): البوابة الفعلية المفقودة — pm10ThresholdRule
  // (rulebook.ts) كان يقارن pm10UgM3 الخام مباشرة بـ340/250 بلا أي شرط
  // حداثة خاص به (بخلاف الرياح/الرؤية المارّتين عبر freshOrNull في dust-
  // engine/engine.ts). تُطبَّق فقط على pm10Source='device' — قراءة طقس/يدوية
  // ليست "قراءة جهاز" لها عمر بنفس المعنى (نفس استثناء dust-engine/engine.ts
  // بالضبط)، فتُعامَل كطازجة دائماً (FRESH) بصرف النظر عن devicePm10LastReadingAt.
  const pm10EvidenceState: Pm10EvidenceState = (() => {
    if (pm10SourceValue !== 'device') return 'FRESH';
    const observedAtIso = merged?.devicePm10LastReadingAt;
    if (!observedAtIso) return 'MISSING';
    const ageMs = evaluatedAtMs - Date.parse(observedAtIso);
    if (Number.isNaN(ageMs)) return 'MISSING';
    if (ageMs < 0) return 'FUTURE';
    return ageMs <= LIVE_FIELD_FRESHNESS_MS ? 'FRESH' : 'STALE';
  })();
  // pm10UgM3 (يدخل pm10ThresholdRule مباشرة) يُصفَّر إلى null عند STALE/
  // FUTURE/MISSING لقراءة جهاز — لا "بلا بيانات" مموَّهة كصفر ولا قيمة قديمة
  // تُعامَل كحية. pm10RawUgM3 يبقى دائماً القيمة الخام كاملة، للعرض/التدقيق
  // فقط (راجع evidence.pm10UgM3 في engine.ts الذي يعرض الخام دائماً).
  const pm10UgM3ForDecision = pm10EvidenceState === 'FRESH' ? pm10RawUgM3 : null;

  return {
    project: buildProjectComplianceProfile(project),
    activity: buildActivityComplianceProfile(
      activityRow,
      sensitiveReceptors,
      mergedWindDirectionDeg,
      deviceTrueNorthCalibration ?? null
    ),
    isForecastStale,
    dviScore: dviResult.score,
    dviDecision: dviResult.decisionCategory,
    dviMandatoryStop: dviResult.mandatoryStop,
    // true فقط عندما يكون سبب إيقاف DVI الإلزامي الوحيد هو تجاوز PM10≥340
    // اللحظي — بلا أي خطر فيزيائي فوري آخر (رؤية حرجة/رياح شديدة) مساهم بنفس
    // اللحظة. يُقرأ الآن من stopBasis/confirmationState (حقول Typed، القسم
    // 4.4 من "دليل الإصلاح الجذري") بدل مطابقة نص كود قاعدة يدوياً — نفس
    // الدلالة بالضبط. تُستخدم في GATE-DVI-002 (engine.ts) لمنع قراءة PM10
    // لحظية واحدة من التحول مباشرة لـMANDATORY_STOP تنظيمي قطعي دون نفس
    // دليل الاستمرار (>دقيقتين) الذي يشترطه pm10ThresholdRule لعتبة
    // PM10-VIOLATION-STOP-006.
    dviMandatoryStopIsPm10Only: dviResult.stopBasis === 'PM10' && dviResult.confirmationState === 'PENDING',
    // راجع تعليق dviVisibilityDataMissing الكامل في types.ts.
    dviVisibilityDataMissing: dviResult.visibilityDataMissing === true,
    dviShortReason: dviResult.shortReason ?? null,
    dviConfidenceScore: dviResult.confidenceScore,
    // خطأ مكتشَف ومُصلَح (مراجعة كود خبير خارجي — "نطاق الرياح النظامي
    // يستخدم رقمًا مشتقًا من الهبات"): كان يُمرَّر dviResult.effectiveWindKmh
    // هنا (max(سرعة، 0.85×هبة)، رقم مخاطر DVI الداخلي) بدل سرعة الرياح
    // الخام — تعليق سابق هنا كان يصف هذا كـ"استثناء مقصود" ويمنع تعديله،
    // لكن ذلك التعليق كان تحذيراً وقائياً ضد كسر القواعد أثناء إعادة هيكلة
    // سابقة، لا قراراً تنظيمياً بأن الهبات تُحسب ضمن "سرعة الرياح" في نص
    // الملحق أ (الذي لا يذكر الهبات إطلاقاً). راجع تعليق windSpeedKmh في
    // types.ts للتفصيل الكامل؛ effectiveWindKmh يبقى محصوراً في DVI
    // (dust-engine/engine.ts) فقط. windGustSafetyRule في rulebook.ts هي
    // القاعدة الوحيدة الآن التي تقرأ windGustKmh لأي قرار تنظيمي.
    windSpeedKmh: merged?.windSpeedKmh ?? null,
    windGustKmh: merged?.windGustKmh ?? null,
    windDirectionDeg: merged?.windDirectionDeg ?? null,
    pm10UgM3: pm10UgM3ForDecision,
    pm25UgM3: merged?.pm25 ?? null,
    relativeHumidityPercent: merged?.relativeHumidityPercent ?? null,
    temperatureC: merged?.temperatureC ?? null,
    visibilityM: merged?.visibilityM ?? null,
    // undefined صراحةً (لا null) عندما لا يوجد ربط جهاز أصلاً (dataSource
    // ليس 'device') — يميّز "لا محطة مرتبطة" عن "محطة مرتبطة بلا قراءة
    // بعد" (null فعلياً)، حتى تعرف الواجهة متى تفعّل تحذير القِدم أصلاً.
    deviceLastReadingAt: dataSource === 'device' ? merged?.deviceLastReadingAt ?? null : undefined,
    devicePm10LastReadingAt: dataSource === 'device' ? merged?.devicePm10LastReadingAt ?? null : undefined,
    dviCaveatsAr: dviResult.caveatsAr ?? [],
    dataSource,
    pm10Source: pm10SourceValue,
    pm10RawUgM3,
    pm10EvidenceState,
    sensitiveReceptors,
    previousDecisionCategory: (previousDecision?.decision as DustComplianceContext['previousDecisionCategory']) ?? null,
    previousDecidingRuleCode: previousDecision?.deciding_rule_code ?? null,
    previousDecisionUpdatedAt: previousDecision?.updated_at ?? null,
    previousEvaluationUpdatedAt: previousDecision?.raw_updated_at ?? null,
    previousPendingResumeSince: previousDecision?.pending_resume_since ?? null,
    previousDecisionQueryFailed,
    pm10SustainedMinutesAbove340: pm10Sustained?.sustainedMinutesAbove340,
    pm10SustainedMinutesAbove250: pm10Sustained?.sustainedMinutesAbove250,
    pm10ConfirmedViolation340: pm10Sustained?.isConfirmedViolation340,
    pm10Suspended250For30Min: pm10Sustained?.isSuspended250For30Min,
    pm10EvidenceReadingIds: pm10Sustained?.evidenceReadingIds,
  };
}

export function buildSensitiveReceptor(row: Record<string, unknown> | null | undefined): SensitiveReceptor {
  return {
    id: String(row?.id ?? ''),
    name: (row?.name as string | undefined) ?? '',
    receptorType: (row?.receptor_type as SensitiveReceptorType) ?? 'OTHER',
    lat: Number(row?.lat),
    lng: Number(row?.lng),
  };
}
