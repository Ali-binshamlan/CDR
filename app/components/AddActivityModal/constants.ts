import type { ReceptorType, DistanceBand } from '@/app/utils/dust-engine/types';
import type { IndicatorTab } from './types';

export const labelClass = 'block text-xs font-semibold text-[#061B40]/70 mb-1';
export const sectionTitleClass =
  'text-sm font-bold text-[#061B40] border-r-4 border-[#3995FF] pr-2 bg-[#F4F7FB] py-1.5 rounded-l-md shadow-sm mb-3';

export const getInputClass = (isDisabled: boolean = false) =>
  `w-full border rounded-lg p-2 text-sm focus:outline-none focus:ring-1 focus:ring-[#3995FF] transition-all ${
    isDisabled
      ? 'bg-[#E5E7EB] text-[#061B40]/50 border-dashed border-[#061B40]/20 cursor-not-allowed'
      : 'bg-[#F4F7FB] border-[#061B40]/20 text-[#061B40]'
  }`;

export const DUST_FORM_DEFAULTS = {
  plannedDate: new Date().toISOString().slice(0, 10),
  plannedTime: new Date().toTimeString().slice(0, 5),
  durationHours: 3,
  hasEarthworks: false,
  internalDirtRoads: false,
  heavyEquipmentMovement: false,
  looseMaterials: false,
  surfaceWet: false,
  receptorType: 'NONE_NEARBY' as ReceptorType,
  receptorDistance: 'OVER_500M' as DistanceBand,
  receptorIsDownwind: false,
  visibleDustPlumeReported: false,
  openConcretePour: false,
  onsiteVisibilityM: '' as string | number,
  onsitePm10: '' as string | number,
  onsitePm25: '' as string | number,
};

// Single concrete batching plant unit (A6) — multiple units can be added to the same activity,
// each unit having its own location (batching_lat/batching_lng, separate from the shared
// stockpile location stockpileLat/stockpileLng in REGULATORY_ACTIVITY_FIELDS_DEFAULTS)
//
// Bug detected and fixed (external code review — "using index number instead of a fixed unit ID"):
// Previously, crusherPrecheckResults/batchingPrecheckResults in index.tsx were indexed by key
// `${itemId}:${index}` — removing/adding a unit mid-session shifted all indices after it,
// causing an old precheck result for a completely different location to be incorrectly matched.
// A fixed id (generated once when addCrusherUnit/addBatchingUnit is called via crypto.randomUUID,
// following the same pattern as generateActivityItemId) remains correct regardless of any subsequent
// additions/deletions of other units.
export const BATCHING_UNIT_DEFAULTS = {
  id: '' as string,
  batchingLat: '' as string | number,
  batchingLng: '' as string | number,
  // Critical bug detected and fixed (explicit request from user — "if one unit is in the east
  // and another in the west, will each unit link to its own device?"): Previously, device location
  // was calculated only for the general activity location (item.deviceId, following the first unit exclusively),
  // so all other batching plant units were displayed (and prior to route.ts fix, actually saved)
  // linked to the first unit's device regardless of their actual specific location.
  // deviceId here is for display purposes only (same concept as item.deviceId in index.tsx) — the actual
  // binding calculation upon saving is performed server-side in route.ts using the actual batching_lat/lng
  // of this specific unit, not from this field.
  deviceId: null as string | null,
  silosSealed: true as boolean | null,
  pm10FilterEfficiencyPercent: '' as string | number,
  leakDetected: false as boolean | null,
  dryCleaningMethodUsed: false as boolean | null,
  dustSuppressionSystemOperational: true as boolean | null,
};
export type BatchingUnit = typeof BATCHING_UNIT_DEFAULTS;

// Single crusher unit (A6) — multiple units can be added to the same activity, each unit having
// its own location (crusher_lat/crusher_lng per row). Extracted from the previous flat fields in
// REGULATORY_ACTIVITY_FIELDS_DEFAULTS (which supported only one crusher per regulatory activity)
// into an array, following the exact same pattern as BatchingUnit.
export const CRUSHER_UNIT_DEFAULTS = {
  id: '' as string,
  crusherLat: '' as string | number,
  crusherLng: '' as string | number,
  // See deviceId comment in BATCHING_UNIT_DEFAULTS above — exact same principle applies.
  deviceId: null as string | null,
  crusherDistanceToReceptorM: '' as string | number,
  crusherUnitsFullyCovered: true as boolean | null,
  loadingPointsHaveSpraySystems: true as boolean | null,
  sprayCannonsAroundCrusher: true as boolean | null,
  conveyorsCoveredCrusher: true as boolean | null,
  dropHeightReducedAtCrusher: true as boolean | null,
  suctionAndFiltrationSystemsPresent: true as boolean | null,
  criticalScheduleApplies: false as boolean | null,
};
export type CrusherUnit = typeof CRUSHER_UNIT_DEFAULTS;

// Single idle surface unit (A4) — multiple units can be added to the same activity
export const IDLE_SURFACE_UNIT_DEFAULTS = {
  idleDays: '' as string | number,
  idleSurfaceStabilized: false as boolean | null,
  idleSurfaceCoverIntact: true as boolean | null,
};
export type IdleSurfaceUnit = typeof IDLE_SURFACE_UNIT_DEFAULTS;

// Regulatory compliance fields specific to a single regulatory activity (regulatoryActivity),
// isolated from general DVI fields in DUST_FORM_DEFAULTS — used to construct a single "regulatory
// activity card" within a list where the user can add multiple cards before saving as a batch
// (instead of repeatedly opening an "Add Activities" modal for each regulatory activity).
export const REGULATORY_ACTIVITY_FIELDS_DEFAULTS = {
  // Explicit user request (full unification): ENTRY_EXIT/OTHER were entirely removed from
  // RegulatoryDustActivity, so no "generic" default value is possible anymore — this field is
  // always immediately replaced by the actual chosen activityKey (see the line consuming this
  // object in index.tsx: `{ ...REGULATORY_ACTIVITY_FIELDS_DEFAULTS, regulatoryActivity: activityKey }`),
  // so the value here merely silences type errors prior to actual selection and is never read in practice.
  regulatoryActivity: 'EARTHWORKS' as
    | 'EARTHWORKS' | 'SITE_TRAFFIC' | 'MATERIAL_HANDLING_STOCKPILE'
    | 'DEMOLITION' | 'CRUSHER' | 'BATCHING_PLANT' | 'STONE_CUTTING' | 'CD_WASTE_TRANSPORT' | 'IDLE_SURFACE',
  isEnclosedOperation: false,
  demolitionActiveAreaM2: '' as string | number,
  continuousMisting: false,
  sprayCannonAvailable: false,
  wetCuttingActive: false,
  hepaExtractionActive: false,
  dustSuppressionSystemOperational: true,
  // A1 — Site prep, excavation, and earthworks
  surfaceWatered: true,
  dropHeightM: '' as string | number,
  exposedSoilAreaM2: '' as string | number,
  truckRoutesDesignated: true,
  pathCoverMaterial: 'GRAVEL' as 'GRAVEL' | 'RECYCLED_ASPHALT' | 'STABILIZER' | 'OTHER' | 'NONE',
  waterSprayMethod: 'SPRAY' as 'SPRAY' | 'FLOODING',
  soilCompactedAfterExcavation: true,
  stabilizerUsedDuringPause: true,
  pauseDurationOver5Days: false,
  sprayUsedDuringSoilUnloading: true,
  workAreaPhased: true,

  // A2 — On-site transport and haul roads
  unpavedRoadsWateredDaily: true,
  dustControlMethod: 'WATER_SPRAY' as 'WATER_SPRAY' | 'SUPPRESSANT' | 'BOTH' | 'NONE',
  speedLimitSignsPosted: true,
  containersCoveredBeforeMoving: true,
  containersInspectedBeforeDeparture: true,
  loadHeightExceedsContainerLimit: false,
  adjacentRoadsSweptMechanically: true,
  sweepFrequencyBand: 'HOURLY' as 'HOURLY' | 'DAILY' | 'LESS_THAN_REQUIRED' | 'NOT_SWEPT',
  wheelWashAtExit: true,
  wheelWashMaintainedRegularly: true,
  washWaterRecycled: true,
  allLoadsCovered: true,
  trucksInspectedBeforeDeparture: true,
  loadSideCoverageAdequate: true,
  publicRoadsVacuumSweptDaily: true,
  waterUsedRoutinelyForCleaning: false,
  unpavedSpeedKmh: '' as string | number,
  pavedSpeedKmh: '' as string | number,
  spillCleanupMinutes: '' as string | number,

  // A3 — Entry and exit points
  entryPointLat: '' as string | number,
  entryPointLng: '' as string | number,
  exitPointLat: '' as string | number,
  exitPointLng: '' as string | number,
  accessRoadPaved: true,
  tireCleaningMethod: 'WHEEL_WASH' as 'WHEEL_WASH' | 'WATER_IMMERSION',
  sandTrapPresent: true,
  oilSeparatorPresent: true,
  washCycleDurationAdequate: true,
  wheelWashOperationMethod: 'AUTO_SENSOR' as 'AUTO_SENSOR' | 'MANUAL_PRESSURE',
  washWaterReused: true,
  antiSlipMeshPresent: true,
  immersionZoneLengthAdequate: true,
  collectionBasinPresent: true,
  truckPathCleanedWithin15Min: true,
  waterTracesBeyond15mFromGate: false,

  // A4 — Windborne dust mitigation
  exposedAreaCurrentlyIdle: false,
  stabilizationMethod: 'POLYMERS' as 'POLYMERS' | 'PROTECTIVE_COVERS' | 'BOTH' | 'OTHER',
  stockpileAreaExists: false,
  suppressantUsedAtStockpileArea: true,
  windBarriersNearStockpiles: true,
  constructionScheduledImmediatelyAfterPrep: true,

  // A5 — Material loading/unloading/storage
  centralizedStorage: true,
  distributedAcrossMultipleLocations: false,
  sprayedImmediatelyAfterUnloading: true,
  fullSubmersionOfPiles: false,
  stockpileShapeLowRounded: true,
  unusedPilesCoveredDaily: true,
  cementInSealedSilos: true,
  silosHavePm10Filters: true,
  pilesBehindWindBarriers: true,
  conveyorsEnclosed: true,
  conveyorsUseAutoSpray: true,
  windBarriersAlignedWithPrevailingWind: true,
  barrierDistanceRatioCompliant: true,
  stockpileHeightM: '' as string | number,
  stockpileBatchingDistanceToReceptorM: '' as string | number,
  stockpileLat: '' as string | number,
  stockpileLng: '' as string | number,

  // Other dust sources
  filterMaintenancePerformedRegularly: true,
  leakPreventionInspectedRegularly: true,
  suppressionSystemCheckedDaily: true,
  manualDrySweepingBanned: true,
  compressedAirBanned: true,
  siteCleaningMethod: 'MECHANICAL_WATER_SWEEP' as 'MECHANICAL_WATER_SWEEP' | 'MANUAL_SWEEP' | 'COMPRESSED_AIR' | 'OTHER',
  wasteHumidityMaintainedDuringTransport: true,
  wasteLoadsCovered: true,

  // Demolition — continuation
  sprayCannonRangeBand: 'M20' as 'M20' | 'M30' | 'UNDER_20' | 'UNAVAILABLE',
  crushersCoveredDemolition: true,
  loadingPointsHaveSprinklers: true,
  demolitionCuttingMethod: 'WATER_FED_SAWS' as 'WATER_FED_SAWS' | 'EXTRACTION_SYSTEMS' | 'ORDINARY_TOOLS',
  sandblastingUsed: false,
  sandblastingInEnclosedBox: true,

  // Stone cutting — continuation
  cuttingResiduesCleanedAfterCompletion: true,

  // Construction & demolition waste transport
  debrisSprayedBeforeLoading: true,
  centralStorageArea: true,
  smallPilesDispersedMultipleLocations: false,
  dailyRemoval: true,
  coveredIfNotRemovedDaily: true,
  debrisCompacted: true,
  onlyActiveSectionSprayed: true,
  loadCovered: true,
  loadExceedsCapacity: false,
  debrisPileHeightM: '' as string | number,
};
export type RegulatoryActivityFields = typeof REGULATORY_ACTIVITY_FIELDS_DEFAULTS;

// Method for specifying daily working hours for a single regulatory activity — single option only
// (the user does not input both):
// - 'shift': selects a pre-configured shift from project.shifts, automatically taking the time
//   from it (its start_time/end_time) without manual time input.
// - 'custom': manually inputs start/end time, restricted within the full project shift range
//   (work_hours_start–work_hours_end) via min/max attributes on input fields.
export type ActivityTimingMode = 'shift' | 'custom';

// A single item within the list of selected regulatory activities — each activity is an independent
// card (accordion) having its own location (on the unified map for all activities), its own date
// range (start/end date which may span days or months), and daily working hours applying to every
// day within that range (a pre-configured shift or custom time — see ActivityTimingMode), instead
// of a single shared location/time/shift for all activities.
// lat/lng start as null (mandatory before saving, see validateRegulatoryActivityLocations in index.tsx)
// to prevent saving an activity with a default location (project center) that the user didn't actually select.
// For batching plant / crusher activities: lat/lng follow the first unit's location automatically
// (see syncItemLocationFromUnit in index.tsx) instead of requiring manual separate specification.
export interface RegulatoryActivityItem {
  id: string;
  fields: RegulatoryActivityFields;
  batchingUnits: BatchingUnit[];
  idleSurfaceUnits: IdleSurfaceUnit[];
  crusherUnits: CrusherUnit[];
  lat: number | null;
  lng: number | null;
  // Monitoring station (project_devices.id) from which readings for this activity will be taken —
  // optional: null means "no station", taking readings automatically from weather API (Open-Meteo)
  // instead of the device (same usual device > API > manual priority). Automatically suggested
  // as the nearest active station to the activity location when setting lat/lng, and remains
  // manually changeable or clearable via dropdown in DustStep.tsx.
  deviceId: string | null;
  startDate: string;
  endDate: string;
  timingMode: ActivityTimingMode;
  // null means "no shift selected yet" — mandatory when timingMode === 'shift'
  shiftId: string | null;
  // Custom daily hours — used only when timingMode === 'custom'
  customStartTime: string;
  customEndTime: string;
}

// Regulatory activity type (regulatoryActivity in REGULATORY_ACTIVITY_FIELDS_DEFAULTS)
export type RegulatoryActivityKey = RegulatoryActivityFields['regulatoryActivity'];

// Options for regulatory compliance activities (Riyadh Dust Compliance) displayed on the activity
// selection screen, activating the dust indicator (DCR only calculates dust/AEI — no heat, no cranes).
// label in Arabic serves as a single unified source used in both the selection screen and DustStep
// (translation map) together.
//
// Explicit user request (full unification): dviCategory was removed — it used to bind each regulatory
// activity to the general engineering ActivityCategory (the legacy system, now fully removed from
// dust-engine). key alone is sufficient and feeds DustEngineInput.regulatoryActivity directly without an intermediary.
export interface RegulatoryActivityOption {
  key: RegulatoryActivityKey;
  label: string;
}

export const REGULATORY_ACTIVITY_OPTIONS: RegulatoryActivityOption[] = [
  { key: 'EARTHWORKS', label: 'أعمال ترابية عامة' },
  { key: 'SITE_TRAFFIC', label: 'حركة طرق/نقل داخل الموقع' },
  { key: 'MATERIAL_HANDLING_STOCKPILE', label: 'تحميل/تنزيل/تخزين مواد (أكوام)' },
  { key: 'DEMOLITION', label: 'هدم' },
  { key: 'CRUSHER', label: 'كسارة' },
  { key: 'BATCHING_PLANT', label: 'محطة خلط خرسانة / نقل إسمنت' },
  { key: 'STONE_CUTTING', label: 'قطع أحجار' },
  { key: 'CD_WASTE_TRANSPORT', label: 'نقل مخلفات هدم وبناء' },
  { key: 'IDLE_SURFACE', label: 'سطح غير نشط' },
];

// Map of regulatory activity key to its full Arabic label — re-exported from
// dust-compliance-engine/rulebook.ts (the exact same dictionary used across all display screens:
// alerts, admin tables, card titles) instead of a local version derived from REGULATORY_ACTIVITY_OPTIONS.label —
// previously two separate dictionaries with slightly different wording for the same keys
// (e.g., "كسارة" here vs "الكسارة" there), making activities display differently across screens.
// label in REGULATORY_ACTIVITY_OPTIONS remains a concise string dedicated to selection screen buttons only.
export { REGULATORY_ACTIVITY_LABEL_AR } from '@/app/utils/dust-compliance-engine/rulebook';

// General advisory text (text-only, no decision effect) per regulatory
// activity — shown at activity creation (DustStep) and persistently on the
// activity card (Compliancewidgetcard) so the user keeps seeing these
// requirements after creation, not only once during setup. These controls
// were removed from rulebook.ts/applyActivityRules; the real decision only
// depends on the few numeric/location fields that remain actual inputs.
export const GENERAL_ALERTS_AR: Record<string, string[]> = {
  EARTHWORKS: [
    'رشّ التربة إلزامي أثناء الحفر والتحميل والتفريغ.',
    'ارتفاع تفريغ التربة يجب ألا يتجاوز 1.5م اعتيادياً، أو 1م أثناء رياح ≥15 كم/س.',
    'دكّ التربة مباشرة بعد الحفر، وتخصيص مسارات مغطاة لعبور الشاحنات.',
    'عند توقف الأعمال أكثر من 5 أيام، استخدم مواد مثبتة للغبار على السطح المكشوف.',
  ],
  SITE_TRAFFIC: [
    'رشّ الطرق غير المسفلتة يومياً، وتثبيت لافتات تحدد السرعة (10 كم/س للطرق غير المسفلتة، 20 كم/س للمسفلتة).',
    'تغطية جميع الحمولات والحاويات قبل التحرك وفحصها قبل المغادرة.',
    'وحدة غسيل إطارات عاملة عند المخرج، وكنس الطرق المجاورة آلياً بانتظام.',
    'تنظيف أي انسكاب خلال 15 دقيقة من وقوعه.',
  ],
  MATERIAL_HANDLING_STOCKPILE: [
    'ارتفاع الأكوام يجب ألا يتجاوز 1م للفئة الأولى، أو 3م للفئتين الثانية والثالثة.',
    'ارتفاع تفريغ المواد يجب ألا يتجاوز 1.5م اعتيادياً، أو 1م أثناء رياح ≥15 كم/س.',
    'تخزين مركزي للمواد بدل توزيعها في مواقع متفرقة، وتغطية الأكوام غير المستخدمة يومياً.',
    'رشّ المواد فوراً بعد التنزيل، وشكل الأكوام منخفض ومستدير لتقليل انجراف الغبار.',
    'الإسمنت في صوامع محكمة الإغلاق مزودة بفلاتر PM10.',
    'السيور الناقلة مغلقة وتستخدم رشاً آلياً، ومصدات رياح بمحاذاة اتجاه الريح السائد.',
  ],
  DEMOLITION: [
    // DEMO-AREA-002 in rulebook.ts stops the activity (RESTRICT_ACTIVITY) if
    // active demolition area exceeds this — a real decision-affecting rule,
    // unlike the rest of this list which is advisory-only.
    'أعمال الهدم يجب ألا تتجاوز 100 م² في المرة الواحدة — قسّم العمل لمراحل إن تجاوزت المساحة هذا الحد.',
    'رش رذاذ مستمر أو مدفع رذاذ (مدى 20-30م) طوال أعمال الهدم.',
    'تغطية الكسارات المستخدمة في الهدم، ونقاط التحميل/التنزيل مزودة برشاشات.',
    'استخدام مناشير مزودة بالمياه أو أنظمة شفط بدل الأدوات العادية للقطع.',
    'الضغط الرملي (إن استُخدم) يجب أن يتم داخل صندوق مغلق فقط.',
  ],
  CRUSHER: [
    'تغطية وحدات الكسارة بالكامل، ونقاط التحميل/التنزيل مزودة برشاشات أو أنظمة ضباب.',
    'مدافع رذاذ حول الكسارة، وناقلات مغطاة، وتقليل ارتفاع نقاط التفريغ.',
    'أنظمة شفط وفلترة مطلوبة للكسارة غير المغلقة.',
  ],
  BATCHING_PLANT: [
    'صيانة دورية لفلاتر PM10 وفحص موانع التسرب دورياً.',
    'فحص أنظمة تثبيط الغبار يومياً، وحظر الكنس اليدوي الجاف والهواء المضغوط صراحة في إجراءات الموقع.',
    'الحفاظ على رطوبة النفايات وتغطيتها أثناء النقل.',
  ],
  STONE_CUTTING: [
    'قطع مبلل بتبريد مائي مستمر، أو شفط هواء HEPA ضمن تشغيل مغلق.',
    'تنظيف مخلفات وبودرة القطع فور الانتهاء من كل عملية.',
    'تثبيط معزَّز إلزامي عند رياح 15-25 كم/س، وإيقاف القطع المكشوف عند تجاوز 25 كم/س — يُحسب تلقائياً من بيانات الرياح الحية.',
  ],
  CD_WASTE_TRANSPORT: [
    'ارتفاع أكوام المخلفات يجب ألا يتجاوز 3م.',
    'رش المخلفات قبل التحميل والتفريغ، وتخزينها في منطقة مركزية واحدة.',
    'إزالة يومية للمخلفات، أو تغطيتها بأغطية محكمة إن لم تُزل.',
    'تغطية جميع شاحنات النقل، وعدم تجاوز الحمولة السعة الاستيعابية.',
  ],
  IDLE_SURFACE: [
    'تثبيت السطح غير النشط بمواد مناسبة (بوليمرات أو أغطية واقية) عند توقف العمل عليه.',
    'التحقق من سلامة الغطاء دورياً، خاصة عند رياح ≥20 كم/س.',
    'حواجز رياح قرب مناطق تجميع المواد، وجدولة استئناف البناء مباشرة بعد التجهيز لتقليل مدة التعرض.',
  ],
  OTHER: [
    'طبّق ضوابط الحد من الغبار العامة المناسبة لطبيعة هذا النشاط حسب دليل RCRC/NCEC.',
  ],
};

export const INDICATOR_LABEL_AR: Record<IndicatorTab, string> = {
  dust: 'تقييم الرؤية والغبار',
};