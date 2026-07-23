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
  RegulatoryDustActivity,
  SensitiveReceptor,
  SensitiveReceptorType,
} from './types';
import { nearestReceptorDistancesM } from './geo';

function toNullableNumber(value: unknown): number | null {
  return typeof value === 'number' && !Number.isNaN(value) ? value : null;
}

function toNullableBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

export function buildProjectComplianceProfile(project: any): DustProjectComplianceProfile {
  return {
    siteAreaM2: toNullableNumber(project?.site_area_m2),
    dailyTruckMovements: toNullableNumber(project?.daily_truck_movements),
    hasOnsiteCrusher: toNullableBoolean(project?.has_onsite_crusher),
    hasOnsiteBatchingPlant: toNullableBoolean(project?.has_onsite_batching_plant),

    dmpApprovalStatus: (project?.dmp_approval_status as DmpApprovalStatus) ?? 'UNKNOWN',
    dmpSubmittedAt: project?.dmp_submitted_at ?? null,
    dmpApprovedAt: project?.dmp_approved_at ?? null,

    baselineMonitoringDays: toNullableNumber(project?.baseline_monitoring_days),
    monitoringStationCount: toNullableNumber(project?.monitoring_station_count),
    monitoringLoggingIntervalMinutes: toNullableNumber(project?.monitoring_logging_interval_minutes),
    anemometerHeightM: toNullableNumber(project?.anemometer_height_m),
    entryExitCamerasInstalled: toNullableBoolean(project?.entry_exit_cameras_installed),
    cameraRetentionDays: toNullableNumber(project?.camera_retention_days),
    sensitivityMapPrepared: toNullableBoolean(project?.sensitivity_map_prepared),
  };
}

export function buildActivityComplianceProfile(
  row: any,
  sensitiveReceptors: SensitiveReceptor[] = []
): DustActivityComplianceProfile {
  const regulatoryActivity: RegulatoryDustActivity = row?.regulatory_activity ?? 'OTHER';

  const crusherLat = toNullableNumber(row?.crusher_lat);
  const crusherLng = toNullableNumber(row?.crusher_lng);
  const { nearestAnyM, nearestResidentialM } = nearestReceptorDistancesM(crusherLat, crusherLng, sensitiveReceptors);

  const stockpileLat = toNullableNumber(row?.stockpile_lat);
  const stockpileLng = toNullableNumber(row?.stockpile_lng);
  const stockpileNearest = nearestReceptorDistancesM(stockpileLat, stockpileLng, sensitiveReceptors);

  const batchingLat = toNullableNumber(row?.batching_lat);
  const batchingLng = toNullableNumber(row?.batching_lng);
  const batchingNearest = nearestReceptorDistancesM(batchingLat, batchingLng, sensitiveReceptors);

  return {
    activityGroupId: row?.activity_group_id ?? `dust-${row?.id}`,
    regulatoryActivity,
    isDustGenerating: row?.is_dust_generating ?? true,
    isEnclosedOperation: toNullableBoolean(row?.is_enclosed_operation) ?? false,
    isActiveOrPlanned: row?.is_active_or_planned ?? true,
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
      pathCoverMaterial: row?.path_cover_material ?? null,
      waterSprayMethod: row?.water_spray_method ?? null,
      soilCompactedAfterExcavation: toNullableBoolean(row?.soil_compacted_after_excavation),
      stabilizerUsedDuringPause: toNullableBoolean(row?.stabilizer_used_during_pause),
      pauseDurationOver5Days: toNullableBoolean(row?.pause_duration_over_5_days),
      sprayUsedDuringSoilUnloading: toNullableBoolean(row?.spray_used_during_soil_unloading),
      workAreaPhased: toNullableBoolean(row?.work_area_phased),

      unpavedRoadsWateredDaily: toNullableBoolean(row?.unpaved_roads_watered_daily),
      dustControlMethod: row?.dust_control_method ?? null,
      speedLimitSignsPosted: toNullableBoolean(row?.speed_limit_signs_posted),
      containersCoveredBeforeMoving: toNullableBoolean(row?.containers_covered_before_moving),
      containersInspectedBeforeDeparture: toNullableBoolean(row?.containers_inspected_before_departure),
      loadHeightExceedsContainerLimit: toNullableBoolean(row?.load_height_exceeds_container_limit),
      adjacentRoadsSweptMechanically: toNullableBoolean(row?.adjacent_roads_swept_mechanically),
      sweepFrequencyBand: row?.sweep_frequency_band ?? null,
      wheelWashAtExit: toNullableBoolean(row?.wheel_wash_at_exit),
      wheelWashMaintainedRegularly: toNullableBoolean(row?.wheel_wash_maintained_regularly),
      washWaterRecycled: toNullableBoolean(row?.wash_water_recycled),
      allLoadsCovered: toNullableBoolean(row?.all_loads_covered),
      trucksInspectedBeforeDeparture: toNullableBoolean(row?.trucks_inspected_before_departure),
      loadSideCoverageAdequate: toNullableBoolean(row?.load_side_coverage_adequate),
      publicRoadsVacuumSweptDaily: toNullableBoolean(row?.public_roads_vacuum_swept_daily),
      waterUsedRoutinelyForCleaning: toNullableBoolean(row?.water_used_routinely_for_cleaning),

      accessRoadPaved: toNullableBoolean(row?.access_road_paved),
      tireCleaningMethod: row?.tire_cleaning_method ?? null,
      sandTrapPresent: toNullableBoolean(row?.sand_trap_present),
      oilSeparatorPresent: toNullableBoolean(row?.oil_separator_present),
      washCycleDurationAdequate: toNullableBoolean(row?.wash_cycle_duration_adequate),
      wheelWashOperationMethod: row?.wheel_wash_operation_method ?? null,
      washWaterReused: toNullableBoolean(row?.wash_water_reused),
      antiSlipMeshPresent: toNullableBoolean(row?.anti_slip_mesh_present),
      immersionZoneLengthAdequate: toNullableBoolean(row?.immersion_zone_length_adequate),
      collectionBasinPresent: toNullableBoolean(row?.collection_basin_present),
      truckPathCleanedWithin15Min: toNullableBoolean(row?.truck_path_cleaned_within_15_min),

      exposedAreaCurrentlyIdle: toNullableBoolean(row?.exposed_area_currently_idle),
      stabilizationMethod: row?.stabilization_method ?? null,
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
      siteCleaningMethod: row?.site_cleaning_method ?? null,
      wasteHumidityMaintainedDuringTransport: toNullableBoolean(row?.waste_humidity_maintained_during_transport),
      wasteLoadsCovered: toNullableBoolean(row?.waste_loads_covered),

      sprayCannonRangeBand: row?.spray_cannon_range_band ?? null,
      crushersCoveredDemolition: toNullableBoolean(row?.crushers_covered_demolition),
      loadingPointsHaveSprinklers: toNullableBoolean(row?.loading_points_have_sprinklers),
      demolitionCuttingMethod: row?.demolition_cutting_method ?? null,
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
  };
}

// dviResult هو windowEval.worst (DviEvaluationResult) الجاهز من computeDustResults —
// لا إعادة حساب هنا إطلاقاً، فقط قراءة الحقول المطلوبة.
// dviResult هو windowEval.worst (DviHourlyEvaluation فعلياً في وقت التشغيل،
// يحمل rawWeatherSample) — النوع هنا DviEvaluationResult|DviHourlyEvaluation
// لقبول كليهما (اختبارات الوحدة تبني DviEvaluationResult مباشرة بلا عينة خام).
export function buildComplianceContext(
  project: any,
  activityRow: any,
  dviResult: DviEvaluationResult | DviHourlyEvaluation,
  sensitiveReceptors: SensitiveReceptor[] = []
): DustComplianceContext {
  const dataSource: DustComplianceContext['dataSource'] =
    activityRow?.onsite_pm10 !== null && activityRow?.onsite_pm10 !== undefined
      ? 'onsite'
      : 'open-meteo';

  // العينة الخام (رياح/اتجاه/PM10/PM2.5) متوفرة فقط إن كان dviResult فعلياً
  // DviHourlyEvaluation (الحالة الحقيقية دائماً في مسار التشغيل الفعلي عبر
  // windowEval.worst) — راجع rawWeatherSample في dust-engine/types.ts.
  const rawSample = (dviResult as Partial<DviHourlyEvaluation>).rawWeatherSample;

  return {
    project: buildProjectComplianceProfile(project),
    activity: buildActivityComplianceProfile(activityRow, sensitiveReceptors),
    dviScore: dviResult.score,
    dviDecision: dviResult.decisionCategory,
    dviMandatoryStop: dviResult.mandatoryStop,
    dviConfidenceScore: dviResult.confidenceScore,
    windSpeedKmh: dviResult.effectiveWindKmh,
    windGustKmh: toNullableNumber(rawSample?.windGustKmh),
    windDirectionDeg: toNullableNumber(rawSample?.windDirectionDeg),
    pm10UgM3: activityRow?.onsite_pm10 !== null && activityRow?.onsite_pm10 !== undefined
      ? toNullableNumber(activityRow?.onsite_pm10)
      : toNullableNumber(rawSample?.pm10),
    pm25UgM3: toNullableNumber(rawSample?.pm25),
    dataSource,
    sensitiveReceptors,
  };
}

export function buildSensitiveReceptor(row: any): SensitiveReceptor {
  return {
    id: row?.id,
    name: row?.name ?? '',
    receptorType: (row?.receptor_type as SensitiveReceptorType) ?? 'OTHER',
    lat: Number(row?.lat),
    lng: Number(row?.lng),
  };
}
