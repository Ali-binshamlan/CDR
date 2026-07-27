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
  values: { minutesAgo: number; pm10: number }[]
): { pm10UgM3: number; recordedAt: string }[] {
  return values.map((v) => ({
    pm10UgM3: v.pm10,
    recordedAt: new Date(now - v.minutesAgo * 60000).toISOString(),
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

  it('فجوة زمنية كبيرة بين قراءتين (>15 دقيقة) لا تُحسَب استمراراً واحداً متواصلاً', () => {
    const readings = readingsBackFromNow(NOW, [
      { minutesAgo: 40, pm10: 350 }, // قراءة قديمة معزولة (جهاز توقف ثم عاد)
      { minutesAgo: 1, pm10: 345 },
      { minutesAgo: 0, pm10: 350 },
    ]);
    const r = computeSustainedPm10Status(readings, NOW);
    // الاستمرار يُحسب فقط من آخر قراءتين متتاليتين (فجوة أقل من 15 دقيقة
    // بينهما)، لا يمتد للقراءة المعزولة قبل 40 دقيقة.
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

  it('استمرار ≥250 لمدة 30 دقيقة متواصلة بالضبط → تعليق مفعَّل', () => {
    const readings = readingsBackFromNow(NOW, [
      { minutesAgo: 30, pm10: 255 },
      { minutesAgo: 15, pm10: 260 },
      { minutesAgo: 0, pm10: 258 },
    ]);
    const r = computeSustainedPm10Status(readings, NOW);
    expect(r.isSuspended250For30Min).toBe(true);
  });

  it('استمرار ≥250 لمدة 25 دقيقة فقط (أقل من 30) → لا تعليق بعد', () => {
    const readings = readingsBackFromNow(NOW, [
      { minutesAgo: 25, pm10: 255 },
      { minutesAgo: 0, pm10: 258 },
    ]);
    const r = computeSustainedPm10Status(readings, NOW);
    expect(r.isSuspended250For30Min).toBe(false);
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
