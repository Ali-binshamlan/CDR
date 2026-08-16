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

// خطأ مكتشَف ومُصلَح (مراجعة كود خارجي — "PM10 القديم يدخل القرار كأنه قراءة
// حية"): pm10UgM3 (أدناه) كان يمرَّر خاماً من merged.pm10 (adapters.ts) بلا
// أي فحص حداثة قبل وصوله pm10ThresholdRule (rulebook.ts) — الرياح/الرؤية
// تمران عبر freshOrNull (dust-engine/engine.ts)، لكن PM10 كان مستثنى عمداً
// من تلك الدالة تحديداً (راجع تعليق buildDeviceMergedReading الكامل هناك:
// قرار مقصود لإبقاء PM10 القديم مؤثراً بدرجة احترازية أضعف في DVI). المشكلة
// الحقيقية لم تكن في DVI (له آلية دقيقة منفصلة: pm10ReadingIsFreshEnoughFor
// ImmediateStop) بل في محرك الامتثال التنظيمي — pm10ThresholdRule يقرأ
// pm10UgM3 مباشرة بلا أي بوابة حداثة خاصة به؛ قراءة جهاز عمرها ساعات، قيمتها
// >340، كانت تُنتج MRQ-PM10-BLACK-PENDING-104 (STOP_AFFECTED_ACTIVITY حقيقي)
// فقط لأنها ليست null، رغم كونها بلا أي دليل على استمرار التجاوز الآن.
export type Pm10EvidenceState = 'FRESH' | 'STALE' | 'MISSING' | 'FUTURE';

export type DustWindBand = 'BELOW_15' | 'FROM_15_TO_25' | 'ABOVE_25' | 'UNKNOWN';

export type DustComplianceDecisionCategory =
  | 'ALLOW'
  | 'PRECAUTION'
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
  // MRQ-RECEPTOR-DOWNWIND-120: أقرب مسافة لمستقبِل سكني/مدرسي/صحي يقع
  // فعلياً باتجاه هبوب الرياح الحالي من موقع الكسارة — null إن كان اتجاه
  // الرياح غير متوفر أو الموقع غير معروف؛ Infinity إن لم يوجد أي مستقبِل
  // باتجاه الريح حالياً.
  crusherDistanceToDownwindReceptorAutoM: number | null;

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
  // خطأ مكتشَف ومُصلَح (مراجعة خبير خارجي — "المستقبلات الحساسة: عند عدم
  // وجود مستقبلات حساسة، يحوّل النظام المسافة إلى Infinity ويعامل الحالة
  // كأنها آمنة؛ لكن القائمة الفارغة قد تعني أن بيانات المستقبلات لم تُدخل
  // أصلاً — يجب التفريق بين 'لا توجد مستقبلات بعد مسح مكتمل' و'لم يتم إدخال
  // بيانات المستقبلات'"): nearestReceptorDistancesM (geo.ts) تُرجع Infinity
  // في كلتا الحالتين (لا وسيلة تقنية للتمييز بينهما داخل تلك الدالة نفسها —
  // تستهلك فقط مصفوفة المستقبِلات، لا تعرف سياق "هل النظام كله فارغ؟").
  // هذا الحقل يحمل تلك المعلومة صراحة من مصدر الجلب الفعلي (عدد صفوف
  // sensitive_receptors عالمياً في قاعدة البيانات، لا فقط ضمن نطاق موقع
  // النشاط) — false يعني "لا يوجد أي مستقبِل حساس مسجَّل في النظام كله بعد"،
  // فأي Infinity ناتجة حينها لا تصلح دليلاً على أمان فعلي، بل نقص بيانات.
  // راجع استهلاكها في crusherRules/batchingPlantRules (rulebook.ts).
  sensitiveReceptorsDataAvailable: boolean;
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
  | 'PRECAUTION'
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
  // خطأ معماري مكتشَف ومُصلَح (مراجعة كود خبير خارجي — "الفصل بين القواعد
  // والقرار النهائي غير مكتمل"): قابلية التجاوز (canOverride في
  // DustComplianceResult) كانت تُشتق في engine.ts من فئة القرار النهائي
  // العامة (decisionCategory !== 'MANDATORY_STOP' && !== 'STOP_AFFECTED_ACTIVITY')،
  // لا من القاعدة الفعلية التي بنت القرار — أي قاعدتين بنفس severity كانتا
  // تُعامَلان معاملة واحدة حتماً حتى لو كانت إحداهما (فيزيائياً) غير قابلة
  // للتجاوز إطلاقاً بينما الأخرى قابلة استثنائياً. الآن كل قاعدة تحمل
  // قابليتها الخاصة صراحة — canOverride النهائي يُشتق من decidingRule.overridable
  // تحديداً (راجع engine.ts)، لا من فئة القرار العامة. افتراضي true (نفس
  // سلوك decisionCategory !== MANDATORY_STOP/STOP_AFFECTED_ACTIVITY السابق)
  // لأي قاعدة لا تحدد الحقل صراحة — القواعد الأشد (MANDATORY_STOP) تضبطه
  // false صراحة عبر ruleHit() في rulebook.ts.
  overridable?: boolean;
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

  // النشاط التنظيمي المحدد (هدم/كسارة/حركة شاحنات...) الذي بُني عليه القرار
  // — تُعرض تسميته العربية في بطاقة الامتثال بدل مسمى نشاط DVI الفيزيائي.
  regulatoryActivity: RegulatoryDustActivity;
  regulatoryActivityLabelAr: string;

  riskClass: DustRiskClass;
  riskClassReasonAr: string;
  windBand: DustWindBand;
  // حالة الإغلاق للنشاط — تُعرض في الواجهة لتوضيح سبب السماح رغم رياح
  // شديدة في حالة واحدة محدَّدة فقط: محطة الخلط (BATCHING_PLANT) بصوامع
  // محكمة الإغلاق وفلتر PM10 كفؤ (راجع isEnclosedExemptFromHighWind في
  // engine.ts للشرط الكامل). isEnclosedOperation وحدها (خطأ توثيقي سابق
  // مُصلَح — طلب صريح من المستخدم: "استثناء الرياح للنشاط المغلق مختلف بين
  // المحرك والكتالوج التنظيمي") لا تُعفي أي نشاط آخر من بوابة إيقاف الرياح
  // >25 كم/س — نشاط مغلق غير محطة خلط (هدم مغلق، حفر مغلق، إلخ) يبقى
  // موقوفاً في رياح شديدة كأي نشاط مكشوف تماماً.
  isEnclosedOperation: boolean;

  decisionCategory: DustComplianceDecisionCategory;
  decisionLabelAr: string;
  mandatoryStop: boolean;
  canOverride: boolean;
  shortReasonAr: string;

  // القرار STOP_AFFECTED_ACTIVITY هنا "معلَّق" فقط بانتظار تأكيد استمرار
  // (مثال: MRQ-PM10-BLACK-PENDING-104 — قراءة ≥340 لم تستمر بعد دقيقتين)،
  // وليس مخالفة تنظيمية مؤكَّدة. false دائماً لو decisionCategory من
  // MANDATORY_STOP فعلياً، أو من قاعدة إيقاف مؤكَّدة أخرى. تُستخدم في
  // computeUnifiedActivityDecision/AEI لتفادي عرض "إيقاف إلزامي نظامي"
  // (لغة قطعية دائمة) على حالة مؤقتة قد تتحول تلقائياً لـALLOW أو
  // MANDATORY_STOP بمجرد التقييم التالي.
  pendingConfirmation: boolean;

  // خطأ معماري مكتشَف ومُصلَح (مراجعة كود خارجي — "المخالفة التنظيمية عند
  // تأكيد PM10 (2-30 دقيقة) لا تنعكس في regulatoryFinding"): PM10-VIOLATION-
  // STOP-006 (مخالفة مؤكَّدة موثَّقة، بلا إيقاف فوري — راجع pm10ThresholdRule
  // في rulebook.ts) تصدر بشدة ALLOW_WITH_CONTROLS عمداً (لا STOP_AFFECTED_
  // ACTIVITY)، لأن الإيقاف الفعلي يبقى مشروطاً حصراً باكتمال 30 دقيقة. لكن
  // decisionCategory النهائي (أعلى شدة بين كل القواعد) قد يبقى ALLOW_WITH_
  // CONTROLS بالكامل إن لم توجد أي مشكلة أخرى — فلا يعكس وحده وجود مخالفة
  // PM10 مؤكَّدة فعلياً. هذا الحقل مستقل تماماً عن decisionCategory/
  // mandatoryStop (لا يتأثر بأيهما ولا يؤثر عليهما): true فقط إن كانت
  // PM10-VIOLATION-STOP-006 ضمن triggeredRules فعلياً، بصرف النظر عن كونها
  // القاعدة الفائزة بأعلى شدة أم لا. final-decision-engine يقرأه ليضبط
  // regulatoryFinding='NON_COMPLIANT' حتى لو operationalDecision لم يصل
  // درجة إيقاف — فصل operationalDecision عن regulatoryFinding، كما يجب.
  hasConfirmedRegulatoryViolation: boolean;

  // كود القاعدة الفعلية التي بنت القرار النهائي (decidingRule.code في
  // engine.ts) — مثال: 'GATE-WIND-ABOVE-25-004' أو 'MRQ-PM10-BLACK-PENDING-104'.
  // يُخزَّن في current_dust_compliance_decisions.deciding_rule_code ويُقرأ لاحقاً
  // كـ previousDecidingRuleCode أدناه، حتى نعرف *سبب* أي إيقاف سابق بدقة
  // بدل استنتاجه خطأً من decisionCategory وحده (راجع previousDecidingRuleCode
  // للسبب الكامل). null لو لم توجد أي قاعدة فائزة (decisionCategory=ALLOW
  // بلا أي ruleHits).
  decidingRuleCode: string | null;
  // messageAr الخاص بنفس decidingRule أعلاه — يُخزَّن كـ stop_cause (نص عربي
  // مختصر لسبب الإيقاف، للعرض/التدقيق المباشر بلا حاجة لترجمة الكود).
  decidingRuleMessageAr: string | null;

  // استمرار PM10 الفعلي حتى لحظة هذا التقييم (من pm10SustainedMinutesAbove340/
  // 250 في DustComplianceContext، راجع computeSustainedPm10Status في
  // dustEvaluation.ts) — يُمرَّر هنا للعرض فقط، حتى تقدر الواجهة تبني عدّاد
  // تنازلي حي "متبقٍ كذا حتى تتأكد المخالفة/يُفعَّل التعليق" بدل انتظار
  // التقييم التالي لمعرفة النتيجة. undefined = لا بيانات استمرار متاحة (لا
  // جهاز/قراءة مرتبطة، أو فشل الاستعلام) — الواجهة تُخفي العدّاد حينها.
  pm10SustainedMinutesAbove340?: number;
  pm10SustainedMinutesAbove250?: number;

  // خطأ مكتشَف ومُصلَح (مراجعة خبير خارجي — "لا قدرة Replay كاملة: القرار
  // المخزَّن لا يحمل معرّفات القراءات الفعلية التي أثبتت الاستمرار"):
  // معرّفات صفوف pm10_readings_history (id) المكوِّنة فعلياً لسلسلة
  // الاستمرار التي بنت isConfirmedViolation340/isSuspended250For30Min —
  // راجع evidenceReadingIds في Pm10SustainedStatus (dustEvaluation.ts)
  // للتفصيل الكامل. يُخزَّن هذا الكائن كاملاً بصيغة jsonb في
  // dust_compliance_evaluations.result، فلا حاجة لعمود قاعدة بيانات جديد؛
  // القرار المخزَّن يحمل الآن معرّفات الأدلة الدقيقة، لا فقط القيمة
  // المجمَّعة النهائية. فارغة/undefined إن لم توجد سلسلة استمرار مُثبَتة.
  pm10EvidenceReadingIds?: string[];

  // خطأ مكتشَف ومُصلَح (مراجعة مستخدم — "ليش التايمر ينعاد إذا سويت تحديث
  // للصفحة"): العدّاد التنازلي في Compliancewidgetcard.tsx كان يفترض أن
  // pm10SustainedMinutesAbove340/250 أعلاه "طازجة تماماً" لحظة عرضها في
  // المتصفح (snapshotAtMs = Date.now() محلي وقت أول render) — صحيح تقريباً
  // أثناء التحديث الدوري (polling كل دقيقتين، فارق زمني ضئيل بين حساب
  // الخادم وعرض المتصفح)، لكن خاطئ عند إعادة تحميل الصفحة يدوياً (المكوّن
  // يُعاد بناؤه من الصفر، فلحظة "أول عرض" تصبح وقت اكتمال تحميل الصفحة، لا
  // وقت حساب الخادم الفعلي الذي قد يسبقه بثوانٍ). evaluatedAt هو وقت حساب
  // الخادم الفعلي لهذا التقييم كاملاً (بما فيه الرقمين أعلاه) — الواجهة
  // تستخدمه كمرجع asOfMs بدل Date.now() المحلي، فيبقى العدّاد دقيقاً بصرف
  // النظر عن توقيت إعادة عرضه في المتصفح.
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
    // للعرض فقط (تنبيهات إعلامية داخل بطاقة الامتثال) — لا تدخل في أي حساب/
    // عتبة ضمن محرك الامتثال نفسه، تماماً كالرطوبة والحرارة أعلاه.
    visibilityM: number | null;
    // آخر وقت إرسال فعلي لمحطة الرصد المرتبطة (ISO) — undefined دائماً
    // عندما لا يوجد ربط جهاز لهذا النشاط (وضع API)، فيُستخدم وجود الحقل
    // (بصرف النظر عن قيمته null/string) كإشارة "هذا النشاط مرتبط بجهاز"
    // في buildStalenessAdvisory (Compliancewidgetcard.tsx). للعرض فقط.
    deviceLastReadingAt?: string | null;
    // آخر وقت وصول PM10 تحديداً من نفس المحطة (ISO) — منفصل عن
    // deviceLastReadingAt لأن الأخير يتحدّث عند أي push جزئي حتى بلا PM10
    // (راجع last_pm10_at في project_devices، وتعليق devicePm10LastReadingAt
    // في DustEngineInput للسبب الكامل). نفس دلالة undefined/null أعلاه.
    // للعرض فقط.
    devicePm10LastReadingAt?: string | null;
    // حالة حداثة pm10UgM3 أعلاه وقت القرار — راجع Pm10EvidenceState/
    // pm10EvidenceState في DustComplianceContext للتفصيل الكامل. undefined
    // يعني "لم يُحسَب" (استدعاءات قديمة/اختبارات تبني evidence يدوياً).
    pm10EvidenceState?: Pm10EvidenceState;
  };

  // ملاحظات تحذيرية لصحة القراءة (من DVI، راجع DviEvaluationResult.caveatsAr)
  // — لا تُغيّر decisionCategory/shortReasonAr إطلاقاً، طلب صريح من المستخدم.
  caveatsAr: string[];

  // true فقط عندما يكون القرار الخام (لو تُرك بلا قيد استئناف) أفضل من
  // STOP_AFFECTED_ACTIVITY، لكن تم تثبيته عندها احترازياً بسبب عدم مرور
  // RESUME_STABILITY_MINUTES بعد. يُستخدم في dustEvaluation.ts لتتبّع "منذ
  // متى أصبحت القراءة جيدة فعلياً" (pendingResumeSince) منفصلاً تماماً عن
  // stopped_since ("منذ متى بدأ الإيقاف") — الخلط بينهما كان يجعل عداد
  // الاستئناف يبدأ من بداية الإيقاف نفسه بدل بداية التحسّن، فيسمح باستئناف
  // فوري إن كانت مدة الإيقاف الكلية (بقراءات سيئة متفرقة) تجاوزت 10 دقائق
  // ولو لم تتراكم دقيقة واحدة فعلية من القراءة الجيدة بعد.
  resumeHoldApplied: boolean;
}

// السياق الكامل الذي يُمرَّر لدالة evaluateDustCompliance — يجمع كل ما تحتاجه
// من المشروع والنشاط ونتيجة DVI الجاهزة، دون أي حساب DVI جديد هنا.
export interface DustComplianceContext {
  project: DustProjectComplianceProfile;
  activity: DustActivityComplianceProfile;
  // القسم 18.6 من "دليل الإصلاح الجذري لمنظومة مرقاب" — القسم "Forecast
  // قديم: التخطيط يظهر نتيجة Stale". true فقط عندما فشل/انقطع استدعاء
  // Open-Meteo فعلياً (راجع isForecastStale في weather.ts) لعينة الطقس
  // المستخدَمة لبناء هذا السياق. لا معنى له في مسار LIVE_OPERATIONAL
  // (القرار الحي مبني من الجهاز مباشرة، بلا استدعاء طقس أصلاً — راجع
  // evaluateLiveOperationalDecision)؛ يُستهلَك حصرياً في buildPlanningForecastResult
  // أدناه (engine.ts) لعرض تحذير "توقّع مبني على بيانات قديمة" بدل عرض
  // "الأجواء تصلح/لا تصلح" بثقة كاملة على تقدير طقس غير موثوق أصلاً.
  isForecastStale: boolean;
  dviScore: number;
  dviDecision: DviDecisionCategory;
  dviMandatoryStop: boolean;
  // true فقط عندما يكون سبب dviMandatoryStop الوحيد هو تجاوز PM10≥340
  // اللحظي، بلا أي خطر فيزيائي فوري آخر (رؤية حرجة/رياح شديدة) مساهم —
  // راجع dust-engine/engine.ts (DVI-DUST-ACTIVITY-STOP-004-PM10-ONLY)
  // وGATE-DVI-002 في engine.ts للاستخدام الفعلي. اختياري (undefined =
  // false توافقياً) حتى لا تنكسر استدعاءات context() القديمة في الاختبارات
  // التي تبني dviMandatoryStop:true يدوياً بلا هذا الحقل.
  dviMandatoryStopIsPm10Only?: boolean;
  // خطأ مكتشَف ومُصلَح (مراجعة خبير خارجي — "فقد الرؤية قد يؤدي إلى ALLOW أو
  // يسمح باستكمال نافذة الاستئناف من إيقاف سابق"): من
  // DviEvaluationResult.visibilityDataMissing — true فقط عندما يوجد جهاز
  // مرتبط فعلياً لكن قراءة الرؤية غائبة/غير طازجة، فلا تُفعَّل بوابتا الرؤية
  // في dust-engine (DVI-VISIBILITY-MANDATORY-STOP-001/RED-002) بصمت كأن
  // الرؤية ممتازة. تُستخدم أدناه لإضافة "الرؤية غير متوفرة" إلى
  // missingCriticalInputs (يمنع ALLOW واثقاً) ولمنع resumeHoldApplied من
  // معاملة هذا الغياب كتحسّن فعلي يُنهي إيقافاً سابقاً. اختياري (undefined =
  // false توافقياً) لنفس سبب dviMandatoryStopIsPm10Only أعلاه.
  dviVisibilityDataMissing?: boolean;
  // السبب النصي المحدَّد لتوقف DVI (مثال: "PM10 = 1806.8")، من
  // DviEvaluationResult.shortReason — يُستخدم في رسالة GATE-DVI-002 بدل نص
  // عام لا يذكر الرقم/السبب الفعلي. اختياري: null/undefined يبقيان الرسالة
  // العامة كما كانت (فشل آمن، لا كسر لأي مستهلك حالي للسياق).
  dviShortReason?: string | null;
  dviConfidenceScore: number;
  // خطأ مكتشَف ومُصلَح (مراجعة كود خبير خارجي — "نطاق الرياح النظامي يستخدم
  // رقمًا مشتقًا من الهبات"): كان هذا الحقل يحمل dviResult.effectiveWindKmh
  // (= max(السرعة, 0.85×الهبة))، رقم مخاطر مشتق مصمَّم لدرجة DVI الفيزيائية
  // الداخلية — لا سرعة الرياح الفعلية التي يعرّفها "بروتوكول الملحق أ"
  // (classifyWind في rulebook.ts، عتبتا 15/25 كم/س). هبة عابرة واحدة كانت
  // كافية لرفع هذا الرقم فوق 25 وتُصنَّف كأنها سرعة رياح مستدامة >25 كم/س،
  // فتُفعِّل GATE-WIND-ABOVE-25-004 (إيقاف تنظيمي) استناداً لخطأ لحظي لا
  // استمرار فعلي. الآن يحمل سرعة الرياح الخام فقط (merged.windSpeedKmh) —
  // نفس الرقم الذي يعرّفه النص التنظيمي حرفياً بلا اشتقاق. راجع
  // windGustKmh أدناه وwindGustSafetyRule في rulebook.ts للهبات تحديداً
  // (قاعدة سلامة منفصلة، لا جزءاً من بروتوكول الملحق أ).
  windSpeedKmh: number | null;
  windGustKmh: number | null;
  windDirectionDeg: number | null;
  pm10UgM3: number | null;
  pm25UgM3: number | null;
  // للعرض فقط في "الطقس المرجعي للقرار" — لا تدخل في أي حساب/عتبة ضمن محرك
  // الامتثال نفسه.
  relativeHumidityPercent: number | null;
  temperatureC: number | null;
  // للعرض فقط (تنبيهات إعلامية داخل بطاقة الامتثال) — لا تدخل في أي حساب/
  // عتبة ضمن محرك الامتثال نفسه.
  visibilityM: number | null;
  // آخر وقت إرسال فعلي لمحطة الرصد المرتبطة بهذا النشاط (ISO) — null إن
  // كان النشاط مرتبطاً بمحطة لم ترسل أي قراءة إطلاقاً بعد، undefined إن
  // لم يكن مرتبطاً بمحطة أصلاً (وضع API). للعرض فقط (تحذير قِدم القراءة).
  deviceLastReadingAt?: string | null;
  // آخر وقت وصول PM10 تحديداً من نفس المحطة (ISO) — راجع تعليق
  // devicePm10LastReadingAt المقابل في evidence أعلى الملف للسبب الكامل.
  // نفس دلالة undefined/null. للعرض فقط.
  devicePm10LastReadingAt?: string | null;
  // ملاحظات DVI التحذيرية (راجع DviEvaluationResult.caveatsAr) تُمرَّر هنا
  // كما هي لتظهر في نتيجة الامتثال أيضاً — لا تُغيّر أي قرار.
  dviCaveatsAr?: string[];
  // مصدر أعلى أولوية فاز فعلياً عبر أي حقل من حقول القراءة (device إن ظهر
  // بأي حقل، وإلا open-meteo، وإلا onsite) — للعرض العام فقط (مثال: أيقونة
  // "بيانات من جهاز" في الواجهة). لا يعني أن كل حقل جاء من هذا المصدر
  // بالضرورة — راجع pm10Source أدناه للمصدر الدقيق لـPM10 تحديداً، وهو ما
  // يجب استخدامه لأي قرار/تسجيل يعتمد على "هل هذي القراءة من الجهاز".
  dataSource: 'device' | 'open-meteo' | 'onsite' | 'project-station' | 'none';
  // مصدر قراءة PM10 تحديداً (لا التلخيص العام أعلاه) — خطأ مكتشَف ومُصلَح:
  // كان تسجيل pm10_readings_history يعتمد على dataSource العام، فحين تأتي
  // الرياح من الجهاز وPM10 من الطقس معاً، dataSource يتحول لـ'device' (يفوز
  // بأي حقل) فيظن الكود أن PM10 "من الجهاز" (لا يُعاد تسجيله، لأن قراءات
  // الجهاز تُسجَّل مرة عند الاستقبال لا هنا) بينما فعلياً جاء من الطقس ولم
  // يُسجَّل في أي مكان — فتنقطع سلسلة إثبات استمرار التجاوز لتلك القراءة
  // كلياً. undefined = لا معلومة مصدر متاحة (اختبارات/استدعاءات قديمة).
  pm10Source?: 'device' | 'weather' | 'onsite' | 'none';
  // القيمة الخام كما وصلت (بلا أي بوابة حداثة) — للعرض/التدقيق فقط (evidence.
  // pm10UgM3 في engine.ts يعرضها دائماً، بصرف النظر عن pm10EvidenceState).
  // pm10UgM3 أعلاه هو ما يدخل فعلياً pm10ThresholdRule (rulebook.ts)؛
  // pm10RawUgM3 لا يدخل أي قرار تنظيمي مطلقاً. عندما pm10EvidenceState=FRESH
  // تكون القيمتان متطابقتين دائماً.
  pm10RawUgM3?: number | null;
  // حالة حداثة قراءة PM10 وقت بناء هذا السياق (evaluatedAtMs، لا Date.now()
  // وقت القراءة نفسها — راجع evaluatedAtMs في buildComplianceContext
  // للسبب: يضمن قابلية إعادة حساب نفس القرار لاحقاً بنفس النتيجة تماماً).
  // MISSING = لا وقت قراءة معروف؛ FUTURE = وقت القراءة بعد evaluatedAtMs
  // (ساعة جهاز غير متزامنة)؛ STALE = تجاوزت LIVE_FIELD_FRESHNESS_MS. تُطبَّق
  // فقط على pm10Source='device' — قراءات الطقس/اليدوية تُعامَل كطازجة دائماً
  // (لا "قراءة" فردية لها عمر بنفس المعنى، نفس مبدأ dust-engine/engine.ts).
  pm10EvidenceState?: Pm10EvidenceState;
  sensitiveReceptors: SensitiveReceptor[];

  // آخر قرار امتثال مسجَّل لنفس activity_group_id (من
  // current_dust_compliance_decisions) — يُستخدم لتحديد إن كان النشاط
  // موقِفاً سابقاً (لتفعيل قيد الاستئناف أصلاً). null/undefined تعني "لا
  // قرار سابق"، فلا قيد يُطبَّق (سلوك المحرك بلا تغيير).
  previousDecisionCategory?: DustComplianceDecisionCategory | null;
  // خطأ مكتشَف ومُصلَح (مراجعة كود خارجي — "فشل قراءة القرار السابق يُبتلع
  // ويزيل حماية الاستئناف"): previousDecisionCategory=null طبيعية لنشاط لم
  // يُقيَّم قط — لكنها أيضاً كانت النتيجة الصامتة لفشل استعلام
  // current_dust_compliance_decisions فعلياً (شبكة/قاعدة بيانات)، فيُعامَل
  // نشاط موقوف فعلياً كأنه لم يُوقَف قط، ويفقد حماية RESUME-STABILITY-HOLD
  // بالكامل. true تعني تحديداً "الاستعلام فشل، لا 'لا قرار سابق' حقيقية" —
  // يُطبَّق بوابة PREVIOUS-DECISION-QUERY-FAILED-HOLD أدناه (فشل آمن نحو
  // إيقاف احترازي، لا سماح بلا دليل). false/undefined = الاستعلام نجح
  // (بصرف النظر عن وجود صف أم لا).
  previousDecisionQueryFailed?: boolean;
  // خطأ مكتشَف ومُصلَح (مراجعة كود خبير خارجي — "سبب الإيقاف السابق يُستنتج
  // من فئة القرار فقط"): previousStopWasWindGate في engine.ts كان يفترض أن
  // أي قرار سابق بفئة STOP_AFFECTED_ACTIVITY سببه بالضرورة بوابة الرياح
  // (GATE-WIND-ABOVE-25-004) — خطأ، لأن عشرات القواعد الأخرى (PM10 معلَّق،
  // تسرب صومعة، غسيل إطارات، ارتفاع تفريغ مواد...) تنتج نفس الفئة تماماً.
  // previousDecidingRuleCode (من current_dust_compliance_decisions.deciding_rule_code)
  // هو مصدر الحقيقة الدقيق: كود القاعدة الفعلية التي بنت القرار السابق، لا
  // فئته العامة فقط. null/undefined = لا كود مسجَّل (صفوف قديمة قبل هذه
  // الإضافة، أو لا قرار سابق) — فشل آمن: لا يُطبَّق أي قيد خاص ببوابة الرياح.
  previousDecidingRuleCode?: string | null;
  // لا تُستخدم لحساب مدة الاستقرار — أُبقيت فقط لتوافق الاستدعاءات القديمة.
  // راجع previousPendingResumeSince أدناه للحقل الصحيح المستخدم فعلياً.
  previousDecisionUpdatedAt?: string | null;
  // خطأ مكتشَف ومُصلَح (مراجعة كود خارجي — "انقطاع البيانات يُحسب ضمن مدة
  // الاستقرار ويسمح بالاستئناف"، البند الثاني: "فجوة أكبر من 90 ثانية تصفّر
  // العداد"): previousDecisionUpdatedAt أعلاه مُحمَّل عمداً بدلالة مختلفة
  // (stopped_since ?? updated_at، "منذ متى بدأ الإيقاف") فلا يصلح لقياس
  // "منذ متى آخر دورة تقييم فعلية لهذا النشاط" — وهو المطلوب هنا فعلياً.
  // previousEvaluationUpdatedAt يحمل current_dust_compliance_decisions.
  // updated_at الخام بلا أي استبدال — يُستخدم فقط لاكتشاف فجوة تقييم (توقّف
  // cron/فشل شبكة/إلخ) بين آخر دورة محفوظة وهذه الدورة: فجوة أطول من
  // PENDING_RESUME_GAP_TOLERANCE_MS (90 ثانية، أعلى قليلاً من وتيرة التقييم
  // الفعلية دقيقة واحدة) تُصفِّر عداد الاستقرار — انقطاع البيانات لا يجوز أن
  // "يُحتسب" ضمن مدة الاستقرار المطلوبة. null/undefined = لا قرار سابق
  // (فشل آمن: لا فجوة تُكتشَف، أول تقييم فعلي).
  previousEvaluationUpdatedAt?: string | null;
  // منذ متى أصبح القرار الخام (لو تُرك بلا قيد استئناف) جيداً بشكل مستمر،
  // بينما القرار المخزَّن لا يزال موقِفاً — منفصل تماماً عن "منذ متى بدأ
  // الإيقاف" (previousDecisionUpdatedAt/stopped_since). الخلط بين الاثنين
  // كان يجعل عداد الاستئناف يبدأ من بداية الإيقاف نفسه، فيسمح باستئناف فوري
  // إن تجاوزت مدة الإيقاف الكلية 10 دقائق ولو لم تتراكم دقيقة واحدة فعلية
  // من القراءة الجيدة بعد (راجع pendingResumeSince في dustEvaluation.ts).
  // null/undefined = لا يوجد استقرار مسجَّل بعد (فشل آمن: لا استئناف فوري).
  previousPendingResumeSince?: string | null;

  // استمرار PM10 عبر الزمن (من pm10_readings_history، راجع
  // fetchPm10SustainedStatus في dustEvaluation.ts) — يُستخدم لتمييز
  // RCRC-PM10-340-VIOLATION-011 (مخالفة مؤكدة بعد أكثر من دقيقتين) عن
  // MRQ-PM10-BLACK-PENDING-104 (معلَّق، أقل من دقيقتين)، وRCRC-PM10-30M-
  // SUSPENSION-012 (تعليق بعد 30 دقيقة عند ≥250). 0/undefined يعني "لا
  // بيانات استمرار متاحة" — فشل آمن نحو معاملة القراءة كأنها لحظية فقط
  // (السلوك القديم قبل هذه الإضافة، بلا كسر توافقي).
  //
  // هذان الرقمان (بالدقائق) يبقيان للعرض/التوعية فقط (مثال: عدّاد "متبقٍ
  // كذا" بالواجهة) — لا يجوز إعادة اشتقاق قرار "مؤكَّدة"/"معلَّقة" منهما في
  // rulebook.ts. راجع confirmedViolation340/suspended250For30Min أدناه
  // للقيمتين اللتين يجب أن يعتمد عليهما القرار الفعلي.
  pm10SustainedMinutesAbove340?: number;
  pm10SustainedMinutesAbove250?: number;

  // خطأ مكتشَف ومُصلَح (مراجعة كود مدير): كانت pm10ThresholdRule بـrulebook.ts
  // تستقبل فقط الرقمين أعلاه وتُعيد اشتقاق "مؤكَّدة"/"معلَّقة" بنفسها من
  // مقارنة بسيطة (sustainedMinutesAbove340 > 2) — فيفقد القرار كل فحوص
  // computeSustainedPm10Status الحقيقية (مصدر السلسلة device فعلاً؟ آخر
  // قراءة حديثة أم متوقفة؟). أخطر من ذلك: القراءة الحالية المقارَنة بـ340
  // (ctx.pm10UgM3) قد تكون من مصدر مختلف تماماً عن السلسلة المستخدَمة لحساب
  // الدقائق (قراءات جهاز على مستوى المشروع تُدمَج لأي نشاط بلا activity_group_id
  // خاص بها، راجع fetchPm10SustainedStatus)، فيُقارَن رقمان غير مرتبطين
  // منطقياً ببعضهما. الإصلاح: القرار المؤكَّد/المعلَّق يُحسب مرة واحدة فقط في
  // computeSustainedPm10Status (حيث كل الأدلة اللازمة متوفرة معاً)، ويُمرَّر
  // هنا كحالة جاهزة — rulebook.ts يقرأ القرار، لا يعيد اشتقاقه.
  // undefined = لا بيانات استمرار متاحة (نفس فشل آمن الحقلين أعلاه).
  pm10ConfirmedViolation340?: boolean;
  pm10Suspended250For30Min?: boolean;

  // خطأ مكتشَف ومُصلَح (مراجعة خبير خارجي — "لا قدرة Replay كاملة: القرار
  // المخزَّن لا يحمل معرّفات القراءات الفعلية التي أثبتت الاستمرار، فقط
  // القيم المجمَّعة"): معرّفات صفوف pm10_readings_history المكوِّنة فعلياً
  // لسلسلة الاستمرار وراء pm10ConfirmedViolation340/pm10Suspended250For30Min
  // أعلاه — راجع evidenceReadingIds في Pm10SustainedStatus (dustEvaluation.ts)
  // لمصدرها الفعلي. تُنسَخ كما هي إلى DustComplianceResult.pm10EvidenceReadingIds
  // (يُخزَّن ضمن jsonb، لا عمود جديد) — القرار المخزَّن يحمل الآن دليلاً
  // قابلاً للتتبع لصفوف محددة، لا فقط رقماً مجمَّعاً.
  pm10EvidenceReadingIds?: string[];
}
