import { describe, it, expect, vi } from 'vitest';
import { buildDustInput, resolveFreshProjectDevice, type FreshDeviceReading } from './dustEvaluation';

// =====================================================================
// اختبارات مسار "قراءة جهاز حية" — راجع خطة "ربط أجهزة الرصد بالمشاريع".
// buildDustInput: التوصيل الصحيح لحقول device* من FreshDeviceReading.
// resolveFreshProjectDevice: اختيار أحدث جهاز نشط بقراءة حديثة، والتجاهل
// الصحيح لجهاز قديم/غير نشط/معدوم.
// =====================================================================

const baseRow = {
  activity_type: 'GENERAL_OUTDOOR_WORK',
  has_earthworks: false,
  internal_dirt_roads: false,
  heavy_equipment_movement: false,
  loose_materials: false,
  large_exposed_area: false,
  dry_surface: false,
  surface_wet: false,
  watering_available: true,
  stockpiles_covered: true,
  speed_limit_applied: true,
  wheel_wash_available: true,
  dust_screens_available: true,
  field_monitoring_available: true,
  receptor_type: 'NONE_NEARBY',
  receptor_distance: 'OVER_500M',
  receptor_is_downwind: false,
  visible_dust_plume_reported: false,
  open_concrete_pour: false,
};

const baseProject = { latitude: 24.7136, longitude: 46.6753 };

function freshDevice(overrides: Partial<FreshDeviceReading> = {}): FreshDeviceReading {
  return {
    last_wind_speed_kmh: 22,
    last_wind_gust_kmh: 30,
    last_wind_direction_deg: 180,
    last_pm10: 260,
    last_pm25: 90,
    last_visibility_m: 1200,
    ...overrides,
  };
}

describe('buildDustInput — توصيل قراءة الجهاز إلى DustEngineInput', () => {
  it('بلا freshDevice، كل حقول device* تكون null (سلوك قديم محفوظ تماماً)', () => {
    const input = buildDustInput(baseRow, baseProject);
    expect(input.deviceWindSpeedKmh).toBeNull();
    expect(input.deviceWindGustKmh).toBeNull();
    expect(input.deviceWindDirectionDeg).toBeNull();
    expect(input.devicePm10).toBeNull();
    expect(input.devicePm25).toBeNull();
    expect(input.deviceVisibilityM).toBeNull();
  });

  it('بوجود freshDevice، تُملأ حقول device* من قيمه مباشرة', () => {
    const input = buildDustInput(baseRow, baseProject, freshDevice());
    expect(input.deviceWindSpeedKmh).toBe(22);
    expect(input.deviceWindGustKmh).toBe(30);
    expect(input.deviceWindDirectionDeg).toBe(180);
    expect(input.devicePm10).toBe(260);
    expect(input.devicePm25).toBe(90);
    expect(input.deviceVisibilityM).toBe(1200);
  });

  it('freshDevice=null صراحةً (جهاز موجود لكن قديم) يساوي عدم تمرير المعامل أصلاً', () => {
    const withNull = buildDustInput(baseRow, baseProject, null);
    const withoutParam = buildDustInput(baseRow, baseProject);
    expect(withNull.deviceWindSpeedKmh).toBe(withoutParam.deviceWindSpeedKmh);
    expect(withNull.devicePm10).toBe(withoutParam.devicePm10);
  });

  it('حقول device* لا تتعارض مع onsite_* — كلاهما يُمرَّر، الأولوية تُحسَم لاحقاً في computeDviResult', () => {
    const row = { ...baseRow, onsite_pm10: 900, onsite_visibility_m: 800 };
    const input = buildDustInput(row, baseProject, freshDevice({ last_pm10: 260, last_visibility_m: 1200 }));
    expect(input.onsitePm10).toBe(900);
    expect(input.devicePm10).toBe(260);
  });
});

describe('resolveFreshProjectDevice — اختيار أحدث قراءة جهاز حية للمشروع', () => {
  // عميل Supabase مموّه بأقل ما يلزم من السلسلة المستخدمة فعلياً في
  // resolveFreshProjectDevice: from().select().eq().eq().not().order().limit().maybeSingle()
  function mockSupabase(row: any) {
    const chain: any = {
      select: () => chain,
      eq: () => chain,
      not: () => chain,
      order: () => chain,
      limit: () => chain,
      maybeSingle: async () => ({ data: row }),
    };
    return { from: vi.fn(() => chain) };
  }

  it('يرجع null إن لم يوجد أي صف (لا أجهزة مسجَّلة أصلاً)', async () => {
    const supabase = mockSupabase(null);
    const result = await resolveFreshProjectDevice(supabase, 'project-1');
    expect(result).toBeNull();
  });

  it('يرجع null إن كانت last_reading_at أقدم من 20 دقيقة (قراءة غير حديثة)', async () => {
    const staleTime = new Date(Date.now() - 25 * 60000).toISOString();
    const supabase = mockSupabase({
      last_reading_at: staleTime,
      last_wind_speed_kmh: 40,
      last_wind_gust_kmh: null,
      last_wind_direction_deg: null,
      last_pm10: null,
      last_pm25: null,
      last_visibility_m: null,
    });
    const result = await resolveFreshProjectDevice(supabase, 'project-1');
    expect(result).toBeNull();
  });

  it('يرجع القراءة عند وجود صف حديث (ضمن 20 دقيقة)', async () => {
    const freshTime = new Date(Date.now() - 5 * 60000).toISOString();
    const supabase = mockSupabase({
      last_reading_at: freshTime,
      last_wind_speed_kmh: 18,
      last_wind_gust_kmh: 25,
      last_wind_direction_deg: 90,
      last_pm10: 150,
      last_pm25: 60,
      last_visibility_m: 3000,
    });
    const result = await resolveFreshProjectDevice(supabase, 'project-1');
    expect(result).toEqual({
      last_wind_speed_kmh: 18,
      last_wind_gust_kmh: 25,
      last_wind_direction_deg: 90,
      last_pm10: 150,
      last_pm25: 60,
      last_visibility_m: 3000,
    });
  });

  it('حدّ العتبة (20 دقيقة بالضبط) يُعامَل كغير طازج (>، لا >=)', async () => {
    const exactlyAtThreshold = new Date(Date.now() - 20 * 60000 - 1000).toISOString();
    const supabase = mockSupabase({
      last_reading_at: exactlyAtThreshold,
      last_wind_speed_kmh: 10,
      last_wind_gust_kmh: null,
      last_wind_direction_deg: null,
      last_pm10: null,
      last_pm25: null,
      last_visibility_m: null,
    });
    const result = await resolveFreshProjectDevice(supabase, 'project-1');
    expect(result).toBeNull();
  });
});
