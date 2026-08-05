// =============================================================
// DVI Engine — Core Calculations
// قاعدة صارمة (قسم 5 و15 من المواصفة): بوابات الإيقاف الإلزامية لا
// تنتظر الدرجة النهائية، وتتجاوز أي Score محسوب.
// =============================================================

import {
  ActivityCategory,
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
function calculateSiteDustGeneration(site: DustSiteInputs, rainfallLast24hMm: number | null) {
  const b = (v: boolean) => (v ? 1 : 0);
  const siteDustGenerationRisk =
    100 *
    (0.25 * b(site.hasEarthworks) +
      0.2 * b(site.internalDirtRoads) +
      0.2 * b(site.heavyEquipmentMovement) +
      0.15 * b(site.looseMaterials) +
      0.1 * b(site.largeExposedArea) +
      0.1 * b(site.drySurface));

  let dampeningFactor = 1 - Math.min(0.6, 0.12 * (rainfallLast24hMm ?? 0));
  if (site.surfaceWet) dampeningFactor = Math.min(dampeningFactor, 0.4);

  const adjustedSiteDustGenerationRisk = siteDustGenerationRisk * dampeningFactor;

  return { siteDustGenerationRisk, adjustedSiteDustGenerationRisk };
}

// -------------------------------------------------------------
// حساب المضاعفات الثلاثة (النشاط، الجوار، إجراءات التحكم)
// -------------------------------------------------------------
function calculateMultipliers(activityType: ActivityCategory, site: DustSiteInputs) {
  const activitySensitivity = ACTIVITY_SENSITIVITY[activityType];
  const activitySensitivityMultiplier = 0.8 + 0.4 * activitySensitivity;

  const receptorSensitivity = RECEPTOR_SENSITIVITY[site.receptorType];
  const downwindAlignment = site.receptorIsDownwind ? 1 : 0;
  const distanceFactor = DISTANCE_FACTOR[site.receptorDistance];
  const receptorImpact = receptorSensitivity * downwindAlignment * distanceFactor;
  const receptorSensitivityMultiplier = 1 + 0.2 * receptorImpact;

  const b = (v: boolean) => (v ? 1 : 0);
  const mitigationScore =
    0.25 * b(site.wateringAvailable) +
    0.2 * b(site.stockpilesCovered) +
    0.15 * b(site.speedLimitApplied) +
    0.15 * b(site.wheelWashAvailable) +
    0.15 * b(site.dustScreensAvailable) +
    0.1 * b(site.fieldMonitoringAvailable);
  const mitigationReductionFactor = 1 - Math.min(0.25, 0.25 * mitigationScore);

  return {
    activitySensitivity,
    activitySensitivityMultiplier,
    receptorSensitivity,
    downwindAlignment,
    distanceFactor,
    receptorImpact,
    receptorSensitivityMultiplier,
    mitigationScore,
    mitigationReductionFactor,
  };
}

// -------------------------------------------------------------
// القرار الأساسي من المستوى (قبل تطبيق البوابات)
// -------------------------------------------------------------
function baseDecisionFromLevel(level: DviLevel, activityType: ActivityCategory): DviDecisionCategory {
  if (level === 'GREEN') return 'ALLOW';
  // ORANGE لم يعد يُنتج RESTRICT — طلب صريح من المستخدم: رسالة "تقييد
  // العمل: وجود فجوة في إجراءات التحكم الميدانية" لا يجوز أن تظهر كقرار
  // "تقييد" في القرارات النهائية. يبقى النطاق البرتقالي ضمن ALLOW_WITH_
  // MONITORING فقط (تنبيه/مراقبة، بلا لغة تقييد فعلي). لا تأثير على
  // RESTRICT_SEVERE أو أي إيقاف إلزامي — تلك تبقى كما هي تماماً.
  if (level === 'YELLOW' || level === 'ORANGE') return 'ALLOW_WITH_MONITORING';

  if (VISIBILITY_DEPENDENT_ACTIVITIES.includes(activityType)) return 'STOP_VISIBILITY_DEPENDENT_ACTIVITIES';
  if (DUST_GENERATING_ACTIVITIES.includes(activityType)) return 'STOP_DUST_GENERATING_ACTIVITIES';
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
  effectiveWindKmh: number | null,
  dustForecastRisk: number,
  receptorImpact: number,
  score: number,
  weatherSymbol: DustWeatherSample['weatherSymbol'],
  baseDecision: DviDecisionCategory,
  // خطأ مكتشَف ومُصلَح (مراجعة خبير خارجي — "PM10 بقيمة 500 وعمر أكبر من
  // أربع دقائق ما زال قادراً على إنتاج إيقاف"): كانت pm10RuleTriggered أدناه
  // تستهلك pm10 اللحظي بلا أي فحص عمر/حداثة — فقراءة قديمة جداً (ساعات، طالما
  // devicePm10 لا يزال غير null من صف الجهاز نفسه) تُفعِّل mandatoryStop=true
  // فوراً، ويُستهلَك هذا الحقل الخام مباشرة في مواضع لا تمر عبر آلية استمرار
  // PM10 الصحيحة في dustEvaluation.ts (مثال: dviLevelToDecision في نقطة
  // الخريطة الحية بـGlobalDashboard/IntegratedDashboard). false هنا (قراءة
  // قديمة/غير متوفرة) لا يُسقِط بوابة PM10 كلياً — فقط يمنعها من فرض
  // mandatoryStop=true القطعي، ويُبقيها عند RESTRICT_SEVERE احترازياً (نفس
  // شدة رؤية<1كم) بانتظار قراءة طازجة تؤكد الخطر فعلياً. لا تأثير على
  // combinedVisibilityWindTriggered (خطر فيزيائي فوري لا علاقة له بحداثة
  // PM10). true دائماً بلا جهاز مرتبط (input.hasDeviceLink=false، القراءة من
  // تقدير طقس لا "قراءة" فردية لها عمر بالمعنى نفسه).
  pm10ReadingIsFreshEnoughForImmediateStop: boolean
): GateOutcome {
  const rules: string[] = [];
  const actions: string[] = [];
  let decision = baseDecision;
  let mandatoryStop = false;
  let overridable = true;
  const isVisibilityActivity = VISIBILITY_DEPENDENT_ACTIVITIES.includes(input.activityType);
  const isDustActivity = DUST_GENERATING_ACTIVITIES.includes(input.activityType);

  if (visibilityKm !== null && visibilityKm < 0.5) {
    rules.push('DVI-VISIBILITY-MANDATORY-STOP-001');
    actions.push('إيقاف الرفع والحركة غير الضرورية والعمل على ارتفاع فورًا');
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
  else if (visibilityKm !== null && visibilityKm < 1) {
    rules.push('DVI-VISIBILITY-RED-002');
    actions.push('منع بدء رفع جديد ومنع الرفع المعقد');
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

  // حد الإيقاف 340 (بدل 500 سابقاً) ليطابق حد المخالفة التنظيمي في
  // "الاستخراج التنظيمي من المرفق" (PM10-VIOLATION-STOP-006 بمحرك
  // الامتثال) — DVI الفيزيائي لا يجوز أن "يسمح" حتى نقطة يوقفها الامتثال
  // التنظيمي فعلياً، وإلا يظهر تناقض بين المحركين.
  //
  // فرعان منفصلان لهما طبيعة مختلفة تماماً (راجع ملاحظة مراجعة خارجية):
  // - pm10RuleTriggered (PM10>340 لحظياً): ليس خطراً فيزيائياً فورياً بحد
  //   ذاته (لا يشبه انعدام الرؤية) — هو نفس عتبة المخالفة التنظيمية
  //   (PM10-VIOLATION-STOP-006) التي يشترط محرك الامتثال لها استمراراً
  //   فعلياً >دقيقتين قبل تأكيدها (pm10ThresholdRule). قراءة واحدة هنا لا
  //   يجوز أن تتحول لـMANDATORY_STOP تنظيمي قطعي دون ذلك الدليل.
  // - combinedVisibilityWindTriggered (رؤية<1كم + حفريات + رياح>40): خطر
  //   فيزيائي فوري حقيقي (رؤية حرجة + رياح شديدة معاً في موقع حفر) لا
  //   علاقة له بعتبة PM10 التنظيمية إطلاقاً — يبقى إيقافاً فورياً صحيحاً.
  // رمز القاعدة (DVI-DUST-ACTIVITY-STOP-004) يبقى واحداً للعرض، لكن
  // triggeredByPm10Only أدناه يميّز الفرعين لمحرك الامتثال (راجع
  // dviMandatoryStopReasonCodes في dust-compliance-engine/adapters.ts).
  //
  // خطأ مكتشَف ومُصلَح (مراجعة كود مدير): كان `>=` — النص التنظيمي يقول
  // "تجاوز 340" (exceeds)، أي `>` صراحة لا `>=` (نفس العتبة بالضبط
  // المستخدمة في pm10ThresholdRule بـrulebook.ts، والتي تحمل نفس الملاحظة
  // حرفياً: "340.000 بالضبط يجب أن تبقى تحذير/تنبيه استباقي لا مخالفة").
  // بقاء `>=` هنا كان يعني أن قراءة 340.000 بالضبط تُفعِّل DVI-DUST-
  // ACTIVITY-STOP-004 (خطر فيزيائي) بينما محرك الامتثال في نفس اللحظة يرفض
  // اعتبارها حتى "تنبيه مخالفة" بعد — تناقض مباشر بين المحركين على نفس
  // القيمة بالضبط.
  const pm10RuleTriggered = pm10 !== null && pm10 > 340;
  const combinedVisibilityWindTriggered =
    visibilityKm !== null && visibilityKm < 1 && input.site.hasEarthworks && (effectiveWindKmh ?? 0) > 40;
  const rule4Triggered = pm10RuleTriggered || combinedVisibilityWindTriggered;
  // خطأ مكتشَف ومُصلَح (مراجعة خبير خارجي — راجع تعليق
  // pm10ReadingIsFreshEnoughForImmediateStop الكامل أعلى الدالة): PM10 لحظي
  // فقط (بلا خطر فيزيائي فوري آخر مساهم) لا يفرض mandatoryStop=true القطعي
  // إلا إن كانت القراءة نفسها طازجة. قراءة قديمة تبقى STOP_DUST_GENERATING_
  // ACTIVITIES احترازياً (يمنع الاستمرار) لكن بدرجة mandatoryStop=false — نفس
  // شدة RESTRICT_SEVERE منطقياً (رؤية<1كم)، لا خطر مؤكَّد فوري.
  const pm10OnlyTriggered = pm10RuleTriggered && !combinedVisibilityWindTriggered;
  const pm10OnlyConfirmable = pm10OnlyTriggered && pm10ReadingIsFreshEnoughForImmediateStop;
  if (rule4Triggered && isDustActivity) {
    rules.push('DVI-DUST-ACTIVITY-STOP-004');
    if (pm10OnlyTriggered) {
      // وسم فرعي مخصَّص لمحرك الامتثال — يميّز "PM10 لحظي فقط" (يحتاج دليل
      // استمرار) عن الرمز العام أعلاه، بلا تغيير أي مستهلك حالي لـ
      // DVI-DUST-ACTIVITY-STOP-004 نفسه.
      rules.push('DVI-DUST-ACTIVITY-STOP-004-PM10-ONLY');
      if (!pm10OnlyConfirmable) {
        rules.push('DVI-DUST-ACTIVITY-STOP-004-PM10-STALE');
      }
    }
    actions.push('إيقاف مؤقت للأعمال المثيرة للغبار (حفر/ردم/دمك/تسوية/نقل تربة) حتى تحسن الظروف');
    decision = 'STOP_DUST_GENERATING_ACTIVITIES';
    mandatoryStop = pm10OnlyTriggered ? pm10OnlyConfirmable : true;
  }

  if (effectiveWindKmh !== null && effectiveWindKmh >= 30 && input.site.looseMaterials) {
    rules.push('DVI-WIND-LOOSE-MATERIAL-005');
    actions.push('تغطية وتأمين المواد السائبة فورًا');
    if (effectiveWindKmh >= 55) {
      actions.push('إيقاف مناولة المواد السائبة المكشوفة');
      if (isDustActivity || input.activityType === 'MATERIAL_TRANSPORT') {
        decision = 'STOP_DUST_GENERATING_ACTIVITIES';
        mandatoryStop = true;
      }
    }
  }

  if (receptorImpact >= 0.6 && score >= 45) {
    rules.push('DVI-RECEPTOR-ESCALATION-006');
    actions.push('زيادة الرش ومراقبة حدود الموقع باتجاه الرياح');
    actions.push('تقليل الأعمال المثيرة للغبار وتوثيق الحالة وإبلاغ HSE');
    if (decision === 'ALLOW_WITH_MONITORING') decision = 'RESTRICT';
    else if (decision === 'RESTRICT') decision = 'RESTRICT_SEVERE';
  }

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

  const hasVisibility = triggeredRules.some((r) => r.startsWith('DVI-VISIBILITY-'));
  const hasWind = triggeredRules.includes('DVI-WIND-LOOSE-MATERIAL-005');
  const hasPm10Only = triggeredRules.includes('DVI-DUST-ACTIVITY-STOP-004-PM10-ONLY');
  // خطر فيزيائي فوري (رؤية حرجة/رياح شديدة+مواد سائبة) مساهم بنفس اللحظة —
  // بمعزل عن كون PM10 اللحظي مساهماً أيضاً أم لا.
  const hasPhysicalHazard = hasVisibility || hasWind;

  const stopBasis: DviEvaluationResult['stopBasis'] = hasPhysicalHazard && hasPm10Only
    ? 'MIXED'
    : hasVisibility
      ? 'VISIBILITY'
      : hasWind
        ? 'WIND'
        : hasPm10Only
          ? 'PM10'
          : 'NONE';

  // معلَّق (PENDING) فقط إن كان السبب PM10 لحظي فقط بلا أي خطر فيزيائي حقيقي
  // مساهم — نفس شرط dviMandatoryStopIsPm10Only القديم بالضبط (قسم "الإصلاح"
  // في final-decision-engine/engine.ts).
  const confirmationState: DviEvaluationResult['confirmationState'] =
    stopBasis === 'PM10' ? 'PENDING' : 'CONFIRMED';

  return { stopBasis, confirmationState };
}

function hasMeaningfulSiteData(site: DustSiteInputs): boolean {
  return (
    site.hasEarthworks ||
    site.internalDirtRoads ||
    site.heavyEquipmentMovement ||
    site.looseMaterials ||
    site.largeExposedArea ||
    site.drySurface ||
    site.surfaceWet ||
    site.wateringAvailable ||
    site.stockpilesCovered ||
    site.speedLimitApplied ||
    site.wheelWashAvailable ||
    site.dustScreensAvailable ||
    site.fieldMonitoringAvailable ||
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

  if (input.site.wateringAvailable) reducers.push('أنظمة رش الطرق مفعّلة بالموقع');
  if (input.site.stockpilesCovered) reducers.push('تغطية وحماية الأكوام الترابية مطبقة');
  if (input.site.speedLimitApplied) reducers.push('التزام الشاحنات بحدود السرعة الداخلية منخفضة');
  if (input.site.dustScreensAvailable) reducers.push('شاشات ومصدات الغبار متوفرة محيطياً');

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
// الجهاز العامة (20 دقيقة، DEVICE_CONNECTION_FRESHNESS_MS).
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
  // تعميم البوابة (راجع تعليق devicePm25At/deviceRelativeHumidityAt/
  // deviceTemperatureAt في types.ts) — PM10 مستثنى عمداً، له آلية حداثة/
  // استمرار مستقلة في dustEvaluation.ts.
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

  const mult = calculateMultipliers(input.activityType, input.site);
  const siteExposureMultiplier = 1.0;

  // نفس الاستثناء: مضاعفا حساسية النشاط والمستقبِل يُسقَطان لقيمة 1 (بلا
  // أي تضخيم) — النشاط لا يُصدر غباراً فعلياً، فلا معنى لتضخيم تأثير طقس
  // خارجي بحساسية نشاط/قرب مستقبِل لا علاقة لهما بمصدر غبار غير موجود أصلاً.
  const activitySensitivityMultiplier = input.isEnclosedDustExempt ? 1 : mult.activitySensitivityMultiplier;
  const receptorSensitivityMultiplier = input.isEnclosedDustExempt ? 1 : mult.receptorSensitivityMultiplier;

  const dviActivityRaw =
    dviBase * activitySensitivityMultiplier * receptorSensitivityMultiplier * siteExposureMultiplier * mult.mitigationReductionFactor;
  const score = Math.round(Math.min(100, Math.max(0, dviActivityRaw)) * 10) / 10;

  const level = dviLevelFromScore(score);
  const baseDecision = baseDecisionFromLevel(level, input.activityType);
  const dustForecastRisk = DFR;

  // راجع تعليق pm10ReadingIsFreshEnoughForImmediateStop الكامل في
  // applyMandatoryGates. بلا جهاز مرتبط (hasDeviceLink=false)، pm10 قادم من
  // تقدير طقس لا من "قراءة" فردية لها عمر بنفس المعنى — يُعامَل كطازج دائماً
  // (فشل آمن نحو السلوك السابق، بلا كسر لمسارات التخطيط/التوقّع). نفس عتبة
  // 4 دقائق المستخدمة في FIELD_FRESHNESS_MS أعلاه (ومطابقة
  // PM10_LAST_READING_FRESHNESS_MINUTES في dustEvaluation.ts — قيمة مكرَّرة
  // عمداً بين الطبقتين، نفس اتفاقية DEVICE_READING_FRESHNESS_MINUTES القائمة
  // أصلاً في المشروع).
  const pm10ReadingAgeMs =
    input.hasDeviceLink && merged.devicePm10LastReadingAt
      ? Date.now() - new Date(merged.devicePm10LastReadingAt).getTime()
      : null;
  const pm10ReadingIsFreshEnoughForImmediateStop =
    !input.hasDeviceLink || (pm10ReadingAgeMs !== null && pm10ReadingAgeMs >= 0 && pm10ReadingAgeMs <= FIELD_FRESHNESS_MS);

  const gates = applyMandatoryGates(
    input,
    visibilityKm,
    pm10,
    effectiveWindKmh,
    dustForecastRisk,
    mult.receptorImpact,
    score,
    weather.weatherSymbol,
    baseDecision,
    pm10ReadingIsFreshEnoughForImmediateStop
  );

  const siteDataProvided = hasMeaningfulSiteData(input.site);
  const cause = classifyCause(weather, pm10);
  const { drivers, reducers } = buildRiskDriversAndReducers(input, visibilityKm, pm10, effectiveWindKmh, cause, siteDataProvided);
  const requiredActions = Array.from(new Set([...baseRequiredActions(gates.decision), ...gates.extraActions]));
  const confidenceScore = calculateConfidence(merged, weather, siteDataProvided);

  const dustExposureHigh = cause === 'DUST' && score >= 45;
  const outdoorWorkRestriction =
    gates.decision === 'MANDATORY_STOP' ||
    gates.decision === 'STOP_DUST_GENERATING_ACTIVITIES' ||
    gates.decision === 'STOP_VISIBILITY_DEPENDENT_ACTIVITIES' ||
    gates.decision === 'RESTRICT_SEVERE';

  // --- ربط النص القصير بالقرار الفعلي ديناميكياً لمنع التناقض ---
  const shortReason =
    gates.decision === 'MANDATORY_STOP'
      ? `إيقاف إلزامي: انخفاض حرج في الرؤية الأفقية الميدانية لمستويات دون الأمان (${visibilityKm?.toFixed(2)} كم).`
      : gates.decision === 'STOP_DUST_GENERATING_ACTIVITIES'
      ? `إيقاف أعمال الغبار: مؤشر جودة الهواء حرج (PM10 = ${pm10}) أو نشاط الرياح عالي مع أعمال حفر وتربة.`
      : gates.decision === 'STOP_VISIBILITY_DEPENDENT_ACTIVITIES'
      ? `إيقاف مؤقت: طبيعة هذا النشاط تعتمد كلياً على جودة الرؤية العالية، والظروف الحالية غير ملائمة.`
      : gates.decision === 'RESTRICT_SEVERE'
      ? 'تقييد شديد: تداخل مؤشرات الغبار والرياح بشكل يتطلب خفض العمليات الميدانية لأدنى مستوياتها.'
      : gates.decision === 'RESTRICT'
      ? 'تقييد العمل: وجود فجوة في إجراءات التحكم الميدانية (مثل غياب رش المياه أو مصدات الغبار).'
      : gates.decision === 'ALLOW_WITH_MONITORING'
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

  // خطأ مكتشَف ومُصلَح (مراجعة كود خبير خارجي — "التوقف الإلزامي يمكن أن
  // يكون قابلاً للتجاوز"): كان شرط overridable في النتيجة النهائية يقصر
  // المنع على decision === 'MANDATORY_STOP' تحديداً — لكن applyMandatoryGates
  // أعلاه يضبط mandatoryStop=true من فرعين آخرين أيضاً بقرار STOP_DUST_
  // GENERATING_ACTIVITIES (DVI-DUST-ACTIVITY-STOP-004 عند PM10≥340 أو رؤية
  // حرجة+رياح، وDVI-WIND-LOOSE-MATERIAL-005 عند رياح≥55 مع مواد سائبة) بلا
  // ضبط overridable=false في أي منهما — يعتمدان على أن overridable يبدأ
  // true ولا يُغيَّر، فتصل نتيجة متناقضة منطقياً (mandatoryStop=true
  // وoverridable=true معاً) لمستهلكين فعليين (Dustwidgetcard.tsx: بانر
  // "توصية إلزامية" لا يظهر رغم إيقاف فعلي). الإصلاح: القاعدة الآن مطلقة
  // بلا استثناء لأي قرار — mandatoryStop=true يفرض overridable=false دائماً،
  // بصرف النظر عن أي فرع ضبطه لاحقاً أو نسيه. assertMandatoryStopInvariant
  // يفرض هذا كـinvariant وقت التشغيل أيضاً، لا الاعتماد على التزام كل فرع
  // مستقبلي في applyMandatoryGates بهذا الشرط يدوياً.
  const finalMandatoryStop = gates.mandatoryStop;
  const finalOverridable = !gates.mandatoryStop && gates.overridable;
  assertMandatoryStopInvariant({ mandatoryStop: finalMandatoryStop, overridable: finalOverridable });
  const { stopBasis, confirmationState } = deriveStopBasisAndConfirmation(finalMandatoryStop, gates.triggeredRules);

  return {
    indicatorType: 'DVI',
    dviBase: Math.round(dviBase * 10) / 10,
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
      visibilityRisk: VR,
      particulateRisk: PR,
      windTransportRisk: WTR,
      dustForecastRisk: DFR,
      siteDustGenerationRisk: Math.round(siteDustGenerationRisk * 10) / 10,
      adjustedSiteDustGenerationRisk: Math.round(adjustedSiteDustGenerationRisk * 10) / 10,
      externalHazard: Math.round(externalHazard * 10) / 10,
      internalDustHazard: Math.round(internalDustHazard * 10) / 10,
    },
    multipliers: mult,

    visibilityKm,
    effectiveWindKmh,

    // راجع تعليق visibilityDataMissing الكامل في types.ts. hasDeviceLink
    // يحصر هذا العلم على مسار الجهاز الحي فقط — طقس تقديري (hasDeviceLink=
    // false) لا "يفتقد" قراءة رؤية بنفس المعنى، فيبقى false دائماً هناك.
    visibilityDataMissing: input.hasDeviceLink && visibilityKm === null,

    visibilityConstraint: visibilityKm !== null && visibilityKm < 1,
    mandatoryVisibilityStop: visibilityKm !== null && visibilityKm < 0.5,
    respiratoryPPERequired: PR >= 45 || dustExposureHigh,
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
      mitigationScore: 0,
      mitigationReductionFactor: 0,
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