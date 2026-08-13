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

// خطأ مكتشَف ومُصلَح (مراجعة خبير خارجي — "واجهة إدارة القواعد للعرض فقط؛
// لا يوجد نظام حقيقي يدعم إنشاء نسخة قاعدة، النشر الذري، منع تعديل نسخة
// منشورة، التراجع لنسخة سابقة"): هذا الملف يختبر الطبقة التي تجعل العتبات
// الرقمية في rulebook.ts/engine.ts قابلة للنشر فعلياً — getRuleParameters
// تبدأ بالافتراضي المطابق للثوابت القديمة، وrefreshRuleParameters تستبدلها
// بآخر نسخة PUBLISHED من قاعدة البيانات.

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

  // خطأ مكتشَف (مراجعة تدقيق — "لا تُحفظ معرفات نسخ المعاملات المستخدمة مع
  // القرار"): getActiveParameterVersionIds تُلتقَط بعد refresh وتُمرَّر حتى
  // final_decisions.rule_parameter_version_snapshot — راجع evaluateProject.ts.
  describe('getActiveParameterVersionIds', () => {
    it('تُرجع كائناً فارغاً قبل أي refresh', () => {
      expect(getActiveParameterVersionIds()).toEqual({});
    });

    it('تمتلئ بمعرّف النسخة لكل معامل منشور بعد refresh ناجح', async () => {
      const supabase = mockSupabase([
        { id: 'v-1', parameter_code: 'STONE_CUTTING_WIND_STOP_KMH', value: 12 },
        { id: 'v-2', parameter_code: 'UNPAVED_SPEED_LIMIT_KMH', value: 8 },
      ]);
      await refreshRuleParameters(supabase);
      expect(getActiveParameterVersionIds()).toEqual({
        STONE_CUTTING_WIND_STOP_KMH: 'v-1',
        UNPAVED_SPEED_LIMIT_KMH: 'v-2',
      });
    });

    it('معامل بلا نسخة PUBLISHED (يستخدم code_default_value) غائب من الخريطة — لا مفتاح بقيمة فارغة', async () => {
      const supabase = mockSupabase([{ id: 'v-1', parameter_code: 'STONE_CUTTING_WIND_STOP_KMH', value: 12 }]);
      await refreshRuleParameters(supabase);
      const versionIds = getActiveParameterVersionIds();
      expect(versionIds.STONE_CUTTING_WIND_STOP_KMH).toBe('v-1');
      expect('UNPAVED_SPEED_LIMIT_KMH' in versionIds).toBe(false);
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

  // خطأ سباق تزامن حرج مكتشَف ومُصلَح (طلب صريح من المستخدم — "لقطة القواعد
  // قابلة لسباق تزامن، ولقطة المدخلات لا تكفي لإعادة إنتاج القرار تاريخياً"):
  // withRuleParametersLock يضمن تنفيذاً تسلسلياً (لا متشابكاً) لكل القسم
  // الحرج من refresh حتى استهلاك القيم عبر دورات evaluateProject المتزامنة
  // — راجع تعليق evaluateProject.ts الكامل للسيناريو الفعلي (3 مصادر
  // استدعاء مستقلة قد تتشابك على نفس الـinstance).
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
      // second:start لا يظهر إلا بعد first:end — لا تشابك بينهما إطلاقاً.
      expect(executionOrder).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
    });

    it('refreshRuleParameters + قراءة القيم داخل نفس القفل لا تتأثر بـrefresh متزامن من قفل آخر', async () => {
      const slowSupabase = mockSupabase([{ id: 'v-slow', parameter_code: 'STONE_CUTTING_WIND_STOP_KMH', value: 11 }]);
      const fastSupabase = mockSupabase([{ id: 'v-fast', parameter_code: 'STONE_CUTTING_WIND_STOP_KMH', value: 22 }]);

      // القفل الأول: refresh ثم "استهلاك" متأخر (يحاكي await فعلي بين
      // refresh والاستهلاك، مثل استعلامات DB الوسيطة في evaluateProject.ts).
      const firstCapturedValue: { value?: number; versionId?: string } = {};
      const first = withRuleParametersLock(async () => {
        await refreshRuleParameters(slowSupabase);
        await new Promise((resolve) => setTimeout(resolve, 20));
        firstCapturedValue.value = getRuleParameters().STONE_CUTTING_WIND_STOP_KMH;
        firstCapturedValue.versionId = getActiveParameterVersionIds().STONE_CUTTING_WIND_STOP_KMH;
      });

      // القفل الثاني (محاولة تزامن): لولا القفل، refresh هذا كان سيُغيِّر
      // current تحت أقدام القفل الأول أثناء انتظاره.
      const secondCapturedValue: { value?: number; versionId?: string } = {};
      const second = withRuleParametersLock(async () => {
        await refreshRuleParameters(fastSupabase);
        secondCapturedValue.value = getRuleParameters().STONE_CUTTING_WIND_STOP_KMH;
        secondCapturedValue.versionId = getActiveParameterVersionIds().STONE_CUTTING_WIND_STOP_KMH;
      });

      await Promise.all([first, second]);

      // القفل الأول يجب أن يرى قيمته الخاصة (11/v-slow) رغم التأخير، لا
      // قيمة القفل الثاني التي "تسرّبت" أثناء انتظاره.
      expect(firstCapturedValue.value).toBe(11);
      expect(firstCapturedValue.versionId).toBe('v-slow');
      // القفل الثاني (نفّذ بعد انتهاء الأول بالكامل) يرى قيمته الخاصة.
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
