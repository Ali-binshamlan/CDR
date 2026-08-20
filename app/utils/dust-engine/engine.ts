// =============================================================
// DVI Engine — Core Calculations
// قاعدة صارمة (قسم 5 و15 من المواصفة): بوابات الإيقاف الإلزامية لا
// تنتظر الدرجة النهائية، وتتجاوز أي Score محسوب.
// =============================================================

import {
  CauseClassification,
  DustEngineInput,
  DustSiteInputs,
  DviDecisionCategory,
  DviEvaluationResult,
  DviHourlyEvaluation,
  DviLevel,
  DviMergedReading,
  DviRiskChannels,
  DviMultipliers,
  DustWindowEvaluation,
  RegulatoryDustActivityKey,
} from './types';
import {
  ACTIVITY_SENSITIVITY,
  DISTANCE_FACTOR,
  DUST_FORECAST_RISK,
  DUST_GENERATING_ACTIVITIES,
  DVI_DECISION_LABEL_AR,
  RECEPTOR_SENSITIVITY,
  VISIBILITY_DEPENDENT_ACTIVITIES,
  confidenceLabel as toConfidenceLabel,
  dviLevelFromScore,
  pm10Risk,
  pm25Risk,
  visibilityRisk,
  windTransportRisk,
} from './tables';
import { fetchDustWeather, fetchDustWeatherHourly } from './weather';
import { DustWeatherSample } from './types';
import { LIVE_FIELD_FRESHNESS_MS } from '@/app/utils/rule-bundles/field-freshness';
// خطأ مكتشَف ومُصلَح (مراجعة كود خارجي — "انقل حدود الرؤية 500/1000 إلى حزمة
// القواعد حتى تدخل في replay"): VISIBILITY_MANDATORY_STOP_KM/
// VISIBILITY_RESTRICT_SEVERE_KM (ruleParameters.ts) — استيراد قيمة رقمية
// قابلة للضبط فقط من محرك آخر (نفس نمط PM10_FORECAST_WARNING_UG_M3 في
// final-decision-engine/engine.ts)، لا منطق قرار مستورَد.
import { getRuleParameters } from '@/app/utils/dust-compliance-engine/ruleParameters';

// -------------------------------------------------------------
// تصنيف مستوى توقع الغبار من تركيز الغبار السطحي ورمز الطقس
// -------------------------------------------------------------
function classifyDustForecastRisk(sample: DustWeatherSample): number {
  if (sample.weatherSymbol === 'SANDSTORM') return DUST_FORECAST_RISK.SANDSTORM;
  if (sample.weatherSymbol === 'BLOWING_DUST') return DUST_FORECAST_RISK.HEAVY;
  if (sample.dustConcentration === null) return DUST_FORECAST_RISK.NONE;
  if (sample.dustConcentration >= 350) return DUST_FORECAST_RISK.HEAVY;
  if (sample.dustConcentration >= 100) return DUST_FORECAST_RISK.MODERATE;
  if (sample.dustConcentration >= 20) return DUST_FORECAST_RISK.LIGHT;
  return DUST_FORECAST_RISK.NONE;
}

// -------------------------------------------------------------
// تصنيف سبب ضعف الرؤية (قسم 3 من المواصفة)
// -------------------------------------------------------------
export function classifyCause(sample: DustWeatherSample, pm10: number | null): CauseClassification {
  const reasons = new Set<CauseClassification>();

  const dustSignal =
    sample.weatherSymbol === 'SANDSTORM' ||
    sample.weatherSymbol === 'BLOWING_DUST' ||
    (pm10 !== null && pm10 >= 150);
  if (dustSignal) reasons.add('DUST');

  const fogSignal =
    sample.weatherSymbol === 'FOG' ||
    (sample.relativeHumidityPercent !== null && sample.relativeHumidityPercent >= 95 && (pm10 === null || pm10 < 100));
  if (fogSignal) reasons.add('FOG');

  // THUNDERSTORM (أكواد WMO 95/96/99) تُعامَل معاملة RAIN هنا — عاصفة رعدية
  // تقلل الرؤية بنفس أثر المطر، وليست إشارة غبار مستقلة (راجع تعليق
  // mapWeatherCodeToSymbol في weather.ts).
  const rainSignal =
    sample.weatherSymbol === 'RAIN' ||
    sample.weatherSymbol === 'THUNDERSTORM' ||
    (sample.rainfallLast24hMm !== null && sample.rainfallLast24hMm > 0);
  if (rainSignal) reasons.add('RAIN_REDUCED_VISIBILITY');

  if (reasons.size === 0) return 'UNKNOWN';
  if (reasons.size === 1) return Array.from(reasons)[0];
  return 'MIXED';
}

// -------------------------------------------------------------
// حساب SiteDustGenerationRisk + التخفيف بالمطر/الرطوبة
// -------------------------------------------------------------
// طلب مستخدم صريح (اكتشاف فجوة مشابهة): largeExposedArea/drySurface (كانتا
// 10%+10% من الوزن) حُذفتا نهائياً من هذه المعادلة — خصائص موقع فيزيائية
// بحتة (مساحة كبيرة/سطح جاف) لا علاقة لها بنوع النشاط منطقياً (أي نشاط من
// التسعة ممكن يكون بموقع صغير أو كبير، رطب أو جاف)، بخلاف hasEarthworks/
// internalDirtRoads/heavyEquipmentMovement/looseMaterials أدناه (كل واحد
// منها تعريفه *هو* طبيعة نشاط تنظيمي محدد بالضبط، فالاشتقاق التلقائي من
// regulatoryActivity منطقي وصادق). لم يكن لهما مسار واجهة إطلاقاً أصلاً (لا
// خانة اختيار في DustStep.tsx)، وربطهما بـtrue ثابتة لكل الأنشطة كان سيرفع
// كل الدرجات بمقدار ثابت بلا أي معلومة حقيقية مضافة — أسوأ من حذفهما. الوزن
// (20% مجتمعة) أُعيد توزيعه نسبياً على الأربعة الباقية (×1.25 لكل وزن أصلي).
function calculateSiteDustGeneration(site: DustSiteInputs, rainfallLast24hMm: number | null) {
  const b = (v: boolean) => (v ? 1 : 0);
  const siteDustGenerationRisk =
    100 *
    (0.3125 * b(site.hasEarthworks) +
      0.25 * b(site.internalDirtRoads) +
      0.25 * b(site.heavyEquipmentMovement) +
      0.1875 * b(site.looseMaterials));

  let dampeningFactor = 1 - Math.min(0.6, 0.12 * (rainfallLast24hMm ?? 0));
  if (site.surfaceWet) dampeningFactor = Math.min(dampeningFactor, 0.4);

  const adjustedSiteDustGenerationRisk = siteDustGenerationRisk * dampeningFactor;

  return { siteDustGenerationRisk, adjustedSiteDustGenerationRisk };
}

// -------------------------------------------------------------
// حساب المضاعفات الثلاثة (النشاط، الجوار، إجراءات التحكم)
// -------------------------------------------------------------
function calculateMultipliers(
  site: DustSiteInputs,
  regulatoryActivity: RegulatoryDustActivityKey
) {
  // رقم حساسية مستقل لكل من الأنشطة التنظيمية التسعة الفعلية — راجع تعليق
  // ACTIVITY_SENSITIVITY الكامل في tables.ts للقيم والمبررات.
  const activitySensitivity = ACTIVITY_SENSITIVITY[regulatoryActivity];
  const activitySensitivityMultiplier = 0.8 + 0.4 * activitySensitivity;

  const receptorSensitivity = RECEPTOR_SENSITIVITY[site.receptorType];
  // تدقيق مكتشَف (مراجعة كود خارجي — "اتجاه الرياح يُستخدم دون توثيق الشمال
  // الحقيقي"، البند ح): site.receptorIsDownwind تصنيف يدوي/تخطيطي من
  // المستخدم وقت إنشاء النشاط (project_dust_profiles.receptor_is_downwind)،
  // لا إقراراً لحظياً بـ"المستقبل باتجاه الرياح الآن"، ولا مشتقاً من قراءة
  // محطة حية بأي شكل — راجع تعليق receptorIsDownwind الكامل في
  // dustEvaluation.ts (buildDustInput) لسبب استقلاله التام عن
  // WindDirectionEvidence (محرك الامتثال المنفصل).
  const downwindAlignment = site.receptorIsDownwind ? 1 : 0;
  const distanceFactor = DISTANCE_FACTOR[site.receptorDistance];
  const receptorImpact = receptorSensitivity * downwindAlignment * distanceFactor;
  const receptorSensitivityMultiplier = 1 + 0.2 * receptorImpact;

  return {
    activitySensitivity,
    activitySensitivityMultiplier,
    receptorSensitivity,
    downwindAlignment,
    distanceFactor,
    receptorImpact,
    receptorSensitivityMultiplier,
  };
}

// -------------------------------------------------------------
// القرار الأساسي من المستوى (قبل تطبيق البوابات)
// -------------------------------------------------------------
function baseDecisionFromLevel(
  level: DviLevel,
  regulatoryActivity: RegulatoryDustActivityKey
): DviDecisionCategory {
  if (level === 'GREEN') return 'ALLOW';
  // ORANGE لم يعد يُنتج RESTRICT — طلب صريح من المستخدم: رسالة "تقييد
  // العمل: وجود فجوة في إجراءات التحكم الميدانية" لا يجوز أن تظهر كقرار
  // "تقييد" في القرارات النهائية. يبقى النطاق البرتقالي ضمن ALLOW_WITH_
  // MONITORING فقط (تنبيه/مراقبة، بلا لغة تقييد فعلي). لا تأثير على
  // RESTRICT_SEVERE أو أي إيقاف إلزامي — تلك تبقى كما هي تماماً.
  if (level === 'YELLOW' || level === 'ORANGE') return 'ALLOW_WITH_MONITORING';

  const isVisibilityDependent = VISIBILITY_DEPENDENT_ACTIVITIES.includes(regulatoryActivity);
  const isDustGenerating = DUST_GENERATING_ACTIVITIES.includes(regulatoryActivity);

  if (isVisibilityDependent) return 'STOP_VISIBILITY_DEPENDENT_ACTIVITIES';
  if (isDustGenerating) return 'STOP_DUST_GENERATING_ACTIVITIES';
  return 'RESTRICT_SEVERE';
}

// -------------------------------------------------------------
// البوابات الإلزامية (قسم 15) — تتجاوز أي Score
// -------------------------------------------------------------
interface GateOutcome {
  decision: DviDecisionCategory;
  mandatoryStop: boolean;
  overridable: boolean;
  triggeredRules: string[];
  extraActions: string[];
}

// invariant صارم — لا يعتمد على التزام كل فرع مستقبلي في applyMandatoryGates
// بضبط overridable=false يدوياً عند mandatoryStop=true (راجع تعليق
// overridable في نتيجة computeDviResult أدناه للسبب الكامل: فرعان كانا
// يضبطان mandatoryStop=true بلا overridable=false، فتصل نتيجة متناقضة
// منطقياً لمستهلكي DviEvaluationResult). يُستدعى مباشرة قبل إرجاع النتيجة
// النهائية — فشل هذا الفحص يعني خطأً برمجياً حقيقياً في applyMandatoryGates
// (بوابة جديدة نسيت ضبط overridable)، لا حالة مستخدم عادية، فيرمي استثناءً
// بدل تمرير نتيجة قد تُعرض على الواجهة كـ"قابلة للتجاوز" رغم إيقافها إلزامياً.
function assertMandatoryStopInvariant(result: { mandatoryStop: boolean; overridable: boolean }): void {
  if (result.mandatoryStop && result.overridable) {
    throw new Error('Invalid DVI decision: mandatoryStop=true cannot coexist with overridable=true');
  }
}

function applyMandatoryGates(
  input: DustEngineInput,
  visibilityKm: number | null,
  pm10: number | null,
  dustForecastRisk: number,
  weatherSymbol: DustWeatherSample['weatherSymbol'],
  baseDecision: DviDecisionCategory
): GateOutcome {
  const rules: string[] = [];
  const actions: string[] = [];
  let decision = baseDecision;
  let mandatoryStop = false;
  let overridable = true;
  const isVisibilityActivity = VISIBILITY_DEPENDENT_ACTIVITIES.includes(input.regulatoryActivity);
  const { VISIBILITY_MANDATORY_STOP_KM, VISIBILITY_RESTRICT_SEVERE_KM } = getRuleParameters();

  if (visibilityKm !== null && visibilityKm < VISIBILITY_MANDATORY_STOP_KM) {
    rules.push('DVI-VISIBILITY-MANDATORY-STOP-001');
    // طلب مستخدم صريح: النص القديم ("إيقاف الرفع... والعمل على ارتفاع")
    // موروث من نطاق مرقاب العام (رافعات/عمل على ارتفاع) — لا ينطبق على أي
    // من التسعة أنشطة التنظيمية الفعلية هنا (هذي القاعدة تُفعَّل فقط لـ
    // CRUSHER/DEMOLITION/STONE_CUTTING عبر isVisibilityActivity، لا رفع أو
    // ارتفاع في أي منها). نص عام يغطي الثلاثة بلا ذكر معدات غير موجودة.
    actions.push('إيقاف كل الأنشطة المعتمدة على الرؤية فوراً (كسارة/هدم/قطع أحجار)');
    actions.push('تأمين المعدات ومنع دخول الشاحنات إلا للضرورة');
    actions.push('إعادة التقييم فور تحسن الرؤية');
    if (isVisibilityActivity) {
      decision = 'MANDATORY_STOP';
      mandatoryStop = true;
      overridable = false;
    } else {
      decision = 'RESTRICT_SEVERE';
    }
  }
  else if (visibilityKm !== null && visibilityKm < VISIBILITY_RESTRICT_SEVERE_KM) {
    rules.push('DVI-VISIBILITY-RED-002');
    // نفس التصحيح أعلاه (DVI-VISIBILITY-MANDATORY-STOP-001) — لا رفع في
    // الأنشطة الثلاثة المعتمدة على الرؤية.
    actions.push('منع بدء عمليات جديدة وتقليل وتيرة العمل الحالي');
    actions.push('تفعيل سرعة داخلية منخفضة واستخدام موجهين ميدانيين');
    if (isVisibilityActivity) decision = 'RESTRICT_SEVERE';
  }

  const clearInternalDustSource = input.site.hasEarthworks || input.site.internalDirtRoads || input.site.looseMaterials;
  if (pm10 !== null && (pm10 >= 250 || (pm10 >= 150 && clearInternalDustSource))) {
    rules.push('DVI-PM10-ACTION-003');
    actions.push('رش الطرق الداخلية وتغطية المواد السائبة وتقليل حركة الشاحنات');
    actions.push('فحص مصدر ارتفاع الغبار ومراقبة حدود الموقع');
    // لم تعد تصعّد إلى RESTRICT (راجع baseDecisionFromLevel) — تبقى عند
    // ALLOW_WITH_MONITORING (تنبيه/مراقبة فقط). قرار الامتثال التنظيمي
    // المستقل (PM10-WARNING-008/PRECAUTION-009 في dust-compliance-engine)
    // هو من يتولى فعلياً أي إجراء تنظيمي فعلي عند هذه القراءات، لا DVI.
    if (decision === 'ALLOW') decision = 'ALLOW_WITH_MONITORING';
  }

  // خطأ معماري حرج مكتشَف ومُصلَح (طلب صريح من المستخدم — مراجعة كود خبير
  // خارجي، الملاحظة #9: "DVI أيضاً ما زال يحتاج تحصيناً... الوثيقة
  // المعمارية تفصل بوضوح بين DVI=تقييم الخطر وRiyadh Dust Compliance
  // Engine=تطبيق قاعدة PM10 التنظيمية... لا يجوز أن يقوم DVI عبر مسار
  // جانبي بعمل PM10>340 → STOP إذا كانت قاعدة المشروع نفسها تقول STOP بعد
  // 30 دقيقة"): كان DVI يحمل نسخته المستقلة الخاصة من عتبة PM10>340
  // (pm10RuleTriggered) تُنتج STOP_DUST_GENERATING_ACTIVITIES/mandatoryStop
  // بمعزل تام عن آلة حالة الاستمرارية 2/30 دقيقة التي تعيش حصراً في محرك
  // الامتثال (pm10ThresholdRule بـrulebook.ts). هذا لم يكن خطأ منطقي مباشر
  // (dviMandatoryStopIsPm10Only/dviStopIsPm10StaleOnly في
  // final-decision-engine/engine.ts كانتا تُصفِّيان الأثر النهائي بنجاح،
  // بعد إصلاحين سابقين لهذا الملف نفسه في نفس الجلسة) — لكنه سلطة قرار
  // مكرَّرة معمارياً: أي مستهلك جديد يقرأ dvi.decisionCategory/mandatoryStop
  // مباشرة (بلا المرور عبر التصفية المزدوجة تلك) يقع في نفس الفخ الذي وقع
  // فيه dviCandidate وGATE-DVI-002 قبل إصلاحهما. الإصلاح الجذري: يُزال هذا
  // الفرع بالكامل من DVI — القرار التنظيمي لـPM10 يأتي الآن من مصدر واحد
  // فقط (محرك الامتثال)، لا نسختين مستقلتين يجب مزامنتهما يدوياً باستمرار.
  //
  // DVI يبقى "يرى" خطر PM10 عبر particulateRisk (PR أدناه، مقياس مستمر لا
  // عتبة ثنائية) — اللون/الدرجة يعكسان ارتفاع PM10 كما هي، فقط لا قرار
  // إيقاف/إلزام مستقل مبني على عتبة 340 تحديداً.
  //
  // طلب مستخدم صريح لاحق (اكتشاف تناقض مماثل): DVI-DUST-ACTIVITY-STOP-004
  // (كانت هنا: رؤية<1كم + حفريات + رياح>40 → إيقاف إلزامي) حُذفت بالكامل —
  // نفس منطق حذف DVI-WIND-LOOSE-MATERIAL-005 بالكامل أدناه (كانت هنا
  // سابقاً): GATE-WIND-ABOVE-25-004 في dust-compliance-engine يوقف أي نشاط
  // من التسعة عند رياح >25 كم/س (isDustGenerating مُشتَقة true دائماً)، أي
  // قبل وصول شرط هذه القاعدة (رياح>40) بخمسة عشر نقطة كاملة — فالقاعدة لم
  // تكن تصل لتفعيلها الفعلي أبداً، النشاط يكون متوقفاً أصلاً من محرك
  // الامتثال قبل أن تبلغ الرياح 40 كم/س. الإيقاف الإلزامي كان محتواها
  // الوحيد بالكامل — حذف الإيقاف يعني حذف القاعدة نفسها، لا تبسيطها.
  //
  // طلب مستخدم صريح ثانٍ (اكتشاف تناقض أوسع بنفس الجلسة): DVI-WIND-LOOSE-
  // MATERIAL-005 حُذفت هي الأخرى بالكامل — شرط تفعيلها الأساسي نفسه كان
  // effectiveWindKmh >= 30، وهذا فوق حد الـ25 كم/س الذي يوقف عنده محرك
  // الامتثال أي نشاط من التسعة أصلاً (لا فقط عتبة الإيقاف الإلزامي عند 55
  // كم/س المحذوفة سابقاً). يعني حتى التنبيه الأساسي ("غطّوا المواد السائبة")
  // كان ميتاً عملياً — العمل يكون متوقفاً من محرك الامتثال قبل وصول الرياح
  // لعتبة تفعيل هذه القاعدة بخمس نقاط كاملة، لأي نشاط من التسعة بلا استثناء.
  //
  // طلب مستخدم صريح (اكتشاف تناقض رابع بنفس الجلسة): DVI-RECEPTOR-
  // ESCALATION-006 حُذفت بالكامل — كانت تعتمد على receptorImpact
  // (receptorType×receptorIsDownwind×receptorDistance في calculateMultipliers
  // أعلاه)، وهذه الحقول الثلاثة (site.receptorType/receptorDistance/
  // receptorIsDownwind) لا مسار واجهة فعلي يملأها (نفس علة hasEarthworks/
  // looseMaterials المُصلَحة سابقاً في dustEvaluation.ts) — القيم الافتراضية
  // الثابتة في AddActivityModal/constants.ts (receptorType='NONE_NEARBY'،
  // receptorDistance='OVER_500M') كلتاهما تُقيَّمان 0.0 في RECEPTOR_SENSITIVITY/
  // DISTANCE_FACTOR (tables.ts)، فـreceptorImpact = 0.0×X×0.0 = 0 ثابتاً
  // رياضياً لكل نشاط — الشرط (>=0.6) مستحيل التحقق فعلياً. بخلاف hasEarthworks/
  // looseMaterials، لا اشتقاق منطقي ممكن من regulatoryActivity هنا (قرب
  // مستقبِل حساس خاصية موقع جغرافي، لا خاصية نوع نشاط) — المشروع يملك أصلاً
  // نظام مستقبِلات حساسة حقيقي (جدول sensitive_receptors + nearestReceptorDistancesM/
  // nearestDownwindReceptorDistanceM في dust-compliance-engine/geo.ts، يعتمد
  // إحداثيات فعلية واتجاه رياح حقيقي) يستخدمه محرك الامتثال بالفعل لتنبيهات
  // الكسارة التوعوية — القاعدة هنا كانت تعيد اختراع نفس المفهوم بحقول يدوية
  // ميتة بدل الاعتماد على المصدر الحقيقي الموجود أصلاً. حُذفت بدل ربطها
  // بنظام مختلف عن الغرض المباشر لهذه الجلسة (توحيد الأنشطة التسعة).

  if (weatherSymbol === 'SANDSTORM' || dustForecastRisk >= 75) {
    // خطأ مكتشَف ومُصلَح (مراجعة كود خبير خارجي): الرمز كان يحمل "NCM" رغم
    // أن مصدر البيانات الفعلي Open-Meteo لا المركز الوطني للأرصاد (NCM)
    // الرسمي — راجع تعليق أعلى weather.ts. الاسم يوحي بمصداقية رسمية غير
    // موجودة فعلياً. لا تأثير على البيانات التاريخية المخزَّنة (triggeredRules
    // القديمة تبقى بالاسم القديم)، هذا يغيّر فقط الرمز المُصدَر من الآن فصاعدًا.
    rules.push('DVI-OPENMETEO-DUST-WARNING-007');
    actions.push('إشعار مدير المشروع وإعادة ترتيب جدول الأنشطة');
    actions.push('تغطية المواد السائبة قبل الحدث وتجهيز خطة تقليل حركة المعدات');
    if (decision === 'ALLOW') decision = 'ALLOW_WITH_MONITORING';
  }

  return { decision, mandatoryStop, overridable, triggeredRules: rules, extraActions: actions };
}

// راجع StopBasis/ConfirmationState في types.ts — يُشتقان هنا من رموز
// القواعد المفعّلة فعلياً (gates.triggeredRules)، بدل ترك كل مستهلك خارجي
// (مثل dust-compliance-engine/adapters.ts) يستدل على السبب بنفسه عبر
// .includes() على نص كود قاعدة مفرد (ربط هش بين محركين، القسم 4.4 من
// "دليل الإصلاح الجذري"). لا تُستخدم لأي قرار داخل هذا الملف نفسه — للعرض/
// التفسير في محركات أخرى فقط.
function deriveStopBasisAndConfirmation(
  mandatoryStop: boolean,
  triggeredRules: string[]
): { stopBasis: DviEvaluationResult['stopBasis']; confirmationState: DviEvaluationResult['confirmationState'] } {
  if (!mandatoryStop) {
    return { stopBasis: 'NONE', confirmationState: 'NOT_APPLICABLE' };
  }

  // طلب مستخدم صريح (توحيد كامل بنفس الجلسة): hasWind (DVI-WIND-LOOSE-
  // MATERIAL-005) وhasPm10Only (DVI-DUST-ACTIVITY-STOP-004-PM10-ONLY) كلاهما
  // كود ميت الآن — القاعدتان المصدر لهذين الكودين حُذفتا بالكامل من
  // applyMandatoryGates أعلاه (لا مسار مطلقاً يدفع أي منهما إلى triggeredRules
  // بعد الآن)، فـ'WIND'/'MIXED' (تقاطع مع hasPm10Only) لم يعودا نتيجتين
  // ممكنتين فعلياً لـstopBasis — يبقى 'VISIBILITY' (من DVI-VISIBILITY-
  // MANDATORY-STOP-001، المصدر الوحيد المتبقي لـmandatoryStop=true) أو
  // 'NONE' نظرياً فقط (لا يصل هنا أصلاً لأن الدالة تُستدعى فقط عند
  // mandatoryStop=true). النوع DviEvaluationResult['stopBasis'] يبقى كما هو
  // (WIND/PM10/MIXED غير محذوفة من النوع نفسه — تبقى قيماً صالحة نظرياً لأي
  // مصدر مستقبلي، فقط لا مسار حي ينتجها من هذا الملف الآن).
  const hasVisibility = triggeredRules.some((r) => r.startsWith('DVI-VISIBILITY-'));

  const stopBasis: DviEvaluationResult['stopBasis'] = hasVisibility ? 'VISIBILITY' : 'NONE';

  // PENDING كان مخصَّصاً لحالة stopBasis==='PM10' (DVI-DUST-ACTIVITY-STOP-
  // 004-PM10-ONLY) — مسار ميت الآن (راجع تعليق stopBasis أعلاه)، فـ
  // confirmationState تبقى دائماً CONFIRMED هنا (الدالة لا تصل لهذه النقطة
  // أصلاً إلا عند mandatoryStop=true، والمصدر الوحيد المتبقي له هو رؤية
  // حرجة حقيقية مؤكَّدة، لا قراءة PM10 معلَّقة تحتاج تأكيداً لاحقاً).
  return { stopBasis, confirmationState: 'CONFIRMED' };
}

function hasMeaningfulSiteData(site: DustSiteInputs): boolean {
  return (
    site.hasEarthworks ||
    site.internalDirtRoads ||
    site.heavyEquipmentMovement ||
    site.looseMaterials ||
    site.surfaceWet ||
    site.visibleDustPlumeReported ||
    site.openConcretePour
  );
}

// خطأ مكتشَف: كانت هذي الدالة تفحص sample (عينة الطقس الخام قبل الدمج) بدل
// merged (القراءة الفعلية المستخدَمة في كل الحساب بعدها — أولوية device>
// weather>onsite، راجع mergeDustReading أعلاه) — فحين يوفّر الجهاز كل
// القياسات وتغيب بيانات الطقس، كانت الدالة ترى sample.pm10/visibilityM/
// windSpeedKmh فارغة (رغم توفرها فعلياً من الجهاز في merged) وتخصم حتى 70
// نقطة ثقة زوراً، فتظهر ثقة ~20/100 لتقييم مبني فعلياً على بيانات جهاز
// كاملة وموثوقة. isForecastStale يبقى من sample حصراً (خاصية طقس بحتة —
// لا معنى له لقراءة جهاز حية).
function calculateConfidence(
  merged: DviMergedReading,
  sample: DustWeatherSample,
  siteDataProvided: boolean
): number {
  let confidence = 100;
  if (merged.visibilityM === null) confidence -= 30;
  if (merged.pm10 === null && merged.pm25 === null) confidence -= 25;
  if (merged.windSpeedKmh === null) confidence -= 15;
  if (sample.isForecastStale) confidence -= 10;
  if (!siteDataProvided) confidence -= 20;
  return Math.max(0, Math.min(100, confidence));
}

function buildRiskDriversAndReducers(
  input: DustEngineInput,
  visibilityKm: number | null,
  pm10: number | null,
  effectiveWindKmh: number | null,
  cause: CauseClassification,
  siteDataProvided: boolean
) {
  const drivers: string[] = [];
  const reducers: string[] = [];

  if (!siteDataProvided) {
    drivers.push('لا توجد بيانات موقع مُدخَلة فعليًا — التقييم مبني على طقس عام فقط.');
  }

  if (visibilityKm !== null && visibilityKm < 3) drivers.push('انخفاض الرؤية التشغيلية الميدانية.');
  if (pm10 !== null && pm10 >= 150) drivers.push('ارتفاع مفرط في تركيز الجسيمات الغبارية PM10.');
  if (effectiveWindKmh !== null && effectiveWindKmh >= 30) drivers.push('نشاط الرياح السطحية المثير للأتربة.');
  if (input.site.hasEarthworks || input.site.internalDirtRoads) drivers.push('وجود مصادر غبار داخلية نشطة بالموقع.');
  if (input.site.receptorIsDownwind && input.site.receptorType !== 'NONE_NEARBY') drivers.push('وجود مستقبلات بيئية حساسة باتجاه هبوب الرياح.');
  if (cause === 'FOG') drivers.push('تدني الرؤية ناتج عن تشكل الضباب وليس الغبار.');

  // طلب مستخدم صريح: مصادر reducers الأربعة (wateringAvailable/
  // stockpilesCovered/speedLimitApplied/dustScreensAvailable) حُذفت مع
  // mitigationReductionFactor أعلاه — كانت دائماً false (قسم إجراءات التحكم
  // مخفي بالكامل بالواجهة)، فـreducers كانت فارغة دائماً فعلياً. الحذف بلا
  // أثر على أي نتيجة سابقة.
  return { drivers: drivers.slice(0, 3), reducers: reducers.slice(0, 3) };
}

function baseRequiredActions(decision: DviDecisionCategory): string[] {
  switch (decision) {
    case 'MANDATORY_STOP':
      return ['إيقاف إلزامي فوري للأنشطة المعتمدة على الرؤية'];
    case 'STOP_DUST_GENERATING_ACTIVITIES':
      return ['إيقاف مؤقت للأعمال المثيرة للغبار حتى تحسن الظروف'];
    case 'STOP_VISIBILITY_DEPENDENT_ACTIVITIES':
      return ['إيقاف أو تقييد الأنشطة المعتمدة على الرؤية والتواصل البصري'];
    case 'RESTRICT_SEVERE':
      return ['تقييد شديد للحركة والأنشطة الحساسة، استخدام موجهين ميدانيين'];
    case 'RESTRICT':
      return ['تقليل حركة المعدات الثقيلة وتفعيل إجراءات التحكم بالغبار'];
    case 'ALLOW_WITH_MONITORING':
      return ['الاستمرار بالعمل مع مراقبة الرؤية والغبار بشكل دوري'];
    default:
      return ['لا توجد قيود إضافية حاليًا'];
  }
}

// -------------------------------------------------------------
// دمج مصدر القراءة — عزل تام بطلب صريح من المستخدم: "حسب ما يختار
// المستخدم تظهر البيانات، لا شيء يعوّض الآخر". input.hasDeviceLink
// (يعكس project_dust_profiles.device_id للنشاط) يحدد فرعاً كاملاً واحداً
// بلا أي خلط بين المصدرين:
//   • hasDeviceLink=true  (المستخدم اختار محطة رصد): كل الحقول من الجهاز
//     حصراً. حقل غائب فعلياً من الجهاز (null) يبقى null — لا تعويض من
//     الطقس ولا onsite_* إطلاقاً، حتى لو كانا متوفرين.
//   • hasDeviceLink=false (لم يُختَر محطة): كل الحقول من تقدير الطقس
//     (Open-Meteo) حصراً — لا تعويض من onsite_* حتى لو أُدخل يدوياً.
// onsite_* لم يعد يُستهلَك هنا في أي من الفرعين (يبقى في DustEngineInput
// للتوافق فقط). القراءة القديمة (أقدم من DEVICE_READING_FRESHNESS_MINUTES)
// لا تُسقَط هنا — تُعرَض كما هي مع تحذير قِدم في الواجهة (راجع
// buildStalenessAdvisory في Compliancewidgetcard.tsx)، فمسؤولية هذه
// الدالة الوحيدة هي اختيار المصدر الصحيح، لا فلترة حداثته.
//
// خطأ مكتشَف ومُصلَح: كان الفرع device= يُستخدَم دائماً بصرف النظر عن وقت
// العينة (weather) الممرَّرة — فعند بناء شبكة توقعات الساعات القادمة
// (evaluateDustVisibilityHourly/WorkDayHourly/Window)، كل ساعة مستقبلية
// (حتى بعد 12+ ساعة) كانت تُعاد فيها قراءة الجهاز الحالية حرفياً، وكأن
// الرياح/PM10/الرؤية الآن ستبقى ثابتة طوال اليوم — توقعات بلا أي قيمة فعلية
// لأي نشاط مرتبط بجهاز. الإصلاح: sampleTimeIso (اختياري) يحدد وقت العينة
// الفعلي؛ لو لم تقع "الآن" ضمن جرس ساعة sampleTimeIso نفسه (راجع تعليق
// isDeviceApplicableToSample أدناه للتفصيل الكامل)، تُستخدَم عينة الطقس
// (توقّع حقيقي لتلك الساعة) بدل قراءة الجهاز الثابتة،
// حتى لنشاط مرتبط بجهاز — لأن الجهاز لا يملك بيانات عن المستقبل أصلاً.
// sampleTimeIso غائب (استدعاء evaluateDustVisibility للحظة الآن فقط، بلا
// وقت عينة مستقل) يعني "هذي عينة الآن"، فيُطبَّق فرع الجهاز كالمعتاد.
//
// استُخرجت هذه الكتلة كدالة مستقلة لتفادي تكرار نفس منطق بناء القراءة من
// الجهاز (نفس الحقول الثمانية + sources) — تُستخدَم هنا داخل فرع الجهاز
// العادي (isDeviceApplicableToSample=true)، وأيضاً ضمنياً عبر computeDviResult
// بـsampleTimeIso=undefined في evaluateDustVisibilityWindow (راجع تعليق
// "لو جهاز حقيقي اعرضها حتى لو قراءاه قديمه" هناك) الذي يفرض هذا الفرع
// بالذات لإعادة حساب worst من الجهاز دائماً، بصرف النظر عن حداثة القراءة.
// القسم 5.3/18.3 من "دليل الإصلاح الجذري لمنظومة مرقاب" — حداثة مستقلة لكل
// حقل فيزيائي حاسم (رياح/رؤية)، منفصلة تماماً عن حداثة أي حقل آخر (حرارة
// حديثة لا يجوز أن "تُثبت" أن قراءة رياح/رؤية قديمة لا تزال حديثة). عمر
// أكبر من هذا الحد يُسقِط القيمة إلى null — تماماً كأن الحقل لم يصل من
// الجهاز إطلاقاً، لا كأنه وصل بقيمة قديمة موثوقة.
//
// راجع app/utils/rule-bundles/field-freshness.ts (LIVE_FIELD_FRESHNESS_MS)
// للتوثيق المركزي الكامل لهذه القيمة ولماذا تختلف عمداً عن عتبة اتصال
// الجهاز العامة (10 دقائق، DEVICE_CONNECTION_FRESHNESS_MS).
const FIELD_FRESHNESS_MS = LIVE_FIELD_FRESHNESS_MS;

function freshOrNull<T>(value: T | null | undefined, observedAtIso: string | null | undefined, nowMs: number): T | null {
  if (value === null || value === undefined || !observedAtIso) return null;
  const observedMs = new Date(observedAtIso).getTime();
  if (!Number.isFinite(observedMs)) return null;
  const ageMs = nowMs - observedMs;
  // عمر سالب (وقت مستقبلي — ساعة جهاز غير متزامنة) يُبطل الحداثة أيضاً، نفس
  // مبدأ H-03.2 في computeSustainedPm10Status (dustEvaluation.ts).
  if (ageMs < 0 || ageMs > FIELD_FRESHNESS_MS) return null;
  return value;
}

function buildDeviceMergedReading(input: DustEngineInput, nowMs: number = Date.now()): DviMergedReading {
  const freshWindSpeedKmh = freshOrNull(input.deviceWindSpeedKmh, input.deviceWindSpeedAt, nowMs);
  const freshWindGustKmh = freshOrNull(input.deviceWindGustKmh, input.deviceWindGustAt, nowMs);
  const freshWindDirectionDeg = freshOrNull(input.deviceWindDirectionDeg, input.deviceWindDirectionAt, nowMs);
  const freshVisibilityM = freshOrNull(input.deviceVisibilityM, input.deviceVisibilityAt, nowMs);
  // طلب صريح من المستخدم أثناء تجربة حية — "خليها تختفي معهم" (توحيد PM10
  // مع بقية الحقول عند انقطاع الجهاز). تم فحص هذا: PM10 له آلية أدق موجودة
  // مسبقاً (pm10ReadingIsFreshEnoughForImmediateStop أدناه في applyMandatoryGates)
  // تمنع قراءة قديمة من إنتاج MANDATORY_STOP قطعي، لكنها تُبقيها مؤثرة
  // بدرجة أضعف (STOP_DUST_GENERATING_ACTIVITIES احترازي) — فشل آمن نحو
  // الاحتراز، لا نحو "تجاهل تام يفتح الباب لقرار مسموح" كما يعنيه null
  // الكامل هنا. توحيد PM10 عبر freshOrNull كان سيُسقِط هذه الدرجة الوسيطة
  // ويُضعِف السلامة التنظيمية (نقص بيانات يفتح المجال لـALLOW بدل الإبقاء
  // على احتراز) — أُبقي PM10 كما هو (بلا freshOrNull هنا)، والآلية الدقيقة
  // المنفصلة أدناه تبقى هي الحارس الفعلي لحداثته.
  const freshPm25 = freshOrNull(input.devicePm25, input.devicePm25At, nowMs);
  const freshRelativeHumidityPercent = freshOrNull(input.deviceRelativeHumidityPercent, input.deviceRelativeHumidityAt, nowMs);
  const freshTemperatureC = freshOrNull(input.deviceTemperatureC, input.deviceTemperatureAt, nowMs);

  const sourceOfDevice = <T,>(device: T | null | undefined): 'device' | 'none' =>
    device !== null && device !== undefined ? 'device' : 'none';

  return {
    windSpeedKmh: freshWindSpeedKmh,
    windGustKmh: freshWindGustKmh,
    windDirectionDeg: freshWindDirectionDeg,
    pm10: input.devicePm10 ?? null,
    pm25: freshPm25,
    visibilityM: freshVisibilityM,
    relativeHumidityPercent: freshRelativeHumidityPercent,
    temperatureC: freshTemperatureC,
    deviceLastReadingAt: input.deviceLastReadingAt ?? null,
    devicePm10LastReadingAt: input.devicePm10LastReadingAt ?? null,
    sources: {
      windSpeedKmh: sourceOfDevice(freshWindSpeedKmh),
      windGustKmh: sourceOfDevice(freshWindGustKmh),
      windDirectionDeg: sourceOfDevice(freshWindDirectionDeg),
      pm10: sourceOfDevice(input.devicePm10),
      pm25: sourceOfDevice(freshPm25),
      visibilityM: sourceOfDevice(freshVisibilityM),
      relativeHumidityPercent: sourceOfDevice(freshRelativeHumidityPercent),
      temperatureC: sourceOfDevice(freshTemperatureC),
    },
  };
}

// عكس buildDeviceMergedReading — قراءة مدموجة كلها من تقدير الطقس (Open-
// Meteo) حصراً، بلا أي مساهمة من الجهاز. تُستخدَم دائماً لشبكة التوقعات
// المستقبلية (treatAsForecast=true في mergeDustReading)، وكفرع طبيعي أيضاً
// عندما hasDeviceLink=false أو الجهاز غير قابل للتطبيق زمنياً.
function buildWeatherMergedReading(weather: DustWeatherSample): DviMergedReading {
  const sourceOfWeather = <T,>(weatherVal: T | null | undefined): 'weather' | 'none' =>
    weatherVal !== null && weatherVal !== undefined ? 'weather' : 'none';

  return {
    windSpeedKmh: weather.windSpeedKmh ?? null,
    windGustKmh: weather.windGustKmh ?? null,
    windDirectionDeg: weather.windDirectionDeg ?? null,
    pm10: weather.pm10 ?? null,
    pm25: weather.pm25 ?? null,
    visibilityM: weather.visibilityM ?? null,
    relativeHumidityPercent: weather.relativeHumidityPercent ?? null,
    temperatureC: weather.temperatureC ?? null,
    deviceLastReadingAt: null,
    devicePm10LastReadingAt: null,
    sources: {
      windSpeedKmh: sourceOfWeather(weather.windSpeedKmh),
      windGustKmh: sourceOfWeather(weather.windGustKmh),
      windDirectionDeg: sourceOfWeather(weather.windDirectionDeg),
      pm10: sourceOfWeather(weather.pm10),
      pm25: sourceOfWeather(weather.pm25),
      visibilityM: sourceOfWeather(weather.visibilityM),
      relativeHumidityPercent: sourceOfWeather(weather.relativeHumidityPercent),
      temperatureC: sourceOfWeather(weather.temperatureC),
    },
  };
}

export function mergeDustReading(
  input: DustEngineInput,
  weather: DustWeatherSample,
  sampleTimeIso?: string,
  // خطأ مكتشَف ومُصلَح (طلب صريح من المستخدم — اكتشاف: "قراءة الجهاز تظهر
  // بالساعة 9 رغم أن آخر قراءة فعلية للجهاز قبل 10 ساعات"، والفصل المطلوب:
  // "الشبكة تستخدم API، القراءة الحية تستخدم قراءة الجهاز — افصلهم عن
  // بعض"): كان فحص isDeviceApplicableToSample ("هل هذه الساعة قريبة من
  // الآن؟") يُطبَّق على *كل* ساعة تمر عبر هذه الدالة، بما فيها ساعات شبكة
  // التوقعات المستقبلية (evaluateDustVisibilityHourly/WorkDayHourly، وhourly/
  // bestWindowWorst/avoidWindowWorst داخل evaluateDustVisibilityWindow) — لا
  // فقط القرار الحي (worst). فأي ساعة بشبكة التوقعات تصادف وقوعها ضمن هامش
  // "قريب من الآن" (30 دقيقة/نفس جرس الساعة) كانت تأخذ قراءة الجهاز الثابتة
  // (حتى لو قديمة جداً، عمرها ساعات) بدل تقدير الطقس الصحيح لتلك الساعة
  // تحديداً — يظهر تناقضاً بصرياً (ساعة واحدة "نظيفة" وسط شبكة كلها متطرفة).
  // treatAsForecast=true يفرض تجاهل الجهاز كلياً لهذه الاستدعاءات (شبكة
  // التوقعات تستخدم API دائماً، بلا استثناء "قريب من الآن")، بصرف النظر عن
  // hasDeviceLink/sampleTimeIso. القرار الحي (worst) يبقى المسار الوحيد الذي
  // يمرر treatAsForecast=false (الافتراضي) ليستمر بمنطقه الخاص (الجهاز
  // دائماً، حتى لو قديم، عبر sampleTimeIso=undefined في evaluateDustVisibilityWindow).
  treatAsForecast: boolean = false
): DviMergedReading {
  if (treatAsForecast) {
    return buildWeatherMergedReading(weather);
  }

  // خطأ مكتشَف ومُصلَح (تقرير مستخدم — "التايمر ينتهي ولا يسجّل مخالفة،
  // ويُعاد مع كل تحديث" + "نزول من 350 إلى 150 يسمح بتشغيل اعتيادي بلا
  // قانون 10 دقائق"): كان الفحص |الآن - sampleTimeIso| <= 30 دقيقة. لكن
  // sampleTimeIso (worstTimeIso في evaluateDustVisibilityWindow) هو دائماً
  // توقيت مربوط ببداية الساعة (Open-Meteo hourly، مثال 14:00:00Z) — ليس
  // "الآن" الفعلي. فأي تقييم يقع بعد الدقيقة 30 من نفس الساعة الحالية
  // (مثال: تقييم الساعة 14:45 لعينة توقيتها 14:00) كان يُرفَض خطأً باعتباره
  // "بعيداً عن الآن"، فيسقط القرار لعينة الطقس التقديرية (open-meteo) بدل
  // قراءة الجهاز الحقيقية — رغم أن الساعة 14:00 هي فعلاً الساعة الحالية.
  // نتيجة ذلك: نصف كل ساعة تقريباً (الدقائق 31-59) كان القرار الفعلي مبنياً
  // على تقدير طقس ساعي بدل قراءة الجهاز الحية كل دقيقتين — فمصدر PM10
  // يتذبذب بين 'device' و'weather' بلا أي تغيّر حقيقي في الجهاز نفسه،
  // فيتصفّر عداد "استمرار مؤكَّد" (isConfirmedViolation340 يشترط مصدر
  // device تحديداً) كل ما وقع التقييم بعد الدقيقة 30، ويُبنى قرار الاستئناف
  // على قراءة طقس مختلفة تماماً بدل القراءة الفعلية المستقرة/المتغيرة.
  //
  // خطأ ثانٍ مكتشَف ومُصلَح (تقرير مستخدم — "مشروع باقي له 4 دقايق ولا
  // ياخذ بيانات الجهاز، ياخذ الطقس"): الإصلاح الأول أعلاه (مطابقة جرس
  // الساعة فقط) كسر حالة نشاط سيبدأ خلال دقائق قليلة قبل بداية الساعة
  // القادمة — مثال: "الآن" 14:56، النشاط يبدأ 15:00. windowSamples في
  // evaluateDustVisibilityWindow تستبعد عينة 14:00 (قبل بداية النافذة
  // بأكثر من 30 دقيقة تسامح)، فيصبح worstTimeIso = 15:00:00Z (ساعة مستقبلية
  // بالضبط). فحص "نفس جرس الساعة" وحده يرفض هذي العينة (15:00 > 14:56)
  // رغم أنها تمثّل "خلال دقائق" فعلياً لا ساعة بعيدة — فيسقط لعينة الطقس
  // خطأً لمجرد أن النشاط لم يبدأ بعد رسمياً.
  //
  // الإصلاح: نفس جرس الساعة (يحل مشكلة "بعد الدقيقة 30 من الساعة الحالية")
  // *أو* فارق مطلق قريب (يحل مشكلة "نشاط يبدأ خلال دقائق قليلة من الساعة
  // القادمة") — أيهما تحقق يكفي لاعتبار العينة "الآن" فعلياً. هامش الفارق
  // المطلق يبقى محدوداً (30 دقيقة) حتى لا يمتد لساعات مستقبلية بعيدة فعلاً
  // (تلك تبقى تسقط لعينة الطقس كما هو مطلوب دائماً).
  const ONE_HOUR_MS = 3600000;
  const NEAR_FUTURE_OR_PAST_TOLERANCE_MS = 30 * 60000;
  const isDeviceApplicableToSample =
    sampleTimeIso === undefined
      ? true
      : (() => {
          const sampleMs = new Date(sampleTimeIso).getTime();
          const nowMs = Date.now();
          const isSameHourBucket = sampleMs <= nowMs && nowMs < sampleMs + ONE_HOUR_MS;
          const isNearNow = Math.abs(sampleMs - nowMs) <= NEAR_FUTURE_OR_PAST_TOLERANCE_MS;
          return isSameHourBucket || isNearNow;
        })();

  if (input.hasDeviceLink && isDeviceApplicableToSample) {
    return buildDeviceMergedReading(input);
  }

  return buildWeatherMergedReading(weather);
}

// -------------------------------------------------------------
// خطوة 1 من computeDviResult: قنوات المخاطر الفيزيائية (VR/PR/WTR/DFR) +
// دمجها في externalHazard/internalDustHazard/dviBase. استُخرجت من
// computeDviResult (كانت الخطوة الأولى ضمن 191 سطراً متتالياً) بلا أي
// تغيير سلوكي — نفس الترتيب، نفس الصيغ الحسابية حرفياً.
// -------------------------------------------------------------
function buildRiskChannels(input: DustEngineInput, weather: DustWeatherSample, merged: DviMergedReading) {
  const visibilityM = merged.visibilityM;
  const visibilityKm = visibilityM !== null ? visibilityM / 1000 : null;

  const pm10 = merged.pm10;
  const pm25 = merged.pm25;

  const windSpeedKmh = merged.windSpeedKmh;
  const windGustKmh = merged.windGustKmh ?? windSpeedKmh;
  const effectiveWindKmh =
    windSpeedKmh !== null ? Math.max(windSpeedKmh, 0.85 * (windGustKmh ?? windSpeedKmh)) : null;
  const relativeHumidityPercent = merged.relativeHumidityPercent;
  const temperatureC = merged.temperatureC;

  const VR = visibilityKm !== null ? visibilityRisk(visibilityKm) : 30;
  const pm10R = pm10 !== null ? pm10Risk(pm10) : null;
  const pm25R = pm25 !== null ? pm25Risk(pm25) : null;
  const PR = pm10R !== null || pm25R !== null ? Math.max(pm10R ?? 0, pm25R ?? 0) : 20;
  const WTR = effectiveWindKmh !== null ? windTransportRisk(effectiveWindKmh) : 5;
  const DFR = classifyDustForecastRisk(weather);

  const externalHazard = 0.45 * VR + 0.3 * PR + 0.15 * WTR + 0.1 * DFR;

  const { siteDustGenerationRisk, adjustedSiteDustGenerationRisk } = calculateSiteDustGeneration(
    input.site,
    weather.rainfallLast24hMm
  );
  // isEnclosedDustExempt (راجع تعليق DustEngineInput الكامل في types.ts):
  // محطة خلط مغلقة بصوامع مختومة وفلتر PM10 كفؤ لا تنتج غباراً من الموقع
  // نفسه فعلياً — internalDustHazard يُصفَّر بدل تركه يُحسَب من site.* كأي
  // نشاط عادي.
  const internalDustHazard = input.isEnclosedDustExempt ? 0 : adjustedSiteDustGenerationRisk;

  const dviBase = 0.7 * externalHazard + 0.3 * internalDustHazard;

  return {
    visibilityKm,
    pm10,
    pm25,
    effectiveWindKmh,
    relativeHumidityPercent,
    temperatureC,
    VR,
    PR,
    WTR,
    DFR,
    externalHazard,
    siteDustGenerationRisk,
    adjustedSiteDustGenerationRisk,
    internalDustHazard,
    dviBase,
  };
}

// -------------------------------------------------------------
// خطوة 2 من computeDviResult: الدرجة النهائية (score) والمستوى والقرار
// الأساسي قبل البوابات الإلزامية. نفس صيغة dviActivityRaw/score الأصلية
// حرفياً.
// -------------------------------------------------------------
function computeScoreAndBaseDecision(
  dviBase: number,
  mult: DviMultipliers,
  isEnclosedDustExempt: boolean | undefined,
  regulatoryActivity: RegulatoryDustActivityKey
) {
  // نفس الاستثناء: مضاعفا حساسية النشاط والمستقبِل يُسقَطان لقيمة 1 (بلا
  // أي تضخيم) — النشاط لا يُصدر غباراً فعلياً، فلا معنى لتضخيم تأثير طقس
  // خارجي بحساسية نشاط/قرب مستقبِل لا علاقة لهما بمصدر غبار غير موجود أصلاً.
  const activitySensitivityMultiplier = isEnclosedDustExempt ? 1 : mult.activitySensitivityMultiplier;
  const receptorSensitivityMultiplier = isEnclosedDustExempt ? 1 : mult.receptorSensitivityMultiplier;

  // طلب مستخدم صريح: siteExposureMultiplier حُذف نهائياً — كان ثابتاً 1.0
  // منذ أول commit في المشروع بلا أي حقل أو منطق حساب خلفه إطلاقاً (بخلاف
  // largeExposedArea/drySurface، لم يكن له حتى تعريف نوع)، ولا توجد بيانات
  // "تعرّض موقع" حقيقية غير مستخدَمة يمكن ربطه بها — أي تفسير منطقي له
  // (قرب مستقبِل، حجم موقع) يتداخل مع receptorSensitivityMultiplier/
  // activitySensitivityMultiplier الموجودين فعلاً. الضرب في 1.0 لا يغيّر
  // النتيجة، فحذفه لا أثر رياضي له.
  //
  // طلب مستخدم صريح (نفس الفجوة): mitigationReductionFactor (وحقوله الستة
  // wateringAvailable/stockpilesCovered/speedLimitApplied/wheelWashAvailable/
  // dustScreensAvailable/fieldMonitoringAvailable) حُذف بالكامل أيضاً — قسم
  // "إجراءات التحكم" في DustStep.tsx كان مخفياً بالكامل
  // (SHOW_CONTROL_MEASURES_SECTION=false)، فكانت كل الحقول false ثابتة دائماً
  // ⇒ mitigationScore=0 ⇒ mitigationReductionFactor=1.0 ثابتة (بلا أي تخفيض
  // فعلي) في كل نتيجة موجودة حتى الآن. الحذف بلا أثر رياضي على أي سكور سابق
  // لنفس سبب حذف siteExposureMultiplier أعلاه.
  const dviActivityRaw = dviBase * activitySensitivityMultiplier * receptorSensitivityMultiplier;
  const score = Math.round(Math.min(100, Math.max(0, dviActivityRaw)) * 10) / 10;

  const level = dviLevelFromScore(score);
  const baseDecision = baseDecisionFromLevel(level, regulatoryActivity);

  return { score, level, baseDecision };
}

// -------------------------------------------------------------
// خطوة 3 من computeDviResult: النص القصير المرتبط ديناميكياً بالقرار
// الفعلي، وتنبيهات صحة القراءة (caveatsAr) — نص/عرض بحت، لا يؤثر على
// level/decisionCategory. نفس النص الحرفي الأصلي.
// -------------------------------------------------------------
function buildShortReasonAndCaveats(
  decision: DviDecisionCategory,
  visibilityKm: number | null,
  relativeHumidityPercent: number | null,
  temperatureC: number | null
) {
  // --- ربط النص القصير بالقرار الفعلي ديناميكياً لمنع التناقض ---
  const shortReason =
    decision === 'MANDATORY_STOP'
      ? `إيقاف إلزامي: انخفاض حرج في الرؤية الأفقية الميدانية لمستويات دون الأمان (${visibilityKm?.toFixed(2)} كم).`
      : decision === 'STOP_DUST_GENERATING_ACTIVITIES'
      ? `إيقاف أعمال الغبار: رؤية أفقية حرجة (${visibilityKm?.toFixed(2)} كم) مع نشاط رياح عالٍ وأعمال حفر وتربة مكشوفة.`
      : decision === 'STOP_VISIBILITY_DEPENDENT_ACTIVITIES'
      ? `إيقاف مؤقت: طبيعة هذا النشاط تعتمد كلياً على جودة الرؤية العالية، والظروف الحالية غير ملائمة.`
      : decision === 'RESTRICT_SEVERE'
      ? 'تقييد شديد: تداخل مؤشرات الغبار والرياح بشكل يتطلب خفض العمليات الميدانية لأدنى مستوياتها.'
      : decision === 'RESTRICT'
      ? 'تقييد العمل: وجود فجوة في إجراءات التحكم الميدانية (مثل غياب رش المياه أو مصدات الغبار).'
      : decision === 'ALLOW_WITH_MONITORING'
      ? 'تشغيل مع المراقبة: رصد ارتفاع طفيف في الجسيمات العالقة أو اقتراب هبات الرياح من حافة التقييد.'
      : 'بيئة تشغيلية آمنة: الرؤية الأفقية ممتازة ومؤشرات الغبار تقع بالكامل ضمن النطاق المسموح للنشاط.';

  // ملاحظات تحذيرية لصحة القراءة نفسها — طلب صريح من المستخدم بالنص الحرفي.
  // لا تُغيّر level/decisionCategory/shortReason إطلاقاً ("لا تُلغى القراءة
  // أو التجاوز")، فقط تُضاف كتنبيهات منفصلة. تُقرأ من القيمة المدموجة
  // (قد تأتي من الجهاز) لا من weather الخام مباشرة، حتى يعكس التحذير
  // القراءة الفعلية التي حدَّدت القرار.
  const caveatsAr: string[] = [];
  if (relativeHumidityPercent !== null && relativeHumidityPercent >= 80) {
    caveatsAr.push(
      'الرطوبة مرتفعة وقد تؤثر في بعض حساسات الجسيمات البصرية؛ لا تُلغى القراءة أو التجاوز، ويلزم التحقق وفق إجراءات الجودة.'
    );
  }
  if (temperatureC !== null && temperatureC >= 50) {
    caveatsAr.push(
      'درجة الحرارة عند أو فوق 50°م؛ تحقّق من أن جهاز PM10 مصنف للعمل في هذه الدرجة. لا يُلغى التجاوز تلقائياً.'
    );
  }

  return { shortReason, caveatsAr };
}

// -------------------------------------------------------------
// الحساب الأساسي وحل التناقضات اللفظية
// -------------------------------------------------------------
export function computeDviResult(
  input: DustEngineInput,
  weather: DustWeatherSample,
  sampleTimeIso?: string,
  // راجع تعليق treatAsForecast الكامل في mergeDustReading أعلاه — يُمرَّر
  // كما هو لضمان أن شبكة التوقعات لا تستخدم الجهاز إطلاقاً حتى في حساب DVI
  // نفسه (لا فقط في mergedReading المعروض)، والقرار الحي يبقى بمنطقه الخاص.
  treatAsForecast: boolean = false
): DviEvaluationResult {
  const merged = mergeDustReading(input, weather, sampleTimeIso, treatAsForecast);
  const risk = buildRiskChannels(input, weather, merged);

  const mult = calculateMultipliers(input.site, input.regulatoryActivity);
  const { score, level, baseDecision } = computeScoreAndBaseDecision(
    risk.dviBase,
    mult,
    input.isEnclosedDustExempt,
    input.regulatoryActivity
  );

  const gates = applyMandatoryGates(
    input,
    risk.visibilityKm,
    risk.pm10,
    risk.DFR,
    weather.weatherSymbol,
    baseDecision
  );

  const siteDataProvided = hasMeaningfulSiteData(input.site);
  const cause = classifyCause(weather, risk.pm10);
  const { drivers, reducers } = buildRiskDriversAndReducers(input, risk.visibilityKm, risk.pm10, risk.effectiveWindKmh, cause, siteDataProvided);
  const requiredActions = Array.from(new Set([...baseRequiredActions(gates.decision), ...gates.extraActions]));
  const confidenceScore = calculateConfidence(merged, weather, siteDataProvided);

  const dustExposureHigh = cause === 'DUST' && score >= 45;
  const outdoorWorkRestriction =
    gates.decision === 'MANDATORY_STOP' ||
    gates.decision === 'STOP_DUST_GENERATING_ACTIVITIES' ||
    gates.decision === 'STOP_VISIBILITY_DEPENDENT_ACTIVITIES' ||
    gates.decision === 'RESTRICT_SEVERE';

  const { shortReason, caveatsAr } = buildShortReasonAndCaveats(
    gates.decision,
    risk.visibilityKm,
    risk.relativeHumidityPercent,
    risk.temperatureC
  );

  // خطأ مكتشَف ومُصلَح (مراجعة كود خبير خارجي — "التوقف الإلزامي يمكن أن
  // يكون قابلاً للتجاوز"): كان شرط overridable في النتيجة النهائية يقصر
  // المنع على decision === 'MANDATORY_STOP' تحديداً — لكن applyMandatoryGates
  // أعلاه كان يضبط mandatoryStop=true من فروع أخرى أيضاً (DVI-DUST-ACTIVITY-
  // STOP-004 وDVI-WIND-LOOSE-MATERIAL-005، كلاهما محذوف بالكامل الآن) بلا
  // ضبط overridable=false فيها — تعتمد على أن overridable يبدأ true ولا
  // يُغيَّر، فتصل نتيجة متناقضة منطقياً (mandatoryStop=true وoverridable=
  // true معاً) لمستهلكين فعليين (Dustwidgetcard.tsx: بانر "توصية إلزامية"
  // لا يظهر رغم إيقاف فعلي). الإصلاح: القاعدة الآن مطلقة بلا استثناء لأي
  // قرار — mandatoryStop=true يفرض overridable=false دائماً، بصرف النظر عن
  // أي فرع ضبطه لاحقاً أو نسيه (بما في ذلك أي قاعدة مستقبلية جديدة تُضاف).
  // assertMandatoryStopInvariant يفرض هذا كـinvariant وقت التشغيل أيضاً، لا
  // الاعتماد على التزام كل فرع مستقبلي في applyMandatoryGates بهذا الشرط يدوياً.
  const finalMandatoryStop = gates.mandatoryStop;
  const finalOverridable = !gates.mandatoryStop && gates.overridable;
  assertMandatoryStopInvariant({ mandatoryStop: finalMandatoryStop, overridable: finalOverridable });
  const { stopBasis, confirmationState } = deriveStopBasisAndConfirmation(finalMandatoryStop, gates.triggeredRules);

  return {
    indicatorType: 'DVI',
    dviBase: Math.round(risk.dviBase * 10) / 10,
    score,
    level,
    causeClassification: cause,

    decisionCategory: gates.decision,
    decisionLabelAr: DVI_DECISION_LABEL_AR[gates.decision] ?? gates.decision,
    mandatoryStop: finalMandatoryStop,
    overridable: finalOverridable,
    stopBasis,
    confirmationState,

    channels: {
      visibilityRisk: risk.VR,
      particulateRisk: risk.PR,
      windTransportRisk: risk.WTR,
      dustForecastRisk: risk.DFR,
      siteDustGenerationRisk: Math.round(risk.siteDustGenerationRisk * 10) / 10,
      adjustedSiteDustGenerationRisk: Math.round(risk.adjustedSiteDustGenerationRisk * 10) / 10,
      externalHazard: Math.round(risk.externalHazard * 10) / 10,
      internalDustHazard: Math.round(risk.internalDustHazard * 10) / 10,
    },
    multipliers: mult,

    visibilityKm: risk.visibilityKm,
    effectiveWindKmh: risk.effectiveWindKmh,

    // راجع تعليق visibilityDataMissing الكامل في types.ts. hasDeviceLink
    // يحصر هذا العلم على مسار الجهاز الحي فقط — طقس تقديري (hasDeviceLink=
    // false) لا "يفتقد" قراءة رؤية بنفس المعنى، فيبقى false دائماً هناك.
    visibilityDataMissing: input.hasDeviceLink && risk.visibilityKm === null,

    visibilityConstraint: risk.visibilityKm !== null && risk.visibilityKm < getRuleParameters().VISIBILITY_RESTRICT_SEVERE_KM,
    mandatoryVisibilityStop: risk.visibilityKm !== null && risk.visibilityKm < getRuleParameters().VISIBILITY_MANDATORY_STOP_KM,
    respiratoryPPERequired: risk.PR >= 45 || dustExposureHigh,
    dustExposureHigh,
    outdoorWorkRestriction,

    triggeredRules: gates.triggeredRules,
    requiredActions,
    shortReason,
    topRiskDrivers: drivers,
    riskReducers: reducers,
    caveatsAr,

    confidenceScore,
    confidenceLabel: toConfidenceLabel(confidenceScore),

    validUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  };
}

export async function evaluateDustVisibility(input: DustEngineInput): Promise<DviEvaluationResult> {
  const weather = await fetchDustWeather(input.latitude, input.longitude);
  return computeDviResult(input, weather);
}

// =============================================================
// evaluateLiveOperationalDecision — القسم 9.2 من "دليل الإصلاح الجذري
// لمنظومة مرقاب": دالة نقية بالكامل (Pure، بلا fetch إطلاقاً) تبني القرار
// الحي حصراً من لقطة جهاز واحدة (input.device*) — لا تستورد weather.ts ولا
// تستدعي Open-Meteo بأي حال، بخلاف evaluateDustVisibilityWindow التي تبقى
// تجلب توقعات الشبكة (hourly/bestWindow) لأغراض التخطيط.
//
// نشاط بلا جهاز مرتبط (hasDeviceLink=false) لا يملك "قرار حي" فعلياً —
// نفس منطق buildAwaitingEvaluationWindow أعلاه (fallback محايد "بانتظار
// تقييم"). القرار الحي الحقيقي دائماً من input.device* مباشرة، بصرف النظر
// عن قِدم القراءة (القِدم مسؤولية طبقة جودة الأدلة في محرك القرار النهائي،
// لا هذه الدالة — راجع evidenceQuality في final-decision-engine/adapters.ts).
// =============================================================
export function evaluateLiveOperationalDecision(input: DustEngineInput): DviHourlyEvaluation {
  const nowIso = new Date().toISOString();

  if (!input.hasDeviceLink) {
    const awaiting = buildAwaitingEvaluationWindow(nowIso, Date.now(), 1);
    return awaiting.worst;
  }

  const neutralWeatherSample: DustWeatherSample = {
    visibilityM: null,
    weatherCode: null,
    weatherSymbol: 'UNKNOWN',
    windSpeedKmh: null,
    windGustKmh: null,
    windDirectionDeg: null,
    relativeHumidityPercent: null,
    temperatureC: null,
    rainfallLast24hMm: null,
    pm10: null,
    pm25: null,
    dustConcentration: null,
    dataSource: 'none',
    isForecastStale: true,
  };

  // sampleTimeIso=undefined يفرض مسار الجهاز دائماً (buildDeviceMergedReading)
  // في mergeDustReading — بلا أي فحص "قريب من الآن"، بلا أي مكالمة شبكة.
  return {
    ...computeDviResult(input, neutralWeatherSample, undefined),
    time: nowIso,
    rawWeatherSample: neutralWeatherSample,
    mergedReading: mergeDustReading(input, neutralWeatherSample, undefined),
  };
}

export async function evaluateDustVisibilityHourly(
  input: DustEngineInput,
  hoursAhead: number = 24
): Promise<DviHourlyEvaluation[]> {
  const samples = await fetchDustWeatherHourly(input.latitude, input.longitude, hoursAhead);
  // treatAsForecast=true: شبكة توقعات مستقبلية بحتة — تستخدم تقدير الطقس
  // دائماً لكل ساعة، بلا أي تدخل من الجهاز حتى لو صادفت ساعة معينة وقوعها
  // قريبة من "الآن" (راجع تعليق treatAsForecast الكامل في mergeDustReading).
  return samples.map((sample) => ({
    ...computeDviResult(input, sample, sample.time, true),
    time: sample.time,
    rawWeatherSample: sample,
    mergedReading: mergeDustReading(input, sample, sample.time, true),
  }));
}

// -------------------------------------------------------------
// تقييم ساعي عبر كامل ساعات دوام المشروع لليوم الحالي (وليس فقط نافذة
// النشاط المجدولة) — نفس مفهوم evaluateHeatStressWorkDayHourly في محرك
// الحرارة، يجيب على "هل أقدر أشتغل فيها؟" لكل ساعة دوام.
// -------------------------------------------------------------
export async function evaluateDustVisibilityWorkDayHourly(
  input: DustEngineInput,
  // وقت بداية النشاط المجدول (ISO UTC) — إن مُرِّر، تُبنى شبكة "توقعات
  // الساعات القادمة" لنافذة دوام *يوم النشاط* تحديداً (planned_date)، لا
  // ليوم فتح الصفحة. بلا هذا، نشاط مجدول لبكرة/بعد يومين كان يعرض توقعات
  // اليوم الحالي (خطأ)، أو خانة واحدة يتيمة لو فُتحت الصفحة بعد انتهاء دوام
  // اليوم. غيابه يُبقي السلوك الافتراضي: نافذة دوام "اليوم" مع الانتقال
  // للغد إذا انتهت.
  activityStartIso?: string
): Promise<DviHourlyEvaluation[]> {
  const nowMs = Date.now();
  // مرجع اليوم: يوم النشاط المجدول إن توفّر، وإلا "اليوم" الحالي. بتوقيت
  // الرياض لا UTC: في الساعات المبكرة من صباح الرياض (00:00-02:59) يكون
  // تاريخ UTC هو اليوم السابق، فيُحسب يوم العمل ونافذته للتاريخ الخطأ.
  // نزيح +3 ساعات قبل أخذ التاريخ.
  const anchorMs = activityStartIso ? new Date(activityStartIso).getTime() : nowMs;
  const dateStr = new Date(anchorMs + 3 * 3600000).toISOString().slice(0, 10);

  // أفق الجلب يجب أن يصل ليوم النشاط كاملاً حتى لو كان مستقبلياً — نجلب من
  // "الآن" حتى نهاية دوام يوم النشاط + هامش، بحد أدنى 36 ساعة.
  // work_hours قد تأتي من قاعدة البيانات بصيغة 'HH:MM:SS' (عمود Postgres
  // time) — نقتطعها إلى 'HH:MM' وإلا ينتج نص تاريخ فاسد (…T07:00:00:00+03:00)
  // فيصبح startMs/endMs = NaN، فيرمي الفلتر كل العينات وترجع الشبكة فارغة
  // (وتسقط للاحتياطي = نافذة النشاط بدل كامل الدوام). هذا كان سبب ظهور ساعة
  // واحدة/ساعات النشاط فقط بدل كامل دوام المشروع.
  const workHoursStart = (input.workHoursStart || '06:00').slice(0, 5);
  const workHoursEnd = (input.workHoursEnd || '18:00').slice(0, 5);
  let startMs = new Date(`${dateStr}T${workHoursStart}:00+03:00`).getTime();
  let endMs = new Date(`${dateStr}T${workHoursEnd}:00+03:00`).getTime();
  if (endMs <= startMs) endMs += 24 * 3600000;

  // إن لم يُمرَّر يوم نشاط صريح، ونافذة دوام اليوم انتهت فعلياً، ننتقل
  // لنافذة الغد بنفس التوقيتين — وإلا تعرض الشبكة فراغاً كل مساء بعد انتهاء
  // الدوام رغم توفر توقعات الغد.
  if (!activityStartIso && nowMs > endMs) {
    startMs += 24 * 3600000;
    endMs += 24 * 3600000;
  }

  // مرجع الجلب: بداية دوام *يوم النشاط* إن مُرِّر يوم صريح — بلا هذا كانت
  // fetchDustWeatherHourly تبدأ دائماً من "الآن" وتجلب طقس اليوم الحالي، ثم
  // يرمي فلتر workDaySamples أدناه كل العينات لأنها لا تطابق يوم النشاط،
  // فترجع الشبكة فارغة وتسقط للاحتياطي (نافذة النشاط = ساعة واحدة). نفس
  // إصلاح anchorIso المُطبَّق أصلاً في evaluateDustVisibilityWindow. بلا يوم
  // صريح نبقى على السلوك القديم (يبدأ من الآن) لتغطية بقية دوام اليوم.
  const anchorIso = activityStartIso ? new Date(startMs).toISOString() : undefined;
  const fetchFromMs = anchorIso ? startMs : nowMs;
  const horizonHours = Math.max(36, Math.ceil((endMs - fetchFromMs) / 3600000) + 2);
  const samples = await fetchDustWeatherHourly(input.latitude, input.longitude, horizonHours, anchorIso);
  if (samples.length === 0) return [];

  const workDaySamples = samples.filter((s) => {
    const t = new Date(s.time).getTime();
    return t >= startMs && t <= endMs;
  });
  if (workDaySamples.length === 0) return [];

  // treatAsForecast=true: نفس سبب evaluateDustVisibilityHourly أعلاه — شبكة
  // توقعات ساعات الدوام بأكملها تستخدم تقدير الطقس دائماً، بلا استثناء
  // "الساعة القريبة من الآن" الذي كان يُدخل قراءة الجهاز الثابتة (حتى لو
  // قديمة جداً) في ساعة واحدة عشوائية وسط الشبكة.
  return workDaySamples.map((sample) => ({
    ...computeDviResult(input, sample, sample.time, true),
    time: sample.time,
    rawWeatherSample: sample,
    mergedReading: mergeDustReading(input, sample, sample.time, true),
  }));
}

const DVI_LEVEL_RANK: Record<DviLevel, number> = { GREEN: 0, YELLOW: 1, ORANGE: 2, RED: 3, DARK_RED: 4, BLACK: 5 };
function severityRank(r: DviEvaluationResult): number {
  return (r.mandatoryStop ? 100000 : 0) + DVI_LEVEL_RANK[r.level] * 1000 + r.score;
}

// خطأ مكتشَف ومُصلَح (مراجعة كود خبير خارجي — "أسوأ حالة عينة تركيبية لم
// تحدث"): كانت aggregateWorstCaseSample تبني DustWeatherSample اصطناعياً
// بانتقاء أقل رؤية من ساعة، أعلى PM10 من ساعة ثانية، أعلى رياح من ساعة
// ثالثة، ثم إعادة تشغيل computeDviResult على هذا المزيج — توليفة لم تحدث
// فعلياً بأي لحظة واحدة، تُعرَض مع ذلك كـ"القرار الممثل للنشاط بأكمله"
// (windowEval.worst، راجع DustWindowEvaluation في types.ts). الحل: نختار
// أسوأ *ساعة فعلية كاملة* واحدة (كل قيمها من نفس اللحظة) بالاعتماد على
// severityRank الموجودة أصلاً، بدل تركيب عينة لم تحدث. لا سقوط صامت لأول
// ساعات خارج النافذة عند غياب البيانات — الخطأ المرمي هنا يُعامَل من طبقة
// dustEvaluation.ts (استدعاء داخل try/catch لكل نشاط على حدة، راجع computeDustResults)
// كـ"تعذّر تقييم هذا النشاط" فيُستبعد من النتائج، لا يظهر بقرار مُلفَّق.
function pickWorstActualHour(hours: readonly DviHourlyEvaluation[]): DviHourlyEvaluation {
  if (hours.length === 0) {
    throw new Error('DATA_UNAVAILABLE: لا توجد ساعة طقس فعلية ضمن نافذة النشاط لتقييمها.');
  }
  return hours.reduce((worst, current) => (severityRank(current) > severityRank(worst) ? current : worst));
}

// خطأ أمني/معماري مكتشَف ومُصلَح (طلب صريح من المستخدم — "لا تجعل API
// الطقس يحضر القراءة حق ساعة النشاط، دايماً اجعله يحتاج قراءة حقيقية من
// الجهاز" + "امنع API كلياً لو ما فيه جهاز، حتى لا يُستدعى إطلاقاً"): كان
// evaluateDustVisibilityWindow يستدعي fetchDustWeatherHourly (Open-Meteo)
// دائماً بصرف النظر عن input.hasDeviceLink — فنشاط بلا جهاز رصد مرتبط
// أصلاً كان يُقيَّم بالكامل (DVI score/decisionCategory/mandatoryStop) على
// تقدير طقس بديل، ثم evidenceQuality=UNAVAILABLE تُصحّح فقط طبقة القرار
// النهائي (decideFinal→HOLD_FOR_VERIFICATION) فوق نتيجة DVI محسوبة أصلاً
// من ذلك التقدير — لا يمنع الاستدعاء نفسه ولا يمنع تسرّب أرقام تقديرية
// (PM10/رياح/رؤية) للواجهة عبر rawWeatherSample/mergedReading قبل تطبيق
// تلك الطبقة. الإصلاح: نشاط بلا جهاز لا يُستدعى له API الطقس إطلاقاً —
// نتيجة ثابتة محايدة "بانتظار تقييم" تُرجَع مباشرة، بلا أي شبكة توقعات
// (hourly/bestWindowWorst/avoidWindowWorst فارغة أيضاً، إذ لا بيانات حية
// أصلاً لبنائها لهذا النوع من الأنشطة). نشاط مرتبط بجهاز (hasDeviceLink=
// true) غير متأثر إطلاقاً — يستمر لاستدعاء Open-Meteo كالمعتاد (يحتاجه
// أصلاً لملء الحقول التي لا يرسلها الجهاز، وللساعات المستقبلية التي لا
// يملك الجهاز بيانات عنها، راجع mergeDustReading/isDeviceApplicableToSample).
function buildAwaitingEvaluationWindow(windowStartIso: string, endMs: number, safeDuration: number): DustWindowEvaluation {
  const neutralMergedReading: DviMergedReading = {
    windSpeedKmh: null,
    windGustKmh: null,
    windDirectionDeg: null,
    pm10: null,
    pm25: null,
    visibilityM: null,
    relativeHumidityPercent: null,
    temperatureC: null,
    deviceLastReadingAt: undefined as unknown as string | null, // يبقى undefined فعلياً (راجع الحذف أدناه)
    devicePm10LastReadingAt: undefined as unknown as string | null,
    sources: {
      windSpeedKmh: 'none',
      windGustKmh: 'none',
      windDirectionDeg: 'none',
      pm10: 'none',
      pm25: 'none',
      visibilityM: 'none',
      relativeHumidityPercent: 'none',
      temperatureC: 'none',
    },
  };
  // حذف صريح (لا مجرد undefined مبدئي): deviceLastReadingAt===undefined هو
  // الإشارة الفعلية التي يقرأها deriveEvidenceQuality (final-decision-engine/
  // adapters.ts) لتصنيف "لا جهاز مرتبط أصلاً" → UNAVAILABLE → HOLD_FOR_
  // VERIFICATION. null هنا كان سيعني خطأً "جهاز مرتبط لكن بلا قراءة بعد".
  delete (neutralMergedReading as Partial<DviMergedReading>).deviceLastReadingAt;
  delete (neutralMergedReading as Partial<DviMergedReading>).devicePm10LastReadingAt;

  const neutralDvi: DviEvaluationResult = {
    indicatorType: 'DVI',
    dviBase: 0,
    score: 0,
    level: 'GREEN',
    causeClassification: 'UNKNOWN',
    decisionCategory: 'ALLOW',
    decisionLabelAr: 'بانتظار تقييم — لا جهاز رصد مرتبط بهذا النشاط',
    mandatoryStop: false,
    overridable: true,
    stopBasis: 'NONE',
    confirmationState: 'NOT_APPLICABLE',
    channels: {
      visibilityRisk: 0,
      particulateRisk: 0,
      windTransportRisk: 0,
      dustForecastRisk: 0,
      siteDustGenerationRisk: 0,
      adjustedSiteDustGenerationRisk: 0,
      externalHazard: 0,
      internalDustHazard: 0,
    } as DviRiskChannels,
    multipliers: {
      activitySensitivity: 0,
      activitySensitivityMultiplier: 0,
      receptorSensitivity: 0,
      downwindAlignment: 0,
      distanceFactor: 0,
      receptorImpact: 0,
      receptorSensitivityMultiplier: 0,
    } as DviMultipliers,
    visibilityKm: null,
    effectiveWindKmh: null,
    // لا جهاز مرتبط أصلاً هنا (راجع تعليق الدالة أعلاه) — visibilityDataMissing
    // مخصَّص لحالة "جهاز مرتبط لكن قراءة الرؤية تحديداً غائبة" فقط، فيبقى
    // false. evidenceQuality=UNAVAILABLE (عبر deviceLastReadingAt المحذوف
    // أعلاه) يكفي لمنع أي قرار واثق هنا أصلاً.
    visibilityDataMissing: false,
    visibilityConstraint: false,
    mandatoryVisibilityStop: false,
    respiratoryPPERequired: false,
    dustExposureHigh: false,
    outdoorWorkRestriction: false,
    triggeredRules: [],
    requiredActions: [],
    shortReason: 'بانتظار تقييم: لا يوجد جهاز رصد مرتبط بهذا النشاط — لا يُعتمَد على تقدير طقس بديل لقرار حي.',
    topRiskDrivers: [],
    riskReducers: [],
    caveatsAr: [],
    confidenceScore: 0,
    confidenceLabel: 'غير متاحة',
    validUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  };

  const worst: DviHourlyEvaluation = {
    ...neutralDvi,
    time: windowStartIso,
    rawWeatherSample: {
      visibilityM: null,
      weatherCode: null,
      weatherSymbol: 'UNKNOWN',
      windSpeedKmh: null,
      windGustKmh: null,
      windDirectionDeg: null,
      relativeHumidityPercent: null,
      temperatureC: null,
      rainfallLast24hMm: null,
      pm10: null,
      pm25: null,
      dustConcentration: null,
      dataSource: 'none',
      isForecastStale: true,
    },
    mergedReading: neutralMergedReading,
  };

  return {
    worst,
    hourly: [],
    windowStartIso,
    windowEndIso: new Date(endMs).toISOString(),
    durationHours: safeDuration,
    bestWindowStartIso: null,
    bestWindowWorst: null,
    avoidWindowStartIso: null,
    avoidWindowWorst: null,
  };
}

// نشاط ضمن هامش ساعتين من بدايته المجدولة (بدأ فعلاً، أو سيبدأ قريباً) —
// "جهاز الرصد يتفعّل قبل ساعتين من بداية النشاط" (طلب صريح موثَّق أدناه في
// isActivityLiveNow/buildAwaitingEvaluationWindow). ثابت وحدة واحد بدل تكرار
// نفس الرقم 120*60000 محلياً في ثلاثة مواضع مختلفة داخل هذا الملف.
const ACTIVITY_LIVE_MARGIN_MS_ENGINE = 120 * 60000;

// راجع تعليق weatherTimeoutMs الكامل داخل evaluateDustVisibilityWindow —
// مهلة مختصرة لطلب Open-Meteo حصراً لنشاط حي بجهاز مرتبط (القرار الحي لا
// يعتمد على نتيجتها أصلاً)، بدل المهلة الكاملة الطبيعية (FETCH_TIMEOUT_MS
// في weather.ts) التي تبقى مطبَّقة لأي نشاط توقّعي بحت.
const LIVE_WEATHER_TIMEOUT_MS = 3000;

// -------------------------------------------------------------
// المنسق الرئيسي للنافذة الزمنية بعد حل مشكلة التاريخ المجدول المستقبلي
// -------------------------------------------------------------
export async function evaluateDustVisibilityWindow(
  input: DustEngineInput,
  windowStartIso: string,
  durationHours: number
): Promise<DustWindowEvaluation> {
  const safeDuration = Math.max(1, Math.round(durationHours));
  const startMs = new Date(windowStartIso).getTime();
  const endMs = startMs + safeDuration * 3600000;
  const nowMs = Date.now();

  // بوابة أمنية/معمارية: لا استدعاء لـfetchDustWeatherHourly (Open-Meteo)
  // إطلاقاً لنشاط بلا جهاز رصد مرتبط — راجع الشرح الكامل أعلى
  // buildAwaitingEvaluationWindow.
  if (!input.hasDeviceLink) {
    return buildAwaitingEvaluationWindow(windowStartIso, endMs, safeDuration);
  }

  const hoursFromNowToWindowEnd = Math.max(0, Math.ceil((endMs - nowMs) / 3600000));
  const horizonHours = Math.max(hoursFromNowToWindowEnd + 6, safeDuration + 24, 24);

  // خطأ تشغيلي مكتشَف — مراجعة كود خبير خارجي: "المسار التشغيلي الحي ما
  // زال ينتظر Open-Meteo وقد يفشل عند بيانات غير متطابقة زمنياً". لنشاط حي
  // بجهاز مرتبط (نفس شرط isActivityLiveNow أدناه، محسوب مبكراً هنا قبل جلب
  // الشبكة)، worst (القرار الحي الفعلي) سيُعاد بناؤه لاحقاً من قراءة الجهاز
  // مباشرة بصرف النظر عن نتيجة هذا الطلب (راجع mergeDustReading/
  // isDeviceApplicableToSample — sampleTimeIso=undefined يفرض مسار الجهاز
  // دائماً) — فلا مبرر لانتظار مهلة الشبكة الكاملة (حتى ~14 ثانية مع إعادة
  // المحاولة) قبل الوصول لتلك النتيجة. مهلة مختصرة هنا (3 ثوانٍ، محاولة
  // واحدة فعلياً ضمنها) تكفي لالتقاط استجابة سريعة إن وُجدت (تُفيد hourly/
  // bestWindowWorst فقط)، بلا حجب القرار الحي طويلاً عند بطء/فشل الشبكة.
  // نشاط غير حي الآن (توقّع مستقبلي بحت) يبقى بالمهلة الكاملة الطبيعية —
  // hourly هنا هي مصدر worst الوحيد فعلياً لتلك الحالة (راجع pickWorstActualHour
  // أدناه)، فتقصير مهلتها كان سيُفقد دقة القرار التوقّعي بلا أي فائدة مقابلة.
  const isLiveNow = nowMs >= startMs - ACTIVITY_LIVE_MARGIN_MS_ENGINE;
  const weatherTimeoutMs = isLiveNow ? LIVE_WEATHER_TIMEOUT_MS : undefined;

  // تعديل حاسم: تم تمرير windowStartIso كـ anchorIso لمنع تكرار بيانات التنبؤ عند اختلاف التواريخ المستقبلية
  const allSamples = await fetchDustWeatherHourly(input.latitude, input.longitude, horizonHours, windowStartIso, weatherTimeoutMs);

  // فشل جلب توقع الطقس (بعد stale-cache fallback في weather.ts) لا يجوز أن
  // يُسقط تقييم النشاط بالكامل — خطأ مكتشَف (تجربة مستخدم سيئة جداً: كل
  // تفاصيل النشاط تختفي فجأة من الواجهة لمجرد انقطاع عابر بخدمة خارجية).
  // نشاط مرتبط بجهاز حي (hasDeviceLink) يواصل هنا ببناء worst من قراءة
  // الجهاز مباشرة أدناه (لا يعتمد فعلياً على allHourlyEvaluations، راجع
  // isActivityLiveNow أدناه) — القرار الحي يبقى صحيحاً رغم غياب شبكة
  // التوقعات المستقبلية (hourly/bestWindowWorst/avoidWindowWorst فقط
  // ستكون فارغة مؤقتاً). نشاط بلا جهاز، أو لم يبدأ بعد، يرجع نافذة محايدة
  // "بانتظار تقييم" بدل استثناء يسقط النشاط كاملاً.
  if (allSamples.length === 0) {
    if (!input.hasDeviceLink || nowMs < startMs - ACTIVITY_LIVE_MARGIN_MS_ENGINE) {
      return buildAwaitingEvaluationWindow(windowStartIso, endMs, safeDuration);
    }

    // نشاط بجهاز حي بدأ فعلاً/قارب على البدء، وفشل جلب توقع الطقس تماماً
    // (لا نسخة قديمة أيضاً بـweather.ts) — نبني worst مباشرة من قراءة
    // الجهاز الحية. neutralWeatherSample محايد بالكامل (كل الحقول null)؛
    // computeDviResult/mergeDustReading يتجاهلانه فعلياً هنا لأن
    // input.hasDeviceLink && sampleTimeIso===undefined يفرض مسار الجهاز
    // (buildDeviceMergedReading) قبل أي لمس لحقول weather — راجع
    // isDeviceApplicableToSample في mergeDustReading. hourly/bestWindowWorst/
    // avoidWindowWorst تبقى فارغة مؤقتاً (لا بيانات طقس مستقبلية متاحة)، لكن
    // القرار الحي الفعلي يبقى صحيحاً ومبنياً على PM10 الحقيقي بدل إسقاط
    // النشاط بالكامل.
    const neutralWeatherSample: DustWeatherSample = {
      visibilityM: null,
      weatherCode: null,
      weatherSymbol: 'UNKNOWN',
      windSpeedKmh: null,
      windGustKmh: null,
      windDirectionDeg: null,
      relativeHumidityPercent: null,
      temperatureC: null,
      rainfallLast24hMm: null,
      pm10: null,
      pm25: null,
      dustConcentration: null,
      dataSource: 'none',
      isForecastStale: true,
    };
    const liveWorst: DviHourlyEvaluation = {
      ...computeDviResult(input, neutralWeatherSample, undefined),
      time: windowStartIso,
      rawWeatherSample: neutralWeatherSample,
      mergedReading: mergeDustReading(input, neutralWeatherSample, undefined),
    };
    return {
      worst: liveWorst,
      hourly: [],
      windowStartIso: new Date(startMs).toISOString(),
      windowEndIso: new Date(endMs).toISOString(),
      durationHours: safeDuration,
      bestWindowStartIso: null,
      bestWindowWorst: null,
      avoidWindowStartIso: null,
      avoidWindowWorst: null,
    };
  }

  // treatAsForecast=true: هذه المصفوفة تبني hourly/bestWindowWorst/
  // avoidWindowWorst (شبكة توقعات بحتة) — يجب أن تستخدم تقدير الطقس دائماً
  // لكل ساعة، بلا استثناء "قريب من الآن" الذي كان يُدخل قراءة الجهاز الثابتة
  // (حتى لو قديمة جداً) في ساعة عشوائية وسط الشبكة. worst (القرار الحي)
  // يُعاد بناؤه بمنطقه الخاص أدناه (treatAsForecast=false، الجهاز دائماً)
  // بعد اختياره من windowHours — لا علاقة له بهذه المصفوفة الأولية.
  const allHourlyEvaluations: DviHourlyEvaluation[] = allSamples.map((sample) => ({
    ...computeDviResult(input, sample, sample.time, true),
    time: sample.time,
    rawWeatherSample: sample,
    mergedReading: mergeDustReading(input, sample, sample.time, true),
  }));

  const windowHours = allHourlyEvaluations.filter((h) => {
    const t = new Date(h.time).getTime();
    return t >= startMs - 1800000 && t < endMs;
  });

  // لا سقوط صامت لأول ساعات خارج النافذة عند غياب مطابقة فعلية (مراجعة كود
  // خبير خارجي) — إن لم توجد أي ساعة حقيقية ضمن نافذة النشاط المجدولة رغم
  // أفق الجلب المحسوب مسبقاً ليغطيها (horizonHours أعلاه)، فهذه حالة بيانات
  // غير متاحة فعلياً (DATA_UNAVAILABLE عبر pickWorstActualHour)، لا تقريب
  // بساعات "الآن" التي قد تسبق النافذة الفعلية بساعات/أيام.
  let worst = pickWorstActualHour(windowHours);

  // خطأ مكتشَف ومُصلَح (طلب صريح من المستخدم — "لو جهاز حقيقي اعرضها حتى
  // لو قراءاه قديمه"، ثم تصحيح إضافي: "نشاط بجهاز = worst دائماً قراءة
  // الجهاز الحالية"): worst هي "القرار الممثل للنشاط بأكمله" المعروض في كل
  // الواجهة (تصميم متعمَّد سابق، راجع DustWindowEvaluation.worst في
  // types.ts) — لنشاط مرتبط بجهاز *بدأ فعلياً أو قارب على البدء*، هذا
  // القرار يجب أن يعكس قراءة الجهاز الحالية دائماً (حتى لو قديمة)، بلا أي
  // فولباك للطقس.
  //
  // لكن (طلب صريح إضافي — "المشروع يبدأ بعد يوم، توقعات ولا قراءة الجهاز؟"):
  // قراءة الجهاز "الآن" لا تمثّل شيئاً عن ظروف نشاط لم يبدأ بعد فعلياً (قد
  // يبدأ بعد ساعات/يوم) — عرضها حينها كقرار حاسم يعني نسب حالة موقع الآن
  // (رياح/PM10 هذه اللحظة) لنشاط سيبدأ بموقع/زمن مختلف كلياً، وهو خطأ من
  // نفس نوع "استخدام تقدير غير ذي صلة كأنه حقيقة". الحد الفاصل (طلب صريح
  // لاحق: كان 30 دقيقة، أصبح ساعتان — "جهاز الرصد يتفعّل قبل ساعتين من بداية
  // النشاط"): نشاط ضمن هامش ساعتين من بدايته المجدولة (بدأ فعلاً، أو سيبدأ
  // قريباً) يُعامَل كـ"الآن" فيفرض قراءة الجهاز؛ نشاط أبعد من ذلك زمنياً يبقى
  // بمنطقه التوقّعي الطبيعي (worst من pickWorstActualHour أعلاه، مبني
  // بـtreatAsForecast عبر allHourlyEvaluations — تقدير طقس صرف، لا قراءة
  // جهاز مقحَمة). الانتقال فوري بمجرد عبور الحد — لا منطقة رمادية/تدرّج.
  // isLiveNow محسوبة مبكراً أعلاه (نفس القيمة بالضبط — nowMs/startMs
  // ثابتان طوال الدالة) لتحديد weatherTimeoutMs قبل جلب الشبكة؛ يُعاد
  // استخدامها هنا بنفس الاسم isActivityLiveNow لسهولة القراءة في هذا السياق.
  const isActivityLiveNow = isLiveNow;
  if (input.hasDeviceLink && isActivityLiveNow) {
    worst = {
      ...computeDviResult(input, worst.rawWeatherSample, undefined),
      time: worst.time,
      rawWeatherSample: worst.rawWeatherSample,
      mergedReading: mergeDustReading(input, worst.rawWeatherSample, undefined),
    };
  }

  let bestWindowStartIso: string | null = null;
  let bestWindowWorst: DviHourlyEvaluation | null = null;
  // تتبّع أسوأ نافذة أيضاً (وليس فقط الأفضل)، لتوفير تحذير "تجنّب هذا
  // الوقت" بنفس مفهوم avoidWindow في محرك الحرارة — يوحّد المزايا المعروضة
  // للمستخدم بين مؤشري الحرارة والغبار بدل اقتصار الاقتراح على الحرارة فقط
  let avoidWindowStartIso: string | null = null;
  let avoidWindowWorst: DviHourlyEvaluation | null = null;
  // يوم البلوك ضمن أيام العمل؟ (لا نقترح أفضل نافذة في يوم عطلة). أسوأ
  // نافذة (avoid) لا تُقيّد — التحذير من وقت سيّئ مفيد حتى لو في عطلة.
  const WEEK_IDS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const RIYADH_UTC_OFFSET_MS = 3 * 3600000;
  const isWorkDay = (iso: string) => {
    if (!input.workDaysList || input.workDaysList.length === 0) return true;
    // يوم الأسبوع يجب أن يُحسب بتوقيت الرياض لا بتوقيت السيرفر: نشاط 01:00
    // صباحًا بالرياض يوم الأحد هو 22:00 السبت UTC — getDay() على UTC يرجّع
    // "السبت" خطأً. نزيح +3 ساعات ثم getUTCDay ليطابق اليوم المحلي الفعلي.
    const riyadhDay = new Date(new Date(iso).getTime() + RIYADH_UTC_OFFSET_MS).getUTCDay();
    return input.workDaysList.includes(WEEK_IDS[riyadhDay]);
  };
  // نفس تصحيح pickWorstActualHour أعلاه: أسوأ ساعة داخل كل بلوك مرشَّح
  // (لأغراض ترتيب أفضل/أسوأ نافذة بديلة) يجب أن تكون ساعة فعلية واحدة من
  // نفس البلوك، لا عينة مركَّبة من عدة ساعات مختلفة ضمنه.
  for (let i = 0; i + safeDuration <= allHourlyEvaluations.length; i++) {
    const blockHours = allHourlyEvaluations.slice(i, i + safeDuration);
    const blockWorst = pickWorstActualHour(blockHours);
    if (isWorkDay(blockHours[0].time) && (!bestWindowWorst || severityRank(blockWorst) < severityRank(bestWindowWorst))) {
      bestWindowWorst = blockWorst;
      bestWindowStartIso = blockHours[0].time;
    }
    if (!avoidWindowWorst || severityRank(blockWorst) > severityRank(avoidWindowWorst)) {
      avoidWindowWorst = blockWorst;
      avoidWindowStartIso = blockHours[0].time;
    }
  }

  return {
    worst,
    hourly: windowHours,
    windowStartIso: new Date(startMs).toISOString(),
    windowEndIso: new Date(endMs).toISOString(),
    durationHours: safeDuration,
    bestWindowStartIso,
    bestWindowWorst,
    avoidWindowStartIso,
    avoidWindowWorst,
  };
}