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
  activity_group_id: string;
  operational_decision: string;
  mandatory_stop: boolean;
  created_at: string;
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

// خطأ مكتشَف ومُصلَح (طلب صريح من المستخدم — "التقارير تعد كل صف في
// final_decisions نشاطاً جديداً. ومع التقييم الدوري ستتضخم أعداد الأنشطة
// كل دقيقتين"): final_decisions جدول append-only — صف جديد بكل دورة تقييم
// تتغيّر فيها الحالة فعلياً (وأحياناً كل ~5 دقائق حتى بلا تغيّر، راجع
// v_skip_final في persist_activity_decision_atomic). عدّ/تجميع dashboard/
// reports وviewer/reports كان يعامل كل صف كنشاط مستقل — نفس النشاط
// (activity_group_id واحد) يُحتسَب عشرات المرات خلال فترة تقرير طويلة.
//
// الإصلاح: تجميع كل صفوف الفترة حسب (project_id, activity_group_id)،
// الاحتفاظ فقط بأحدث صف لكل نشاط فريد (آخر قرار وصله خلال الفترة) — هذا هو
// "حالة النشاط عند نهاية الفترة"، المعنى الصحيح لتقرير تنفيذي، لا "كم مرة
// أُعيد تقييمه". صفوف بلا activity_group_id (نادر، احتياطي فقط) تُعامَل كل
// واحدة كنشاط مستقل بمعرّف مصطنع من id الصف نفسه — نفس نمط fallback
// المستخدَم في buildRecentActivities (route.ts) وfetchLatestFinalDecisions.
export function dedupeToLatestPerActivity<T extends FinalDecisionReportRow>(rows: readonly T[]): T[] {
  const latestByKey = new Map<string, T>();
  for (const row of rows) {
    const key = `${row.project_id}:${row.activity_group_id || `row-${row.id}`}`;
    const existing = latestByKey.get(key);
    if (!existing || row.created_at > existing.created_at) {
      latestByKey.set(key, row);
    }
  }
  return Array.from(latestByKey.values());
}
