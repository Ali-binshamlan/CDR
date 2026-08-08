import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  getRuleParameters,
  refreshRuleParameters,
  resetRuleParametersForTests,
  DEFAULT_RULE_PARAMETERS,
} from './ruleParameters';

// خطأ مكتشَف ومُصلَح (مراجعة خبير خارجي — "واجهة إدارة القواعد للعرض فقط؛
// لا يوجد نظام حقيقي يدعم إنشاء نسخة قاعدة، النشر الذري، منع تعديل نسخة
// منشورة، التراجع لنسخة سابقة"): هذا الملف يختبر الطبقة التي تجعل العتبات
// الرقمية في rulebook.ts/engine.ts قابلة للنشر فعلياً — getRuleParameters
// تبدأ بالافتراضي المطابق للثوابت القديمة، وrefreshRuleParameters تستبدلها
// بآخر نسخة PUBLISHED من قاعدة البيانات.

function mockSupabase(rows: { parameter_code: string; value: number }[] | null, error: unknown = null): SupabaseClient {
  const chain = {
    select: () => chain,
    eq: async () => ({ data: rows, error }),
  };
  return { from: vi.fn(() => chain) } as unknown as SupabaseClient;
}

describe('ruleParameters', () => {
  beforeEach(() => {
    resetRuleParametersForTests();
  });

  it('getRuleParameters تُرجع الافتراضي قبل أي refresh', () => {
    expect(getRuleParameters()).toEqual(DEFAULT_RULE_PARAMETERS);
  });

  it('refreshRuleParameters تستبدل معاملاً واحداً منشوراً وتبقي البقية على افتراضها', async () => {
    const supabase = mockSupabase([{ parameter_code: 'STONE_CUTTING_WIND_STOP_KMH', value: 12 }]);
    await refreshRuleParameters(supabase);
    const params = getRuleParameters();
    expect(params.STONE_CUTTING_WIND_STOP_KMH).toBe(12);
    expect(params.CRUSHER_SENSITIVE_RECEPTOR_DISTANCE_M).toBe(DEFAULT_RULE_PARAMETERS.CRUSHER_SENSITIVE_RECEPTOR_DISTANCE_M);
  });

  it('parameter_code غير معروف في الصف يُتجاهَل بأمان (لا يُضاف حقل جديد للكائن)', async () => {
    const supabase = mockSupabase([{ parameter_code: 'UNKNOWN_FUTURE_PARAM', value: 999 }]);
    await refreshRuleParameters(supabase);
    const params = getRuleParameters();
    expect((params as unknown as Record<string, number>).UNKNOWN_FUTURE_PARAM).toBeUndefined();
    expect(params).toEqual(DEFAULT_RULE_PARAMETERS);
  });

  it('فشل الاستعلام (error) يُبقي آخر قيم معروفة — لا رجوع صامت للافتراضي', async () => {
    const supabaseOk = mockSupabase([{ parameter_code: 'STONE_CUTTING_WIND_STOP_KMH', value: 12 }]);
    await refreshRuleParameters(supabaseOk);
    expect(getRuleParameters().STONE_CUTTING_WIND_STOP_KMH).toBe(12);

    const supabaseFail = mockSupabase(null, { message: 'db down' });
    await refreshRuleParameters(supabaseFail);
    // القيمة السابقة (12) تبقى كما هي — لا ترجع لـ15 الافتراضية بصمت.
    expect(getRuleParameters().STONE_CUTTING_WIND_STOP_KMH).toBe(12);
  });

  it('رمي استثناء أثناء الاستعلام لا يُسقط التقييم — يُبتلَع بأمان', async () => {
    const throwingSupabase = {
      from: () => ({
        select: () => ({
          eq: async () => {
            throw new Error('network error');
          },
        }),
      }),
    } as unknown as SupabaseClient;
    await expect(refreshRuleParameters(throwingSupabase)).resolves.toBeUndefined();
    expect(getRuleParameters()).toEqual(DEFAULT_RULE_PARAMETERS);
  });

  it('استبدال كامل (لا دمج جزئي) — كل نداء refresh يبني كائناً جديداً من الافتراضي + المنشور الحالي فقط', async () => {
    const first = mockSupabase([
      { parameter_code: 'STONE_CUTTING_WIND_STOP_KMH', value: 12 },
      { parameter_code: 'UNPAVED_SPEED_LIMIT_KMH', value: 8 },
    ]);
    await refreshRuleParameters(first);
    expect(getRuleParameters().STONE_CUTTING_WIND_STOP_KMH).toBe(12);
    expect(getRuleParameters().UNPAVED_SPEED_LIMIT_KMH).toBe(8);

    // دورة ثانية تُرجع فقط معاملاً واحداً منشوراً الآن (الآخر رجع لحالة
    // غير منشورة نظرياً) — يجب أن يرجع UNPAVED_SPEED_LIMIT_KMH للافتراضي،
    // لا يبقى عالقاً على القيمة القديمة من الدورة الأولى.
    const second = mockSupabase([{ parameter_code: 'STONE_CUTTING_WIND_STOP_KMH', value: 12 }]);
    await refreshRuleParameters(second);
    expect(getRuleParameters().UNPAVED_SPEED_LIMIT_KMH).toBe(DEFAULT_RULE_PARAMETERS.UNPAVED_SPEED_LIMIT_KMH);
  });
});
