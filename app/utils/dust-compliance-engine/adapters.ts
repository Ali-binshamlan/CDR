// =============================================================
// Riyadh Dust Compliance Engine — Adapters
// Converts raw Supabase rows (project + project_dust_profiles) plus a
// precomputed DVI result (DviEvaluationResult) into a unified
// DustComplianceContext, following the same pattern as buildDustInput in
// app/lib/craneEvaluation.ts.
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

export function buildActivityComplianceProfile(
  row: Record<string, unknown> | null | undefined,
  sensitiveReceptors: SensitiveReceptor[] = [],
  // The actual merged wind direction (after device > weather > onsite
  // priority — the same direction shown to the user in
  // evidence.windDirectionDeg, not the raw pre-merge weather sample), used
  // to compute crusherDistanceToDownwindReceptorAutoM
  // (MRQ-RECEPTOR-DOWNWIND-120).
  //
  // windDirectionDeg is used directly as-is, with no device true-north
  // calibration requirement — that calibration feature was removed
  // entirely (migration 202608130005 drops the related columns) because
  // the calibration value actually used at decision time was never
  // persisted with the decision, making it unauditable/unreplayable.
  windDirectionDeg: number | null = null
): DustActivityComplianceProfile {
  const regulatoryActivity: RegulatoryDustActivity = (row?.regulatory_activity as RegulatoryDustActivity) ?? 'OTHER';

  const crusherLat = toNullableNumber(row?.crusher_lat);
  const crusherLng = toNullableNumber(row?.crusher_lng);
  const { nearestAnyM, nearestResidentialM } = nearestReceptorDistancesM(crusherLat, crusherLng, sensitiveReceptors);
  const crusherDownwindM = nearestDownwindReceptorDistanceM(crusherLat, crusherLng, windDirectionDeg, sensitiveReceptors);

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
    // Derived from the length of the full receptor array as fetched
    // (all sensitive_receptors, not yet filtered by activity location —
    // nearestReceptorDistancesM/nearestDownwindReceptorDistanceM above do
    // that filtering). A length of zero here means "no sensitive receptor
    // registered in the system at all", not "none near this location".
    sensitiveReceptorsDataAvailable: sensitiveReceptors.length > 0,
  };
}

// dviResult is windowEval.worst (DviEvaluationResult) from computeDustResults
// — never recomputed here, only its fields are read. At runtime it is
// actually a DviHourlyEvaluation (carrying rawWeatherSample); the type here
// is DviEvaluationResult|DviHourlyEvaluation to accept both (unit tests
// build a plain DviEvaluationResult with no raw sample).
export function buildComplianceContext(
  project: Record<string, unknown> | null | undefined,
  activityRow: Record<string, unknown> | null | undefined,
  dviResult: DviEvaluationResult | DviHourlyEvaluation,
  sensitiveReceptors: SensitiveReceptor[] = [],
  // The last recorded compliance decision for the same activity_group_id
  // (from current_dust_compliance_decisions) — used to prevent an
  // immediate automatic resume after a stop (see RESUME_STABILITY_MINUTES
  // in engine.ts). Optional and left undefined on any path that doesn't
  // fetch it (e.g. the forecast hourly grid), so no such restriction is
  // applied there. pending_resume_since is tracked separately from
  // updated_at — see previousPendingResumeSince in types.ts for why.
  previousDecision?: {
    decision: string;
    updated_at: string;
    pending_resume_since?: string | null;
    deciding_rule_code?: string | null;
    // updated_at above carries "how long the stop has been in effect"
    // semantics (stopped_since ?? updated_at); raw_updated_at is the
    // unmodified value, used only to detect an evaluation gap. Optional:
    // undefined = no gap check (backward compatible).
    raw_updated_at?: string | null;
  } | null,
  // Sustained PM10 status over time (the full object returned by
  // computeSustainedPm10Status in dustEvaluation.ts, not just the raw
  // numbers) — optional; undefined means "no sustained-status data", so the
  // engine falls back to its safe path (treating the reading as
  // instantaneous only). isConfirmedViolation340/isSuspended250For30Min are
  // computed there with all necessary evidence (source, reading freshness)
  // and passed through as-is, with no re-derivation in rulebook.ts (see
  // pm10ConfirmedViolation340 in types.ts for the full rationale).
  pm10Sustained?: {
    sustainedMinutesAbove340: number;
    sustainedMinutesAbove250: number;
    isConfirmedViolation340: boolean;
    isSuspended250For30Min: boolean;
    evidenceReadingIds?: string[];
  } | null,
  // The "now" instant used to compute PM10 reading freshness — defaults to
  // Date.now() for backward compatibility, but callers should pass the same
  // instant later given to evaluateDustCompliance(ctx, now) explicitly (not
  // rely on the default) so a decision can be replayed with an identical
  // result — two separate Date.now() calls within the same evaluation could
  // otherwise land on opposite sides of the freshness threshold.
  evaluatedAtMs: number = Date.now(),
  // True only when the current_dust_compliance_decisions query actually
  // failed (not "no row found") — independent of previousDecision itself
  // (which can be null in both cases; the failure flag is what
  // distinguishes them). Defaults to false for backward compatibility.
  previousDecisionQueryFailed: boolean = false
): DustComplianceContext {
  // The actual merged reading (after device > weather > onsite priority —
  // see mergeDustReading in dust-engine/engine.ts) is only available when
  // dviResult is actually a DviHourlyEvaluation (always true on the real
  // runtime path via windowEval.worst).
  //
  // All reading fields here are read from the same mergedReading that DVI
  // itself computed, rather than deriving a separate priority chain here
  // that could disagree with it (some fields used to ignore the device
  // entirely, and PM10 used to prefer onsite over everything else) — a
  // single unified reading instead of two sources that could diverge.
  //
  // The wind direction used to compute the downwind receptor distance
  // (crusherDistanceToDownwindReceptorAutoM below) must come from
  // merged.windDirectionDeg — the same direction shown to the user as
  // evidence.windDirectionDeg in engine.ts — not the raw pre-merge weather
  // sample. Using the raw sample instead of the merged value could return
  // Infinity (no receptor downwind of the wrong direction) even though a
  // real receptor sits downwind of the direction actually displayed,
  // silently missing MRQ-RECEPTOR-DOWNWIND-120.
  const merged = (dviResult as Partial<DviHourlyEvaluation>).mergedReading;
  // rawWeatherSample.isForecastStale (weather.ts, set true when Open-Meteo
  // fails/is unreachable) previously never reached the compliance engine —
  // DustComplianceContext didn't carry this field. Only meaningful for the
  // PLANNING path (Live is built directly from the device, with no
  // relevant rawWeatherSample — see evaluateLiveOperationalDecision).
  const isForecastStale = (dviResult as Partial<DviHourlyEvaluation>).rawWeatherSample?.isForecastStale === true;
  const mergedWindDirectionDeg = toNullableNumber(merged?.windDirectionDeg);

  // dataSource is for display only: the highest-priority source that
  // actually won for any field in mergedReading.sources, ordered device >
  // open-meteo > onsite > none. There isn't always one "correct" source for
  // every field (e.g. a device sends wind only, so humidity still comes
  // from weather despite a live device) — this is the best single summary.
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
  // pm10ThresholdRule (rulebook.ts) used to compare the raw pm10UgM3
  // directly against 340/250 with no freshness gate of its own (unlike
  // wind/visibility, which pass through freshOrNull in
  // dust-engine/engine.ts). Applies only to pm10Source='device' — a
  // weather/manual reading isn't a "device reading" with an age in the same
  // sense (same exemption as dust-engine/engine.ts), so it is always
  // treated as fresh (FRESH) regardless of devicePm10LastReadingAt.
  const pm10EvidenceState: Pm10EvidenceState = (() => {
    if (pm10SourceValue !== 'device') return 'FRESH';
    const observedAtIso = merged?.devicePm10LastReadingAt;
    if (!observedAtIso) return 'MISSING';
    const ageMs = evaluatedAtMs - Date.parse(observedAtIso);
    if (Number.isNaN(ageMs)) return 'MISSING';
    if (ageMs < 0) return 'FUTURE';
    return ageMs <= LIVE_FIELD_FRESHNESS_MS ? 'FRESH' : 'STALE';
  })();
  // pm10UgM3 (fed directly into pm10ThresholdRule) is nulled out on
  // STALE/FUTURE/MISSING for a device reading — never a stale value
  // masquerading as live, nor "no data" disguised as zero. pm10RawUgM3
  // always keeps the full raw value, for display/audit only (see
  // evidence.pm10UgM3 in engine.ts, which always shows the raw value).
  const pm10UgM3ForDecision = pm10EvidenceState === 'FRESH' ? pm10RawUgM3 : null;

  return {
    project: buildProjectComplianceProfile(project),
    activity: buildActivityComplianceProfile(
      activityRow,
      sensitiveReceptors,
      mergedWindDirectionDeg
    ),
    isForecastStale,
    dviScore: dviResult.score,
    dviDecision: dviResult.decisionCategory,
    dviMandatoryStop: dviResult.mandatoryStop,
    // True only when the sole reason for DVI's mandatory stop is an
    // instantaneous PM10>=340 exceedance — with no other immediate physical
    // hazard (critical visibility/severe wind) contributing at the same
    // moment. Read from stopBasis/confirmationState (typed fields) rather
    // than matching a rule code string. Used in GATE-DVI-002 (engine.ts) to
    // prevent a single instantaneous PM10 reading from becoming a
    // regulatory MANDATORY_STOP without the same persistence evidence
    // (>2 minutes) that pm10ThresholdRule requires for
    // PM10-VIOLATION-STOP-006.
    dviMandatoryStopIsPm10Only: dviResult.stopBasis === 'PM10' && dviResult.confirmationState === 'PENDING',
    // See the dviVisibilityDataMissing comment in types.ts.
    dviVisibilityDataMissing: dviResult.visibilityDataMissing === true,
    dviShortReason: dviResult.shortReason ?? null,
    dviConfidenceScore: dviResult.confidenceScore,
    // Uses the raw wind speed, not dviResult.effectiveWindKmh
    // (max(speed, 0.85*gust), DVI's internal risk figure) — Annex A's
    // regulatory wind thresholds are stated in terms of sustained speed and
    // never mention gusts. See the windSpeedKmh comment in types.ts for
    // detail; effectiveWindKmh stays confined to DVI (dust-engine/engine.ts).
    // windGustSafetyRule in rulebook.ts is the only rule that reads
    // windGustKmh for any regulatory decision.
    windSpeedKmh: merged?.windSpeedKmh ?? null,
    windGustKmh: merged?.windGustKmh ?? null,
    windDirectionDeg: merged?.windDirectionDeg ?? null,
    pm10UgM3: pm10UgM3ForDecision,
    pm25UgM3: merged?.pm25 ?? null,
    relativeHumidityPercent: merged?.relativeHumidityPercent ?? null,
    temperatureC: merged?.temperatureC ?? null,
    visibilityM: merged?.visibilityM ?? null,
    // Explicitly undefined (not null) when no device is linked at all
    // (dataSource is not 'device') — distinguishes "no linked station" from
    // "station linked but no reading yet" (actual null), so the UI knows
    // when to show a staleness warning at all.
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
