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

vi.mock('@/app/utils/dust-compliance-engine', async () => {
  const actual = await vi.importActual('@/app/utils/dust-compliance-engine');
  return {
    ...actual,
    refreshRuleParameters: vi.fn(async () => undefined),
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

  it('كسارة في مشروع دون الفئة الثالثة → blocked:true', async () => {
    tableResults.projects = { data: { site_area_m2: 1000, daily_truck_movements: 5 }, error: null };
    const { validateDustUnitPlacement } = await import('./dustPlacementValidation');
    const result = await validateDustUnitPlacement({
      projectId: 'p1',
      lat: 24.7,
      lng: 46.6,
      activityType: 'CRUSHER',
    });
    expect(result.verified).toBe(true);
    if (result.verified) expect(result.blocked).toBe(true);
  });

  it('محطة خلط + مستقبل حساس على 100م → blocked:true', async () => {
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
      expect(result.blocked).toBe(true);
      expect(result.riskClass).toBeUndefined();
    }
  });

  it('OSM يكتشف معلَماً قريباً → blocked:true مع سبب مضمَّن', async () => {
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
      expect(result.blocked).toBe(true);
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
});
