import { describe, it, expect } from 'vitest';
import { computeSustainedPm10Status, computeStoppedSince } from './dustEvaluation';

// =====================================================================
// اختبارات computeSustainedPm10Status — يحقق 3 قواعد كانت مستحيلة التطبيق
// من قراءة لحظية واحدة:
//   • RCRC-PM10-340-VIOLATION-011: أكثر من دقيقتين ≥340 = مخالفة مؤكدة.
//   • MRQ-PM10-BLACK-PENDING-104: أقل من دقيقتين ≥340 = معلَّق فقط.
//   • RCRC-PM10-30M-SUSPENSION-012: 30 دقيقة متواصلة ≥250 = تعليق النشاط.
// =====================================================================

function readingsBackFromNow(
  now: number,
  values: { minutesAgo: number; pm10: number; source?: 'device' | 'manual' | 'open-meteo' }[]
): { pm10UgM3: number; recordedAt: string; source?: 'device' | 'manual' | 'open-meteo' }[] {
  return values.map((v) => ({
    pm10UgM3: v.pm10,
    recordedAt: new Date(now - v.minutesAgo * 60000).toISOString(),
    source: v.source,
  }));
}

describe('computeSustainedPm10Status', () => {
  const NOW = Date.parse('2026-01-01T12:00:00.000Z');

  it('لا قراءات إطلاقاً → لا استمرار، لا معلَّق، لا تعليق', () => {
    const r = computeSustainedPm10Status([], NOW);
    expect(r.currentReadingUgM3).toBeNull();
    expect(r.isConfirmedViolation340).toBe(false);
    expect(r.isPendingViolation340).toBe(false);
    expect(r.isSuspended250For30Min).toBe(false);
  });

  it('قراءة واحدة فقط ≥340 (بلا استمرار مثبت) → معلَّق فقط، ليست مخالفة مؤكدة', () => {
    const readings = readingsBackFromNow(NOW, [{ minutesAgo: 0, pm10: 350 }]);
    const r = computeSustainedPm10Status(readings, NOW);
    expect(r.isPendingViolation340).toBe(true);
    expect(r.isConfirmedViolation340).toBe(false);
  });

  it('قراءات ≥340 مستمرة لأكثر من دقيقتين → مخالفة مؤكدة', () => {
    const readings = readingsBackFromNow(NOW, [
      { minutesAgo: 3, pm10: 350 },
      { minutesAgo: 2, pm10: 345 },
      { minutesAgo: 1, pm10: 355 },
      { minutesAgo: 0, pm10: 342 },
    ]);
    const r = computeSustainedPm10Status(readings, NOW);
    expect(r.sustainedMinutesAbove340).toBeGreaterThanOrEqual(2);
    expect(r.isConfirmedViolation340).toBe(true);
    expect(r.isPendingViolation340).toBe(false);
  });

  it('قراءات ≥340 استمرت دقيقة واحدة فقط ثم انقطعت (قراءة أقدم دون 340) → معلَّق فقط', () => {
    const readings = readingsBackFromNow(NOW, [
      { minutesAgo: 5, pm10: 200 }, // دون الحد — يوقف الاستمرار هنا
      { minutesAgo: 1, pm10: 345 },
      { minutesAgo: 0, pm10: 350 },
    ]);
    const r = computeSustainedPm10Status(readings, NOW);
    expect(r.isConfirmedViolation340).toBe(false);
    expect(r.isPendingViolation340).toBe(true);
  });

  it('فجوة زمنية كبيرة بين قراءتين (>4 دقائق) لا تُحسَب استمراراً واحداً متواصلاً', () => {
    const readings = readingsBackFromNow(NOW, [
      { minutesAgo: 40, pm10: 350 }, // قراءة قديمة معزولة (جهاز توقف ثم عاد)
      { minutesAgo: 1, pm10: 345 },
      { minutesAgo: 0, pm10: 350 },
    ]);
    const r = computeSustainedPm10Status(readings, NOW);
    // الاستمرار يُحسب فقط من آخر قراءتين متتاليتين (فجوة أقل من 4 دقائق
    // بينهما، تطابق دورة إرسال الجهاز كل دقيقتين)، لا يمتد للقراءة المعزولة
    // قبل 40 دقيقة.
    expect(r.sustainedMinutesAbove340).toBeLessThan(5);
  });

  it('القراءة الحالية دون 250 → لا تعليق حتى لو كان هناك تاريخ استمرار سابق فوق 250', () => {
    const readings = readingsBackFromNow(NOW, [
      { minutesAgo: 35, pm10: 260 },
      { minutesAgo: 20, pm10: 260 },
      { minutesAgo: 0, pm10: 100 }, // القراءة الحالية انخفضت فعلياً
    ]);
    const r = computeSustainedPm10Status(readings, NOW);
    expect(r.isSuspended250For30Min).toBe(false);
    expect(r.currentReadingUgM3).toBe(100);
  });

  it('استمرار ≥250 لمدة 30 دقيقة متواصلة بالضبط (قراءات كل دقيقتين) → تعليق مفعَّل', () => {
    const readings = readingsBackFromNow(
      NOW,
      Array.from({ length: 16 }, (_, i) => ({ minutesAgo: 30 - i * 2, pm10: 255 }))
    );
    const r = computeSustainedPm10Status(readings, NOW);
    expect(r.isSuspended250For30Min).toBe(true);
  });

  it('استمرار ≥250 لمدة 25 دقيقة فقط (أقل من 30، قراءات كل دقيقتين) → لا تعليق بعد', () => {
    const readings = readingsBackFromNow(
      NOW,
      Array.from({ length: 13 }, (_, i) => ({ minutesAgo: 24 - i * 2, pm10: 255 }))
    );
    const r = computeSustainedPm10Status(readings, NOW);
    expect(r.isSuspended250For30Min).toBe(false);
  });

  it('آخر قراءة قديمة (>4 دقائق) — جهاز متوقف — لا تُبقي حالة "مؤكدة" أو "معلَّقة" حيّة رغم استمرار ظاهري طويل', () => {
    const readings = readingsBackFromNow(NOW, [
      { minutesAgo: 10, pm10: 350 },
      { minutesAgo: 8, pm10: 345 },
      { minutesAgo: 6, pm10: 342 }, // آخر قراءة فعلية — عمرها 6 دقائق، أقدم من عتبة الحيوية (4 دقائق)
    ]);
    const r = computeSustainedPm10Status(readings, NOW);
    expect(r.isConfirmedViolation340).toBe(false);
    expect(r.isPendingViolation340).toBe(true);
  });

  it('قراءات مصدرها open-meteo فقط → لا تصل أبداً لحالة "مؤكدة" حتى لو استمرت أكثر من دقيقتين وكانت حديثة', () => {
    const readings = readingsBackFromNow(NOW, [
      { minutesAgo: 3, pm10: 350, source: 'open-meteo' },
      { minutesAgo: 2, pm10: 345, source: 'open-meteo' },
      { minutesAgo: 0, pm10: 342, source: 'open-meteo' },
    ]);
    const r = computeSustainedPm10Status(readings, NOW);
    expect(r.isConfirmedViolation340).toBe(false);
    expect(r.isPendingViolation340).toBe(true);
  });

  it('قراءات مصدرها device صريحاً وحديثة ومستمرة لأكثر من دقيقتين → مخالفة مؤكدة', () => {
    const readings = readingsBackFromNow(NOW, [
      { minutesAgo: 3, pm10: 350, source: 'device' },
      { minutesAgo: 2, pm10: 345, source: 'device' },
      { minutesAgo: 0, pm10: 342, source: 'device' },
    ]);
    const r = computeSustainedPm10Status(readings, NOW);
    expect(r.isConfirmedViolation340).toBe(true);
  });

  // خطأ مكتشَف ومُصلَح: كانت السلسلة تمتد عبر قراءات مختلطة المصدر، ويُكتفى
  // بفحص مصدر آخر قراءة وحدها — فقراءة جهاز واحدة تُلحَق بسلسلة open-meteo
  // سابقة كانت تكفي لتأكيد مخالفة بدليل استمرار مصدره فعلياً توقّع طقس.
  it('قراءة جهاز واحدة تسبقها سلسلة open-meteo ضمن هامش الفجوة → لا تُحسب استمراراً مؤكداً (لا خلط مصادر)', () => {
    const readings = readingsBackFromNow(NOW, [
      { minutesAgo: 6, pm10: 350, source: 'open-meteo' },
      { minutesAgo: 4, pm10: 355, source: 'open-meteo' },
      { minutesAgo: 2, pm10: 360, source: 'open-meteo' },
      { minutesAgo: 0, pm10: 350, source: 'device' }, // قراءة جهاز واحدة فقط
    ]);
    const r = computeSustainedPm10Status(readings, NOW);
    // الاستمرار المُحتسَب يقتصر على قراءة الجهاز الوحيدة (صفر دقائق فعلياً)،
    // فلا يبلغ حد الدقيقتين رغم أن الخليط الزمني الظاهري يتجاوزها.
    expect(r.sustainedMinutesAbove340).toBeLessThan(2);
    expect(r.isConfirmedViolation340).toBe(false);
    expect(r.isPendingViolation340).toBe(true);
  });

  it('سلسلة device متجانسة يسبقها open-meteo أقدم → تُحتسب دقائق الجهاز وحدها فقط', () => {
    const readings = readingsBackFromNow(NOW, [
      { minutesAgo: 8, pm10: 350, source: 'open-meteo' },
      { minutesAgo: 6, pm10: 355, source: 'open-meteo' },
      { minutesAgo: 3, pm10: 345, source: 'device' },
      { minutesAgo: 1, pm10: 350, source: 'device' },
      { minutesAgo: 0, pm10: 342, source: 'device' },
    ]);
    const r = computeSustainedPm10Status(readings, NOW);
    // 3 دقائق من الجهاز فقط (لا 8 دقائق شاملة قراءات الطقس) — تكفي للتأكيد.
    expect(r.sustainedMinutesAbove340).toBeGreaterThanOrEqual(2);
    expect(r.sustainedMinutesAbove340).toBeLessThan(6);
    expect(r.isConfirmedViolation340).toBe(true);
  });

  it('ترتيب القراءات العشوائي (غير مرتّب زمنياً) لا يؤثر على النتيجة — الدالة تُرتّب داخلياً', () => {
    const orderedNewestFirst = readingsBackFromNow(NOW, [
      { minutesAgo: 3, pm10: 350 },
      { minutesAgo: 1, pm10: 345 },
      { minutesAgo: 0, pm10: 342 },
    ]);
    const shuffled = [orderedNewestFirst[1], orderedNewestFirst[0], orderedNewestFirst[2]];
    const rOrdered = computeSustainedPm10Status(orderedNewestFirst, NOW);
    const rShuffled = computeSustainedPm10Status(shuffled, NOW);
    expect(rShuffled.isConfirmedViolation340).toBe(rOrdered.isConfirmedViolation340);
  });
});

describe('computeStoppedSince (تأكيد عدم كسر السلوك الحالي بعد إضافة قواعد PM10 الجديدة)', () => {
  it('لا يزال يعمل بنفس المنطق السابق', () => {
    expect(computeStoppedSince('ALLOW', null, 'ALLOW')).toBeNull();
  });
});
