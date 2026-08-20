import { describe, it, expect, vi, afterEach } from 'vitest';
import { evaluateLiveOperationalDecision } from './engine';
import type { DustEngineInput } from './types';

// =====================================================================
// evaluateLiveOperationalDecision — القسم 9 من "دليل الإصلاح الجذري لمنظومة
// مرقاب": القرار الحي يجب ألا يعتمد على Open-Meteo أو ينتظره إطلاقاً، حتى
// لنشاط مرتبط بجهاز. اختبار القبول الحاسم المطلوب صراحة (القسم 9.2):
// Mock على global.fetch يرمي فور استدعائه، ويجب أن ينجح الاستدعاء ويثبت
// أن عدد مكالمات fetch يساوي صفراً — لا فقط "مهلة قصيرة" كما كان الحال في
// evaluateDustVisibilityWindow (LIVE_WEATHER_TIMEOUT_MS).
// =====================================================================

function input(overrides: Partial<DustEngineInput> = {}): DustEngineInput {
  return {
    regulatoryActivity: 'IDLE_SURFACE',
    latitude: 24.7,
    longitude: 46.7,
    site: {
      hasEarthworks: false,
      internalDirtRoads: false,
      heavyEquipmentMovement: false,
      looseMaterials: false,
      surfaceWet: false,
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
});

describe('evaluateLiveOperationalDecision — صفر مكالمات fetch إطلاقاً', () => {
  it('fetch يرمي خطأً فور استدعائه — النشاط بجهاز حي ينجح رغم ذلك، وfetch لا يُستدعى مطلقاً', () => {
    const fetchMock = vi.fn(() => {
      throw new Error('fetch يجب ألا يُستدعى إطلاقاً من هذه الدالة');
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = evaluateLiveOperationalDecision(
      input({
        hasDeviceLink: true,
        devicePm10: 260,
        deviceWindSpeedKmh: 18,
        deviceVisibilityM: 5000,
        deviceLastReadingAt: new Date().toISOString(),
      })
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.mergedReading.pm10).toBe(260);
    expect(result.decisionLabelAr).not.toContain('بانتظار تقييم');
  });

  it('hasDeviceLink=false → "بانتظار تقييم" محايدة، صفر fetch', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = evaluateLiveOperationalDecision(input({ hasDeviceLink: false }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.decisionLabelAr).toContain('بانتظار تقييم');
    expect(result.mandatoryStop).toBe(false);
    expect(result.mergedReading.deviceLastReadingAt).toBeUndefined();
  });

  it('يقرأ قراءة الجهاز مباشرة بصرف النظر عن قِدمها (لا فحص حداثة داخل هذه الدالة)', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const oldReadingAt = new Date(Date.now() - 3 * 3600000).toISOString();
    const result = evaluateLiveOperationalDecision(
      input({
        hasDeviceLink: true,
        devicePm10: 345,
        deviceLastReadingAt: oldReadingAt,
      })
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.mergedReading.pm10).toBe(345);
    expect(result.mergedReading.deviceLastReadingAt).toBe(oldReadingAt);
  });

  // خطأ معماري مكتشَف ومُصلَح (طلب صريح من المستخدم — الملاحظة #9: "DVI لا
  // يجوز أن يقوم عبر مسار جانبي بعمل PM10>340 → STOP إذا كانت قاعدة المشروع
  // نفسها تقول STOP بعد 30 دقيقة"): DVI لم يعد يملك أي عتبة PM10 مستقلة
  // تُنتج mandatoryStop/STOP_DUST_GENERATING_ACTIVITIES — القرار التنظيمي
  // لـPM10 يأتي حصراً من محرك الامتثال (pm10ThresholdRule/GATE-DVI-002 في
  // dust-compliance-engine). الاختبارات الثلاثة القديمة هنا (طازجة/غائبة/
  // قديمة) كانت تختبر بالضبط آلية الحداثة التي أُزيلت — استُبدلت باختبار
  // واحد يثبت أن PM10 مرتفع وحده (بلا خطر فيزيائي حقيقي آخر) لا يُنتج أي
  // إيقاف من DVI إطلاقاً، بصرف النظر عن حداثة القراءة.
  it('PM10>340 من الجهاز وحده (بلا رؤية حرجة/رياح شديدة مساهمة)، بصرف النظر عن حداثة القراءة → لا mandatoryStop، لا STOP_DUST_GENERATING_ACTIVITIES (القرار التنظيمي لـPM10 يأتي حصراً من محرك الامتثال)', () => {
    vi.stubGlobal('fetch', vi.fn());
    const result = evaluateLiveOperationalDecision(
      input({
        regulatoryActivity: 'EARTHWORKS',
        hasDeviceLink: true,
        devicePm10: 500,
        deviceLastReadingAt: new Date().toISOString(),
        devicePm10LastReadingAt: new Date().toISOString(),
      })
    );
    expect(result.mandatoryStop).toBe(false);
    expect(result.decisionCategory).not.toBe('STOP_DUST_GENERATING_ACTIVITIES');
    expect(result.stopBasis).toBe('NONE');
    expect(result.triggeredRules).not.toContain('DVI-DUST-ACTIVITY-STOP-004');
  });
});
