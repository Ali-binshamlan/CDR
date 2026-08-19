// =============================================================
// Riyadh Dust Compliance Engine — Types
// A regulatory compliance layer on top of the DVI engine (app/utils/dust-engine).
// Strict rule: this layer only consumes a precomputed DVI result (read-only)
// and never recomputes it. The decision here is fully independent of DviDecisionCategory.
// =============================================================

import type { DviDecisionCategory } from '@/app/utils/dust-engine/types';

export type DustRiskClass =
  | 'CATEGORY_I_LOW'
  | 'CATEGORY_II_MEDIUM'
  | 'CATEGORY_III_HIGH'
  | 'UNCLASSIFIED';

// Tracks freshness of a device PM10 reading for pm10ThresholdRule (rulebook.ts),
// which compares pm10UgM3 directly against the 340/250 thresholds with no
// freshness gate of its own, unlike wind/visibility.
export type Pm10EvidenceState = 'FRESH' | 'STALE' | 'MISSING' | 'FUTURE';

// طلب مستخدم صريح ("لقطة القرار والبصمة"): كائن مستقل موازٍ لـ
// pm10TemporalEvidenceState (السلسلة المسطَّحة أدناه في evidence) — يحمل
// نفس الحالة لكن بشكل صريح يضم رمز الفشل ووقت التقييم معاً في بنية واحدة،
// كي يدخل input_snapshot_hash/evidence_hash ككائن واضح قابل للفحص المباشر
// من أي أداة تدقيق تقرأ اللقطة، لا فقط كسلسلة نصية مبعثرة بين حقول evidence
// الأخرى. queryState يطابق pm10TemporalEvidenceState حرفياً (مصدر الحقيقة
// نفسه، لا اشتقاق مستقل) — الحقلان يتحركان معاً دائماً.
export interface Pm10TemporalEvidenceSnapshot {
  queryState: 'AVAILABLE' | 'NO_READINGS' | 'QUERY_FAILED';
  failureCode: 'PM10_HISTORY_QUERY_FAILED' | null;
  evaluatedAt: string;
}

export type DustWindBand = 'BELOW_15' | 'FROM_15_TO_25' | 'ABOVE_25' | 'UNKNOWN';

export type DustComplianceDecisionCategory =
  | 'ALLOW'
  | 'PRECAUTION'
  | 'ALLOW_WITH_CONTROLS'
  | 'FIELD_VERIFICATION_REQUIRED'
  | 'RESTRICT_ACTIVITY'
  | 'STOP_AFFECTED_ACTIVITY'
  | 'MANDATORY_STOP';

// Regulatory activity type, independent of dust-engine's engineering
// ActivityCategory — this classifies by the RCRC/NCEC guide chapters
// (Chapter 3), optional at the activity level.
export type RegulatoryDustActivity =
  | 'EARTHWORKS'
  | 'SITE_TRAFFIC'
  | 'ENTRY_EXIT'
  | 'MATERIAL_HANDLING_STOCKPILE'
  | 'DEMOLITION'
  | 'CRUSHER'
  | 'BATCHING_PLANT'
  | 'STONE_CUTTING'
  | 'CD_WASTE_TRANSPORT'
  | 'IDLE_SURFACE'
  | 'OTHER';

export type DmpApprovalStatus =
  | 'NOT_REQUIRED'
  | 'NOT_STARTED'
  | 'DRAFT'
  | 'SUBMITTED'
  | 'APPROVED'
  | 'REJECTED'
  | 'UNKNOWN';

// Project compliance profile — relatively stable project-level data, used
// for risk category classification (Section 6) and monitoring obligations (Section 10).
export interface DustProjectComplianceProfile {
  siteAreaM2: number | null;
  dailyTruckMovements: number | null;
  hasOnsiteCrusher: boolean | null;
  hasOnsiteBatchingPlant: boolean | null;

  dmpApprovalStatus: DmpApprovalStatus;
  dmpSubmittedAt?: string | null;
  dmpApprovedAt?: string | null;

  baselineMonitoringDays: number | null;
  monitoringStationCount: number | null;
  monitoringLoggingIntervalMinutes: number | null;
  anemometerHeightM: number | null;
  entryExitCamerasInstalled: boolean | null;
  cameraRetentionDays: number | null;
  sensitivityMapPrepared: boolean | null;
}

// Evidence of control measures actually in place on the activity (not merely required in theory).
export interface DustControlEvidence {
  dustSuppressionSystemOperational: boolean | null;
  continuousMisting: boolean | null;
  sprayCannonAvailable: boolean | null;
  dustScreensAvailable: boolean | null;
  wetCuttingActive: boolean | null;
  hepaExtractionActive: boolean | null;
  wheelWashOperational: boolean | null;
  hourlyInspectionRecorded: boolean | null;
  speedControlApplied: boolean | null;
  loadCovered: boolean | null;
  conveyorsEnclosed: boolean | null;
  foggingAvailable: boolean | null;
  idleSurfaceStabilized: boolean | null;
  // A6 — batching plants and cement transport (Section 4-b, Activity
  // Matrix A6): silo sealing, filter efficiency, leaks, operation.
  silosSealed: boolean | null;
  pm10FilterEfficiencyPercent: number | null;
  leakDetected: boolean | null;
  dryCleaningMethodUsed: boolean | null;
  // A4 — idle surfaces and inactive areas (cover condition and wind
  // speed/direction from Activity Matrix A4; cover inspection after wind >20 km/h).
  idleSurfaceCoverIntact: boolean | null;
  // A1 — surface spraying/wetting during excavation, loading, and dumping
  // (Section 4, Part II — Category I obligations, applied to all categories in practice).
  surfaceWatered: boolean | null;

  // A1 — site prep and earthworks fields
  truckRoutesDesignated: boolean | null;
  pathCoverMaterial: 'GRAVEL' | 'RECYCLED_ASPHALT' | 'STABILIZER' | 'OTHER' | 'NONE' | null;
  waterSprayMethod: 'SPRAY' | 'FLOODING' | null;
  soilCompactedAfterExcavation: boolean | null;
  stabilizerUsedDuringPause: boolean | null;
  pauseDurationOver5Days: boolean | null;
  sprayUsedDuringSoilUnloading: boolean | null;
  workAreaPhased: boolean | null;

  // A2 — on-site traffic and service roads
  unpavedRoadsWateredDaily: boolean | null;
  dustControlMethod: 'WATER_SPRAY' | 'SUPPRESSANT' | 'BOTH' | 'NONE' | null;
  speedLimitSignsPosted: boolean | null;
  containersCoveredBeforeMoving: boolean | null;
  containersInspectedBeforeDeparture: boolean | null;
  loadHeightExceedsContainerLimit: boolean | null;
  adjacentRoadsSweptMechanically: boolean | null;
  sweepFrequencyBand: 'HOURLY' | 'DAILY' | 'LESS_THAN_REQUIRED' | 'NOT_SWEPT' | null;
  wheelWashAtExit: boolean | null;
  wheelWashMaintainedRegularly: boolean | null;
  washWaterRecycled: boolean | null;
  allLoadsCovered: boolean | null;
  trucksInspectedBeforeDeparture: boolean | null;
  loadSideCoverageAdequate: boolean | null;
  publicRoadsVacuumSweptDaily: boolean | null;
  waterUsedRoutinelyForCleaning: boolean | null;

  // A3 — entry/exit (branches by tire cleaning method)
  accessRoadPaved: boolean | null;
  tireCleaningMethod: 'WHEEL_WASH' | 'WATER_IMMERSION' | null;
  sandTrapPresent: boolean | null;
  oilSeparatorPresent: boolean | null;
  washCycleDurationAdequate: boolean | null;
  wheelWashOperationMethod: 'AUTO_SENSOR' | 'MANUAL_PRESSURE' | null;
  washWaterReused: boolean | null;
  antiSlipMeshPresent: boolean | null;
  immersionZoneLengthAdequate: boolean | null;
  collectionBasinPresent: boolean | null;
  truckPathCleanedWithin15Min: boolean | null;

  // A4 — mitigating wind-driven dust dispersal
  exposedAreaCurrentlyIdle: boolean | null;
  stabilizationMethod: 'POLYMERS' | 'PROTECTIVE_COVERS' | 'BOTH' | 'OTHER' | null;
  stockpileAreaExists: boolean | null;
  suppressantUsedAtStockpileArea: boolean | null;
  windBarriersNearStockpiles: boolean | null;
  constructionScheduledImmediatelyAfterPrep: boolean | null;

  // A5 — material loading/unloading/storage
  centralizedStorage: boolean | null;
  distributedAcrossMultipleLocations: boolean | null;
  sprayedImmediatelyAfterUnloading: boolean | null;
  fullSubmersionOfPiles: boolean | null;
  stockpileShapeLowRounded: boolean | null;
  unusedPilesCoveredDaily: boolean | null;
  cementInSealedSilos: boolean | null;
  silosHavePm10Filters: boolean | null;
  pilesBehindWindBarriers: boolean | null;
  conveyorsUseAutoSpray: boolean | null;
  windBarriersAlignedWithPrevailingWind: boolean | null;
  barrierDistanceRatioCompliant: boolean | null;

  // Other dust sources (shared with BATCHING_PLANT)
  filterMaintenancePerformedRegularly: boolean | null;
  leakPreventionInspectedRegularly: boolean | null;
  suppressionSystemCheckedDaily: boolean | null;
  manualDrySweepingBanned: boolean | null;
  compressedAirBanned: boolean | null;
  siteCleaningMethod: 'MECHANICAL_WATER_SWEEP' | 'MANUAL_SWEEP' | 'COMPRESSED_AIR' | 'OTHER' | null;
  wasteHumidityMaintainedDuringTransport: boolean | null;
  wasteLoadsCovered: boolean | null;

  // Demolition — additional fields
  sprayCannonRangeBand: 'M20' | 'M30' | 'UNDER_20' | 'UNAVAILABLE' | null;
  crushersCoveredDemolition: boolean | null;
  loadingPointsHaveSprinklers: boolean | null;
  demolitionCuttingMethod: 'WATER_FED_SAWS' | 'EXTRACTION_SYSTEMS' | 'ORDINARY_TOOLS' | null;
  sandblastingUsed: boolean | null;
  sandblastingInEnclosedBox: boolean | null;

  // Crushers — additional fields
  crusherUnitsFullyCovered: boolean | null;
  loadingPointsHaveSpraySystems: boolean | null;
  sprayCannonsAroundCrusher: boolean | null;
  conveyorsCoveredCrusher: boolean | null;
  dropHeightReducedAtCrusher: boolean | null;
  suctionAndFiltrationSystemsPresent: boolean | null;
  criticalScheduleApplies: boolean | null;

  // Stone cutting — additional fields
  cuttingResiduesCleanedAfterCompletion: boolean | null;

  // Demolition/construction debris transport
  debrisSprayedBeforeLoading: boolean | null;
  centralStorageArea: boolean | null;
  smallPilesDispersedMultipleLocations: boolean | null;
  dailyRemoval: boolean | null;
  coveredIfNotRemovedDaily: boolean | null;
  debrisCompacted: boolean | null;
  onlyActiveSectionSprayed: boolean | null;
  loadExceedsCapacity: boolean | null;
}

// Field/operational measurements tied to a specific regulatory activity.
export interface DustActivityMeasurements {
  demolitionActiveAreaM2: number | null;
  crusherDistanceToReceptorM: number | null;
  stockpileBatchingDistanceToReceptorM: number | null;
  stockpileHeightM: number | null;
  dropHeightM: number | null;
  idleDays: number | null;
  spillCleanupMinutes: number | null;
  unpavedSpeedKmh: number | null;
  pavedSpeedKmh: number | null;
  visibleTrackoutBeyond15m: boolean | null;
  // A1 — site prep, excavation, and earthworks (digging, grading,
  // backfilling, trenching, compaction): exposed soil area and surface moisture.
  exposedSoilAreaM2: number | null;

  // Crusher — location coordinates (map picker), used to auto-compute
  // distance from the sensitive_receptors table instead of relying only on manual entry.
  crusherLat: number | null;
  crusherLng: number | null;
  // Auto-computed (Haversine) distance when coordinates are available —
  // populated by adapters.ts, not a user input field.
  crusherDistanceToNearestReceptorAutoM: number | null;
  crusherDistanceToResidentialReceptorAutoM: number | null;
  // MRQ-RECEPTOR-DOWNWIND-120: nearest distance to a residential/school/
  // hospital receptor actually downwind of the crusher's current wind
  // direction — null if wind direction is unavailable or location is
  // unknown; Infinity if no receptor is currently downwind.
  crusherDistanceToDownwindReceptorAutoM: number | null;

  // A3 — entry/exit
  entryPointLat: number | null;
  entryPointLng: number | null;
  exitPointLat: number | null;
  exitPointLng: number | null;
  waterTracesBeyond15mFromGate: boolean | null;

  // A5 — material loading/unloading/storage — stockpile/batching plant
  // location coordinates (map picker), used to auto-compute distance to
  // the nearest sensitive receptor instead of relying only on manual entry
  // (same principle as the crusher above — a compliance decision must not
  // depend solely on a user's self-report, which could be wrong or omit a
  // nearby sensitive facility).
  stockpileLat: number | null;
  stockpileLng: number | null;
  stockpileDistanceToNearestReceptorAutoM: number | null;
  stockpileDistanceToResidentialReceptorAutoM: number | null;
  stockpileDistanceUnder200m: boolean | null;

  // A6 — batching plant — a separate location from the shared stockpile
  // location above (each row now represents one batching unit, same principle as the crusher).
  batchingLat: number | null;
  batchingLng: number | null;
  batchingDistanceToNearestReceptorAutoM: number | null;
  batchingDistanceToResidentialReceptorAutoM: number | null;

  // Demolition/construction debris transport
  debrisPileHeightM: number | null;
}

// خطأ حرج مكتشَف ومُصلَح (مراجعة كود خارجي — "اتجاه الرياح يُستخدم دون
// توثيق الشمال الحقيقي"): يميّز صراحة بين اتجاه رياح موثَّق فعلياً على
// الشمال الحقيقي (VERIFIED) واتجاه خام غير موثَّق (UNVERIFIED) وغياب أي
// اتجاه إطلاقاً (UNAVAILABLE) — بدل استخدام last_wind_direction_deg الخام
// مباشرة في تحليل الانتشار المكاني (nearestDownwindReceptorDistanceM) بلا
// أي ضمان أن الحساس معايَر فعلياً. راجع resolveWindDirectionEvidence في
// dustEvaluation.ts للمنطق الكامل، وmigration 202608190002 لحقول التوثيق
// المصدر (project_devices.true_north_*).
export type WindDirectionQuality = 'VERIFIED' | 'UNVERIFIED' | 'UNAVAILABLE';

export interface WindDirectionEvidence {
  // القيمة الخام كما وردت من الجهاز/التقدير — تُعرض دائماً للمستخدم (شفافية
  // كاملة)، بصرف النظر عن حالة التوثيق، لكنها لا تدخل تحليل الانتشار المكاني
  // إلا حين quality='VERIFIED' (راجع directionForAnalysisDeg أدناه).
  rawDeg: number | null;
  // القيمة الفعلية المستخدَمة في nearestDownwindReceptorDistanceM — null إلا
  // حين تكون المحاذاة موثَّقة فعلياً (TRUE_NORTH موثَّق ومطبَّق). لا يُستبدَل
  // تلقائياً باتجاه Open-Meteo التقديري عند غياب التوثيق — يبقى null صراحة،
  // فتُعيد nearestDownwindReceptorDistanceM نتيجة null (لا تفعيل لقاعدة
  // المستقبل باتجاه الرياح)، لا قيمة مضلِّلة مبنية على تقدير مختلف تماماً.
  directionForAnalysisDeg: number | null;
  quality: WindDirectionQuality;
  source: 'DEVICE' | 'FORECAST' | 'MANUAL' | 'NONE';
  deviceId: string | null;
  trueNorthDocumented: boolean;
  alignmentType: 'TRUE_NORTH' | 'MAGNETIC_NORTH' | null;
  verifiedAt: string | null;
  verifiedBy: string | null;
  verificationMethod: string | null;
  deviationDeg: number | null;
  evidenceUrl: string | null;
}

export interface DustActivityComplianceProfile {
  activityGroupId: string;
  regulatoryActivity: RegulatoryDustActivity;
  isDustGenerating: boolean;
  isEnclosedOperation: boolean;
  isActiveOrPlanned: boolean;
  controls: DustControlEvidence;
  measurements: DustActivityMeasurements;
  // nearestReceptorDistancesM (geo.ts) returns Infinity both when there are
  // genuinely no nearby receptors and when the receptor table hasn't been
  // populated at all — those two cases are indistinguishable inside that
  // function (it only sees the receptor array, not whether the system-wide
  // table is empty). This field carries that distinction explicitly, based
  // on the actual fetch source (total sensitive_receptors row count
  // system-wide, not just near the activity): false means "no sensitive
  // receptor registered in the system at all yet", so any resulting
  // Infinity is not evidence of actual safety, just missing data. See its
  // use in crusherRules/batchingPlantRules (rulebook.ts).
  sensitiveReceptorsDataAvailable: boolean;
}

// A sensitive receptor (school/hospital/residential/mosque) with
// coordinates — used to auto-compute crusher distance instead of asking
// the user directly for the 200m/500m distance answers.
export type SensitiveReceptorType = 'SCHOOL' | 'HOSPITAL' | 'RESIDENTIAL' | 'MOSQUE' | 'OTHER';

export interface SensitiveReceptor {
  id: string;
  name: string;
  receptorType: SensitiveReceptorType;
  lat: number;
  lng: number;
}

export type DustRuleSeverity =
  | 'PRECAUTION'
  | 'ALLOW_WITH_CONTROLS'
  | 'FIELD_VERIFICATION_REQUIRED'
  | 'RESTRICT_ACTIVITY'
  | 'STOP_AFFECTED_ACTIVITY'
  | 'MANDATORY_STOP';

// Independent regulatory classification per rule hit, since severity (operational
// action) cannot by itself indicate whether a documented violation occurred — the
// same severity can mean either a purely operational precaution or a confirmed breach.
//   NONE: purely operational state, no documented legal/numeric threshold exceeded.
//   PENDING: an exceedance observed but confirmation evidence not yet complete
//     (e.g. PM10>340 before the 2-minute sustain window elapses).
//   VIOLATION: a documented legal/numeric threshold confirmed exceeded now.
export type RuleRegulatoryFinding = 'NONE' | 'PENDING' | 'VIOLATION';

// Structured metadata attached to every rule hit. RULE_METADATA_REGISTRY
// (ruleMetadata.ts) is the single source of truth for these fields — attachRuleMetadata()
// applies it automatically at hit-creation time, and rulesCatalog.ts (the admin page)
// derives its listing from the same registry instead of a hand-maintained copy, so the
// catalog cannot silently drift from the actual rule logic in rulebook.ts/engine.ts.
export interface RuleMetadata {
  // Duplicates DustRuleHit.code for self-documentation when this object is
  // passed around independently of the original hit (e.g. a single-rule audit view).
  ruleId: string;
  // Rulebook version (RULEBOOK_VERSION, from ACTIVE_RULE_BUNDLE.id) as of the last
  // documented change to this specific rule — not necessarily the current engine
  // version; an unchanged rule keeps its older version number until actually edited.
  ruleVersion: string;
  // GATE: top-priority check applied regardless of regulatory activity.
  // ACTIVITY_SPECIFIC: scoped to one or more explicit activities.
  // DECISION_LAYER: applied after the initial decisionCategory (resume/confidence), not activity-specific.
  ruleType: 'GATE' | 'ACTIVITY_SPECIFIC' | 'DECISION_LAYER';
  // Primary physical/operational indicator the rule depends on. NONE for rules
  // that don't depend on a live measurement (e.g. project classification, DMP approval state).
  indicatorType: 'PM10' | 'WIND' | 'VISIBILITY' | 'DISTANCE' | 'AREA' | 'CONTROL_STATE' | 'CONFIDENCE' | 'NONE';
  // Regulatory activities this applies to — empty array means "all activities" (a general gate).
  activityTypes: RegulatoryDustActivity[];
  // Short description of the actual logical condition implemented in
  // rulebook.ts/engine.ts (documentation only — not executed; the real decision stays in code).
  conditionPredicate: string;
  // Relative tie-break priority among rules of equal severity — higher wins.
  // Derived from the real DECISION_PRIORITY[severity] in engine.ts (not an
  // independent number that could drift), scaled by 10 to leave room for future fine-grained tie-breaks.
  priority: number;
  // Whether this rule alone (regardless of other concurrent hits) is an absolute
  // mandatory stop — true only for severity === 'MANDATORY_STOP' (not
  // STOP_AFFECTED_ACTIVITY, which is a real stop but exceptionally field-overridable per overridable).
  mandatoryStop: boolean;
  // General risk classification independent of operational severity (severity answers
  // "what do we do now?", riskLevel answers "how severe is this inherently?").
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  // Mirrors severity under an alternate documentation-only field name, to match
  // the naming used elsewhere without breaking existing consumers of `severity`.
  decisionCategory: DustRuleSeverity;
  // Itemized action list (an alternative to the free-text actionAr) — actionAr
  // remains the only field actually rendered in the UI; this is documentation-only,
  // for breaking the action into discrete steps if ever needed.
  requiredActions: string[];
  // Description of the resume condition after a stop caused by this specific rule —
  // empty ('') for rules that don't stop an activity (severity lighter than STOP_AFFECTED_ACTIVITY).
  restartConditions: string;
  // NONE: no automatic escalation. AUTO_ESCALATE_ON_PERSISTENCE: the rule escalates
  // severity automatically if the condition persists (e.g. MRQ-PM10-BLACK-PENDING-104 →
  // RCRC-PM10-30M-SUSPENSION-012 after 30 minutes).
  escalationPolicy: 'NONE' | 'AUTO_ESCALATE_ON_PERSISTENCE';
  // Field override authority for this rule — derived from the default overridable
  // per severity (see ruleHit() in rulebook.ts), not an independent field that could contradict it.
  overridePolicy: 'NO_OVERRIDE' | 'FIELD_OVERRIDE_ALLOWED';
  // Original regulatory reference (document/section name) — matches the source
  // cited in the rulebook.ts comment for this specific rule.
  source: string;
  // Effective start date of the last documented version of this rule (YYYY-MM-DD).
  effectiveFrom: string;
  // Effective end date — null for a rule still in force (all currently active rules).
  effectiveTo: string | null;
  // Whether this rule is currently active in the real decision logic — false only
  // for a rule kept in code for compatibility (documented dead code) that could be
  // reactivated later, such as the ENTRY_EXIT rules (removal deliberately deferred).
  isActive: boolean;
}

export interface DustRuleHit {
  code: string;
  severity: DustRuleSeverity;
  // See the RuleRegulatoryFinding doc above. Defaults to 'NONE' for any rule that
  // doesn't set it explicitly (fail-safe toward "no violation" — a regulatory
  // violation must never be assumed without an explicit per-rule classification).
  regulatoryFinding?: RuleRegulatoryFinding;
  // messageAr: description of the detected violation/state, shown under "Active
  // Rules". actionAr: the corrective action required, shown under "Required
  // Actions". Keeping them separate is required — reusing messageAr as the action
  // would show the same sentence twice as if it were two different pieces of information.
  messageAr: string;
  actionAr: string;
  // Each rule carries its own overridable flag explicitly, rather than canOverride
  // being derived solely from the final decision's general severity category — two
  // rules of equal severity are not necessarily equally overridable in practice.
  //
  // The final canOverride is computed in engine.ts as
  // topHits.every(hit => hit.overridable !== false): **all** rules tied for the
  // top severity (not just decidingRule) must be overridable for canOverride=true —
  // one non-overridable rule among topHits blocks override even if decidingRule
  // (the one chosen for display text) is itself overridable. Defaults to true for
  // any rule that doesn't set it explicitly; MANDATORY_STOP rules set it false via ruleHit().
  overridable?: boolean;
  // Optional — undefined for a rule not yet registered in RULE_METADATA_REGISTRY
  // (a documentation-only fail-safe with no effect on the actual decision; code/
  // severity/messageAr/actionAr/overridable/regulatoryFinding remain the sole decision source).
  metadata?: RuleMetadata;
}

export interface DustMonitoringObligation {
  key: string;
  required: boolean;
  status: 'COMPLIANT' | 'NON_COMPLIANT' | 'UNKNOWN' | 'NOT_APPLICABLE';
  descriptionAr: string;
}

export interface DustComplianceResult {
  engineType: 'RIYADH_DUST_COMPLIANCE';
  engineVersion: string;
  rulebookVersion: string;

  // The specific regulatory activity (demolition/crushing/truck movement/etc.) the
  // decision was built on — its Arabic label is shown on the compliance card instead
  // of the underlying physical DVI activity name.
  regulatoryActivity: RegulatoryDustActivity;
  regulatoryActivityLabelAr: string;

  riskClass: DustRiskClass;
  riskClassReasonAr: string;
  windBand: DustWindBand;
  // Enclosure state of the activity — shown in the UI to explain why activity is
  // allowed despite high wind in exactly one case: a batching plant (BATCHING_PLANT)
  // with sealed silos and an effective PM10 filter (see isEnclosedExemptFromHighWind
  // in engine.ts for the full condition). isEnclosedOperation alone does not exempt
  // any other activity from the >25 km/h wind stop gate — an enclosed activity that
  // isn't a batching plant (enclosed demolition, enclosed excavation, etc.) still
  // stops in high wind like any fully exposed activity.
  isEnclosedOperation: boolean;

  decisionCategory: DustComplianceDecisionCategory;
  decisionLabelAr: string;
  mandatoryStop: boolean;
  canOverride: boolean;
  shortReasonAr: string;

  // True when confirmation evidence (the 2-minute sustain window) for this decision
  // is not yet complete — computed as topHits.every(isPendingRuleHit) in engine.ts,
  // independent of decisionCategory. Can be true while decisionCategory is
  // ALLOW_WITH_CONTROLS (no stop at all), which is the common case for a PM10
  // reading under the 120-second window. Always false when decisionCategory is a
  // confirmed MANDATORY_STOP or other non-pending stop/restrict rule. Used by
  // computeUnifiedActivityDecision/AEI/FinalDecision.pendingConfirmation to avoid
  // showing definitive language for a provisional state that may resolve on the next evaluation.
  pendingConfirmation: boolean;

  // True if any rule in triggeredRules carries regulatoryFinding === 'VIOLATION'
  // (see RuleRegulatoryFinding above), regardless of whether that rule is the one
  // that won the top severity. Independent of decisionCategory/mandatoryStop — a
  // confirmed PM10 violation (PM10-VIOLATION-STOP-006, see pm10ThresholdRule in
  // rulebook.ts) can be reported here as true even while decisionCategory stays at
  // ALLOW_WITH_CONTROLS, since the actual stop is conditioned on a separate 30-minute
  // window. final-decision-engine reads this to set regulatoryFinding='NON_COMPLIANT'
  // even when operationalDecision hasn't reached a stop, keeping the two concepts separate.
  hasConfirmedRegulatoryViolation: boolean;

  // True if any rule in triggeredRules carries regulatoryFinding === 'PENDING'
  // AND no rule anywhere has regulatoryFinding === 'VIOLATION' (a confirmed
  // violation always outranks an unrelated pending condition). Distinct from
  // pendingConfirmation above: pendingConfirmation asks "is the whole winning
  // operational decision pending?" (false the moment any non-pending rule ties
  // at the top severity, e.g. a concurrent 15-25 km/h wind gate) — this field
  // asks "does an unresolved pending regulatory condition exist at all?",
  // independent of what else is tied at the top severity. A confirmed fact
  // with no regulatory finding of its own (regulatoryFinding: 'NONE', e.g.
  // wind in the enhanced-control band) must not demote an active pending PM10
  // confirmation window down to a plain "compliant" reading. final-decision-
  // engine reads this to keep regulatoryFinding='PENDING_CONFIRMATION' in that case.
  hasPendingRegulatoryFinding: boolean;

  // The code of the rule that actually built the final decision (decidingRule.code
  // in engine.ts), e.g. 'GATE-WIND-ABOVE-25-004' or 'MRQ-PM10-BLACK-PENDING-104'.
  // Stored as current_dust_compliance_decisions.deciding_rule_code and later read
  // back as previousDecidingRuleCode below, so a prior stop's exact cause is known
  // precisely instead of inferred from decisionCategory alone. Null if no rule won
  // (decisionCategory=ALLOW with no ruleHits).
  decidingRuleCode: string | null;
  // messageAr of the same decidingRule above — stored as stop_cause (a short Arabic
  // description of the stop reason) for direct display/audit without decoding the rule code.
  decidingRuleMessageAr: string | null;

  // Actual PM10 sustain duration as of this evaluation (from
  // pm10SustainedMinutesAbove340/250 in DustComplianceContext, see
  // computeSustainedPm10Status in dustEvaluation.ts) — passed through for display
  // only, so the UI can render a live countdown ("time remaining until confirmed")
  // instead of waiting for the next evaluation. Undefined = no sustain data
  // available (no linked device/reading, or query failure) — the UI hides the counter then.
  pm10SustainedMinutesAbove340?: number;
  pm10SustainedMinutesAbove250?: number;

  // IDs of the pm10_readings_history rows that make up the sustain chain behind
  // isConfirmedViolation340/isSuspended250For30Min — see evidenceReadingIds in
  // Pm10SustainedStatus (dustEvaluation.ts). Stored as part of the jsonb result
  // (no new DB column needed), so a saved decision carries traceable evidence
  // row IDs, not just the aggregated minute counts. Empty/undefined if no proven sustain chain exists.
  pm10EvidenceReadingIds?: string[];

  // Server-side computation time of this full evaluation (including the two sustain
  // numbers above). The UI uses this as the asOfMs reference instead of a local
  // Date.now() snapshot, so the countdown counter in Compliancewidgetcard.tsx stays
  // accurate regardless of when the page happens to render (a plain client-side
  // Date.now() at first render is wrong after a manual page reload, since the
  // component is rebuilt from scratch and "first render" no longer aligns with actual server compute time).
  evaluatedAt: string;

  triggeredRules: DustRuleHit[];
  requiredActions: string[];
  restartConditions: string[];
  missingCriticalInputs: string[];
  monitoringObligations: DustMonitoringObligation[];

  confidenceScore: number;
  confidenceLabelAr: string;
  validUntil: string;

  evidence: {
    dviScore: number;
    dviDecision: DviDecisionCategory;
    dviMandatoryStop: boolean;
    windSpeedKmh: number | null;
    windGustKmh: number | null;
    windDirectionDeg: number | null;
    pm10UgM3: number | null;
    pm25UgM3: number | null;
    relativeHumidityPercent: number | null;
    temperatureC: number | null;
    // Display only (informational advisories on the compliance card) — does not
    // enter any calculation/threshold in the compliance engine itself, same as humidity and temperature above.
    visibilityM: number | null;
    // Last actual transmission time from the linked monitoring station (ISO) —
    // always undefined when no device is linked to this activity (API mode); the
    // mere presence of the field (regardless of null/string value) signals "this
    // activity has a linked device" in buildStalenessAdvisory (Compliancewidgetcard.tsx). Display only.
    deviceLastReadingAt?: string | null;
    // Last time PM10 specifically arrived from the same station (ISO) — separate
    // from deviceLastReadingAt, which updates on any partial push even without PM10
    // (see last_pm10_at in project_devices and the devicePm10LastReadingAt comment
    // in DustEngineInput for the full rationale). Same undefined/null semantics as above. Display only.
    devicePm10LastReadingAt?: string | null;
    // Freshness state of pm10UgM3 above as of decision time — see Pm10EvidenceState/
    // pm10EvidenceState in DustComplianceContext for detail. Undefined means "not
    // computed" (legacy calls/tests building evidence manually).
    pm10EvidenceState?: Pm10EvidenceState;
    // خطأ حرج مكتشَف ومُصلَح (مراجعة كود خارجي — "فشل استعلام سلسلة PM10 يتحول
    // إلى سلسلة فارغة"): تشخيص صريح لحالة سلسلة PM10 التاريخية وقت هذا
    // القرار — مستقل تماماً عن pm10EvidenceState أعلاه (ذاك يقيس حداثة
    // القراءة اللحظية الواحدة، هذا يقيس نجاح/فشل استعلام السلسلة الزمنية
    // كاملةً، fetchPm10SustainedStatus في dustEvaluation.ts):
    //   AVAILABLE  = الاستعلام نجح ووُجدت قراءات فعلية ضمن النافذة الزمنية.
    //   NO_READINGS = الاستعلام نجح لكن بصفر صفوف (حالة طبيعية: لا قراءات
    //     بعد لهذا النشاط/الجهاز، لا خطأ).
    //   QUERY_FAILED = الاستعلام فشل فعلياً (pm10HistoryQueryFailed=true) —
    //     لا يجوز الخلط بينها وبين NO_READINGS رغم أن كلتيهما تُنتجان
    //     sustainedMinutesAbove340=0/isConfirmedViolation340=false ظاهرياً.
    // Undefined = لم يُبنَ بعد (استدعاءات قديمة/اختبارات تبني evidence يدوياً).
    pm10TemporalEvidenceState?: 'AVAILABLE' | 'NO_READINGS' | 'QUERY_FAILED';
    // طلب مستخدم صريح ("لقطة القرار والبصمة"): نفس حالة pm10TemporalEvidenceState
    // أعلاه، لكن ككائن صريح ({queryState, failureCode, evaluatedAt}) بدل
    // سلسلة نصية مفردة — يضمن أن "استعلام ناجح بلا قراءات" (NO_READINGS)
    // و"استعلام فاشل" (QUERY_FAILED) لا يحملان أبداً نفس البصمة (input_
    // snapshot_hash/evidence_hash)، لأن evaluatedAt وfailureCode يختلفان
    // أيضاً بينهما، لا queryState وحده. Undefined = لم يُبنَ بعد (استدعاءات
    // قديمة/اختبارات تبني evidence يدوياً) — نفس دلالة الحقل المسطَّح أعلاه.
    pm10TemporalEvidence?: Pm10TemporalEvidenceSnapshot;
    // خطأ حرج مكتشَف ومُصلَح (مراجعة كود خارجي — "اتجاه الرياح يُستخدم دون
    // توثيق الشمال الحقيقي"): نسخة التوثيق المستخدمة فعلياً وقت هذا القرار
    // بالضبط — تدخل input_snapshot/input_snapshot_hash/evidence_hash تلقائياً
    // (نفس أي حقل آخر هنا)، فلو تغيّر توثيق الجهاز لاحقاً (إعادة معايرة)،
    // يبقى القرار القديم قابلاً لإعادة البناء بالقيمة التي كانت مستخدمة فعلاً
    // وقت صدوره (بخلاف ميزة المعايرة القديمة المحذوفة في migration
    // 202608130005، التي فقدت هذا الأثر تماماً). Undefined = لم يُبنَ بعد
    // (استدعاءات قديمة/اختبارات تبني evidence يدوياً).
    windDirection?: WindDirectionEvidence;
  };

  // Reading-validity advisory notes (from DVI, see DviEvaluationResult.caveatsAr) —
  // never change decisionCategory/shortReasonAr.
  caveatsAr: string[];

  // Ready-computed PLANNING-mode suitability result (computed once here, where the
  // rule is actually defined) — undefined outside PLANNING (not meaningful for
  // LIVE_OPERATIONAL, which has its own full path in final-decision-engine).
  // final-decision-engine reads this field directly rather than importing the PM10
  // threshold or recomputing isFavorable itself, keeping the threshold defined in exactly one place.
  planningSuitability?: {
    isFavorable: boolean;
    // Reason for unsuitability when isFavorable=false — ready-to-display text (no
    // code needing further translation/interpretation by final-decision-engine).
    reasonAr: string;
  };

  // True only when the raw decision (without a resume hold) would be better than
  // STOP_AFFECTED_ACTIVITY, but has been pinned as a precaution because
  // RESUME_STABILITY_MINUTES hasn't elapsed yet. Used in dustEvaluation.ts to track
  // "since when did the reading actually turn good" (pendingResumeSince),
  // separately from stopped_since ("since when did the stop begin") — conflating
  // the two let the resume counter start from the beginning of the stop instead
  // of the beginning of improvement, allowing an immediate resume once total stop
  // duration passed 10 minutes even with zero actual minutes of a good reading accumulated.
  resumeHoldApplied: boolean;
}

// Full context passed to evaluateDustCompliance — gathers everything needed from
// the project, the activity, and the ready-made DVI result, without recomputing DVI here.
export interface DustComplianceContext {
  project: DustProjectComplianceProfile;
  activity: DustActivityComplianceProfile;
  // True only when the Open-Meteo call actually failed/was interrupted (see
  // isForecastStale in weather.ts) for the weather sample used to build this
  // context. Not meaningful on the LIVE_OPERATIONAL path (the live decision is
  // built straight from the device, with no weather call at all — see
  // evaluateLiveOperationalDecision); consumed only by buildPlanningForecastResult
  // below (engine.ts) to show a "forecast based on stale data" warning instead of
  // asserting suitability with full confidence on an unreliable weather estimate.
  isForecastStale: boolean;
  dviScore: number;
  dviDecision: DviDecisionCategory;
  dviMandatoryStop: boolean;
  // True only when the sole reason for dviMandatoryStop is an instantaneous
  // PM10≥340 exceedance, with no other contributing immediate physical hazard
  // (critical visibility/high wind) — see dust-engine/engine.ts
  // (DVI-DUST-ACTIVITY-STOP-004-PM10-ONLY) and GATE-DVI-002 in engine.ts for actual
  // usage. Optional (undefined = false) so legacy test context() calls that build
  // dviMandatoryStop:true manually without this field don't break.
  dviMandatoryStopIsPm10Only?: boolean;
  // From DviEvaluationResult.visibilityDataMissing — true only when a device is
  // actually linked but the visibility reading is missing/stale, so the dust-engine
  // visibility gates (DVI-VISIBILITY-MANDATORY-STOP-001/RED-002) don't silently
  // treat it as excellent visibility. Used below to add "visibility unavailable" to
  // missingCriticalInputs (blocks a confident ALLOW) and to prevent resumeHoldApplied
  // from treating this absence as genuine improvement ending a prior stop. Optional
  // (undefined = false) for the same reason as dviMandatoryStopIsPm10Only above.
  dviVisibilityDataMissing?: boolean;
  // Specific text reason DVI stopped (e.g. "PM10 = 1806.8"), from
  // DviEvaluationResult.shortReason — used in the GATE-DVI-002 message instead of a
  // generic text that omits the actual number/reason. Optional: null/undefined keep
  // the generic message (fail-safe, no break for existing context consumers).
  dviShortReason?: string | null;
  dviConfidenceScore: number;
  // Holds the raw wind speed only (merged.windSpeedKmh) — the same figure the
  // regulatory text defines literally with no derivation, not
  // dviResult.effectiveWindKmh (= max(speed, 0.85×gust)), a derived risk figure
  // designed for the internal physical DVI score. A single transient gust was
  // previously enough to push that derived figure above 25 and get misclassified
  // as a sustained >25 km/h wind speed, firing GATE-WIND-ABOVE-25-004 (a regulatory
  // stop) based on a momentary spike rather than sustained wind. See windGustKmh
  // below and windGustSafetyRule in rulebook.ts for gust handling specifically (a
  // separate safety rule, not part of the Annex A protocol).
  windSpeedKmh: number | null;
  windGustKmh: number | null;
  windDirectionDeg: number | null;
  // خطأ حرج مكتشَف ومُصلَح (مراجعة كود خارجي — "اتجاه الرياح يُستخدم دون
  // توثيق الشمال الحقيقي"): الدليل الكامل (raw + الجودة + التوثيق) الذي
  // بُني منه windDirectionDeg أعلاه — يُنسَخ كما هو إلى DustComplianceResult.
  // evidence.windDirection (engine.ts) ليدخل input_snapshot/evidence_hash.
  // undefined = لم يُبنَ (استدعاءات context() قديمة في الاختبارات).
  windDirectionEvidence?: WindDirectionEvidence;
  pm10UgM3: number | null;
  pm25UgM3: number | null;
  // Display only, in the "reference weather for the decision" panel — does not
  // feed any calculation/threshold in the compliance engine itself.
  relativeHumidityPercent: number | null;
  temperatureC: number | null;
  // Display only (informational advisories on the compliance card) — does not
  // feed any calculation/threshold in the compliance engine itself.
  visibilityM: number | null;
  // Last actual transmission time of the monitoring station linked to this
  // activity (ISO) — null if linked to a station that has never sent a reading,
  // undefined if not linked to a station at all (API mode). Display only (staleness warning).
  deviceLastReadingAt?: string | null;
  // Last time PM10 specifically arrived from the same station (ISO) — see the
  // matching devicePm10LastReadingAt comment in evidence above for the full
  // rationale. Same undefined/null semantics. Display only.
  devicePm10LastReadingAt?: string | null;
  // DVI advisory caveats (see DviEvaluationResult.caveatsAr), passed through
  // as-is so they also appear in the compliance result — never change any decision.
  dviCaveatsAr?: string[];
  // Highest-priority source that actually won across any reading field (device if
  // it appears in any field, else open-meteo, else onsite) — general display only
  // (e.g. a "data from device" icon in the UI). Does not imply every field came
  // from this source — see pm10Source below for the precise PM10 source, which
  // must be used for any decision/logging depending on "is this reading actually from the device."
  dataSource: 'device' | 'open-meteo' | 'onsite' | 'project-station' | 'none';
  // Source of the PM10 reading specifically (not the general summary above).
  // pm10_readings_history logging previously relied on the general dataSource,
  // which resolves to 'device' whenever any field came from the device (even if
  // wind came from the device but PM10 came from weather) — the code would then
  // wrongly assume PM10 "came from the device" (so skip logging it, since device
  // readings are logged once on receipt, not here) while it actually came from
  // weather and was never logged anywhere, breaking the sustained-exceedance
  // evidence chain for that reading. Undefined = no source info available (legacy tests/calls).
  pm10Source?: 'device' | 'weather' | 'onsite' | 'none';
  // The raw value as received (no freshness gate) — for display/audit only
  // (evidence.pm10UgM3 in engine.ts always shows it, regardless of
  // pm10EvidenceState). pm10UgM3 above is what actually feeds pm10ThresholdRule
  // (rulebook.ts); pm10RawUgM3 never enters any regulatory decision. The two values
  // are always identical when pm10EvidenceState=FRESH.
  pm10RawUgM3?: number | null;
  // Freshness state of the PM10 reading as of context build time (evaluatedAtMs,
  // not the reading's own timestamp — see evaluatedAtMs in buildComplianceContext:
  // this guarantees the same decision can be recomputed later with an identical
  // result). MISSING = no known reading time; FUTURE = reading time after
  // evaluatedAtMs (unsynced device clock); STALE = exceeded
  // LIVE_FIELD_FRESHNESS_MS. Applied only to pm10Source='device' — weather/manual
  // readings are always treated as fresh (no per-reading age concept, same
  // principle as dust-engine/engine.ts).
  pm10EvidenceState?: Pm10EvidenceState;
  sensitiveReceptors: SensitiveReceptor[];

  // Last recorded compliance decision for the same activity_group_id (from
  // current_dust_compliance_decisions) — used to determine whether the activity was
  // previously stopped (to engage the resume hold at all). Null/undefined means "no
  // prior decision", so no hold is applied (unchanged engine behavior).
  previousDecisionCategory?: DustComplianceDecisionCategory | null;
  // previousDecisionCategory=null is the natural state for an activity never
  // evaluated, but it was also the silent result of a failed
  // current_dust_compliance_decisions query (network/database) — treating an
  // actually-stopped activity as if it had never been stopped, losing
  // RESUME-STABILITY-HOLD protection entirely. True specifically means "the query
  // failed, not a genuine 'no prior decision'" — triggers the
  // PREVIOUS-DECISION-QUERY-FAILED-HOLD gate below (fail-safe toward a
  // precautionary stop, not an unproven allow). False/undefined = the query
  // succeeded (regardless of whether a row existed).
  previousDecisionQueryFailed?: boolean;
  // previousStopWasWindGate in engine.ts used to assume any prior
  // STOP_AFFECTED_ACTIVITY decision was necessarily caused by the wind gate
  // (GATE-WIND-ABOVE-25-004) — wrong, since dozens of other rules (pending PM10,
  // silo leak, tire washing, excessive material drop height...) produce the same
  // category. previousDecidingRuleCode (from
  // current_dust_compliance_decisions.deciding_rule_code) is the precise source of
  // truth: the actual rule code that built the prior decision, not just its general
  // category. Null/undefined = no code recorded (rows predating this addition, or
  // no prior decision) — fail-safe: no wind-gate-specific hold applied.
  previousDecidingRuleCode?: string | null;
  // Not used to compute stability duration — kept only for legacy call
  // compatibility. See previousPendingResumeSince below for the field actually used.
  previousDecisionUpdatedAt?: string | null;
  // previousDecisionUpdatedAt above is deliberately loaded with a different meaning
  // (stopped_since ?? updated_at, "since when did the stop begin"), so it can't
  // measure "since when was this activity actually last evaluated" — which is what
  // is needed here. previousEvaluationUpdatedAt carries the raw
  // current_dust_compliance_decisions.updated_at with no substitution — used only
  // to detect an evaluation gap (cron outage/network failure/etc.) between the last
  // saved cycle and this one: a gap longer than PENDING_RESUME_GAP_TOLERANCE_MS (90
  // seconds, slightly above the actual one-minute evaluation cadence) resets the
  // stability counter — a data gap must never "count toward" the required stability
  // duration. Null/undefined = no prior decision (fail-safe: no gap detected, first real evaluation).
  previousEvaluationUpdatedAt?: string | null;
  // Since when the raw decision (absent a resume hold) became continuously good,
  // while the stored decision is still a stop — kept strictly separate from "since
  // when did the stop begin" (previousDecisionUpdatedAt/stopped_since). Conflating
  // the two would let the resume counter start from the beginning of the stop
  // itself, allowing immediate resume once total stop duration exceeded 10 minutes
  // even with zero actual minutes of a good reading accumulated (see
  // pendingResumeSince in dustEvaluation.ts). Null/undefined = no stability
  // recorded yet (fail-safe: no immediate resume).
  previousPendingResumeSince?: string | null;

  // PM10 sustain duration over time (from pm10_readings_history, see
  // fetchPm10SustainedStatus in dustEvaluation.ts) — used to distinguish
  // RCRC-PM10-340-VIOLATION-011 (confirmed violation after more than 2 minutes)
  // from MRQ-PM10-BLACK-PENDING-104 (pending, under 2 minutes), and
  // RCRC-PM10-30M-SUSPENSION-012 (suspension after 30 minutes at ≥250).
  // 0/undefined means "no sustain data available" — fail-safe toward treating the
  // reading as instantaneous only (legacy behavior, no compatibility break).
  //
  // These two figures (in minutes) remain for display/awareness only (e.g. a "time
  // remaining" counter in the UI) — a confirmed/pending decision must never be
  // re-derived from them in rulebook.ts. See confirmedViolation340/
  // suspended250For30Min below for the values the actual decision must rely on.
  pm10SustainedMinutesAbove340?: number;
  pm10SustainedMinutesAbove250?: number;

  // pm10ThresholdRule in rulebook.ts previously received only the two figures above
  // and re-derived confirmed/pending itself from a simple comparison
  // (sustainedMinutesAbove340 > 2), losing all of computeSustainedPm10Status's real
  // checks (is the series actually device-sourced? is the last reading fresh or
  // stalled?). Worse, the current reading compared against 340 (ctx.pm10UgM3) could
  // come from an entirely different source than the series used to compute the
  // minutes (project-level device readings are merged into any activity without
  // its own activity_group_id — see fetchPm10SustainedStatus), comparing two
  // logically unrelated numbers. The confirmed/pending decision is now computed
  // exactly once in computeSustainedPm10Status (where all the necessary evidence is
  // available together) and passed here as a ready-made state — rulebook.ts reads
  // the decision rather than re-deriving it. Undefined = no sustain data available
  // (same fail-safe as the two fields above).
  pm10ConfirmedViolation340?: boolean;
  pm10Suspended250For30Min?: boolean;

  // IDs of the pm10_readings_history rows that actually make up the sustain chain
  // behind pm10ConfirmedViolation340/pm10Suspended250For30Min above — see
  // evidenceReadingIds in Pm10SustainedStatus (dustEvaluation.ts) for their actual
  // source. Copied as-is into DustComplianceResult.pm10EvidenceReadingIds (stored
  // in the existing jsonb column, no new column needed) — the stored decision now
  // carries traceable evidence to specific rows, not just an aggregated number.
  pm10EvidenceReadingIds?: string[];

  // خطأ حرج مكتشَف ومُصلَح (مراجعة كود خارجي — "فشل استعلام سلسلة PM10 يتحول
  // إلى سلسلة فارغة"): true فقط عندما فشل استعلام pm10_readings_history
  // فعلياً (fetchPm10SustainedStatus في dustEvaluation.ts) — لا عند نجاحه
  // بصفر صفوف (تلك حالة طبيعية: "لا قراءات بعد"، pm10ConfirmedViolation340
  // تبقى false بحق). نفس مبدأ previousDecisionQueryFailed أعلاه بالضبط،
  // مطبَّقاً هنا على سلسلة PM10 التاريخية بدل القرار السابق. يُستهلَك في
  // engine.ts لإصدار FIELD_VERIFICATION_REQUIRED صراحة بدل معاملة الفشل
  // كـ"لا مخالفة" صامتة. False/undefined = الاستعلام نجح (بصرف النظر عن
  // عدد الصفوف).
  pm10HistoryQueryFailed?: boolean;
  // كود الفشل نفسه من Pm10SustainedFetchResult.failureCode (dustEvaluation.ts)
  // — منسوخ كما هو، لا مُعاد اشتقاقه. null دائماً حين pm10HistoryQueryFailed
  // ليست true (توافقي مع أي مصدر مستقبلي لأكواد فشل إضافية بلا كسر هذا
  // الحقل). undefined = استدعاء قديم لا يمرره (نفس دلالة null عملياً).
  pm10HistoryFailureCode?: 'PM10_HISTORY_QUERY_FAILED' | null;
  // يُنسَخ إلى DustComplianceResult.evidence.pm10TemporalEvidenceState
  // (engine.ts) — راجع تعليقه الكامل هناك للفرق الدقيق عن pm10EvidenceState.
  // undefined = استدعاء قديم لا يمرره (evidence.pm10TemporalEvidenceState
  // يبقى undefined أيضاً حينها، لا قيمة افتراضية مُخمَّنة).
  pm10TemporalEvidenceState?: 'AVAILABLE' | 'NO_READINGS' | 'QUERY_FAILED';
}
