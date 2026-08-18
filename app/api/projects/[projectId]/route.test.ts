import { describe, expect, it, vi } from 'vitest';
import type { DustActivityRow, StoredFinalDecisionRow } from '@/app/lib/dustEvaluation';
import { activityDecisionKey } from '@/app/lib/dustEvaluation';

// route.ts يستورد supabaseAdmin على مستوى الوحدة (module-level) — يحتاج
// متغيرات بيئة حقيقية عند الاستيراد الفعلي. الاختبارات هنا تستهدف فقط
// buildRecentActivities/stripUnitSuffix (دوال نقية، بلا أي استدعاء شبكة)،
// فنموّه بديل فارغ لتفادي فشل تهيئة العميل في بيئة الاختبار — نفس نمط
// dust-profiles/route.test.ts.
vi.mock('@/app/lib/supabaseAdmin', () => ({ supabaseAdmin: {} }));

const { buildRecentActivities, stripUnitSuffix } = await import('./route');

// اختبارات طبقة تجميع "أسوأ قرار للنشاط" عبر الوحدات المتعددة (كسارتان/
// محطتا خلط متباعدتان جغرافياً، كل وحدة بجهازها وقراراتها المستقلة تماماً).
// خلفية الخطأ: buildRecentActivities كانت تُنشئ بطاقة منفصلة لكل وحدة —
// المستخدم يرى بطاقتين بنفس العنوان (مثال: "الكسارة" مرتين) بلا أي إشارة
// إلى أنهما نفس النشاط التنظيمي الواحد. الإصلاح: التجميع الآن بمفتاح
// المعرّف الأساس (بلا لاحقة -uN) بدل activity_group_id الخام — بطاقة واحدة
// لكل نشاط، مع بقاء تفاصيل كل وحدة (summaries/decisionTargets) منفصلة.

function makeRow(overrides: Partial<DustActivityRow>): DustActivityRow {
  return {
    id: 1,
    project_id: 'project-1',
    activity_group_id: 'base',
    regulatory_activity: 'CRUSHER',
    created_at: '2026-08-16T08:00:00.000Z',
    ...overrides,
  } as DustActivityRow;
}

describe('stripUnitSuffix', () => {
  it('يزيل لاحقة -uN فقط عند وجودها', () => {
    expect(stripUnitSuffix('base-u1')).toBe('base');
    expect(stripUnitSuffix('base-u2')).toBe('base');
    expect(stripUnitSuffix('base-u12')).toBe('base');
  });

  it('لا يغيّر معرّفاً بلا لاحقة -uN (نشاط وحدة واحدة)', () => {
    expect(stripUnitSuffix('base')).toBe('base');
    expect(stripUnitSuffix('dust-42')).toBe('dust-42');
  });

  it('لا يزيل نمطاً مشابهاً في المنتصف، فقط في النهاية', () => {
    expect(stripUnitSuffix('base-u1-extra')).toBe('base-u1-extra');
  });
});

describe('buildRecentActivities — تجميع وحدات النشاط الواحد المتعدد في بطاقة واحدة', () => {
  it('كسارتان بنفس activity_group_id الأساس (-u1/-u2) تُدمَجان في بطاقة واحدة بدل بطاقتين', () => {
    const rows: DustActivityRow[] = [
      makeRow({ id: 1, activity_group_id: 'base-u1' }),
      makeRow({ id: 2, activity_group_id: 'base-u2' }),
    ];

    const activities = buildRecentActivities('project-1', rows, new Map(), new Map());

    expect(activities).toHaveLength(1);
    expect(activities[0].activityGroupId).toBe('base');
    expect(activities[0].unitGroupIds.sort()).toEqual(['base-u1', 'base-u2']);
    // كل وحدة تبقي ملخّصها الخاص — لا دمج بيانات، فقط دمج عرض.
    expect(activities[0].summaries).toHaveLength(2);
  });

  it('نشاطان مختلفان تماماً (معرّفات أساس مختلفة) يبقيان بطاقتين منفصلتين', () => {
    const rows: DustActivityRow[] = [
      makeRow({ id: 1, activity_group_id: 'base-a' }),
      makeRow({ id: 2, activity_group_id: 'base-b' }),
    ];

    const activities = buildRecentActivities('project-1', rows, new Map(), new Map());

    expect(activities).toHaveLength(2);
    const groupIds = activities.map((a) => a.activityGroupId).sort();
    expect(groupIds).toEqual(['base-a', 'base-b']);
  });

  it('نشاط وحدة واحدة (بلا لاحقة -uN) يبقى بطاقة مستقلة كما كان دائماً', () => {
    const rows: DustActivityRow[] = [makeRow({ id: 1, activity_group_id: 'solo' })];

    const activities = buildRecentActivities('project-1', rows, new Map(), new Map());

    expect(activities).toHaveLength(1);
    expect(activities[0].activityGroupId).toBe('solo');
    expect(activities[0].unitGroupIds).toEqual(['solo']);
  });

  it('mandatoryStop للبطاقة الموحّدة = true إن كانت أي وحدة وحدها BLACK (أسوأ حالة بين الوحدات تفوز)، رغم أن الأخرى GREEN', () => {
    const rows: DustActivityRow[] = [
      makeRow({ id: 1, activity_group_id: 'base-u1' }),
      makeRow({ id: 2, activity_group_id: 'base-u2' }),
    ];

    // لا نتيجة محرك حية (dustByGroup فارغة) — يُستخدَم fallback القرار
    // المخزَّن (finalDecisionsByGroup)، أبسط وأدق لاختبار منطق التجميع نفسه
    // دون التوقف على تفاصيل computeUnifiedActivityDecision الداخلية.
    const stoppedUnit: StoredFinalDecisionRow = {
      activity_group_id: 'base-u1',
      decision_label_ar: 'إيقاف إلزامي',
      level: 'BLACK',
      operational_decision: 'MANDATORY_STOP',
      pending_confirmation: false,
      mandatory_stop: true,
    };
    const allowedUnit: StoredFinalDecisionRow = {
      activity_group_id: 'base-u2',
      decision_label_ar: 'مسموح',
      level: 'GREEN',
      operational_decision: 'ALLOW',
      pending_confirmation: false,
      mandatory_stop: false,
    };

    const finalDecisionsByGroup = new Map<string, StoredFinalDecisionRow>([
      [activityDecisionKey('project-1', 'base-u1'), stoppedUnit],
      [activityDecisionKey('project-1', 'base-u2'), allowedUnit],
    ]);

    const activities = buildRecentActivities('project-1', rows, new Map(), finalDecisionsByGroup);

    expect(activities).toHaveLength(1);
    expect(activities[0].mandatoryStop).toBe(true);
    expect(activities[0].summaries.map((s) => s.riskWeight).sort()).toEqual([0, 4]);
  });
});

// خطأ معماري مكتشَف ومُصلَح (مراجعة كود خارجي — P1، الملاحظة #13: "الواجهة
// ما زالت تستطيع عرض قرار حي لم يُحفظ بعد في Immutable Audit"): isLiveComputed
// يسمح للعميل بتمييز "معاينة حية" (لم تُكتب في final_decinsions بالضرورة
// بعد) عن "قرار رسمي محفوظ فعلياً" — هذه الاختبارات تثبت الحقل في كلا
// المسارين (fallback مخزَّن، وانتظار تقييم أول).
describe('buildRecentActivities — isLiveComputed يميّز مصدر كل ملخّص (الملاحظة #13)', () => {
  it('لا نتيجة محرك حية (dustByGroup فارغة) + قرار مخزَّن موجود → isLiveComputed=false', () => {
    const rows: DustActivityRow[] = [makeRow({ id: 1, activity_group_id: 'base' })];
    const stored: StoredFinalDecisionRow = {
      activity_group_id: 'base',
      decision_label_ar: 'مسموح',
      level: 'GREEN',
      operational_decision: 'ALLOW',
      pending_confirmation: false,
      mandatory_stop: false,
    };
    const finalDecisionsByGroup = new Map<string, StoredFinalDecisionRow>([
      [activityDecisionKey('project-1', 'base'), stored],
    ]);

    const activities = buildRecentActivities('project-1', rows, new Map(), finalDecisionsByGroup);

    expect(activities[0].summaries[0].isLiveComputed).toBe(false);
  });

  it('لا نتيجة محرك حية ولا قرار مخزَّن (لم يُقيَّم بعد) → isLiveComputed=false ("بانتظار التقييم")', () => {
    const rows: DustActivityRow[] = [makeRow({ id: 1, activity_group_id: 'base' })];

    const activities = buildRecentActivities('project-1', rows, new Map(), new Map());

    expect(activities[0].summaries[0].decisionLabel).toBe('بانتظار التقييم');
    expect(activities[0].summaries[0].isLiveComputed).toBe(false);
  });
});
