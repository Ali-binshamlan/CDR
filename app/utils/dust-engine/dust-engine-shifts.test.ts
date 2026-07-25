import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { DustHourlySample } from './types';
import type { DustEngineInput } from './types';

// =====================================================================
// evaluateDustVisibilityWorkDayHourly — نافذة ساعات الدوام الرسمية
// المسجّلة عند إنشاء المشروع (work_hours_start/work_hours_end) تُستخدم
// دائماً كاملة، بصرف النظر عن وجود ورديات فرعية (shifts) أضيق منها —
// طلب صريح من المستخدم يلغي السلوك السابق (استثناء الفجوة بين الورديات).
// نُموّه fetchDustWeatherHourly لتفادي أي استدعاء شبكي فعلي في الاختبار،
// ونُثبّت "الآن" (vi.setSystemTime) على 03:00 بتوقيت الرياض (00:00Z) —
// قبل أي نافذة دوام مُختبرة هنا — حتى لا تتأثر النتائج بوقت تشغيل
// الاختبار الفعلي (evaluateDustVisibilityWorkDayHourly ينتقل ليوم الغد
// تلقائياً إذا كان الوقت الحالي بعد نهاية نافذة اليوم).
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
// كاملاً بتوقيت الرياض دون فجوات، حتى تُختبر كل النطاقات بأمان
const ALL_DAY_SAMPLES: DustHourlySample[] = Array.from({ length: 24 }, (_, h) => hourlySample(h));

vi.mock('./weather', () => ({
  fetchDustWeatherHourly: vi.fn(async () => ALL_DAY_SAMPLES),
}));

beforeEach(() => {
  // 00:00Z = 03:00 بتوقيت الرياض — قبل بداية كل نافذة دوام مُختبرة هنا
  // (06:00/07:00 فأبعد)، فلا يُفعَّل مسار "الانتقال ليوم الغد".
  vi.setSystemTime(new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`));
});

afterEach(() => {
  vi.useRealTimers();
});

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

describe('evaluateDustVisibilityWorkDayHourly — نافذة ساعات الدوام الرسمية دائماً', () => {
  it('بلا shifts (فقط workHoursStart/End) يُرجع فقط ساعات النافذة', async () => {
    const { evaluateDustVisibilityWorkDayHourly } = await import('./engine');
    const result = await evaluateDustVisibilityWorkDayHourly(
      baseInput({ workHoursStart: '07:00', workHoursEnd: '10:00' })
    );
    // 07:00-10:00 بتوقيت الرياض (+3) = 04:00-07:00 UTC → 4 ساعات (04,05,06,07)
    const hoursUtc = result.map((r) => new Date(r.time).getUTCHours()).sort((a, b) => a - b);
    expect(hoursUtc).toEqual([4, 5, 6, 7]);
  });

  it('بورديتين منفصلتين بفجوة بينهما (06:00-08:00 و16:00-18:00) يُرجع نافذة الدوام الرسمية كاملة، بما فيها الفجوة', async () => {
    const { evaluateDustVisibilityWorkDayHourly } = await import('./engine');
    const result = await evaluateDustVisibilityWorkDayHourly(
      baseInput({
        workHoursStart: '06:00',
        workHoursEnd: '18:00',
        shifts: [
          { startTime: '06:00', endTime: '08:00' },
          { startTime: '16:00', endTime: '18:00' },
        ],
      })
    );
    const hoursUtc = new Set(result.map((r) => new Date(r.time).getUTCHours()));
    // نافذة الدوام الرسمية 06-18 الرياض = 03-15 UTC كاملة — بما فيها الفجوة
    // بين الورديتين (09-12 الرياض = 06-09 UTC)، بخلاف السلوك السابق.
    expect(hoursUtc.has(3)).toBe(true);
    expect(hoursUtc.has(6)).toBe(true);
    expect(hoursUtc.has(7)).toBe(true);
    expect(hoursUtc.has(8)).toBe(true);
    expect(hoursUtc.has(9)).toBe(true);
    expect(hoursUtc.has(15)).toBe(true);
  });

  it('shifts فارغة ([]) لا تغيّر النافذة — نفس نتيجة غياب الحقل تماماً', async () => {
    const { evaluateDustVisibilityWorkDayHourly } = await import('./engine');
    const withEmptyShifts = await evaluateDustVisibilityWorkDayHourly(
      baseInput({ workHoursStart: '07:00', workHoursEnd: '09:00', shifts: [] })
    );
    const withoutShiftsField = await evaluateDustVisibilityWorkDayHourly(
      baseInput({ workHoursStart: '07:00', workHoursEnd: '09:00' })
    );
    expect(withEmptyShifts.map((r) => r.time)).toEqual(withoutShiftsField.map((r) => r.time));
  });

  it('الوقت الحالي بعد نهاية نافذة اليوم → ينتقل تلقائياً لنافذة الغد بنفس التوقيتين', async () => {
    // 23:55 بتوقيت الرياض (20:55Z) — بعد نهاية نافذة 07:00-10:00 لليوم نفسه
    vi.setSystemTime(new Date(`${new Date().toISOString().slice(0, 10)}T20:55:00Z`));
    const { evaluateDustVisibilityWorkDayHourly } = await import('./engine');
    const result = await evaluateDustVisibilityWorkDayHourly(
      baseInput({ workHoursStart: '07:00', workHoursEnd: '10:00' })
    );
    // العينات المتاحة (ALL_DAY_SAMPLES) ليوم واحد فقط، فنافذة الغد تقع خارج
    // نطاق العينات المموّهة هنا — النتيجة المتوقعة فارغة، لا نافذة اليوم
    // الماضية (كانت هذي هي المشكلة الفعلية: عرض نافذة منتهية بدل الانتقال
    // أو الفراغ الصريح).
    const hoursUtc = result.map((r) => new Date(r.time).getUTCHours());
    expect(hoursUtc).toEqual([]);
  });
});
