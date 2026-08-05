import { describe, it, expect, vi } from 'vitest';
import { fetchLatestFinalDecisions, fetchLatestStoredCompliance, activityDecisionKey } from './dustEvaluation';
import type { SupabaseClient } from '@supabase/supabase-js';

// =====================================================================
// اختبار قبول القسم 12.2/18.5 من "دليل الإصلاح الجذري لمنظومة مرقاب" —
// "أنشئ مشروعين لهما activity_group_id='same-id'. يجب ألا يقرأ أي API أو
// تنبيه أو Current Pointer قرار المشروع الآخر." يثبت أن fetchLatestFinalDecisions/
// fetchLatestStoredCompliance يفلتران فعلياً بالمفتاح المركّب
// (project_id, activity_group_id)، لا activity_group_id وحده.
// =====================================================================

describe('fetchLatestFinalDecisions — عزل المشاريع بمفتاح مركّب', () => {
  it('activity_group_id متطابق بين مشروعين → كل مشروع يقرأ قراره الخاص فقط، لا خلط', async () => {
    // يحاكي استعلام Supabase .in('project_id',...).in('activity_group_id',...)
    // يُرجع صفوفاً من كلا المشروعين معاً (نفس ما يحدث فعلياً في القاعدة —
    // العزل يجب أن يحدث في طبقة التطبيق بعد القراءة، لا يعتمد على القاعدة
    // لترشيح الزوج الصحيح تلقائياً من .in() على عمودين منفصلين).
    const rows = [
      {
        id: 'decision-project-a',
        project_id: 'project-a',
        activity_group_id: 'same-id',
        decision_label_ar: 'إيقاف إلزامي نظامي',
        level: 'BLACK',
        mandatory_stop: true,
        created_at: '2026-08-04T10:00:00.000Z',
      },
      {
        id: 'decision-project-b',
        project_id: 'project-b',
        activity_group_id: 'same-id',
        decision_label_ar: 'مسموح — تشغيل اعتيادي',
        level: 'GREEN',
        mandatory_stop: false,
        created_at: '2026-08-04T10:00:00.000Z',
      },
    ];

    const supabaseAdmin = {
      from: vi.fn(() => ({
        select: vi.fn().mockReturnThis(),
        in: vi.fn().mockReturnThis(),
        order: vi.fn().mockResolvedValue({ data: rows }),
      })),
    };

    const result = await fetchLatestFinalDecisions(supabaseAdmin as unknown as SupabaseClient, [
      { projectId: 'project-a', activityGroupId: 'same-id' },
    ]);

    // فقط قرار project-a يظهر في النتيجة، رغم أن الاستعلام الخام أرجع صفي
    // كلا المشروعين معاً — قرار project-b (الموقف إلزامياً) لا يجوز أن
    // يُقرأ أو يُخلَط ضمن مفتاح project-a.
    expect(result.size).toBe(1);
    expect(result.get(activityDecisionKey('project-a', 'same-id'))?.id).toBe('decision-project-a');
    expect(result.has(activityDecisionKey('project-b', 'same-id'))).toBe(false);
  });

  it('لا نتيجة إطلاقاً إن كان الصف الوحيد المتاح ينتمي لمشروع آخر غير المطلوب', async () => {
    const rows = [
      {
        id: 'decision-project-b',
        project_id: 'project-b',
        activity_group_id: 'same-id',
        decision_label_ar: 'مسموح — تشغيل اعتيادي',
        level: 'GREEN',
        mandatory_stop: false,
        created_at: '2026-08-04T10:00:00.000Z',
      },
    ];

    const supabaseAdmin = {
      from: vi.fn(() => ({
        select: vi.fn().mockReturnThis(),
        in: vi.fn().mockReturnThis(),
        order: vi.fn().mockResolvedValue({ data: rows }),
      })),
    };

    const result = await fetchLatestFinalDecisions(supabaseAdmin as unknown as SupabaseClient, [
      { projectId: 'project-a', activityGroupId: 'same-id' },
    ]);

    expect(result.size).toBe(0);
  });
});

describe('fetchLatestStoredCompliance — عزل المشاريع بمفتاح مركّب', () => {
  it('activity_group_id متطابق بين مشروعين → current_dust_compliance_decisions لا يخلط النتيجتين', async () => {
    const currentRows = [
      { project_id: 'project-a', activity_group_id: 'same-id', latest_evaluation_id: 'eval-a' },
      { project_id: 'project-b', activity_group_id: 'same-id', latest_evaluation_id: 'eval-b' },
    ];
    const evalRows = [
      { id: 'eval-a', result: { decisionCategory: 'MANDATORY_STOP' } },
      { id: 'eval-b', result: { decisionCategory: 'ALLOW' } },
    ];

    const supabaseAdmin = {
      from: vi.fn((table: string) => {
        if (table === 'current_dust_compliance_decisions') {
          const chain: Record<string, unknown> & { _inCalls?: number } = {
            select: () => chain,
            in: vi.fn((..._args: unknown[]) => {
              // ثاني استدعاء .in() (على activity_group_id) هو نهاية السلسلة
              // فعلياً هنا (لا .order() بعده) — نُرجع Promise مباشرة عندها.
              chain._inCalls = (chain._inCalls ?? 0) + 1;
              if (chain._inCalls >= 2) return Promise.resolve({ data: currentRows });
              return chain;
            }),
          };
          return chain;
        }
        return {
          select: vi.fn().mockReturnThis(),
          in: vi.fn().mockResolvedValue({ data: evalRows }),
        };
      }),
    };

    const result = await fetchLatestStoredCompliance(supabaseAdmin as unknown as SupabaseClient, [
      { projectId: 'project-a', activityGroupId: 'same-id' },
    ]);

    expect(result.size).toBe(1);
    expect(result.get(activityDecisionKey('project-a', 'same-id'))?.decisionCategory).toBe('MANDATORY_STOP');
    expect(result.has(activityDecisionKey('project-b', 'same-id'))).toBe(false);
  });
});
