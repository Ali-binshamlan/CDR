import { describe, it, expect, vi, beforeEach } from 'vitest';

type TableResult = { data: unknown; error: { message: string } | null };
const tableResults: Record<string, TableResult> = {};

function makeChain(tableName: string) {
  const result = tableResults[tableName] ?? { data: null, error: null };
  const chain: Record<string, unknown> = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => ({ data: result.data ?? null, error: result.error ?? null }),
    then: (resolve: (value: { data: unknown; error: unknown }) => void) =>
      resolve({ data: result.data ?? null, error: result.error ?? null }),
  };
  return chain;
}

vi.mock('@/app/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from: (tableName: string) => makeChain(tableName),
  },
}));

let refreshDelayMs = 0;
const refreshOrder: string[] = [];
vi.mock('@/app/utils/dust-compliance-engine', async () => {
  const actual = await vi.importActual('@/app/utils/dust-compliance-engine');
  return {
    ...actual,
    // مؤخَّرة اختيارياً (refreshDelayMs) لمحاكاة زمن استعلام DB حقيقي بين
    // refresh والاستهلاك — ضرورية لاختبار withRuleParametersLock أدناه
    // (بلا تأخير، لا فرصة عملية ليتشابك استدعاءان في نفس event loop tick).
    refreshRuleParameters: vi.fn(async () => {
      refreshOrder.push('refresh:start');
      if (refreshDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, refreshDelayMs));
      refreshOrder.push('refresh:end');
    }),
  };
});

let mockOsmWarning: string | null = null;
vi.mock('@/app/utils/geo/overpassReceptors', () => ({
  buildOsmProximityWarning: async () => mockOsmWarning,
}));

describe('validateDustUnitPlacement', () => {
  beforeEach(() => {
    for (const key of Object.keys(tableResults)) delete tableResults[key];
    tableResults.projects = { data: { site_area_m2: 6000, daily_truck_movements: 10 }, error: null };
    mockOsmWarning = null;
    refreshDelayMs = 0;
    refreshOrder.length = 0;
  });

  it('كسارة في مشروع فئة ثالثة بلا مستقبلات → verified:true, blocked:false', async () => {
    const { validateDustUnitPlacement } = await import('./dustPlacementValidation');
    const result = await validateDustUnitPlacement({
      projectId: 'p1',
      lat: 24.7,
      lng: 46.6,
      activityType: 'CRUSHER',
    });
    expect(result.verified).toBe(true);
    if (result.verified) {
      expect(result.blocked).toBe(false);
      expect(result.riskClass).toBe('CATEGORY_III_HIGH');
    }
  });

  // قرار مُعاد النظر فيه بالكامل (طلب صريح من المستخدم — "المستقبلات الحساسة
  // لا تدخل ضمن قرارات الإيقاف"، يشمل صراحة منع حفظ الموقع على الخريطة):
  // blocked أصبحت false دائماً — reasonsAr تبقى تُبنى وتُعاد كتنبيه نصي بحت،
  // بلا منع فعلي للحفظ. راجع dustPlacementValidation.ts.
  it('كسارة في مشروع دون الفئة الثالثة → تنبيه نصي فقط (blocked:false)، لا يزال reasonsAr يوثّق السبب', async () => {
    tableResults.projects = { data: { site_area_m2: 1000, daily_truck_movements: 5 }, error: null };
    const { validateDustUnitPlacement } = await import('./dustPlacementValidation');
    const result = await validateDustUnitPlacement({
      projectId: 'p1',
      lat: 24.7,
      lng: 46.6,
      activityType: 'CRUSHER',
    });
    expect(result.verified).toBe(true);
    if (result.verified) {
      expect(result.blocked).toBe(false);
      expect(result.reasonsAr.length).toBeGreaterThan(0);
    }
  });

  it('محطة خلط + مستقبل حساس على 100م → تنبيه نصي فقط (blocked:false)', async () => {
    tableResults.sensitive_receptors = {
      data: [{ id: 'r1', name: 'مسجد', receptor_type: 'MOSQUE', lat: 24.7009, lng: 46.6 }],
      error: null,
    };
    const { validateDustUnitPlacement } = await import('./dustPlacementValidation');
    const result = await validateDustUnitPlacement({
      projectId: 'p1',
      lat: 24.7,
      lng: 46.6,
      activityType: 'BATCHING_PLANT',
    });
    expect(result.verified).toBe(true);
    if (result.verified) {
      expect(result.blocked).toBe(false);
      expect(result.reasonsAr.length).toBeGreaterThan(0);
      expect(result.riskClass).toBeUndefined();
    }
  });

  it('OSM يكتشف معلَماً قريباً → تنبيه نصي فقط (blocked:false) مع سبب مضمَّن', async () => {
    mockOsmWarning = 'تحذير: تم اكتشاف معلَم قريب محتمل الحساسية عبر خرائط OpenStreetMap.';
    const { validateDustUnitPlacement } = await import('./dustPlacementValidation');
    const result = await validateDustUnitPlacement({
      projectId: 'p1',
      lat: 24.7,
      lng: 46.6,
      activityType: 'BATCHING_PLANT',
    });
    expect(result.verified).toBe(true);
    if (result.verified) {
      expect(result.blocked).toBe(false);
      expect(result.reasonsAr).toContain(mockOsmWarning);
    }
  });

  it('فشل استعلام sensitive_receptors → verified:false، لا أمان كاذب', async () => {
    tableResults.sensitive_receptors = { data: null, error: { message: 'db down' } };
    const { validateDustUnitPlacement } = await import('./dustPlacementValidation');
    const result = await validateDustUnitPlacement({
      projectId: 'p1',
      lat: 24.7,
      lng: 46.6,
      activityType: 'CRUSHER',
    });
    expect(result.verified).toBe(false);
  });

  it('فشل استعلام المشروع (كسارة فقط) → verified:false', async () => {
    tableResults.projects = { data: null, error: { message: 'db down' } };
    const { validateDustUnitPlacement } = await import('./dustPlacementValidation');
    const result = await validateDustUnitPlacement({
      projectId: 'p1',
      lat: 24.7,
      lng: 46.6,
      activityType: 'CRUSHER',
    });
    expect(result.verified).toBe(false);
  });

  // خطأ تزامن مكتشَف ومُصلَح (مراجعة كود خبير ثانية — "القفل الجديد تحسن
  // جيد، لكن مسار فحص الموقع يستطيع تحديث الحالة العامة خارج القفل"):
  // validateDustUnitPlacement كانت تستدعي refreshRuleParameters مباشرة بلا
  // withRuleParametersLock — يمكن أن تتشابك مع دورة evaluateProject مقفَلة
  // أخرى على نفس current/currentVersionIds العالميتين. الإصلاح يُدخِل قسم
  // refresh+قراءة القيم في withRuleParametersLock — هذا الاختبار يثبت أن
  // استدعاءً خارجياً لـwithRuleParametersLock الآن يحجز الدور فعلياً، فلا
  // يبدأ refresh الخاص بـvalidateDustUnitPlacement إلا بعد تحرّر القفل.
  it('withRuleParametersLock من مستدعٍ خارجي يحجز الدور — validateDustUnitPlacement تنتظر تحرّره، لا تتشابك معه', async () => {
    const { withRuleParametersLock } = await import('@/app/utils/dust-compliance-engine');
    const { validateDustUnitPlacement } = await import('./dustPlacementValidation');

    refreshDelayMs = 20;
    const executionOrder: string[] = [];

    const externalLock = withRuleParametersLock(async () => {
      executionOrder.push('external:start');
      await new Promise((resolve) => setTimeout(resolve, 30));
      executionOrder.push('external:end');
      return 'external-result';
    });

    const placement = validateDustUnitPlacement({
      projectId: 'p1',
      lat: 24.7,
      lng: 46.6,
      activityType: 'CRUSHER',
    }).then((result) => {
      executionOrder.push('placement:done');
      return result;
    });

    await Promise.all([externalLock, placement]);

    // external:end يجب أن يظهر قبل أي أثر لـplacement (refresh لم يبدأ
    // إلا بعد تحرّر القفل الخارجي بالكامل) — لا تشابك.
    expect(executionOrder[0]).toBe('external:start');
    expect(executionOrder[1]).toBe('external:end');
    expect(executionOrder[2]).toBe('placement:done');
    expect(refreshOrder).toEqual(['refresh:start', 'refresh:end']);
  });
});
