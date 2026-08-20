import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  getRuleParameters,
  refreshRuleParameters,
  resetRuleParametersForTests,
  DEFAULT_RULE_PARAMETERS,
  getActiveParameterVersionIds,
  withRuleParametersLock,
} from './ruleParameters';

// Tests the layer that makes numeric thresholds in rulebook.ts/engine.ts
// publishable at runtime — getRuleParameters starts from defaults matching
// the old constants, and refreshRuleParameters replaces them with the latest
// PUBLISHED version from the database.

function mockSupabase(
  rows: { id?: string; parameter_code: string; value: number }[] | null,
  error: unknown = null
): SupabaseClient {
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
    // Previous value (12) is retained — must not silently fall back to the default 15.
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
      { parameter_code: 'WIND_GATE_ENHANCED_MIN_KMH', value: 8 },
    ]);
    await refreshRuleParameters(first);
    expect(getRuleParameters().STONE_CUTTING_WIND_STOP_KMH).toBe(12);
    expect(getRuleParameters().WIND_GATE_ENHANCED_MIN_KMH).toBe(8);

    // A second refresh returns only one published parameter now (the other
    // reverted to unpublished) — WIND_GATE_ENHANCED_MIN_KMH must fall back to
    // the default, not stay stuck on the first refresh's value.
    const second = mockSupabase([{ parameter_code: 'STONE_CUTTING_WIND_STOP_KMH', value: 12 }]);
    await refreshRuleParameters(second);
    expect(getRuleParameters().WIND_GATE_ENHANCED_MIN_KMH).toBe(DEFAULT_RULE_PARAMETERS.WIND_GATE_ENHANCED_MIN_KMH);
  });

  // getActiveParameterVersionIds is captured after refresh and passed through
  // to final_decisions.rule_parameter_version_snapshot — see evaluateProject.ts.
  describe('getActiveParameterVersionIds', () => {
    it('تُرجع كائناً فارغاً قبل أي refresh', () => {
      expect(getActiveParameterVersionIds()).toEqual({});
    });

    it('تمتلئ بمعرّف النسخة لكل معامل منشور بعد refresh ناجح', async () => {
      const supabase = mockSupabase([
        { id: 'v-1', parameter_code: 'STONE_CUTTING_WIND_STOP_KMH', value: 12 },
        { id: 'v-2', parameter_code: 'WIND_GATE_ENHANCED_MIN_KMH', value: 8 },
      ]);
      await refreshRuleParameters(supabase);
      expect(getActiveParameterVersionIds()).toEqual({
        STONE_CUTTING_WIND_STOP_KMH: 'v-1',
        WIND_GATE_ENHANCED_MIN_KMH: 'v-2',
      });
    });

    it('معامل بلا نسخة PUBLISHED (يستخدم code_default_value) غائب من الخريطة — لا مفتاح بقيمة فارغة', async () => {
      const supabase = mockSupabase([{ id: 'v-1', parameter_code: 'STONE_CUTTING_WIND_STOP_KMH', value: 12 }]);
      await refreshRuleParameters(supabase);
      const versionIds = getActiveParameterVersionIds();
      expect(versionIds.STONE_CUTTING_WIND_STOP_KMH).toBe('v-1');
      expect('WIND_GATE_ENHANCED_MIN_KMH' in versionIds).toBe(false);
    });

    it('فشل الاستعلام لا يغيّر بصمة المعرّفات — تبقى آخر حالة معروفة جيدة', async () => {
      const supabaseOk = mockSupabase([{ id: 'v-1', parameter_code: 'STONE_CUTTING_WIND_STOP_KMH', value: 12 }]);
      await refreshRuleParameters(supabaseOk);
      expect(getActiveParameterVersionIds().STONE_CUTTING_WIND_STOP_KMH).toBe('v-1');

      const supabaseFail = mockSupabase(null, { message: 'db down' });
      await refreshRuleParameters(supabaseFail);
      expect(getActiveParameterVersionIds().STONE_CUTTING_WIND_STOP_KMH).toBe('v-1');
    });

    it('resetRuleParametersForTests يعيد بصمة المعرّفات لكائن فارغ أيضاً', async () => {
      const supabase = mockSupabase([{ id: 'v-1', parameter_code: 'STONE_CUTTING_WIND_STOP_KMH', value: 12 }]);
      await refreshRuleParameters(supabase);
      expect(getActiveParameterVersionIds().STONE_CUTTING_WIND_STOP_KMH).toBe('v-1');

      resetRuleParametersForTests();
      expect(getActiveParameterVersionIds()).toEqual({});
    });
  });

  // withRuleParametersLock guarantees sequential (non-interleaved) execution
  // of the critical section from refresh through value consumption across
  // concurrent evaluateProject cycles — see the full comment in
  // evaluateProject.ts for the real scenario (3 independent call sites that
  // can interleave on the same instance).
  describe('withRuleParametersLock', () => {
    it('استدعاءان متزامنان يُنفَّذان بالتسلسل — الثاني ينتظر انتهاء الأول كاملاً قبل البدء', async () => {
      const executionOrder: string[] = [];
      const first = withRuleParametersLock(async () => {
        executionOrder.push('first:start');
        await new Promise((resolve) => setTimeout(resolve, 20));
        executionOrder.push('first:end');
        return 'first-result';
      });
      const second = withRuleParametersLock(async () => {
        executionOrder.push('second:start');
        executionOrder.push('second:end');
        return 'second-result';
      });

      const [firstResult, secondResult] = await Promise.all([first, second]);
      expect(firstResult).toBe('first-result');
      expect(secondResult).toBe('second-result');
      // second:start only appears after first:end — no interleaving at all.
      expect(executionOrder).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
    });

    it('refreshRuleParameters + قراءة القيم داخل نفس القفل لا تتأثر بـrefresh متزامن من قفل آخر', async () => {
      const slowSupabase = mockSupabase([{ id: 'v-slow', parameter_code: 'STONE_CUTTING_WIND_STOP_KMH', value: 11 }]);
      const fastSupabase = mockSupabase([{ id: 'v-fast', parameter_code: 'STONE_CUTTING_WIND_STOP_KMH', value: 22 }]);

      // First lock: refresh, then a delayed "consumption" (simulates a real
      // await between refresh and consumption, like intervening DB queries
      // in evaluateProject.ts).
      const firstCapturedValue: { value?: number; versionId?: string } = {};
      const first = withRuleParametersLock(async () => {
        await refreshRuleParameters(slowSupabase);
        await new Promise((resolve) => setTimeout(resolve, 20));
        firstCapturedValue.value = getRuleParameters().STONE_CUTTING_WIND_STOP_KMH;
        firstCapturedValue.versionId = getActiveParameterVersionIds().STONE_CUTTING_WIND_STOP_KMH;
      });

      // Second lock (attempted concurrency): without the lock, this refresh
      // would change `current` out from under the first lock while it waits.
      const secondCapturedValue: { value?: number; versionId?: string } = {};
      const second = withRuleParametersLock(async () => {
        await refreshRuleParameters(fastSupabase);
        secondCapturedValue.value = getRuleParameters().STONE_CUTTING_WIND_STOP_KMH;
        secondCapturedValue.versionId = getActiveParameterVersionIds().STONE_CUTTING_WIND_STOP_KMH;
      });

      await Promise.all([first, second]);

      // The first lock must see its own value (11/v-slow) despite the delay,
      // not a value "leaked" from the second lock during its wait.
      expect(firstCapturedValue.value).toBe(11);
      expect(firstCapturedValue.versionId).toBe('v-slow');
      // The second lock (ran only after the first fully finished) sees its own value.
      expect(secondCapturedValue.value).toBe(22);
      expect(secondCapturedValue.versionId).toBe('v-fast');
    });

    it('فشل دالة داخل القفل لا يمنع الاستدعاء التالي من البدء', async () => {
      const failing = withRuleParametersLock(async () => {
        throw new Error('boom');
      });
      await expect(failing).rejects.toThrow('boom');

      const after = await withRuleParametersLock(async () => 'recovered');
      expect(after).toBe('recovered');
    });
  });
});
