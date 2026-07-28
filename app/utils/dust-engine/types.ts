// =============================================================
// DVI (Dust & Visibility Index) Engine — Types
// مرقاب | مؤشر الرؤية والغبار
// مبني حسب مواصفة "مؤشر الرؤية والغبار في مرقاب".
// قاعدة صارمة: DVI لا يعرض رقمًا خامًا (رؤية/PM10/رياح) للمستخدم،
// بل قرارًا تشغيليًا: استمرار / مراقبة / تقييد / إيقاف / إعادة جدولة.
// =============================================================

export type ActivityCategory =
  | 'CRANE_LIFTING'
  | 'WORK_AT_HEIGHT'
  | 'STEEL_ERECTION'
  | 'FACADE_INSTALLATION'
  | 'HEAVY_EQUIPMENT_MOVEMENT'
  | 'MATERIAL_TRANSPORT'
  | 'EXCAVATION'
  | 'BACKFILLING'
  | 'GRADING'
  | 'SOIL_TRANSPORT'
  | 'COMPACTION'
  | 'ROAD_WORKS'
  | 'ASPHALT_PAVING'
  | 'EXTERNAL_PAINTING'
  | 'COATING'
  | 'WATERPROOFING'
  | 'CONCRETE_POURING'
  | 'GENERAL_OUTDOOR_WORK'
  | 'MEP_EXTERNAL_WORK'
  | 'LANDSCAPING'
  | 'INDOOR_WORK'
  | 'OFFICE_WORK';

export type ReceptorType =
  | 'HOSPITAL_SCHOOL_NURSERY_RESIDENTIAL_ADJACENT'
  | 'HIGH_TRAFFIC_PUBLIC_ROAD'
  | 'COMMERCIAL_AREA'
  | 'INDUSTRIAL_AREA'
  | 'NONE_NEARBY';

export type DistanceBand = 'UNDER_50M' | 'M50_100' | 'M100_250' | 'M250_500' | 'OVER_500M';

export type CauseClassification =
  | 'DUST'
  | 'FOG'
  | 'RAIN_REDUCED_VISIBILITY'
  | 'SMOKE'
  | 'MIXED'
  | 'UNKNOWN';

export type DviLevel = 'GREEN' | 'YELLOW' | 'ORANGE' | 'RED' | 'DARK_RED' | 'BLACK';

export type DviDecisionCategory =
  | 'ALLOW'
  | 'ALLOW_WITH_MONITORING'
  | 'RESTRICT'
  | 'RESTRICT_SEVERE'
  | 'STOP_DUST_GENERATING_ACTIVITIES'
  | 'STOP_VISIBILITY_DEPENDENT_ACTIVITIES'
  | 'MANDATORY_STOP';

export interface DustWeatherSample {
  visibilityM: number | null;
  weatherCode: number | null;
  weatherSymbol: 'SANDSTORM' | 'BLOWING_DUST' | 'FOG' | 'RAIN' | 'CLEAR' | 'UNKNOWN';
  windSpeedKmh: number | null;
  windGustKmh: number | null;
  windDirectionDeg: number | null;
  relativeHumidityPercent: number | null;
  temperatureC: number | null;
  rainfallLast24hMm: number | null;
  pm10: number | null;
  pm25: number | null;
  dustConcentration: number | null; // µg/m³ من نموذج جودة الهواء (تقديري، ليس NCM)
  dataSource: 'open-meteo' | 'none';
  isForecastStale: boolean;
}

// بيانات الموقع (شكل المشروع) — مدخلات مستقرة نسبيًا لا تتغير كل ساعة
export interface DustSiteInputs {
  hasEarthworks: boolean;          // حفر / ردم / تسوية / دمك
  internalDirtRoads: boolean;      // طرق ترابية داخلية
  heavyEquipmentMovement: boolean; // حركة معدات ثقيلة كثيفة
  looseMaterials: boolean;         // مواد سائبة مكشوفة / أكوام رمل أو تربة
  largeExposedArea: boolean;       // منطقة مكشوفة كبيرة
  drySurface: boolean;             // سطح جاف (يرفع الغبار أسهل)
  surfaceWet: boolean;             // سطح مبلل الآن (رش/مطر حديث)

  // إجراءات التحكم
  wateringAvailable: boolean;
  stockpilesCovered: boolean;
  speedLimitApplied: boolean;
  wheelWashAvailable: boolean;
  dustScreensAvailable: boolean;
  fieldMonitoringAvailable: boolean;

  // الجوار
  receptorType: ReceptorType;
  receptorDistance: DistanceBand;
  receptorIsDownwind: boolean; // الرياح تنقل الغبار من المصدر باتجاه المستقبل الحساس

  // إشارة ميدانية اختيارية
  visibleDustPlumeReported: boolean; // عمود غبار مرئي بالعين مؤكد ميدانيًا
  openConcretePour: boolean;         // صب خرساني مكشوف قائم الآن (لقاعدة 16.6)
}

export interface DustEngineInput {
  activityType: ActivityCategory;
  latitude: number;
  longitude: number;
  site: DustSiteInputs;

  // قياسات ميدانية اختيارية (أعلى ثقة من تقدير الطقس)
  onsiteVisibilityM?: number | null;
  onsitePm10?: number | null;
  onsitePm25?: number | null;

  // قراءة حية من جهاز رصد مسجَّل على المشروع (project_devices). عزل تام
  // بطلب صريح من المستخدم: "لا شيء يعوض الآخر" — hasDeviceLink هو مفتاح
  // الفرع الكامل في mergeDustReading (engine.ts): true = كل الحقول من
  // الجهاز حصراً (حقل غائب من الجهاز يبقى null بلا أي تعويض من الطقس أو
  // onsite_*)، false = كل الحقول من تقدير الطقس (Open-Meteo) حصراً (بلا
  // تعويض من onsite_* أيضاً). onsite_* يبقى في النوع للتوافق لكنه غير
  // مُستهلَك في mergeDustReading إطلاقاً بعد الآن.
  hasDeviceLink: boolean;
  // آخر وقت إرسال فعلي للمحطة المرتبطة (ISO) — لعرض "قِدم القراءة" في
  // الواجهة عندما تتجاوز DEVICE_READING_FRESHNESS_MINUTES (راجع
  // buildStalenessAdvisory في Compliancewidgetcard.tsx). null إن كانت
  // المحطة لم ترسل أي قراءة إطلاقاً، أو hasDeviceLink=false أصلاً.
  deviceLastReadingAt?: string | null;
  // خطأ مكتشَف: deviceLastReadingAt وحده كان يُستخدَم أيضاً لتقييم قِدم
  // قراءة PM10 تحديداً، لكنه يتحدّث عند أي push جزئي من الجهاز (حتى لو
  // الحرارة فقط، بلا PM10 إطلاقاً) — راجع last_pm10_at في project_devices
  // (migration منفصلة). null إن كانت المحطة لم ترسل PM10 قط، undefined إن
  // لم يُمرَّر أصلاً (فشل آمن: يُعامَل كـnull في buildStalenessAdvisory).
  devicePm10LastReadingAt?: string | null;
  deviceWindSpeedKmh?: number | null;
  deviceWindGustKmh?: number | null;
  deviceWindDirectionDeg?: number | null;
  devicePm10?: number | null;
  devicePm25?: number | null;
  deviceVisibilityM?: number | null;
  deviceRelativeHumidityPercent?: number | null;
  deviceTemperatureC?: number | null;

  // أيام عمل المشروع (معرّفات sun..sat) — تُقيّد اقتراح أفضل/أسوأ نافذة
  // بديلة بأيام العمل فقط، فلا يُقترح يوم عطلة (مثل الجمعة). اختيارية.
  workDaysList?: string[];
  // أوقات دوام المشروع (HH:mm) — تُستخدم لحصر التقييم الساعي على ساعات
  // الدوام الفعلية بدل افتراض حدود ثابتة. اختيارية.
  workHoursStart?: string;
  workHoursEnd?: string;
  // ورديات عمل حقيقية (مثال: صباحية 06:00-10:00 + مسائية 16:00-20:00
  // لتفادي ذروة الحرارة/الغبار الظهرية) — إن وُجدت، تُستخدم بدل
  // workHoursStart/workHoursEnd في بناء نافذة يوم العمل الساعية
  // (evaluateDustVisibilityWorkDayHourly). الحقلان أعلاه يبقيان للتوافق
  // مع مشاريع بلا ورديات معرَّفة (نافذة واحدة ضمنية).
  shifts?: { startTime: string; endTime: string }[];
}

// عينة طقس ساعية موسومة بوقتها — أساس تقييم نافذة زمنية للنشاط
export interface DustHourlySample extends DustWeatherSample {
  time: string; // ISO
}

// القراءة المدموجة فعلياً بعد تطبيق العزل التام (جهاز فقط أو طقس فقط،
// راجع mergeDustReading في engine.ts وhasDeviceLink في DustEngineInput
// أعلاه) — لا مزيج بين مصدرين أبداً لنفس التقييمة الواحدة. حقل sources
// يوثّق أي مصدر فاز فعلياً لكل حقل (كله device/none أو كله weather/none
// حسب hasDeviceLink، لا onsite أبداً بعد الآن — العمود تاريخي/توافقي).
export interface DviMergedReading {
  windSpeedKmh: number | null;
  windGustKmh: number | null;
  windDirectionDeg: number | null;
  pm10: number | null;
  pm25: number | null;
  visibilityM: number | null;
  relativeHumidityPercent: number | null;
  temperatureC: number | null;
  // آخر وقت إرسال فعلي للمحطة (ISO) — منسوخ من DustEngineInput.deviceLastReadingAt
  // فقط عندما hasDeviceLink=true، وإلا null دائماً.
  deviceLastReadingAt: string | null;
  // آخر وقت وصول PM10 تحديداً من المحطة (ISO) — منسوخ من
  // DustEngineInput.devicePm10LastReadingAt فقط عندما hasDeviceLink=true،
  // وإلا null دائماً. راجع تعليق devicePm10LastReadingAt في DustEngineInput
  // للسبب الكامل (لماذا لا يكفي deviceLastReadingAt وحده).
  devicePm10LastReadingAt: string | null;
  sources: {
    windSpeedKmh: 'device' | 'weather' | 'onsite' | 'none';
    windGustKmh: 'device' | 'weather' | 'onsite' | 'none';
    windDirectionDeg: 'device' | 'weather' | 'onsite' | 'none';
    pm10: 'device' | 'weather' | 'onsite' | 'none';
    pm25: 'device' | 'weather' | 'onsite' | 'none';
    visibilityM: 'device' | 'weather' | 'onsite' | 'none';
    relativeHumidityPercent: 'device' | 'weather' | 'onsite' | 'none';
    temperatureC: 'device' | 'weather' | 'onsite' | 'none';
  };
}

// نتيجة تقييم ساعة واحدة ضمن نافذة النشاط
export interface DviHourlyEvaluation extends DviEvaluationResult {
  time: string; // ISO
  // عينة الطقس الخام (رياح/اتجاه/PM10/PM2.5/غبار) المستخدمة لحساب هذه
  // الساعة تحديداً — حقل شقيق منفصل عمداً عن DviEvaluationResult نفسه،
  // وليس إضافة عليه: القاعدة الصارمة أعلى هذا الملف ("DVI لا يعرض رقمًا
  // خامًا... بل قرارًا تشغيليًا") تصف بنية DviEvaluationResult تحديداً.
  // هذا الحقل يسمح لطبقات استهلاك أخرى (مثل محرك الامتثال التنظيمي) بقراءة
  // القيم الخام دون أن يُعاد حساب DVI أو يُخرق ذلك العقد.
  rawWeatherSample: DustWeatherSample;
  // القراءة بعد تطبيق أولوية جهاز > طقس > onsite (راجع DviMergedReading
  // أعلاه) — حقل شقيق آخر لنفس السبب، يسمح لمحرك الامتثال بقراءة نفس
  // القيم المدموجة التي استخدمها DVI فعلياً بدل إعادة اشتقاق سلسلة أولوية
  // منفصلة قد تتعارض معها (كان هذا سبب تناقضات "بانر أخضر/بطاقة حمراء"
  // سابقاً).
  mergedReading: DviMergedReading;
}

// تقييم نافذة زمنية كاملة لنشاط له وقت بدء ومدة (مثال: 3 ساعات)
export interface DustWindowEvaluation {
  // أسوأ حالة عبر كل ساعات النافذة المختارة — هذا هو القرار الممثل للنشاط بأكمله
  worst: DviHourlyEvaluation;
  // تفصيل كل ساعة ضمن النافذة المختارة
  hourly: DviHourlyEvaluation[];
  windowStartIso: string;
  windowEndIso: string;
  durationHours: number;
  // أفضل نافذة بديلة بنفس المدة خلال الأفق المتاح (لأغراض اقتراح وقت أفضل)
  bestWindowStartIso: string | null;
  bestWindowWorst: DviHourlyEvaluation | null;
  // أسوأ نافذة بديلة بنفس المدة خلال الأفق المتاح (لتحذير "تجنّب هذا الوقت")
  // — نفس مفهوم avoidWindow في محرك الحرارة، لتوحيد المزايا بين المؤشرين
  avoidWindowStartIso: string | null;
  avoidWindowWorst: DviHourlyEvaluation | null;
}

export interface DviRiskChannels {
  visibilityRisk: number;
  particulateRisk: number;
  windTransportRisk: number;
  dustForecastRisk: number;
  siteDustGenerationRisk: number;
  adjustedSiteDustGenerationRisk: number;
  externalHazard: number;
  internalDustHazard: number;
}

export interface DviMultipliers {
  activitySensitivity: number;
  activitySensitivityMultiplier: number;
  receptorSensitivity: number;
  downwindAlignment: number;
  distanceFactor: number;
  receptorImpact: number;
  receptorSensitivityMultiplier: number;
  mitigationScore: number;
  mitigationReductionFactor: number;
}

export interface DviEvaluationResult {
  indicatorType: 'DVI';
  dviBase: number;
  score: number; // DVI_activity بعد القص 0-100
  level: DviLevel;
  causeClassification: CauseClassification;

  decisionCategory: DviDecisionCategory;
  decisionLabelAr: string;
  mandatoryStop: boolean;
  overridable: boolean;

  channels: DviRiskChannels;
  multipliers: DviMultipliers;

  visibilityKm: number | null;
  effectiveWindKmh: number | null;

  // إشارات للمحركات الأخرى (قسم 17 و 16.1 من المواصفة)
  visibilityConstraint: boolean;
  mandatoryVisibilityStop: boolean;
  respiratoryPPERequired: boolean;
  dustExposureHigh: boolean;
  outdoorWorkRestriction: boolean;

  triggeredRules: string[];
  requiredActions: string[];
  shortReason: string;
  topRiskDrivers: string[];
  riskReducers: string[];

  // ملاحظات تحذيرية لا تُغيّر القرار/الدرجة إطلاقاً — فقط تنبيه لصحة القراءة
  // نفسها (مثال: رطوبة نسبية مرتفعة قد تؤثر على حساسات الجسيمات البصرية،
  // أو حرارة قد تتجاوز التصنيف التشغيلي لجهاز PM10). طلب صريح من المستخدم:
  // "لا تُلغى القراءة أو التجاوز" — تبقى منفصلة تماماً عن decisionCategory.
  caveatsAr: string[];

  confidenceScore: number;
  confidenceLabel: string;

  validUntil: string;
}