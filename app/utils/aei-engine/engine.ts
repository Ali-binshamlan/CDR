// =============================================================
// AEI Engine — Core Calculation (نسخة DCR: DVI فقط)
//
// المراحل المطبّقة هنا:
//  1) البوابة الحاكمة: DVI إيقاف إلزامي → AEI = 0, CLOSED.
//  2) درجة السلامة: تأثير الغبار على سلامة العمال.
//  3) درجة الجودة: تعتمد على DVI (الجسيمات العالقة).
//  4) BaseScore = min(safety, quality) + سقف إجباري وتعديل حالة إجباري.
// =============================================================

import { ActivityCategory, DviEvaluationResult } from '../dust-engine/types';
import { ACTIVITY_LABEL_AR, ACTIVITY_SENSITIVITY } from '../dust-engine/tables';
import {
  AEI_CAPPING_DVI_DECISIONS,
  AEI_RESTRICT_CAP,
  AEI_COLOR_FROM_STATUS,
  AEI_STATUS_LABEL_AR,
  DUST_QUALITY_SENSITIVE_ACTIVITIES,
  aeiStatusFromScore,
} from './tables';
import { AeiEvaluationResult, AeiSourceSnapshot } from './types';

function buildSourceSnapshot(dvi: DviEvaluationResult): AeiSourceSnapshot[] {
  return [
    {
      indicator: 'DVI',
      score: dvi.score,
      level: dvi.level,
      decisionCategory: dvi.decisionCategory,
      causeClassification: dvi.causeClassification,
    },
  ];
}

function calculateSafetyScore(dvi: DviEvaluationResult, activityType: ActivityCategory): number {
  const sensitivity = ACTIVITY_SENSITIVITY[activityType] ?? 0.5;
  const dustRiskContribution = dvi.score * (0.6 + 0.4 * sensitivity);
  return Math.round(Math.max(0, 100 - dustRiskContribution) * 10) / 10;
}

function calculateQualityScore(dvi: DviEvaluationResult, activityType: ActivityCategory): number {
  const isQualitySensitive = DUST_QUALITY_SENSITIVE_ACTIVITIES.includes(activityType);

  if (!isQualitySensitive) {
    return Math.round(Math.max(0, 100 - dvi.channels.particulateRisk * 0.4) * 10) / 10;
  }

  const penalty =
    dvi.channels.particulateRisk * 1.1 +
    (dvi.dustExposureHigh ? 15 : 0) +
    dvi.channels.windTransportRisk * 0.2;

  return Math.round(Math.max(0, 100 - penalty) * 10) / 10;
}

export function evaluateAei(
  dvi: DviEvaluationResult,
  activityType: ActivityCategory
): AeiEvaluationResult {
  const activityLabelAr = ACTIVITY_LABEL_AR[activityType] ?? activityType;
  const sources = buildSourceSnapshot(dvi);

  // المرحلة 1 — البوابة الحاكمة: إيقاف فوري
  if (dvi.mandatoryStop) {
    return {
      indicatorType: 'AEI',
      activityLabelAr,
      status: 'CLOSED',
      statusLabelAr: AEI_STATUS_LABEL_AR.CLOSED,
      color: AEI_COLOR_FROM_STATUS.CLOSED,
      score: 0,
      safetyScore: 0,
      qualityScore: 0,
      baseScore: 0,
      closedByGate: true,
      cappedByGate: false,
      gateReasonAr: `⛔ إيقاف إلزامي للعمل: انعدام الرؤية أو كثافة الغبار تمنع العمل بأمان (${dvi.decisionLabelAr}).`,
      shortReasonAr: dvi.shortReason,
      recommendationAr: 'يُمنع العمل حالياً بسبب سوء الأحوال الجوية. يُرجى الانتظار حتى تنجلي موجة الغبار وتتحسن الرؤية.',
      sources,
    };
  }

  // المرحلة 2 — حساب السلامة والجودة
  const safetyScore = calculateSafetyScore(dvi, activityType);
  const qualityScore = calculateQualityScore(dvi, activityType);

  // المرحلة 3 — الأساس والسقف الإجباري
  const baseScore = Math.min(safetyScore, qualityScore);
  let score = baseScore;
  let cappedByGate = false;
  let capReason = '';
  let forceRestrict = false;

  // سقف بسبب الغبار
  if (AEI_CAPPING_DVI_DECISIONS.includes(dvi.decisionCategory)) {
    forceRestrict = true;
    capReason = `تأثير الغبار: ${dvi.decisionLabelAr}`;
  }

  if (forceRestrict && score > AEI_RESTRICT_CAP) {
    score = AEI_RESTRICT_CAP;
    cappedByGate = true;
  }

  score = Math.round(Math.min(100, Math.max(0, score)) * 10) / 10;
  let status = aeiStatusFromScore(score);

  // الإجبار المنطقي لتطابق الحالة مع التقييد
  if (forceRestrict && (status === 'ALLOW' || status === 'MONITOR')) {
    status = 'RESTRICT';
    cappedByGate = true;
  }

  // المرحلة 4 — تحديد السبب الرئيسي للقصور
  const isQualitySensitive = DUST_QUALITY_SENSITIVE_ACTIVITIES.includes(activityType);
  const qualityIsLimiting = qualityScore < safetyScore;

  let shortReasonAr = '';

  if (status === 'ALLOW') {
    shortReasonAr = 'الأجواء ممتازة والظروف آمنة (لا توجد عوائق غبارية).';
  } else if (qualityIsLimiting) {
    shortReasonAr = isQualitySensitive
      ? 'احتمالية تأثر جودة العمل (مثل عمليات الصبغ أو التشطيب) بسبب الغبار العالق في الجو.'
      : 'تأثر جودة العمل بشكل طفيف بسبب وجود جسيمات غبارية عالقة.';
  } else {
    shortReasonAr = 'انخفاض مستوى الأمان للعمال بسبب الغبار وتدني مدى الرؤية.';
  }

  // التوصيات الذكية
  const recommendationAr = status === 'ALLOW'
    ? 'استمر بالعمل، لا توجد قيود حالية.'
    : status === 'MONITOR'
    ? 'استمر بالعمل مع أخذ فترات راحة للعمال ومراقبة الأجواء بشكل دوري.'
    : 'يُرجى تقليل المجهود البدني للعمال أو تأجيل المهام الشاقة لوقت يكون فيه الطقس أفضل.';

  return {
    indicatorType: 'AEI',
    activityLabelAr,
    status,
    statusLabelAr: AEI_STATUS_LABEL_AR[status],
    color: AEI_COLOR_FROM_STATUS[status],
    score,
    safetyScore,
    qualityScore,
    baseScore: Math.round(baseScore * 10) / 10,
    closedByGate: false,
    cappedByGate,
    gateReasonAr: cappedByGate ? `⚠️ تنبيه وقائي: تم تقييد النشاط حفاظاً على سلامة العمال وجودة العمل بناءً على (${capReason}).` : null,
    shortReasonAr,
    recommendationAr,
    sources,
  };
}
