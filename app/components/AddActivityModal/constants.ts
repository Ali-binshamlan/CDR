import type { ActivityCategory, ReceptorType, DistanceBand, DviLevel } from '@/app/utils/dust-engine/types';
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
  activityType: 'GENERAL_OUTDOOR_WORK' as ActivityCategory,
  plannedDate: new Date().toISOString().slice(0, 10),
  plannedTime: new Date().toTimeString().slice(0, 5),
  durationHours: 3,
  hasEarthworks: false,
  internalDirtRoads: false,
  heavyEquipmentMovement: false,
  looseMaterials: false,
  largeExposedArea: false,
  drySurface: false,
  surfaceWet: false,
  wateringAvailable: false,
  stockpilesCovered: false,
  speedLimitApplied: false,
  wheelWashAvailable: false,
  dustScreensAvailable: false,
  fieldMonitoringAvailable: false,
  receptorType: 'NONE_NEARBY' as ReceptorType,
  receptorDistance: 'OVER_500M' as DistanceBand,
  receptorIsDownwind: false,
  visibleDustPlumeReported: false,
  openConcretePour: false,
  onsiteVisibilityM: '' as string | number,
  onsitePm10: '' as string | number,
  onsitePm25: '' as string | number,
};

// وحدة "محطة خلط خرسانة" واحدة (A6) — يمكن إضافة أكثر من وحدة لنفس النشاط،
// كل وحدة بموقعها الخاص (batching_lat/batching_lng، منفصل عن موقع الأكوام
// المشترك stockpileLat/stockpileLng في REGULATORY_ACTIVITY_FIELDS_DEFAULTS)
export const BATCHING_UNIT_DEFAULTS = {
  batchingLat: '' as string | number,
  batchingLng: '' as string | number,
  silosSealed: true as boolean | null,
  pm10FilterEfficiencyPercent: '' as string | number,
  leakDetected: false as boolean | null,
  dryCleaningMethodUsed: false as boolean | null,
  dustSuppressionSystemOperational: true as boolean | null,
};
export type BatchingUnit = typeof BATCHING_UNIT_DEFAULTS;

// وحدة "كسارة" واحدة (A6) — يمكن إضافة أكثر من وحدة لنفس النشاط، كل وحدة
// بموقعها الخاص (crusher_lat/crusher_lng لكل صف). مستخرجة من الحقول المسطّحة
// السابقة في REGULATORY_ACTIVITY_FIELDS_DEFAULTS (كانت كسارة واحدة فقط لكل
// نشاط تنظيمي) إلى مصفوفة، بنفس نمط BatchingUnit تماماً.
export const CRUSHER_UNIT_DEFAULTS = {
  crusherLat: '' as string | number,
  crusherLng: '' as string | number,
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

// وحدة "سطح غير نشط" واحدة (A4) — يمكن إضافة أكثر من وحدة لنفس النشاط
export const IDLE_SURFACE_UNIT_DEFAULTS = {
  idleDays: '' as string | number,
  idleSurfaceStabilized: false as boolean | null,
  idleSurfaceCoverIntact: true as boolean | null,
};
export type IdleSurfaceUnit = typeof IDLE_SURFACE_UNIT_DEFAULTS;

// حقول الامتثال التنظيمي الخاصة بنشاط تنظيمي واحد (regulatoryActivity)،
// معزولة عن حقول DVI العامة في DUST_FORM_DEFAULTS — تُستخدم لبناء "بطاقة
// نشاط تنظيمي" واحدة ضمن قائمة يمكن للمستخدم إضافة عدة بطاقات منها قبل
// الحفظ دفعة واحدة (بدل تكرار فتح نافذة "إضافة أنشطة" لكل نشاط تنظيمي).
export const REGULATORY_ACTIVITY_FIELDS_DEFAULTS = {
  // ENTRY_EXIT محذوف من هذا الاتحاد (راجع تعليق REGULATORY_ACTIVITY_OPTIONS
  // أدناه) — الواجهة لا يمكنها إنشاء هذا النوع بعد الآن، لكنه يبقى في
  // RegulatoryDustActivity (محرك الامتثال) للتوافق مع صفوف قديمة محفوظة.
  regulatoryActivity: 'OTHER' as
    | 'EARTHWORKS' | 'SITE_TRAFFIC' | 'MATERIAL_HANDLING_STOCKPILE'
    | 'DEMOLITION' | 'CRUSHER' | 'BATCHING_PLANT' | 'STONE_CUTTING' | 'CD_WASTE_TRANSPORT' | 'IDLE_SURFACE' | 'OTHER',
  isEnclosedOperation: false,
  demolitionActiveAreaM2: '' as string | number,
  continuousMisting: false,
  sprayCannonAvailable: false,
  wetCuttingActive: false,
  hepaExtractionActive: false,
  dustSuppressionSystemOperational: true,
  // A1 — تجهيز الموقع وأعمال الحفر والأعمال الترابية
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

  // A2 — النقل داخل الموقع والطرق الخدمية
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

  // A3 — الدخول والخروج
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

  // A4 — تخفيف تطاير الغبار الناتج عن هبوب الرياح
  exposedAreaCurrentlyIdle: false,
  stabilizationMethod: 'POLYMERS' as 'POLYMERS' | 'PROTECTIVE_COVERS' | 'BOTH' | 'OTHER',
  stockpileAreaExists: false,
  suppressantUsedAtStockpileArea: true,
  windBarriersNearStockpiles: true,
  constructionScheduledImmediatelyAfterPrep: true,

  // A5 — تحميل/تنزيل/تخزين المواد
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

  // مصادر الغبار الأخرى
  filterMaintenancePerformedRegularly: true,
  leakPreventionInspectedRegularly: true,
  suppressionSystemCheckedDaily: true,
  manualDrySweepingBanned: true,
  compressedAirBanned: true,
  siteCleaningMethod: 'MECHANICAL_WATER_SWEEP' as 'MECHANICAL_WATER_SWEEP' | 'MANUAL_SWEEP' | 'COMPRESSED_AIR' | 'OTHER',
  wasteHumidityMaintainedDuringTransport: true,
  wasteLoadsCovered: true,

  // الهدم — استكمال
  sprayCannonRangeBand: 'M20' as 'M20' | 'M30' | 'UNDER_20' | 'UNAVAILABLE',
  crushersCoveredDemolition: true,
  loadingPointsHaveSprinklers: true,
  demolitionCuttingMethod: 'WATER_FED_SAWS' as 'WATER_FED_SAWS' | 'EXTRACTION_SYSTEMS' | 'ORDINARY_TOOLS',
  sandblastingUsed: false,
  sandblastingInEnclosedBox: true,

  // قطع الأحجار — استكمال
  cuttingResiduesCleanedAfterCompletion: true,

  // نقل مخلفات الهدم والبناء
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

// طريقة تحديد ساعات العمل اليومية لنشاط تنظيمي واحد — خيار واحد فقط
// (المستخدم لا يُدخل الاثنين معاً):
// - 'shift': يختار وردية جاهزة من project.shifts، والوقت يُؤخذ منها
//   تلقائياً (start_time/end_time الخاصان بها)، بلا إدخال وقت يدوي.
// - 'custom': يُدخل وقت بداية/نهاية يدوياً، مقيَّد ضمن نطاق دوام المشروع
//   الكامل (work_hours_start–work_hours_end) عبر min/max على الحقول.
export type ActivityTimingMode = 'shift' | 'custom';

// عنصر واحد ضمن قائمة الأنشطة التنظيمية المختارة — كل نشاط بطاقة مستقلة
// (أكورديون) لها موقعها الخاص (على الخريطة الموحدة لكل الأنشطة)، ومداها
// الزمني الخاص (تاريخ بداية/نهاية قد يمتد لأيام أو أشهر)، وساعات عمل يومية
// تنطبق على كل يوم ضمن هذا المدى (وردية جاهزة أو وقت مخصص — راجع
// ActivityTimingMode)، بدل موقع/توقيت/وردية مشتركة واحدة لكل الأنشطة.
// lat/lng تبدأ null (إلزامية قبل الحفظ، راجع validateRegulatoryActivityLocations
// في index.tsx) لتفادي حفظ نشاط بموقع افتراضي (مركز المشروع) لم يختره
// المستخدم فعلياً. لأنشطة الخلاطة/الكسارة: lat/lng تتبع موقع الوحدة الأولى
// تلقائياً (راجع syncItemLocationFromUnit في index.tsx) بدل أن يحددها
// المستخدم يدوياً بشكل منفصل.
export interface RegulatoryActivityItem {
  id: string;
  fields: RegulatoryActivityFields;
  batchingUnits: BatchingUnit[];
  idleSurfaceUnits: IdleSurfaceUnit[];
  crusherUnits: CrusherUnit[];
  lat: number | null;
  lng: number | null;
  startDate: string;
  endDate: string;
  timingMode: ActivityTimingMode;
  // null يعني "لم تُختَر وردية بعد" — إلزامي عند timingMode === 'shift'
  shiftId: string | null;
  // ساعات يومية مخصصة — تُستخدم فقط عند timingMode === 'custom'
  customStartTime: string;
  customEndTime: string;
}

export const DVI_STYLES: Record<DviLevel, { bg: string; border: string; text: string; dot: string }> = {
  GREEN: { bg: 'bg-green-50', border: 'border-green-400', text: 'text-green-700', dot: 'bg-green-500' },
  YELLOW: { bg: 'bg-yellow-50', border: 'border-yellow-400', text: 'text-yellow-700', dot: 'bg-yellow-500' },
  ORANGE: { bg: 'bg-orange-50', border: 'border-orange-400', text: 'text-orange-700', dot: 'bg-orange-500' },
  RED: { bg: 'bg-red-50', border: 'border-red-400', text: 'text-red-700', dot: 'bg-red-500' },
  DARK_RED: { bg: 'bg-red-100', border: 'border-red-600', text: 'text-red-800', dot: 'bg-red-700' },
  BLACK: { bg: 'bg-[#061B40]/5', border: 'border-[#061B40]', text: 'text-[#061B40]', dot: 'bg-[#061B40]' },
};

// نوع النشاط التنظيمي (regulatoryActivity في REGULATORY_ACTIVITY_FIELDS_DEFAULTS)
export type RegulatoryActivityKey = RegulatoryActivityFields['regulatoryActivity'];

// خيارات أنشطة الامتثال التنظيمي (Riyadh Dust Compliance) المعروضة في شاشة
// اختيار النشاط — كل نشاط تنظيمي مرتبط بـ dviCategory مناسب لمحرك DVI
// الفيزيائي (نفس فئات ActivityCategory)، ويُفعّل مؤشر الغبار (DCR لا يحسب
// إلا الغبار/AEI — لا حرارة ولا رافعات). label بالعربي مصدر موحّد يُستخدم
// في شاشة الاختيار وفي DustStep (خريطة الترجمة) معاً.
export interface RegulatoryActivityOption {
  key: RegulatoryActivityKey;
  label: string;
  dviCategory: ActivityCategory;
}

// ENTRY_EXIT (منطقة دخول وخروج المشروع) حُذف عمداً من هذه القائمة — لا يعود
// بالإمكان إنشاء نشاط جديد بهذا النوع من الواجهة. النوع نفسه (RegulatoryActivityKey)
// وقواعده في dust-compliance-engine/rulebook.ts (entryExitRules) يبقيان بلا
// تغيير حتى تستمر صفوف project_dust_profiles القديمة بهذا النوع بالتقييم
// الصحيح عبر نفس محرك الامتثال — الحذف هنا مقصور على مسار إنشاء نشاط جديد فقط.
export const REGULATORY_ACTIVITY_OPTIONS: RegulatoryActivityOption[] = [
  { key: 'EARTHWORKS', label: 'أعمال ترابية عامة', dviCategory: 'GRADING' },
  { key: 'SITE_TRAFFIC', label: 'حركة طرق/نقل داخل الموقع', dviCategory: 'ROAD_WORKS' },
  { key: 'MATERIAL_HANDLING_STOCKPILE', label: 'تحميل/تنزيل/تخزين مواد (أكوام)', dviCategory: 'MATERIAL_TRANSPORT' },
  { key: 'DEMOLITION', label: 'هدم', dviCategory: 'HEAVY_EQUIPMENT_MOVEMENT' },
  { key: 'CRUSHER', label: 'كسارة', dviCategory: 'HEAVY_EQUIPMENT_MOVEMENT' },
  { key: 'BATCHING_PLANT', label: 'محطة خلط خرسانة / نقل إسمنت', dviCategory: 'CONCRETE_POURING' },
  { key: 'STONE_CUTTING', label: 'قطع أحجار', dviCategory: 'HEAVY_EQUIPMENT_MOVEMENT' },
  { key: 'CD_WASTE_TRANSPORT', label: 'نقل مخلفات هدم وبناء', dviCategory: 'MATERIAL_TRANSPORT' },
  { key: 'IDLE_SURFACE', label: 'سطح غير نشط', dviCategory: 'GENERAL_OUTDOOR_WORK' },
  { key: 'OTHER', label: 'أخرى / غير محدد', dviCategory: 'GENERAL_OUTDOOR_WORK' },
];

// خريطة سريعة من key النشاط التنظيمي إلى تسميته العربية — مشتقة من
// REGULATORY_ACTIVITY_OPTIONS لتفادي تكرار القائمة في أكثر من ملف.
export const REGULATORY_ACTIVITY_LABEL_AR: Record<string, string> = Object.fromEntries(
  REGULATORY_ACTIVITY_OPTIONS.map((o) => [o.key, o.label])
);

export const INDICATOR_LABEL_AR: Record<IndicatorTab, string> = {
  dust: 'تقييم الرؤية والغبار',
};

export const LOCATION_OPTIONS = [
  'كامل الموقع',
  'منطقة مفتوحة',
  'منطقة محاطة بمبانٍ',
  'سطح المبنى',
  'موقع الرافعة',
  'طريق أو مسار',
  'منطقة حفر',
  'أخرى',
];

export const CONCRETE_POUR_TYPES = [
  'صب قواعد',
  'صب أعمدة',
  'صب أسقف',
  'صب أرضيات',
  'صب خرسانة طرق',
  'صب ليلي',
  'صب صغير',
  'صب كبير ومستمر'
];

export const PAVING_TYPES = [
  'فرش طبقة أساس',
  'رش طبقة لاصقة',
  'فرد أسفلت',
  'دمك',
  'صيانة طريق',
  'سفلتة ليلية'
];

export const EXCAVATION_TYPES = [
  'حفر مفتوح',
  'حفر خنادق',
  'ردم',
  'تسوية',
  'نقل تربة',
  'أعمال ترابية عامة'
];

export const HEIGHT_WORK_TYPES = [
  'تركيب واجهات',
  'أعمال سقالات',
  'أعمال أسطح',
  'أعمال صيانة خارجية',
  'أعمال إنارة أو كهرباء',
  'أعمال تركيب عامة'
];
