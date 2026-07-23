// =============================================================
// Riyadh Dust Compliance Engine — Types
// طبقة امتثال تنظيمية فوق محرك DVI (app/utils/dust-engine).
// قاعدة صارمة: هذه الطبقة تستهلك نتيجة DVI الجاهزة (قراءة فقط)
// ولا تُعيد حسابها أبداً. القرار هنا مستقل تماماً عن DviDecisionCategory.
// =============================================================

import type { DviDecisionCategory } from '@/app/utils/dust-engine/types';

export type DustRiskClass =
  | 'CATEGORY_I_LOW'
  | 'CATEGORY_II_MEDIUM'
  | 'CATEGORY_III_HIGH'
  | 'UNCLASSIFIED';

export type DustWindBand = 'BELOW_15' | 'FROM_15_TO_25' | 'ABOVE_25' | 'UNKNOWN';

export type DustComplianceDecisionCategory =
  | 'ALLOW'
  | 'ALLOW_WITH_CONTROLS'
  | 'FIELD_VERIFICATION_REQUIRED'
  | 'RESTRICT_ACTIVITY'
  | 'STOP_AFFECTED_ACTIVITY'
  | 'MANDATORY_STOP';

// نوع نشاط تنظيمي مستقل عن ActivityCategory الهندسي في dust-engine —
// هذا تصنيف حسب فصول دليل RCRC/NCEC (الباب الثالث)، اختياري على مستوى النشاط.
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

// ملف امتثال المشروع — بيانات مستقرة نسبياً على مستوى المشروع ككل،
// تُستخدم لتصنيف فئة المخاطر (القسم 6) والتزامات الرصد (القسم 10).
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

// أدلة ضوابط التحكم الفعلية المتوفرة فعلياً على النشاط (وليس المطلوبة نظرياً).
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
  // A6 — محطات خلط الخرسانة ونقل الإسمنت (القسم الرابع، الفقرة "ب"،
  // ومصفوفة الأنشطة A6): إحكام الصوامع، كفاءة الفلاتر، التسرب، التشغيل.
  silosSealed: boolean | null;
  pm10FilterEfficiencyPercent: number | null;
  leakDetected: boolean | null;
  dryCleaningMethodUsed: boolean | null;
  // A4 — الأسطح المكشوفة والمناطق غير النشطة (عنصرا "حالة الأغطية" و"اتجاه
  // وسرعة الرياح" من مصفوفة الأنشطة A4؛ فحص الأغطية بعد رياح >20 كم/س).
  idleSurfaceCoverIntact: boolean | null;
  // A1 — رش/ترطيب السطح أثناء الحفر والتحميل والتفريغ (القسم الرابع، ثانياً
  // — التزامات الفئة الأولى الخاصة، وتنطبق على جميع الفئات فعلياً).
  surfaceWatered: boolean | null;

  // A1 — استكمال أسئلة "تجهيز الموقع وأعمال الحفر.pdf"
  truckRoutesDesignated: boolean | null;
  pathCoverMaterial: 'GRAVEL' | 'RECYCLED_ASPHALT' | 'STABILIZER' | 'OTHER' | 'NONE' | null;
  waterSprayMethod: 'SPRAY' | 'FLOODING' | null;
  soilCompactedAfterExcavation: boolean | null;
  stabilizerUsedDuringPause: boolean | null;
  pauseDurationOver5Days: boolean | null;
  sprayUsedDuringSoilUnloading: boolean | null;
  workAreaPhased: boolean | null;

  // A2 — النقل داخل الموقع والطرق الخدمية
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

  // A3 — الدخول والخروج (تفريع طريقة تنظيف الإطارات)
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

  // A4 — تخفيف تطاير الغبار الناتج عن هبوب الرياح
  exposedAreaCurrentlyIdle: boolean | null;
  stabilizationMethod: 'POLYMERS' | 'PROTECTIVE_COVERS' | 'BOTH' | 'OTHER' | null;
  stockpileAreaExists: boolean | null;
  suppressantUsedAtStockpileArea: boolean | null;
  windBarriersNearStockpiles: boolean | null;
  constructionScheduledImmediatelyAfterPrep: boolean | null;

  // A5 — تحميل/تنزيل/تخزين المواد
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

  // مصادر الغبار الأخرى (يشترك مع BATCHING_PLANT)
  filterMaintenancePerformedRegularly: boolean | null;
  leakPreventionInspectedRegularly: boolean | null;
  suppressionSystemCheckedDaily: boolean | null;
  manualDrySweepingBanned: boolean | null;
  compressedAirBanned: boolean | null;
  siteCleaningMethod: 'MECHANICAL_WATER_SWEEP' | 'MANUAL_SWEEP' | 'COMPRESSED_AIR' | 'OTHER' | null;
  wasteHumidityMaintainedDuringTransport: boolean | null;
  wasteLoadsCovered: boolean | null;

  // الهدم — استكمال
  sprayCannonRangeBand: 'M20' | 'M30' | 'UNDER_20' | 'UNAVAILABLE' | null;
  crushersCoveredDemolition: boolean | null;
  loadingPointsHaveSprinklers: boolean | null;
  demolitionCuttingMethod: 'WATER_FED_SAWS' | 'EXTRACTION_SYSTEMS' | 'ORDINARY_TOOLS' | null;
  sandblastingUsed: boolean | null;
  sandblastingInEnclosedBox: boolean | null;

  // الكسارات — استكمال
  crusherUnitsFullyCovered: boolean | null;
  loadingPointsHaveSpraySystems: boolean | null;
  sprayCannonsAroundCrusher: boolean | null;
  conveyorsCoveredCrusher: boolean | null;
  dropHeightReducedAtCrusher: boolean | null;
  suctionAndFiltrationSystemsPresent: boolean | null;
  criticalScheduleApplies: boolean | null;

  // قطع الأحجار — استكمال
  cuttingResiduesCleanedAfterCompletion: boolean | null;

  // نقل مخلفات الهدم والبناء
  debrisSprayedBeforeLoading: boolean | null;
  centralStorageArea: boolean | null;
  smallPilesDispersedMultipleLocations: boolean | null;
  dailyRemoval: boolean | null;
  coveredIfNotRemovedDaily: boolean | null;
  debrisCompacted: boolean | null;
  onlyActiveSectionSprayed: boolean | null;
  loadExceedsCapacity: boolean | null;
}

// قياسات ميدانية/تشغيلية مرتبطة بالنشاط التنظيمي المحدد.
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
  // A1 — تجهيز الموقع وأعمال الحفر والأعمال الترابية (الحفر، التسوية،
  // الردم، الخنادق، الدمك): مساحة التربة المكشوفة وحالة رطوبة السطح.
  exposedSoilAreaM2: number | null;

  // الكسارة — إحداثيات الموقع (Map Picker)، تُستخدم لحساب المسافة تلقائياً
  // من جدول sensitive_receptors بدل الاعتماد فقط على الإدخال اليدوي.
  crusherLat: number | null;
  crusherLng: number | null;
  // المسافة المحسوبة تلقائياً (Haversine) عند توفر إحداثيات — تُملأ من
  // adapters.ts وليست حقل إدخال مستخدم.
  crusherDistanceToNearestReceptorAutoM: number | null;
  crusherDistanceToResidentialReceptorAutoM: number | null;

  // A3 — الدخول والخروج
  entryPointLat: number | null;
  entryPointLng: number | null;
  exitPointLat: number | null;
  exitPointLng: number | null;
  waterTracesBeyond15mFromGate: boolean | null;

  // A5 — تحميل/تنزيل/تخزين المواد — إحداثيات موقع الأكوام/محطة الخلط
  // (Map Picker)، تُستخدم لحساب المسافة عن أقرب مستقبل حساس تلقائياً بدل
  // الاعتماد فقط على إدخال المستخدم اليدوي (نفس مبدأ الكسارة أعلاه — لا
  // يجوز أن يعتمد قرار المطابقة على تصريح المستخدم وحده لأنه قد يخطئ أو
  // يتجاهل وجود منشأة حساسة قريبة فعلياً).
  stockpileLat: number | null;
  stockpileLng: number | null;
  stockpileDistanceToNearestReceptorAutoM: number | null;
  stockpileDistanceToResidentialReceptorAutoM: number | null;
  stockpileDistanceUnder200m: boolean | null;

  // A6 — محطة الخلط الخرساني — إحداثيات موقع منفصلة عن موقع الأكوام
  // المشترك أعلاه (كل صف الآن يمثل خلاطة واحدة، بنفس مبدأ الكسارة).
  batchingLat: number | null;
  batchingLng: number | null;
  batchingDistanceToNearestReceptorAutoM: number | null;
  batchingDistanceToResidentialReceptorAutoM: number | null;

  // نقل مخلفات الهدم والبناء
  debrisPileHeightM: number | null;
}

export interface DustActivityComplianceProfile {
  activityGroupId: string;
  regulatoryActivity: RegulatoryDustActivity;
  isDustGenerating: boolean;
  isEnclosedOperation: boolean;
  isActiveOrPlanned: boolean;
  controls: DustControlEvidence;
  measurements: DustActivityMeasurements;
}

// مستقبِل حساس (مدرسة/مستشفى/سكني/مسجد) بإحداثياته — يُستخدم لحساب مسافة
// الكسارة تلقائياً بدل سؤال المستخدم عن الإجابة مباشرة (طلب صريح في مستند
// "تجهيز الموقع وأعمال الحفر.pdf" لسؤالي المسافة 200م/500م).
export type SensitiveReceptorType = 'SCHOOL' | 'HOSPITAL' | 'RESIDENTIAL' | 'MOSQUE' | 'OTHER';

export interface SensitiveReceptor {
  id: string;
  name: string;
  receptorType: SensitiveReceptorType;
  lat: number;
  lng: number;
}

export type DustRuleSeverity =
  | 'ALLOW_WITH_CONTROLS'
  | 'FIELD_VERIFICATION_REQUIRED'
  | 'RESTRICT_ACTIVITY'
  | 'STOP_AFFECTED_ACTIVITY'
  | 'MANDATORY_STOP';

export interface DustRuleHit {
  code: string;
  severity: DustRuleSeverity;
  // messageAr: وصف المخالفة/الحالة المكتشفة ("لا يوجد رش للتربة...") — يُعرض
  // تحت "القواعد المفعّلة". actionAr: الإجراء التصحيحي المطلوب لمعالجتها
  // ("فعّل رش التربة...") — نص مستقل الصياغة يُعرض تحت "الإجراءات المطلوبة".
  // الفصل بين الحقلين إلزامي: إعادة استخدام messageAr نفسه كإجراء يُنتج
  // نفس الجملة مرتين في الواجهة (نفس المشكلة معروضة كأنها معلومتان مختلفتان).
  messageAr: string;
  actionAr: string;
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

  riskClass: DustRiskClass;
  riskClassReasonAr: string;
  windBand: DustWindBand;
  // حالة الإغلاق للنشاط — تُعرض في الواجهة لتوضيح سبب السماح رغم رياح
  // شديدة (العمليات المغلقة مستثناة من بوابة إيقاف الرياح >25 كم/س، لأن
  // الإغلاق يمنع تطاير الغبار)، فيختفي اللبس بين "نطاق الرياح: أعلى من 25"
  // و"مسموح".
  isEnclosedOperation: boolean;

  decisionCategory: DustComplianceDecisionCategory;
  decisionLabelAr: string;
  mandatoryStop: boolean;
  canOverride: boolean;
  shortReasonAr: string;

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
  };
}

// السياق الكامل الذي يُمرَّر لدالة evaluateDustCompliance — يجمع كل ما تحتاجه
// من المشروع والنشاط ونتيجة DVI الجاهزة، دون أي حساب DVI جديد هنا.
export interface DustComplianceContext {
  project: DustProjectComplianceProfile;
  activity: DustActivityComplianceProfile;
  dviScore: number;
  dviDecision: DviDecisionCategory;
  dviMandatoryStop: boolean;
  dviConfidenceScore: number;
  windSpeedKmh: number | null;
  windGustKmh: number | null;
  windDirectionDeg: number | null;
  pm10UgM3: number | null;
  pm25UgM3: number | null;
  dataSource: 'open-meteo' | 'onsite' | 'project-station' | 'none';
  sensitiveReceptors: SensitiveReceptor[];
}
