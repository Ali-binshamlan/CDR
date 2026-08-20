// =============================================================
// DVI (Dust & Visibility Index) Engine — Types
// مرقاب | مؤشر الرؤية والغبار
// مبني حسب مواصفة "مؤشر الرؤية والغبار في مرقاب".
// قاعدة صارمة: DVI لا يعرض رقمًا خامًا (رؤية/PM10/رياح) للمستخدم،
// بل قرارًا تشغيليًا: استمرار / مراقبة / تقييد / إيقاف / إعادة جدولة.
// =============================================================

// طلب مستخدم صريح (توحيد كامل): ActivityCategory (النظام الهندسي العام
// القديم، 6 قيم) حُذف نهائياً — RegulatoryDustActivityKey أدناه هو المصدر
// الوحيد للحقيقة الآن في كل محرك (DVI/AEI/الامتثال). قبل هذا الحذف، كانت
// ثلاثة أنشطة تنظيمية مختلفة (CRUSHER/DEMOLITION/STONE_CUTTING) تتشارك قسراً
// نفس قيمة ActivityCategory الواحدة (HEAVY_EQUIPMENT_MOVEMENT) لعلاقة many-
// to-one بين النظامين — لا يمكن إعطاء الثلاثة أرقام حساسية مختلفة إلا
// بالانتقال الكامل لنظام التسعة. نوع محلي مستقل هنا (لا استيراد من dust-
// compliance-engine، رغم تطابق القيم التسعة تماماً هناك أيضاً بعد حذف
// ENTRY_EXIT/OTHER) — dust-engine يبقى مستقلاً معمارياً كما هو (الاستثناء
// الوحيد القائم أصلاً هو استيراد قيمة رقمية واحدة من ruleParameters.ts، لا
// نوع/منطق قرار).
export type RegulatoryDustActivityKey =
  | 'EARTHWORKS'
  | 'SITE_TRAFFIC'
  | 'MATERIAL_HANDLING_STOCKPILE'
  | 'DEMOLITION'
  | 'CRUSHER'
  | 'BATCHING_PLANT'
  | 'STONE_CUTTING'
  | 'CD_WASTE_TRANSPORT'
  | 'IDLE_SURFACE';

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

// StopBasis/ConfirmationState — القسم 4.4 من "دليل الإصلاح الجذري لمنظومة
// مرقاب": حقول Typed تحل محل الاستدلال على سبب الإيقاف من نص كود قاعدة
// (triggeredRules?.includes('DVI-DUST-ACTIVITY-STOP-004-PM10-ONLY')) — ربط
// هش بين محركين. Final Decision يستخدم هذين الحقلين مباشرة للتفسير/التدقيق،
// لا للتحكم الخفي في مسار البرنامج.
export type StopBasis = 'NONE' | 'PM10' | 'VISIBILITY' | 'WIND' | 'MIXED';
export type ConfirmationState = 'NOT_APPLICABLE' | 'PENDING' | 'CONFIRMED';

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
  weatherSymbol: 'SANDSTORM' | 'BLOWING_DUST' | 'FOG' | 'RAIN' | 'THUNDERSTORM' | 'CLEAR' | 'UNKNOWN';
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
  surfaceWet: boolean;             // سطح مبلل الآن (رش/مطر حديث)

  // الجوار
  receptorType: ReceptorType;
  receptorDistance: DistanceBand;
  receptorIsDownwind: boolean; // الرياح تنقل الغبار من المصدر باتجاه المستقبل الحساس

  // إشارة ميدانية اختيارية
  visibleDustPlumeReported: boolean; // عمود غبار مرئي بالعين مؤكد ميدانيًا
  openConcretePour: boolean;         // صب خرساني مكشوف قائم الآن (لقاعدة 16.6)
}

export interface DustEngineInput {
  // طلب مستخدم صريح (توحيد كامل): إجباري صرفاً، لا اختياري — كل نشاط مضمون
  // أن يحمل واحداً من التسعة (الواجهة تفرض الاختيار من REGULATORY_ACTIVITY_
  // OPTIONS قبل أي إنشاء، ولا توجد صفوف قديمة ناقصة لهذا الحقل). راجع تعليق
  // RegulatoryDustActivityKey الكامل في types.ts لسبب إلغاء ActivityCategory
  // (النظام العام القديم) بالكامل لصالح هذا الحقل وحده.
  regulatoryActivity: RegulatoryDustActivityKey;
  latitude: number;
  longitude: number;
  site: DustSiteInputs;

  // طلب صريح من المستخدم — "محطة الخلط لا تنتج غبار": محطة خلط خرسانة
  // (regulatory_activity='BATCHING_PLANT') بصوامع مختومة (silos_sealed)
  // وفلتر PM10 كفؤ (pm10_filter_efficiency_percent >= الحد الأدنى — راجع
  // isBatchingPm10Exempt في dustEvaluation.ts، نفس شرط استثناء بوابة
  // الرياح التنظيمية) كانت تبقى تُقاس بمضاعف حساسية CONCRETE_POURING
  // (0.55) كأي نشاط صب خرسانة مكشوف عادي، فتظهر "مراقبة" رغم طقس ممتاز
  // ونشاط لا ينتج غباراً فعلياً. true هنا يُصفِّر مخاطر الموقع الداخلية
  // (internalDustHazard) ويُسقِط مضاعفي حساسية النشاط/المستقبِل لأدنى قيمة
  // ممكنة (كأن النشاط بلا حساسية غبار إطلاقاً) في computeDviResult —
  // الطقس (externalHazard) يبقى العامل الوحيد المؤثر فعلياً حينها.
  isEnclosedDustExempt?: boolean;

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

  // القسم 5.3/18.3 من "دليل الإصلاح الجذري لمنظومة مرقاب" — وقت رصد مستقل
  // لكل حقل فيزيائي حاسم في القرار (رياح/رؤية)، منفصل عن deviceLastReadingAt
  // العام (يتحدّث عند أي push جزئي حتى بلا هذا الحقل تحديداً — نفس علة
  // devicePm10LastReadingAt أعلاه). buildDeviceMergedReading (engine.ts)
  // يُسقِط القيمة (يعيدها null) إن كان عمرها أكبر من FIELD_FRESHNESS_MS —
  // حرارة/PM10 حديثان لا يجوز أن "يُثبتا" حداثة رياح أو رؤية عمرها فعلياً
  // أقدم بكثير (كانت كل الحقول تُقرأ بقيمتها الخام دائماً، بصرف النظر عن
  // عمرها الفردي، طالما وُجد صف جهاز نشط). undefined/null يعني "غير معروف"
  // — يُعامَل كغير طازج (فشل آمن، نفس مبدأ evidenceUnavailable في
  // final-decision-engine).
  deviceWindSpeedAt?: string | null;
  deviceWindGustAt?: string | null;
  deviceWindDirectionAt?: string | null;
  deviceVisibilityAt?: string | null;
  // خطأ مكتشَف ومُصلَح (مراجعة خبير خارجي — "حداثة البيانات ما زالت جزئية:
  // بوابة الأربع دقائق مطبَّقة فقط تقريباً على الرياح والهبات والاتجاه
  // والرؤية؛ أما PM2.5/الحرارة/الرطوبة فقد تدخل القرار دون نفس الاستبعاد"):
  // عُمِّمت البوابة لتشمل كل حقل جهاز فعلي يدخل القرار الحي، لا الحقول
  // الأربعة الأولى فقط. PM10 نفسه مستثنى عمداً هنا — له آلية استمرار/تأكيد
  // مستقلة تماماً (computeSustainedPm10Status في dustEvaluation.ts تقرأ من
  // تاريخ القراءات، لا من قيمة لحظية واحدة)، فتطبيق freshOrNull عليه هنا
  // يتعارض مع ذلك المنطق المصمَّم عمداً بعتبة/سلوك مختلفَين.
  //
  // خطأ مُحتمَل نُظِر فيه ورُفِض (طلب مستخدم أثناء تجربة حية — "خليها تختفي
  // معهم"، توحيد PM10 مع بقية الحقول عبر freshOrNull هنا): جُرِّب فعلياً،
  // ثم اتضح أنه يُسقِط آلية أدق موجودة مسبقاً خاصة بـPM10 تحديداً
  // (pm10ReadingIsFreshEnoughForImmediateStop في applyMandatoryGates،
  // engine.ts) — تلك الآلية تمنع قراءة PM10 قديمة (>4 دقائق) من إنتاج
  // MANDATORY_STOP قطعي، لكنها تُبقيها مؤثرة بدرجة أضعف (STOP_DUST_
  // GENERATING_ACTIVITIES احترازي)، فشل آمن نحو الاحتراز. تطبيق freshOrNull
  // هنا كان سيُحوِّل pm10 بالكامل إلى null عند التقادم، فيُسقِط ذلك التمييز
  // الدقيق ويفتح المجال لقرار ALLOW عند مجرد انقطاع اتصال قصير — أضعف
  // للسلامة التنظيمية من الوضع الحالي، لا أقوى. الاستثناء هنا يبقى مقصوداً.
  devicePm25At?: string | null;
  deviceRelativeHumidityAt?: string | null;
  deviceTemperatureAt?: string | null;

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

  // راجع تعليق StopBasis/ConfirmationState أعلى الملف. stopBasis='NONE' إن
  // لم يكن هناك أي إيقاف/تقييد فعلي (decisionCategory لا يحمل خطراً فيزيائياً
  // فورياً). confirmationState='NOT_APPLICABLE' إلا عند PM10 لحظي لم يثبت
  // استمراره بعد (نفس حالة DVI-DUST-ACTIVITY-STOP-004-PM10-ONLY القديمة).
  stopBasis: StopBasis;
  confirmationState: ConfirmationState;

  channels: DviRiskChannels;
  multipliers: DviMultipliers;

  visibilityKm: number | null;
  effectiveWindKmh: number | null;

  // خطأ مكتشَف ومُصلَح (مراجعة خبير خارجي — "فقد الرؤية قد يؤدي إلى ALLOW أو
  // يسمح باستكمال نافذة الاستئناف من إيقاف سابق"): applyMandatoryGates كان
  // يتخطى بوابتي الرؤية (DVI-VISIBILITY-MANDATORY-STOP-001/RED-002) بصمت
  // عند visibilityKm===null (جهاز مرتبط لكن قراءة الرؤية غائبة/قديمة)، فيُعامَل
  // غياب البيانات فعلياً كـ"رؤية ممتازة" — لا فرق بين الحالتين في
  // decisionCategory/mandatoryStop الناتجين. true فقط عندما يكون هناك جهاز
  // مرتبط فعلياً (hasDeviceLink) لكن قراءة الرؤية غير متوفرة/غير طازجة —
  // تُستهلَك في dust-compliance-engine (missingCriticalInputs + منع تخفيف
  // قرار إيقاف سابق عبر resumeHoldApplied) لمعاملة غياب الرؤية كبيانات ناقصة
  // حرجة، لا كتحسّن فعلي. false دائماً بلا جهاز مرتبط (hasDeviceLink=false):
  // القراءة حينها تقدير طقس فقط، لا معنى لـ"جهاز لم يرسل قراءة رؤية".
  visibilityDataMissing: boolean;

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