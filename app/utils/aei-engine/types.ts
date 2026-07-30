// =============================================================
// AEI Engine — Types
// مؤشر قابلية تنفيذ النشاط (Activity Execution Index)
// نسخة DCR: AEI مبني على DVI (الغبار) فقط.
// =============================================================

import { CauseClassification, DviDecisionCategory, DviLevel } from '../dust-engine/types';

export type AeiStatus = 'ALLOW' | 'MONITOR' | 'RESTRICT' | 'CLOSED';
export type AeiColor = 'GREEN' | 'YELLOW' | 'ORANGE' | 'RED' | 'BLACK';

export type AeiSourceSnapshot = {
  indicator: 'DVI';
  score: number;
  level: DviLevel;
  decisionCategory: DviDecisionCategory;
  causeClassification: CauseClassification;
};

export interface AeiEvaluationResult {
  indicatorType: 'AEI';
  activityLabelAr: string;

  status: AeiStatus;
  statusLabelAr: string;
  color: AeiColor;

  score: number; // 0-100 — القيمة النهائية بعد البوابات والسقوف
  safetyScore: number;
  qualityScore: number;
  baseScore: number; // min(safety, quality) قبل تطبيق السقوف

  closedByGate: boolean; // إيقاف إلزامي (المرحلة 1)
  cappedByGate: boolean; // سقف إجباري (المرحلة 3)
  gateReasonAr: string | null;

  // true فقط عندما FinalDecision.operationalDecision === 'HOLD_FOR_VERIFICATION'
  // (لا جهاز رصد مرتبط بالنشاط أصلاً، راجع deriveEvidenceQuality في
  // final-decision-engine/adapters.ts) — يميّز هذه الحالة صراحةً (بدل
  // الاعتماد على مقارنة نصية هشة لـstatusLabelAr) حتى تقدر الواجهة (مثال:
  // عدّادات "متبقٍ حتى تتأكد المخالفة" في Compliancewidgetcard.tsx) تُخفي
  // أي عدّاد/رقم PM10 خام يوحي بثقة في قرار مبني فعلياً على تقدير طقس لا
  // قراءة جهاز حقيقية.
  isHoldForVerification: boolean;

  shortReasonAr: string;
  recommendationAr: string;

  sources: AeiSourceSnapshot[]; // تحويلها إلى مصفوفة لدعم تتبع المصادر المتعددة في لوحة التحكم
}
