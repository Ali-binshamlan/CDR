import { describe, it, expect } from 'vitest';
import {
  operationalDecisionToReportStatus,
  toReportDecisionRow,
  dedupeToLatestPerActivity,
  type FinalDecisionReportRow,
} from './finalDecisionStatus';

function row(overrides: Partial<FinalDecisionReportRow> = {}): FinalDecisionReportRow {
  return {
    id: 'row-1',
    project_id: 'project-1',
    activity_group_id: 'group-1',
    operational_decision: 'ALLOW',
    mandatory_stop: false,
    created_at: '2026-08-16T08:00:00.000Z',
    ...overrides,
  };
}

describe('operationalDecisionToReportStatus', () => {
  it('MANDATORY_STOP → stopped', () => {
    expect(operationalDecisionToReportStatus('MANDATORY_STOP', false)).toBe('stopped');
  });
  it('mandatoryStop=true بصرف النظر عن operationalDecision → stopped', () => {
    expect(operationalDecisionToReportStatus('ALLOW', true)).toBe('stopped');
  });
  it('PROTECTIVE_STOP → stopped', () => {
    expect(operationalDecisionToReportStatus('PROTECTIVE_STOP', false)).toBe('stopped');
  });
  it('RESTRICT → restricted', () => {
    expect(operationalDecisionToReportStatus('RESTRICT', false)).toBe('restricted');
  });
  it('MONITOR/HOLD_FOR_VERIFICATION → caution', () => {
    expect(operationalDecisionToReportStatus('MONITOR', false)).toBe('caution');
    expect(operationalDecisionToReportStatus('HOLD_FOR_VERIFICATION', false)).toBe('caution');
  });
  it('ALLOW → safe', () => {
    expect(operationalDecisionToReportStatus('ALLOW', false)).toBe('safe');
  });
});

describe('toReportDecisionRow', () => {
  it('يحوّل الصف الخام لشكل status المبسَّط بلا فقدان id/project_id', () => {
    const result = toReportDecisionRow(row({ operational_decision: 'MANDATORY_STOP' }));
    expect(result).toEqual({ id: 'row-1', project_id: 'project-1', status: 'stopped' });
  });
});

// خطأ مكتشَف ومُصلَح (طلب صريح من المستخدم — "التقارير تعد كل صف في
// final_decisions نشاطاً جديداً. ومع التقييم الدوري ستتضخم أعداد الأنشطة
// كل دقيقتين. المطلوب العد حسب النشاط الفريد أو آخر قرار لكل
// activity_group_id"): dedupeToLatestPerActivity هي الإصلاح — تُستخدَم في
// dashboard/reports وviewer/reports قبل تحويل الصفوف لعرضها كأنشطة.
describe('dedupeToLatestPerActivity', () => {
  it('نشاط واحد بعدة صفوف (تقييم دوري متكرر) → صف واحد فقط، الأحدث', () => {
    const rows = [
      row({ id: 'r1', created_at: '2026-08-16T08:00:00.000Z', operational_decision: 'ALLOW' }),
      row({ id: 'r2', created_at: '2026-08-16T08:05:00.000Z', operational_decision: 'RESTRICT' }),
      row({ id: 'r3', created_at: '2026-08-16T08:10:00.000Z', operational_decision: 'MANDATORY_STOP' }),
    ];
    const result = dedupeToLatestPerActivity(rows);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('r3');
    expect(result[0].operational_decision).toBe('MANDATORY_STOP');
  });

  it('لا يتأثر بترتيب الصفوف الوارد — الأحدث يفوز دائماً بصرف النظر عن ترتيب المصفوفة', () => {
    const rows = [
      row({ id: 'r3', created_at: '2026-08-16T08:10:00.000Z' }),
      row({ id: 'r1', created_at: '2026-08-16T08:00:00.000Z' }),
      row({ id: 'r2', created_at: '2026-08-16T08:05:00.000Z' }),
    ];
    const result = dedupeToLatestPerActivity(rows);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('r3');
  });

  it('نشاطان مختلفان (activity_group_id مختلف) → صفان منفصلان، كل واحد بأحدث قرار له', () => {
    const rows = [
      row({ id: 'a1', activity_group_id: 'group-a', created_at: '2026-08-16T08:00:00.000Z' }),
      row({ id: 'a2', activity_group_id: 'group-a', created_at: '2026-08-16T08:05:00.000Z' }),
      row({ id: 'b1', activity_group_id: 'group-b', created_at: '2026-08-16T08:01:00.000Z' }),
    ];
    const result = dedupeToLatestPerActivity(rows);
    expect(result).toHaveLength(2);
    const ids = result.map((r) => r.id).sort();
    expect(ids).toEqual(['a2', 'b1']);
  });

  it('نفس activity_group_id في مشروعين مختلفين → يُعامَلان كنشاطين منفصلين تماماً (لا خلط عبر المشاريع)', () => {
    const rows = [
      row({ id: 'p1-row', project_id: 'project-1', activity_group_id: 'shared-group', created_at: '2026-08-16T08:00:00.000Z' }),
      row({ id: 'p2-row', project_id: 'project-2', activity_group_id: 'shared-group', created_at: '2026-08-16T08:00:00.000Z' }),
    ];
    const result = dedupeToLatestPerActivity(rows);
    expect(result).toHaveLength(2);
  });

  it('صف بلا activity_group_id (احتياطي) يُعامَل كنشاط مستقل بمعرّفه الخاص، لا يُدمَج خطأً مع غيره', () => {
    const rows = [
      row({ id: 'legacy-1', activity_group_id: '', created_at: '2026-08-16T08:00:00.000Z' }),
      row({ id: 'legacy-2', activity_group_id: '', created_at: '2026-08-16T08:05:00.000Z' }),
    ];
    const result = dedupeToLatestPerActivity(rows);
    expect(result).toHaveLength(2);
  });

  it('مصفوفة فارغة → مصفوفة فارغة', () => {
    expect(dedupeToLatestPerActivity([])).toEqual([]);
  });
});
