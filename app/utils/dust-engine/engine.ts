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

  const rainSignal = sample.weatherSymbol === 'RAIN' || (sample.rainfallLast24hMm !== null && sample.rainfallLast24hMm > 0);
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
  if (level === 'YELLOW') return 'ALLOW_WITH_MONITORING';
  if (level === 'ORANGE') return 'RESTRICT';

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

function applyMandatoryGates(
  input: DustEngineInput,
  visibilityKm: number | null,
  pm10: number | null,
  effectiveWindKmh: number | null,
  dustForecastRisk: number,
  receptorImpact: number,
  score: number,
  weatherSymbol: DustWeatherSample['weatherSymbol'],
  baseDecision: DviDecisionCategory
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
    if (decision === 'ALLOW' || decision === 'ALLOW_WITH_MONITORING') decision = 'RESTRICT';
  }

  const rule4Triggered =
    (pm10 !== null && pm10 >= 500) ||
    (visibilityKm !== null && visibilityKm < 1 && input.site.hasEarthworks && (effectiveWindKmh ?? 0) > 40);
  if (rule4Triggered && isDustActivity) {
    rules.push('DVI-DUST-ACTIVITY-STOP-004');
    actions.push('إيقاف مؤقت للأعمال المثيرة للغبار (حفر/ردم/دمك/تسوية/نقل تربة) حتى تحسن الظروف');
    decision = 'STOP_DUST_GENERATING_ACTIVITIES';
    mandatoryStop = true;
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
    rules.push('DVI-NCM-DUST-WARNING-007');
    actions.push('إشعار مدير المشروع وإعادة ترتيب جدول الأنشطة');
    actions.push('تغطية المواد السائبة قبل الحدث وتجهيز خطة تقليل حركة المعدات');
    if (decision === 'ALLOW') decision = 'ALLOW_WITH_MONITORING';
  }

  return { decision, mandatoryStop, overridable, triggeredRules: rules, extraActions: actions };
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

function calculateConfidence(
  sample: DustWeatherSample,
  hasOnsiteVisibility: boolean,
  hasOnsitePm: boolean,
  siteDataProvided: boolean
): number {
  let confidence = 100;
  if (!hasOnsiteVisibility && sample.visibilityM === null) confidence -= 30;
  if (!hasOnsitePm && sample.pm10 === null && sample.pm25 === null) confidence -= 25;
  if (sample.windSpeedKmh === null) confidence -= 15;
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
// الحساب الأساسي وحل التناقضات اللفظية
// -------------------------------------------------------------
export function computeDviResult(input: DustEngineInput, weather: DustWeatherSample): DviEvaluationResult {
  const visibilityM = input.onsiteVisibilityM ?? weather.visibilityM;
  const visibilityKm = visibilityM !== null ? visibilityM / 1000 : null;

  const pm10 = input.onsitePm10 ?? weather.pm10;
  const pm25 = input.onsitePm25 ?? weather.pm25;

  const windSpeedKmh = weather.windSpeedKmh;
  const windGustKmh = weather.windGustKmh ?? windSpeedKmh;
  const effectiveWindKmh =
    windSpeedKmh !== null ? Math.max(windSpeedKmh, 0.85 * (windGustKmh ?? windSpeedKmh)) : null;

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
  const internalDustHazard = adjustedSiteDustGenerationRisk;

  const dviBase = 0.7 * externalHazard + 0.3 * internalDustHazard;

  const mult = calculateMultipliers(input.activityType, input.site);
  const siteExposureMultiplier = 1.0;

  const dviActivityRaw =
    dviBase * mult.activitySensitivityMultiplier * mult.receptorSensitivityMultiplier * siteExposureMultiplier * mult.mitigationReductionFactor;
  const score = Math.round(Math.min(100, Math.max(0, dviActivityRaw)) * 10) / 10;

  const level = dviLevelFromScore(score);
  const baseDecision = baseDecisionFromLevel(level, input.activityType);
  const dustForecastRisk = DFR;

  const gates = applyMandatoryGates(
    input,
    visibilityKm,
    pm10,
    effectiveWindKmh,
    dustForecastRisk,
    mult.receptorImpact,
    score,
    weather.weatherSymbol,
    baseDecision
  );

  const siteDataProvided = hasMeaningfulSiteData(input.site);
  const cause = classifyCause(weather, pm10);
  const { drivers, reducers } = buildRiskDriversAndReducers(input, visibilityKm, pm10, effectiveWindKmh, cause, siteDataProvided);
  const requiredActions = Array.from(new Set([...baseRequiredActions(gates.decision), ...gates.extraActions]));
  const confidenceScore = calculateConfidence(weather, input.onsiteVisibilityM != null, input.onsitePm10 != null || input.onsitePm25 != null, siteDataProvided);

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

  return {
    indicatorType: 'DVI',
    dviBase: Math.round(dviBase * 10) / 10,
    score,
    level,
    causeClassification: cause,

    decisionCategory: gates.decision,
    decisionLabelAr: DVI_DECISION_LABEL_AR[gates.decision] ?? gates.decision,
    mandatoryStop: gates.mandatoryStop,
    overridable: gates.overridable && gates.decision !== 'MANDATORY_STOP',

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

    confidenceScore,
    confidenceLabel: toConfidenceLabel(confidenceScore),

    validUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  };
}

export async function evaluateDustVisibility(input: DustEngineInput): Promise<DviEvaluationResult> {
  const weather = await fetchDustWeather(input.latitude, input.longitude);
  return computeDviResult(input, weather);
}

export async function evaluateDustVisibilityHourly(
  input: DustEngineInput,
  hoursAhead: number = 24
): Promise<DviHourlyEvaluation[]> {
  const samples = await fetchDustWeatherHourly(input.latitude, input.longitude, hoursAhead);
  return samples.map((sample) => ({ ...computeDviResult(input, sample), time: sample.time, rawWeatherSample: sample }));
}

// -------------------------------------------------------------
// تقييم ساعي عبر كامل ساعات دوام المشروع لليوم الحالي (وليس فقط نافذة
// النشاط المجدولة) — نفس مفهوم evaluateHeatStressWorkDayHourly في محرك
// الحرارة، يجيب على "هل أقدر أشتغل فيها؟" لكل ساعة دوام.
// -------------------------------------------------------------
export async function evaluateDustVisibilityWorkDayHourly(input: DustEngineInput): Promise<DviHourlyEvaluation[]> {
  const now = new Date();
  // تاريخ "اليوم" يجب أن يكون بتوقيت الرياض لا UTC: في الساعات المبكرة من
  // صباح الرياض (00:00-02:59) يكون تاريخ UTC هو اليوم السابق، فيُحسب يوم
  // العمل ونافذته للتاريخ الخطأ. نزيح +3 ساعات قبل أخذ التاريخ.
  const dateStr = new Date(now.getTime() + 3 * 3600000).toISOString().slice(0, 10);

  const horizonHours = 36;
  const samples = await fetchDustWeatherHourly(input.latitude, input.longitude, horizonHours);
  if (samples.length === 0) return [];

  // ورديات حقيقية (إن وُجدت) تحل محل نافذة workHoursStart/workHoursEnd
  // الواحدة — كل وردية تُبنى كنطاق [بداية، نهاية] مستقل بنفس منطق التعامل
  // مع عبور منتصف الليل، ثم تُؤخذ العينات ضمن اتحاد كل النطاقات (union)،
  // لا نطاق واحد فقط. مشروع بلا ورديات (shifts فارغة/غائبة) يسلك بالضبط
  // نفس المسار القديم: نافذة واحدة من workHoursStart إلى workHoursEnd.
  const shiftWindows =
    input.shifts && input.shifts.length > 0
      ? input.shifts
      : [{ startTime: input.workHoursStart || '06:00', endTime: input.workHoursEnd || '18:00' }];

  const ranges = shiftWindows.map(({ startTime, endTime }) => {
    const startMs = new Date(`${dateStr}T${startTime}:00+03:00`).getTime();
    let endMs = new Date(`${dateStr}T${endTime}:00+03:00`).getTime();
    if (endMs <= startMs) endMs += 24 * 3600000;
    return { startMs, endMs };
  });

  const workDaySamples = samples.filter((s) => {
    const t = new Date(s.time).getTime();
    return ranges.some((r) => t >= r.startMs && t <= r.endMs);
  });
  if (workDaySamples.length === 0) return [];

  return workDaySamples.map((sample) => ({ ...computeDviResult(input, sample), time: sample.time, rawWeatherSample: sample }));
}

const DVI_LEVEL_RANK: Record<DviLevel, number> = { GREEN: 0, YELLOW: 1, ORANGE: 2, RED: 3, DARK_RED: 4, BLACK: 5 };
function severityRank(r: DviEvaluationResult): number {
  return (r.mandatoryStop ? 100000 : 0) + DVI_LEVEL_RANK[r.level] * 1000 + r.score;
}

function aggregateWorstCaseSample(samples: DustWeatherSample[]): DustWeatherSample {
  const first = samples[0];

  const worstOf = (values: (number | null)[], pickWorst: (vals: number[]) => number): number | null => {
    const present = values.filter((v): v is number => v !== null);
    return present.length > 0 ? pickWorst(present) : null;
  };

  const symbolPriority: DustWeatherSample['weatherSymbol'][] = [
    'SANDSTORM',
    'BLOWING_DUST',
    'FOG',
    'RAIN',
    'CLEAR',
    'UNKNOWN',
  ];
  const worstSymbol =
    symbolPriority.find((sym) => samples.some((s) => s.weatherSymbol === sym)) ?? 'UNKNOWN';

  return {
    visibilityM: worstOf(samples.map((s) => s.visibilityM), (v) => Math.min(...v)),
    weatherCode: first.weatherCode,
    weatherSymbol: worstSymbol,
    windSpeedKmh: worstOf(samples.map((s) => s.windSpeedKmh), (v) => Math.max(...v)),
    windGustKmh: worstOf(samples.map((s) => s.windGustKmh), (v) => Math.max(...v)),
    windDirectionDeg: first.windDirectionDeg,
    relativeHumidityPercent: worstOf(samples.map((s) => s.relativeHumidityPercent), (v) => Math.max(...v)),
    rainfallLast24hMm: worstOf(samples.map((s) => s.rainfallLast24hMm), (v) => Math.min(...v)),
    pm10: worstOf(samples.map((s) => s.pm10), (v) => Math.max(...v)),
    pm25: worstOf(samples.map((s) => s.pm25), (v) => Math.max(...v)),
    dustConcentration: worstOf(samples.map((s) => s.dustConcentration), (v) => Math.max(...v)),
    dataSource: first.dataSource,
    isForecastStale: samples.some((s) => s.isForecastStale),
  };
}

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

  const hoursFromNowToWindowEnd = Math.max(0, Math.ceil((endMs - nowMs) / 3600000));
  const horizonHours = Math.max(hoursFromNowToWindowEnd + 6, safeDuration + 24, 24);
  
  // تعديل حاسم: تم تمرير windowStartIso كـ anchorIso لمنع تكرار بيانات التنبؤ عند اختلاف التواريخ المستقبلية
  const allSamples = await fetchDustWeatherHourly(input.latitude, input.longitude, horizonHours, windowStartIso);

  if (allSamples.length === 0) {
    throw new Error('تعذر جلب توقع الطقس الساعي لتقييم نافذة النشاط.');
  }

  const allHourlyEvaluations: DviHourlyEvaluation[] = allSamples.map((sample) => ({
    ...computeDviResult(input, sample),
    time: sample.time,
    rawWeatherSample: sample,
  }));

  let windowSamples = allSamples.filter((s) => {
    const t = new Date(s.time).getTime();
    return t >= startMs - 1800000 && t < endMs;
  });
  let windowHours = allHourlyEvaluations.filter((h) => {
    const t = new Date(h.time).getTime();
    return t >= startMs - 1800000 && t < endMs;
  });

  if (windowSamples.length === 0) {
    windowSamples = allSamples.slice(0, Math.min(safeDuration, allSamples.length));
    windowHours = allHourlyEvaluations.slice(0, Math.min(safeDuration, allHourlyEvaluations.length));
  }

  const aggregatedSample = aggregateWorstCaseSample(windowSamples);
  const worst: DviHourlyEvaluation = {
    ...computeDviResult(input, aggregatedSample),
    time: windowSamples[0]?.time ?? new Date(startMs).toISOString(),
    rawWeatherSample: aggregatedSample,
  };

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
  for (let i = 0; i + safeDuration <= allSamples.length; i++) {
    const blockSamples = allSamples.slice(i, i + safeDuration);
    const blockAggregatedSample = aggregateWorstCaseSample(blockSamples);
    const blockWorst: DviHourlyEvaluation = {
      ...computeDviResult(input, blockAggregatedSample),
      time: blockSamples[0].time,
      rawWeatherSample: blockAggregatedSample,
    };
    if (isWorkDay(blockSamples[0].time) && (!bestWindowWorst || severityRank(blockWorst) < severityRank(bestWindowWorst))) {
      bestWindowWorst = blockWorst;
      bestWindowStartIso = blockSamples[0].time;
    }
    if (!avoidWindowWorst || severityRank(blockWorst) > severityRank(avoidWindowWorst)) {
      avoidWindowWorst = blockWorst;
      avoidWindowStartIso = blockSamples[0].time;
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