import { describe, it, expect, vi } from 'vitest';
import { buildDustInput, resolveFreshProjectDevice, type FreshDeviceReading } from './dustEvaluation';

// =====================================================================
// اختبارات مسار "قراءة جهاز حية" — راجع خطة "عزل مصادر القراءة: محطة
// محددة فقط أو API فقط، بلا أي تعويض بينهما".
// buildDustInput: التوصيل الصحيح لحقول device*/hasDeviceLink من
// FreshDeviceReading + device_id. resolveFreshProjectDevice: يرجع آخر
// قراءة معروفة للجهاز المطلوب دائماً (حتى لو قديمة) — لا إسقاط صامت
// بعد الآن، القِدم مسؤولية طبقة العرض.
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
    last_relative_humidity_percent: 45,
    last_temperature_c: 38,
    last_reading_at: new Date().toISOString(),
    last_pm10_at: new Date().toISOString(),
    last_wind_speed_at: new Date().toISOString(),
    last_wind_gust_at: new Date().toISOString(),
    last_wind_direction_at: new Date().toISOString(),
    last_visibility_at: new Date().toISOString(),
    last_relative_humidity_at: new Date().toISOString(),
    last_temperature_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('buildDustInput — توصيل قراءة الجهاز وhasDeviceLink إلى DustEngineInput', () => {
  it('بلا device_id على الصف، hasDeviceLink=false وكل حقول device* تكون null', () => {
    const input = buildDustInput(baseRow, baseProject);
    expect(input.hasDeviceLink).toBe(false);
    expect(input.deviceWindSpeedKmh).toBeNull();
    expect(input.deviceWindGustKmh).toBeNull();
    expect(input.deviceWindDirectionDeg).toBeNull();
    expect(input.devicePm10).toBeNull();
    expect(input.devicePm25).toBeNull();
    expect(input.deviceVisibilityM).toBeNull();
    expect(input.deviceRelativeHumidityPercent).toBeNull();
    expect(input.deviceTemperatureC).toBeNull();
    expect(input.deviceLastReadingAt).toBeNull();
  });

  it('بوجود device_id + freshDevice، hasDeviceLink=true وتُملأ حقول device* من قيمه مباشرة', () => {
    const row = { ...baseRow, device_id: 'device-1' };
    const input = buildDustInput(row, baseProject, freshDevice());
    expect(input.hasDeviceLink).toBe(true);
    expect(input.deviceWindSpeedKmh).toBe(22);
    expect(input.deviceWindGustKmh).toBe(30);
    expect(input.deviceWindDirectionDeg).toBe(180);
    expect(input.devicePm10).toBe(260);
    expect(input.devicePm25).toBe(90);
    expect(input.deviceVisibilityM).toBe(1200);
    expect(input.deviceRelativeHumidityPercent).toBe(45);
    expect(input.deviceTemperatureC).toBe(38);
  });

  it('device_id موجود لكن freshDevice غاب (لا صف جهاز نشط) — hasDeviceLink يبقى true رغم فراغ الحقول', () => {
    const row = { ...baseRow, device_id: 'device-1' };
    const input = buildDustInput(row, baseProject, null);
    expect(input.hasDeviceLink).toBe(true);
    expect(input.devicePm10).toBeNull();
    expect(input.deviceLastReadingAt).toBeNull();
  });

  it('onsite_* يبقى يُمرَّر في DustEngineInput (توافقية) لكن لم يعد يؤثر على الدمج في mergeDustReading', () => {
    const row = { ...baseRow, device_id: 'device-1', onsite_pm10: 900, onsite_visibility_m: 800 };
    const input = buildDustInput(row, baseProject, freshDevice({ last_pm10: 260, last_visibility_m: 1200 }));
    expect(input.onsitePm10).toBe(900);
    expect(input.devicePm10).toBe(260);
  });

  // خطأ مكتشَف ومُصلَح: last_reading_at عمود مشترك يتحدّث على أي push جزئي
  // من الجهاز (حتى بلا PM10) — last_pm10_at عمود منفصل يعكس حداثة PM10
  // تحديداً. يجب أن ينقلهما buildDustInput لحقلين منفصلين تماماً في
  // DustEngineInput، لا حقل واحد مشترك.
  it('devicePm10LastReadingAt ينقل last_pm10_at بمعزل تام عن deviceLastReadingAt (last_reading_at)', () => {
    const row = { ...baseRow, device_id: 'device-1' };
    const generalReadingAt = '2026-07-28T10:00:00.000Z'; // آخر اتصال عام (حرارة فقط مثلاً)
    const pm10ReadingAt = '2026-07-28T09:30:00.000Z'; // آخر PM10 فعلي، أقدم
    const input = buildDustInput(
      row,
      baseProject,
      freshDevice({ last_reading_at: generalReadingAt, last_pm10_at: pm10ReadingAt })
    );
    expect(input.deviceLastReadingAt).toBe(generalReadingAt);
    expect(input.devicePm10LastReadingAt).toBe(pm10ReadingAt);
    expect(input.devicePm10LastReadingAt).not.toBe(input.deviceLastReadingAt);
  });

  it('last_pm10_at=null (جهاز لم يرسل PM10 قط) → devicePm10LastReadingAt يبقى null رغم last_reading_at حديث', () => {
    const row = { ...baseRow, device_id: 'device-1' };
    const input = buildDustInput(row, baseProject, freshDevice({ last_pm10_at: null }));
    expect(input.deviceLastReadingAt).not.toBeNull();
    expect(input.devicePm10LastReadingAt).toBeNull();
  });
});

describe('resolveFreshProjectDevice — اختيار أحدث قراءة جهاز حية للمشروع', () => {
  // عميل Supabase مموّه بأقل ما يلزم من السلسلة المستخدمة فعلياً في
  // resolveFreshProjectDevice: from().select().eq().eq().not().order().limit().maybeSingle()
  // (أو .eq(id) بدل .order() عند تمرير deviceId — راجع chain.eq أدناه).
  function mockSupabase(row: any) {
    const eqCalls: any[] = [];
    const chain: any = {
      select: () => chain,
      eq: (...args: any[]) => { eqCalls.push(args); return chain; },
      not: () => chain,
      order: () => chain,
      limit: () => chain,
      maybeSingle: async () => ({ data: row }),
    };
    return { from: vi.fn(() => chain), _eqCalls: eqCalls };
  }

  it('يرجع null إن لم يوجد أي صف (لا أجهزة مسجَّلة أصلاً)', async () => {
    const supabase = mockSupabase(null);
    const result = await resolveFreshProjectDevice(supabase, 'project-1');
    expect(result).toBeNull();
  });

  it('يرجع القراءة حتى لو كانت last_reading_at أقدم من 20 دقيقة — لا إسقاط صامت بعد الآن', async () => {
    const staleTime = new Date(Date.now() - 25 * 60000).toISOString();
    const supabase = mockSupabase({
      last_reading_at: staleTime,
      last_wind_speed_kmh: 40,
      last_wind_gust_kmh: null,
      last_wind_direction_deg: null,
      last_pm10: null,
      last_pm25: null,
      last_visibility_m: null,
      last_relative_humidity_percent: null,
      last_temperature_c: null,
    });
    const result = await resolveFreshProjectDevice(supabase, 'project-1');
    expect(result).not.toBeNull();
    expect(result?.last_wind_speed_kmh).toBe(40);
    expect(result?.last_reading_at).toBe(staleTime);
  });

  it('يرجع القراءة عند وجود صف حديث (ضمن 20 دقيقة) — يشمل last_reading_at', async () => {
    const freshTime = new Date(Date.now() - 5 * 60000).toISOString();
    const supabase = mockSupabase({
      last_reading_at: freshTime,
      last_wind_speed_kmh: 18,
      last_wind_gust_kmh: 25,
      last_wind_direction_deg: 90,
      last_pm10: 150,
      last_pm25: 60,
      last_visibility_m: 3000,
      last_relative_humidity_percent: 55,
      last_temperature_c: 41,
    });
    const result = await resolveFreshProjectDevice(supabase, 'project-1');
    expect(result).toEqual({
      last_wind_speed_kmh: 18,
      last_wind_gust_kmh: 25,
      last_wind_direction_deg: 90,
      last_pm10: 150,
      last_pm25: 60,
      last_visibility_m: 3000,
      last_relative_humidity_percent: 55,
      last_temperature_c: 41,
      last_reading_at: freshTime,
      last_pm10_at: null,
      last_wind_speed_at: null,
      last_wind_gust_at: null,
      last_wind_direction_at: null,
      last_visibility_at: null,
      last_relative_humidity_at: null,
      last_temperature_at: null,
    });
  });

  it('قراءة قديمة جداً (أياماً) تُرجَع أيضاً — القِدم مسؤولية طبقة العرض لا هذه الدالة', async () => {
    const veryOldTime = new Date(Date.now() - 5 * 24 * 3600000).toISOString();
    const supabase = mockSupabase({
      last_reading_at: veryOldTime,
      last_wind_speed_kmh: 10,
      last_wind_gust_kmh: null,
      last_wind_direction_deg: null,
      last_pm10: null,
      last_pm25: null,
      last_visibility_m: null,
      last_relative_humidity_percent: null,
      last_temperature_c: null,
    });
    const result = await resolveFreshProjectDevice(supabase, 'project-1');
    expect(result).not.toBeNull();
    expect(result?.last_reading_at).toBe(veryOldTime);
  });

  it('مع تمرير deviceId، يُفلتر الاستعلام بـ.eq("id", deviceId) بدل أحدث جهاز بالمشروع', async () => {
    const freshTime = new Date(Date.now() - 5 * 60000).toISOString();
    const supabase = mockSupabase({
      last_reading_at: freshTime,
      last_wind_speed_kmh: 12,
      last_wind_gust_kmh: null,
      last_wind_direction_deg: null,
      last_pm10: null,
      last_pm25: null,
      last_visibility_m: null,
      last_relative_humidity_percent: null,
      last_temperature_c: null,
    });
    const result = await resolveFreshProjectDevice(supabase, 'project-1', 'device-42');
    expect(result?.last_wind_speed_kmh).toBe(12);
    // .eq('project_id', ...) و .eq('is_active', true) دائماً، بالإضافة إلى
    // .eq('id', 'device-42') تحديداً عند تمرير deviceId — تأكيد أن التقييد
    // بمحطة محددة يحدث فعلاً، لا فقط قبول المعامل بصمت.
    expect(supabase._eqCalls).toContainEqual(['id', 'device-42']);
  });

  it('بلا deviceId (أو null)، لا يُستدعى .eq("id", ...) — يبقى السلوك القديم (أحدث جهاز بالمشروع)', async () => {
    const freshTime = new Date(Date.now() - 5 * 60000).toISOString();
    const supabase = mockSupabase({
      last_reading_at: freshTime,
      last_wind_speed_kmh: 12,
      last_wind_gust_kmh: null,
      last_wind_direction_deg: null,
      last_pm10: null,
      last_pm25: null,
      last_visibility_m: null,
      last_relative_humidity_percent: null,
      last_temperature_c: null,
    });
    await resolveFreshProjectDevice(supabase, 'project-1', null);
    const idCalls = supabase._eqCalls.filter((args: any[]) => args[0] === 'id');
    expect(idCalls.length).toBe(0);
  });
});
