import { describe, it, expect, vi } from 'vitest';
import type { DustHourlySample } from './types';
import type { DustEngineInput } from './types';

// =====================================================================
// ورديات عمل حقيقية في evaluateDustVisibilityWorkDayHourly — تحل محل
// نافذة workHoursStart/workHoursEnd الواحدة عند تعريفها (طلب المستخدم:
// إضافة ورديات تنعكس فعلياً في تقييم المحرك، لا فقط واجهة الإدخال).
// نُموّه fetchDustWeatherHourly لتفادي أي استدعاء شبكي فعلي في الاختبار.
// =====================================================================

function hourlySample(hour: number, overrides: Partial<DustHourlySample> = {}): DustHourlySample {
  const dateStr = new Date().toISOString().slice(0, 10);
  const hh = String(hour).padStart(2, '0');
  return {
    time: `${dateStr}T${hh}:00:00Z`,
    visibilityM: 10000,
    weatherCode: null,
    weatherSymbol: 'CLEAR',
    windSpeedKmh: 10,
    windGustKmh: 15,
    windDirectionDeg: 0,
    relativeHumidityPercent: 40,
    rainfallLast24hMm: 0,
    pm10: 20,
    pm25: 10,
    dustConcentration: 10,
    dataSource: 'open-meteo',
    isForecastStale: false,
    ...overrides,
  };
}

// عينات كل ساعة من 00:00Z (=03:00 بتوقيت الرياض) إلى 23:00Z تغطي يوماً
// كاملاً بتوقيت الرياض دون فجوات، حتى تُختبر كل نطاقات الورديات بأمان
const ALL_DAY_SAMPLES: DustHourlySample[] = Array.from({ length: 24 }, (_, h) => hourlySample(h));

vi.mock('./weather', () => ({
  fetchDustWeatherHourly: vi.fn(async () => ALL_DAY_SAMPLES),
}));

function baseInput(overrides: Partial<DustEngineInput> = {}): DustEngineInput {
  return {
    activityType: 'EARTHWORKS_EXCAVATION',
    latitude: 24.7136,
    longitude: 46.6753,
    site: {
      hasEarthworks: true,
      internalDirtRoads: false,
      heavyEquipmentMovement: false,
      looseMaterials: false,
      largeExposedArea: false,
      drySurface: false,
      surfaceWet: false,
      wateringAvailable: true,
      stockpilesCovered: true,
      speedLimitApplied: true,
      wheelWashAvailable: true,
      dustScreensAvailable: true,
      fieldMonitoringAvailable: true,
      receptorType: 'NONE',
      receptorDistance: 'FAR',
      receptorIsDownwind: false,
      visibleDustPlumeReported: false,
      openConcretePour: false,
    },
    onsiteVisibilityM: null,
    onsitePm10: null,
    onsitePm25: null,
    ...overrides,
  } as DustEngineInput;
}

describe('evaluateDustVisibilityWorkDayHourly — ورديات عمل حقيقية', () => {
  it('بلا shifts (فقط workHoursStart/End) يُرجع فقط ساعات النافذة القديمة', async () => {
    const { evaluateDustVisibilityWorkDayHourly } = await import('./engine');
    const result = await evaluateDustVisibilityWorkDayHourly(
      baseInput({ workHoursStart: '07:00', workHoursEnd: '10:00' })
    );
    // 07:00-10:00 بتوقيت الرياض (+3) = 04:00-07:00 UTC → 4 ساعات (04,05,06,07)
    const hoursUtc = result.map((r) => new Date(r.time).getUTCHours()).sort((a, b) => a - b);
    expect(hoursUtc).toEqual([4, 5, 6, 7]);
  });

  it('بورديتين منفصلتين (06:00-08:00 و16:00-18:00 بتوقيت الرياض) يُرجع فقط ساعات كلتا الورديتين، لا الفجوة بينهما', async () => {
    const { evaluateDustVisibilityWorkDayHourly } = await import('./engine');
    const result = await evaluateDustVisibilityWorkDayHourly(
      baseInput({
        shifts: [
          { startTime: '06:00', endTime: '08:00' },
          { startTime: '16:00', endTime: '18:00' },
        ],
      })
    );
    const hoursUtc = new Set(result.map((r) => new Date(r.time).getUTCHours()));
    // 06-08 الرياض = 03-05 UTC، 16-18 الرياض = 13-15 UTC
    expect(hoursUtc.has(3)).toBe(true);
    expect(hoursUtc.has(4)).toBe(true);
    expect(hoursUtc.has(5)).toBe(true);
    expect(hoursUtc.has(13)).toBe(true);
    expect(hoursUtc.has(14)).toBe(true);
    expect(hoursUtc.has(15)).toBe(true);
    // الفجوة بين الورديتين (09-12 الرياض = 06-09 UTC) يجب ألا تظهر
    expect(hoursUtc.has(6)).toBe(false);
    expect(hoursUtc.has(7)).toBe(false);
    expect(hoursUtc.has(8)).toBe(false);
    expect(hoursUtc.has(9)).toBe(false);
  });

  it('shifts فارغة ([]) تسلك بالضبط مسار workHoursStart/End كأن shifts غائبة', async () => {
    const { evaluateDustVisibilityWorkDayHourly } = await import('./engine');
    const withEmptyShifts = await evaluateDustVisibilityWorkDayHourly(
      baseInput({ workHoursStart: '07:00', workHoursEnd: '09:00', shifts: [] })
    );
    const withoutShiftsField = await evaluateDustVisibilityWorkDayHourly(
      baseInput({ workHoursStart: '07:00', workHoursEnd: '09:00' })
    );
    expect(withEmptyShifts.map((r) => r.time)).toEqual(withoutShiftsField.map((r) => r.time));
  });
});
