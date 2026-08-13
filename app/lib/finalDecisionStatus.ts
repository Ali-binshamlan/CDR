// يحوّل صف final_decisions (operational_decision + mandatory_stop) إلى نفس
// مفردات status ('safe'|'caution'|'restricted'|'stopped') التي كانت تُقرأ
// سابقاً من decision_records.status — حتى تستمر ReportsView.tsx وأي مستهلك
// آخر بنفس منطق الفلترة (d.status === 'safe' || 'caution'، إلخ) بلا أي
// تعديل، رغم تغيّر مصدر البيانات بالكامل من قرارات موثَّقة يدوياً (ميزة
// محذوفة) إلى قرارات المحرك الآلي الفعلية.
export type ReportDecisionStatus = 'safe' | 'caution' | 'restricted' | 'stopped';

export type OperationalDecision =
  | 'ALLOW'
  | 'MONITOR'
  | 'RESTRICT'
  | 'HOLD_FOR_VERIFICATION'
  | 'PROTECTIVE_STOP'
  | 'MANDATORY_STOP';

export function operationalDecisionToReportStatus(
  operationalDecision: OperationalDecision | string,
  mandatoryStop: boolean
): ReportDecisionStatus {
  if (mandatoryStop || operationalDecision === 'MANDATORY_STOP' || operationalDecision === 'PROTECTIVE_STOP') {
    return 'stopped';
  }
  if (operationalDecision === 'RESTRICT') return 'restricted';
  if (operationalDecision === 'MONITOR' || operationalDecision === 'HOLD_FOR_VERIFICATION') return 'caution';
  return 'safe'; // ALLOW
}

export interface FinalDecisionReportRow {
  id: string;
  project_id: string;
  operational_decision: string;
  mandatory_stop: boolean;
}

export interface ReportDecisionRow {
  id: string;
  project_id: string;
  status: ReportDecisionStatus;
}

export function toReportDecisionRow(row: FinalDecisionReportRow): ReportDecisionRow {
  return {
    id: row.id,
    project_id: row.project_id,
    status: operationalDecisionToReportStatus(row.operational_decision, row.mandatory_stop),
  };
}
