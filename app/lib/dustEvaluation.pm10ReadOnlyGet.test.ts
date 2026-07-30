import { describe, it, expect, vi } from 'vitest';
import { computeDustComplianceResults } from './dustEvaluation';

// =====================================================================
// اختبار قبول: فتح صفحة GET (لا يمرر persistPm10Reading) يجب ألا يكتب أي
// عينة جديدة في pm10_readings_history — راجع ملاحظة مراجعة خارجية: كان
// computeDustComplianceResults يُدرِج قراءة PM10 كأثر جانبي دائم بصرف
// النظر عن استدعاء GET أم POST، فيُطيل مدة إثبات "استمرار مخالفة" لمجرد
// تحديث صفحة. الآن الإدراج مشروط صراحة بمعامل persistPm10Reading (السادس)
// الذي لا يُمرِّره true إلا POST /api/projects/[projectId]/evaluate.
// =====================================================================

const baseRow = {
  id: 'profile-1',
  activity_group_id: 'group-1',
  activity_type: 'GENERAL_OUTDOOR_WORK',
  regulatory_activity: 'OTHER',
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
  device_id: null,
};

const project = { id: 'project-1', latitude: 24.7136, longitude: 46.6753 };

function dustResult(pm10Source: 'onsite' | 'weather' = 'onsite') {
  return {
    activityId: 'profile-1',
    activityGroupId: 'group-1',
    windowEval: {
      worst: {
        score: 90,
        decisionCategory: 'ALLOW',
        mandatoryStop: false,
        shortReason: null,
        confidenceScore: 1,
        effectiveWindKmh: 10,
        caveatsAr: [],
        mergedReading: {
          windSpeedKmh: 10,
          windGustKmh: null,
          windDirectionDeg: null,
          pm10: 310, // فوق عتبة الاحتراز — يكفي ليُدرَج لو الكتابة مفعّلة
          pm25: null,
          relativeHumidityPercent: null,
          temperatureC: null,
          visibilityM: null,
          deviceLastReadingAt: null,
          devicePm10LastReadingAt: null,
          sources: { pm10: pm10Source },
        },
      },
    },
  };
}

// عميل Supabase مموّه — يسجّل كل استدعاء .insert() (الجدول + المحتوى)،
// ويرجع سلسلة عمليات فارغة كافية لكل الاستعلامات التي تنفّذها الدالة
// (current_dust_compliance_decisions select، pm10_readings_history/
// weather_forecasts select/insert).
function mockSupabase() {
  const inserts: { table: string; payload: any }[] = [];
  const chain: any = {
    select: () => chain,
    eq: () => chain,
    in: () => chain,
    gte: () => chain,
    order: () => chain,
    limit: () => chain,
    maybeSingle: async () => ({ data: null }),
    then: undefined,
  };
  // استعلامات select المتسلسلة تنتهي بـ await مباشر على chain (بلا
  // .maybeSingle) في بعض المسارات — نجعل chain نفسه thenable يرجع { data: [] }.
  chain.then = (resolve: any) => resolve({ data: [] });

  return {
    from: vi.fn((table: string) => ({
      ...chain,
      insert: vi.fn((payload: any) => {
        inserts.push({ table, payload });
        return { then: (resolve: any) => resolve({ data: null }) };
      }),
    })),
    _inserts: inserts,
    get _insertedTables() {
      return inserts.map((i) => i.table);
    },
  };
}

describe('computeDustComplianceResults — GET لا يكتب في pm10_readings_history', () => {
  it('بلا تمرير persistPm10Reading (مسار GET)، لا يُستدعى insert على pm10_readings_history', async () => {
    const supabase = mockSupabase();
    await computeDustComplianceResults([baseRow], project, [dustResult()], [], supabase);
    expect(supabase._insertedTables).not.toContain('pm10_readings_history');
  });

  it('بتمرير persistPm10Reading=false صراحة (نفس افتراضي GET)، لا كتابة أيضاً', async () => {
    const supabase = mockSupabase();
    await computeDustComplianceResults([baseRow], project, [dustResult()], [], supabase, false);
    expect(supabase._insertedTables).not.toContain('pm10_readings_history');
  });

  it('بتمرير persistPm10Reading=true (مسار POST /evaluate الصريح)، يُستدعى insert على pm10_readings_history', async () => {
    const supabase = mockSupabase();
    await computeDustComplianceResults([baseRow], project, [dustResult()], [], supabase, true);
    expect(supabase._insertedTables).toContain('pm10_readings_history');
  });

  it('استدعاءات GET المتكررة (10 مرات) لا تراكم أي كتابة في السجل التاريخي', async () => {
    const supabase = mockSupabase();
    for (let i = 0; i < 10; i++) {
      await computeDustComplianceResults([baseRow], project, [dustResult()], [], supabase);
    }
    expect(supabase._insertedTables).not.toContain('pm10_readings_history');
  });
});

describe('computeDustComplianceResults — فصل توقّع Open-Meteo عن سجل الأدلة الميداني', () => {
  it('قراءة onsite (يدوية) تُدرَج في pm10_readings_history بمصدر manual', async () => {
    const supabase = mockSupabase();
    await computeDustComplianceResults([baseRow], project, [dustResult('onsite')], [], supabase, true);
    const historyInsert = supabase._inserts.find((i) => i.table === 'pm10_readings_history');
    expect(historyInsert).toBeDefined();
    expect(historyInsert?.payload).toMatchObject({ source: 'manual', pm10_ug_m3: 310 });
    expect(supabase._insertedTables).not.toContain('weather_forecasts');
  });

  it('توقّع open-meteo (weather) يُدرَج في weather_forecasts بـ evidence_eligible=false، لا في pm10_readings_history إطلاقاً', async () => {
    const supabase = mockSupabase();
    await computeDustComplianceResults([baseRow], project, [dustResult('weather')], [], supabase, true);
    const forecastInsert = supabase._inserts.find((i) => i.table === 'weather_forecasts');
    expect(forecastInsert).toBeDefined();
    expect(forecastInsert?.payload).toMatchObject({
      provider: 'open-meteo',
      pm10_ug_m3: 310,
      evidence_eligible: false,
    });
    expect(supabase._insertedTables).not.toContain('pm10_readings_history');
  });

  it('توقّع weather لا يُدرَج في weather_forecasts أصلاً على مسار GET (persistPm10Reading=false)', async () => {
    const supabase = mockSupabase();
    await computeDustComplianceResults([baseRow], project, [dustResult('weather')], [], supabase);
    expect(supabase._insertedTables).not.toContain('weather_forecasts');
    expect(supabase._insertedTables).not.toContain('pm10_readings_history');
  });
});
