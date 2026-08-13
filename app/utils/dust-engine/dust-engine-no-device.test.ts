import { describe, it, expect, vi, afterEach } from 'vitest';
import { evaluateDustVisibilityWindow } from './engine';
import { __clearWeatherCacheForTests } from './weather';
import type { DustEngineInput } from './types';

// =====================================================================
// خطأ أمني/معماري مكتشَف ومُصلَح (طلب صريح من المستخدم — "لا تجعل API
// الطقس يحضر القراءة حق ساعة النشاط... دايماً اجعله يحتاج قراءة حقيقية من
// الجهاز" + "امنع API كلياً لو ما فيه جهاز، حتى لا يُستدعى إطلاقاً"، ثم
// تأكيداً صريحاً إضافياً: "الآيبي الغيه تماما لا تستدعي منه بيانات حتى"):
// evaluateDustVisibilityWindow كان يستدعي fetchDustWeatherHourly (Open-Meteo)
// دائماً بصرف النظر عن hasDeviceLink، فنشاط بلا جهاز رصد كان يُقيَّم بالكامل
// (DVI score/decisionCategory/mandatoryStop، ثم compliance/AEI فوقه) على
// تقدير طقس بديل — قبل أن تُصحَّح النتيجة لاحقاً بطبقة HOLD_FOR_VERIFICATION
// في decideFinal. هذا يعني استدعاء API فعلياً + تسرّب قيم تقديرية (PM10/
// رياح/رؤية) عبر rawWeatherSample/mergedReading قبل تلك الطبقة التصحيحية.
// الآن: نشاط بلا جهاز لا يُستدعى له fetch إطلاقاً — نتيجة ثابتة محايدة
// "بانتظار تقييم" تُرجَع مباشرة (بلا شبكة توقعات أيضاً لنفس النشاط).
// =====================================================================

function input(overrides: Partial<DustEngineInput> = {}): DustEngineInput {
  return {
    activityType: 'GENERAL_OUTDOOR_WORK',
    latitude: 24.7,
    longitude: 46.7,
    site: {
      hasEarthworks: false,
      internalDirtRoads: false,
      heavyEquipmentMovement: false,
      looseMaterials: false,
      largeExposedArea: false,
      drySurface: false,
      surfaceWet: false,
      wateringAvailable: false,
      stockpilesCovered: false,
      speedLimitApplied: false,
      wheelWashAvailable: false,
      dustScreensAvailable: false,
      fieldMonitoringAvailable: false,
      receptorType: 'NONE_NEARBY',
      receptorDistance: 'OVER_500M',
      receptorIsDownwind: false,
      visibleDustPlumeReported: false,
      openConcretePour: false,
    },
    onsiteVisibilityM: null,
    onsitePm10: null,
    onsitePm25: null,
    hasDeviceLink: false,
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  __clearWeatherCacheForTests();
});

describe('evaluateDustVisibilityWindow — لا استدعاء API إطلاقاً لنشاط بلا جهاز رصد', () => {
  it('hasDeviceLink=false → fetch لا يُستدعى مطلقاً (لا forecast ولا air-quality)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await evaluateDustVisibilityWindow(input({ hasDeviceLink: false }), '2026-07-30T10:00:00Z', 3);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('hasDeviceLink=false → يرجع نتيجة "بانتظار تقييم" ثابتة، بلا خطأ وبلا قيم تقديرية', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await evaluateDustVisibilityWindow(input({ hasDeviceLink: false }), '2026-07-30T10:00:00Z', 3);

    expect(result.worst.mandatoryStop).toBe(false);
    expect(result.worst.confidenceScore).toBe(0);
    expect(result.worst.decisionLabelAr).toContain('بانتظار تقييم');
    // لا أي قيمة طقس تقديرية مسرَّبة — كل حقول rawWeatherSample/mergedReading فارغة
    expect(result.worst.rawWeatherSample.pm10).toBeNull();
    expect(result.worst.rawWeatherSample.windSpeedKmh).toBeNull();
    expect(result.worst.rawWeatherSample.visibilityM).toBeNull();
    expect(result.worst.mergedReading.pm10).toBeNull();
    // deviceLastReadingAt يجب أن يبقى undefined (لا null) — هو الإشارة التي
    // يعتمدها deriveEvidenceQuality لتصنيف "لا جهاز مرتبط أصلاً" → UNAVAILABLE
    expect(result.worst.mergedReading.deviceLastReadingAt).toBeUndefined();
    // لا شبكة توقعات لنشاط بلا جهاز (لا بيانات حية أصلاً لبنائها)
    expect(result.hourly).toEqual([]);
    expect(result.bestWindowWorst).toBeNull();
    expect(result.avoidWindowWorst).toBeNull();
  });

  it('hasDeviceLink=true → يستمر لاستدعاء API كالمعتاد (غير متأثر بالبوابة الجديدة)', async () => {
    const fetchMock = vi.fn(async (url: string) => ({
      ok: true,
      json: async () =>
        url.includes('air-quality-api')
          ? { hourly: { time: [], pm10: [], pm2_5: [], dust: [] } }
          : {
              hourly: {
                time: ['2026-07-30T10:00'],
                visibility: [9000],
                weather_code: [0],
                wind_speed_10m: [10],
                wind_gusts_10m: [15],
                wind_direction_10m: [180],
                relative_humidity_2m: [30],
                temperature_2m: [35],
                precipitation: [0],
              },
              daily: { precipitation_sum: [0] },
            },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await evaluateDustVisibilityWindow(input({ hasDeviceLink: true }), '2026-07-30T10:00:00Z', 1);

    expect(fetchMock).toHaveBeenCalled();
    expect(result.worst.decisionLabelAr).not.toContain('بانتظار تقييم');
  });
});
