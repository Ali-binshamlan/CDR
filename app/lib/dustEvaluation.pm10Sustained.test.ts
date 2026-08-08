import { describe, it, expect, vi } from 'vitest';
import { computeSustainedPm10Status, computeStoppedSince, fetchPm10SustainedStatus } from './dustEvaluation';
import type { SupabaseClient } from '@supabase/supabase-js';

// =====================================================================
// اختبارات computeSustainedPm10Status — يحقق 3 قواعد كانت مستحيلة التطبيق
// من قراءة لحظية واحدة:
//   • RCRC-PM10-340-VIOLATION-011: أكثر من دقيقتين ≥340 = مخالفة مؤكدة.
//   • MRQ-PM10-BLACK-PENDING-104: أقل من دقيقتين ≥340 = معلَّق فقط.
//   • RCRC-PM10-30M-SUSPENSION-012: 30 دقيقة متواصلة ≥250 = تعليق النشاط.
// =====================================================================

function readingsBackFromNow(
  now: number,
  values: { minutesAgo: number; pm10: number; source?: 'device' | 'manual' | 'open-meteo'; id?: string }[]
): { pm10UgM3: number; recordedAt: string; source?: 'device' | 'manual' | 'open-meteo'; id?: string }[] {
  return values.map((v) => ({
    pm10UgM3: v.pm10,
    recordedAt: new Date(now - v.minutesAgo * 60000).toISOString(),
    source: v.source,
    id: v.id,
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

  // خطأ مكتشَف ومُصلَح (مراجعة كود مدير — ملاحظة #3): كانت المدة تُحسب
  // (now - وقت أقدم قراءة بالسلسلة)، فقراءة جهاز واحدة فقط تصل ثم لا يصل
  // شيء بعدها كانت "تكتسب" دقائق استمرار وهمية بمجرد مرور الوقت — عمرها 3
  // دقائق يتحول لـ"استمرار 3 دقائق" رغم عدم وجود أي دليل ثانٍ على بقاء
  // التركيز مرتفعاً طوال تلك المدة. الاختبار التالي يثبّت السيناريو بالضبط:
  // نفس القراءة الوحيدة من الاختبار أعلاه، لكن now هنا بعد 3 دقائق من
  // وصولها (لا في نفس لحظتها) — يجب أن يبقى الاستمرار صفراً، لا 3.
  it('قراءة جهاز واحدة فقط ≥340، ومرور 3 دقائق بلا أي قراءة ثانية → استمرار صفر (لا "استمرار" وهمي من مجرد مرور الوقت)', () => {
    const readingTimeMs = NOW - 3 * 60000;
    const readings = [{ pm10UgM3: 350, recordedAt: new Date(readingTimeMs).toISOString(), source: 'device' as const }];
    const r = computeSustainedPm10Status(readings, NOW);
    expect(r.sustainedMinutesAbove340).toBe(0);
    // القراءة نفسها قديمة الآن (3 دقائق > عتبة الحداثة 4 دقائق تقريباً حدّياً،
    // لكن حتى لو كانت "حديثة"، شرط عينتين على الأقل يمنع "المؤكَّدة" هنا).
    expect(r.isConfirmedViolation340).toBe(false);
    expect(r.isPendingViolation340).toBe(true);
  });

  it('قراءتان فعليتان ≥340 بفارق حقيقي بينهما → الاستمرار يُقاس بين القراءتين، لا حتى "الآن"', () => {
    // القراءة الأحدث وصلت قبل نصف دقيقة من "الآن" (لا في نفس لحظته) — فرق
    // مهم: لو احتُسبت المدة حتى now لكانت 2 دقيقة، لكن الصحيح 1.5 دقيقة فقط
    // (بين القراءتين الفعليتين). الفجوة بينهما 1.5 دقيقة بالضبط — الحد
    // الأقصى المسموح (90 ثانية، ACTIVE_RULE_BUNDLE.pm10.evidence.
    // maxContinuityGapMs).
    const readings = readingsBackFromNow(NOW, [
      { minutesAgo: 2, pm10: 345 },
      { minutesAgo: 0.5, pm10: 350 },
    ]);
    const r = computeSustainedPm10Status(readings, NOW);
    expect(r.sustainedMinutesAbove340).toBe(1.5);
  });

  it('قراءات ≥340 مستمرة لأكثر من دقيقتين → مخالفة مؤكدة', () => {
    // source='device' صراحة (لا افتراضي) — منذ إصلاح H-03.1 (مراجعة كود
    // خبير خارجي: "مصدر مجهول يتحول إلى device")، قراءة بلا source مسجَّل
    // تُعامَل كأضعف ثقة ('open-meteo') لا كأقواها، فتبقى معلَّقة أبداً
    // مهما طال الاستمرار الظاهري — يجب تمرير المصدر الحقيقي صراحة ليتأكد.
    const readings = readingsBackFromNow(NOW, [
      { minutesAgo: 3, pm10: 350, source: 'device' },
      { minutesAgo: 2, pm10: 345, source: 'device' },
      { minutesAgo: 1, pm10: 355, source: 'device' },
      { minutesAgo: 0, pm10: 342, source: 'device' },
    ]);
    const r = computeSustainedPm10Status(readings, NOW);
    expect(r.sustainedMinutesAbove340).toBeGreaterThanOrEqual(2);
    expect(r.isConfirmedViolation340).toBe(true);
    expect(r.isPendingViolation340).toBe(false);
  });

  // خطأ مكتشَف ومُصلَح (مراجعة خبير خارجي — "لا قدرة Replay كاملة: القرار
  // المخزَّن لا يحمل معرّفات القراءات الفعلية التي أثبتت الاستمرار"):
  // evidenceReadingIds يجب أن تحمل بالضبط معرّفات القراءات المكوِّنة لسلسلة
  // الاستمرار المؤكَّدة، لا كل القراءات المُمرَّرة ولا فارغة.
  describe('evidenceReadingIds — معرّفات القراءات المُثبِتة للاستمرار', () => {
    it('مخالفة مؤكَّدة (>340 لأكثر من دقيقتين) → evidenceReadingIds تحمل معرّفات السلسلة كاملة', () => {
      const readings = readingsBackFromNow(NOW, [
        { minutesAgo: 3, pm10: 350, source: 'device', id: 'r1' },
        { minutesAgo: 2, pm10: 345, source: 'device', id: 'r2' },
        { minutesAgo: 1, pm10: 355, source: 'device', id: 'r3' },
        { minutesAgo: 0, pm10: 342, source: 'device', id: 'r4' },
      ]);
      const r = computeSustainedPm10Status(readings, NOW);
      expect(r.isConfirmedViolation340).toBe(true);
      expect(r.evidenceReadingIds.sort()).toEqual(['r1', 'r2', 'r3', 'r4'].sort());
    });

    it('معلَّق فقط (أقل من دقيقتين) → evidenceReadingIds فارغة (لا دليل مؤكَّد بعد)', () => {
      const readings = readingsBackFromNow(NOW, [{ minutesAgo: 0, pm10: 350, source: 'device', id: 'r1' }]);
      const r = computeSustainedPm10Status(readings, NOW);
      expect(r.isConfirmedViolation340).toBe(false);
      expect(r.evidenceReadingIds).toEqual([]);
    });

    it('قراءة معزولة خارج الفجوة المسموحة (>90 ثانية) لا تدخل evidenceReadingIds', () => {
      const readings = readingsBackFromNow(NOW, [
        { minutesAgo: 40, pm10: 350, source: 'device', id: 'isolated' },
        { minutesAgo: 1, pm10: 345, source: 'device', id: 'r1' },
        { minutesAgo: 0, pm10: 350, source: 'device', id: 'r2' },
      ]);
      const r = computeSustainedPm10Status(readings, NOW);
      expect(r.evidenceReadingIds).not.toContain('isolated');
    });

    it('تعليق 250 لمدة 30 دقيقة → evidenceReadingIds تحمل معرّفات سلسلة الـ250 (لا 340)', () => {
      const readings = readingsBackFromNow(
        NOW,
        Array.from({ length: 31 }, (_, i) => ({ minutesAgo: 30 - i, pm10: 255, source: 'device' as const, id: `r${i}` }))
      );
      const r = computeSustainedPm10Status(readings, NOW);
      expect(r.isSuspended250For30Min).toBe(true);
      expect(r.isConfirmedViolation340).toBe(false);
      expect(r.evidenceReadingIds.length).toBe(31);
    });

    it('لا مخالفة مؤكَّدة ولا تعليق (ALLOW عادي) → evidenceReadingIds فارغة', () => {
      const readings = readingsBackFromNow(NOW, [{ minutesAgo: 0, pm10: 50, source: 'device', id: 'r1' }]);
      const r = computeSustainedPm10Status(readings, NOW);
      expect(r.evidenceReadingIds).toEqual([]);
    });
  });

  // خطأ مكتشَف ومُصلَح (مراجعة كود مدير — "حد PM10 ما زال خاطئاً"):
  // isAbove340Now/isConfirmedViolation340 كانا يستخدمان `>=` بدل `>` على
  // كلا العتبتين (قيمة 340 نفسها، ومدة استمرار دقيقتين نفسها) — النص
  // التنظيمي يشترط "أكثر من دقيقتين" و"تجاوز 340" صراحة (كلاهما `>`)، لا
  // "على الأقل"/"يساوي أو أكثر". القيمتان الحديّتان بالضبط (340.000، ودقيقتان
  // تماماً) يجب ألا تُصنَّفا "أعلى من الحد الآن"/"مؤكَّدة" بعد.
  it('القراءة الحالية = 340 بالضبط (لا تجاوز فعلي) → ليست "أعلى من 340 الآن"، لا معلَّق ولا مؤكَّد', () => {
    const readings = readingsBackFromNow(NOW, [
      { minutesAgo: 3, pm10: 340, source: 'device' },
      { minutesAgo: 0, pm10: 340, source: 'device' },
    ]);
    const r = computeSustainedPm10Status(readings, NOW);
    expect(r.isPendingViolation340).toBe(false);
    expect(r.isConfirmedViolation340).toBe(false);
  });

  it('استمرار فعلي = دقيقتان بالضبط (لا أكثر) فوق 340 → يبقى معلَّقاً، ليس مؤكَّداً بعد', () => {
    const readings = readingsBackFromNow(NOW, [
      { minutesAgo: 2, pm10: 350, source: 'device' },
      { minutesAgo: 1, pm10: 348, source: 'device' },
      { minutesAgo: 0, pm10: 345, source: 'device' },
    ]);
    const r = computeSustainedPm10Status(readings, NOW);
    expect(r.sustainedMinutesAbove340).toBe(2);
    expect(r.isConfirmedViolation340).toBe(false);
    expect(r.isPendingViolation340).toBe(true);
  });

  it('استمرار فعلي أكثر بقليل من دقيقتين (2 دقيقة و1 ثانية) فوق 340 → مؤكَّدة الآن', () => {
    const readings = [
      { pm10UgM3: 350, recordedAt: new Date(NOW - 121_000).toISOString(), source: 'device' as const },
      { pm10UgM3: 348, recordedAt: new Date(NOW - 60_000).toISOString(), source: 'device' as const },
      { pm10UgM3: 345, recordedAt: new Date(NOW).toISOString(), source: 'device' as const },
    ];
    const r = computeSustainedPm10Status(readings, NOW);
    expect(r.isConfirmedViolation340).toBe(true);
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

  it('فجوة زمنية كبيرة بين قراءتين (>90 ثانية) لا تُحسَب استمراراً واحداً متواصلاً', () => {
    const readings = readingsBackFromNow(NOW, [
      { minutesAgo: 40, pm10: 350 }, // قراءة قديمة معزولة (جهاز توقف ثم عاد)
      { minutesAgo: 1, pm10: 345 },
      { minutesAgo: 0, pm10: 350 },
    ]);
    const r = computeSustainedPm10Status(readings, NOW);
    // الاستمرار يُحسب فقط من آخر قراءتين متتاليتين (فجوة أقل من 90 ثانية
    // بينهما، القيمة الفعلية من ACTIVE_RULE_BUNDLE.pm10.evidence.
    // maxContinuityGapMs)، لا يمتد للقراءة المعزولة قبل 40 دقيقة.
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

  // خطأ مكتشَف ومُصلَح (مراجعة خبير خارجي — "استمرارية الدليل غير صحيحة"):
  // كانت القراءات بفارق دقيقتين بين كل قراءتين (يتجاوز الحد الفعلي 90 ثانية
  // من ACTIVE_RULE_BUNDLE.pm10.evidence.maxContinuityGapMs) — الآن بفارق
  // دقيقة واحدة بالضبط (ضمن الحد المسموح).
  it('استمرار ≥250 لمدة 30 دقيقة متواصلة بالضبط (قراءات كل دقيقة) → تعليق مفعَّل', () => {
    // source='device' صراحة — راجع تعليق H-03.1 في الاختبار السابق.
    const readings = readingsBackFromNow(
      NOW,
      Array.from({ length: 31 }, (_, i) => ({ minutesAgo: 30 - i, pm10: 255, source: 'device' as const }))
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

  // خطأ مكتشَف ومُصلَح (مراجعة خبير خارجي — "استمرارية الدليل غير صحيحة"):
  // الفجوة المسموحة بين قراءتين متتاليتين أصبحت 90 ثانية (1.5 دقيقة) —
  // القيمة الفعلية من ACTIVE_RULE_BUNDLE.pm10.evidence.maxContinuityGapMs
  // (المرجع التنظيمي: الملحق ب، صفحة 82)، لا 4 دقائق كما كانت. القراءات
  // هنا بفجوة دقيقة واحدة بين كل قراءتين — ضمن الحد المسموح.
  it('قراءات مصدرها device صريحاً وحديثة ومستمرة لأكثر من دقيقتين → مخالفة مؤكدة', () => {
    const readings = readingsBackFromNow(NOW, [
      { minutesAgo: 3, pm10: 350, source: 'device' },
      { minutesAgo: 2, pm10: 345, source: 'device' },
      { minutesAgo: 1, pm10: 344, source: 'device' },
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
      { minutesAgo: 2, pm10: 350, source: 'device' },
      { minutesAgo: 1, pm10: 344, source: 'device' },
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

  // خطأ مكتشَف ومُصلَح (مراجعة كود خبير خارجي — H-03.3: "قراءة =340 تُحتسب
  // ضمن سلسلة >340"): streakMinutesAbove(340) كانت تقطع السلسلة بشرط
  // `< threshold` فقط — قراءة تساوي 340 بالضبط لم تكن "أقل من" العتبة، فتُسهم
  // في الاستمرار المُحتسَب رغم أنها لا تمثّل تجاوزاً فعلياً (isAbove340Now
  // يشترط > 340 صراحة). الآن تُقطَع السلسلة عند 340 بالضبط تماماً كأي قراءة
  // أقل منها.
  it('H-03.3: قراءة =340 بالضبط تقطع سلسلة الاستمرار (لا تُحتسب ضمنها)', () => {
    const readings = readingsBackFromNow(NOW, [
      { minutesAgo: 5, pm10: 340, source: 'device' }, // =340 بالضبط — يجب أن تقطع السلسلة هنا
      { minutesAgo: 3, pm10: 345, source: 'device' },
      { minutesAgo: 2, pm10: 348, source: 'device' },
      { minutesAgo: 1, pm10: 350, source: 'device' },
      { minutesAgo: 0, pm10: 342, source: 'device' },
    ]);
    const r = computeSustainedPm10Status(readings, NOW);
    // الاستمرار يُقاس فقط بين القراءات الأربع الأخيرة (>340 فعلياً: منذ
    // 3 دقائق حتى الآن)، لا ممتداً إلى القراءة الأقدم (منذ 5 دقائق، =340
    // بالضبط) — يجب أن يكون 3 دقائق بالضبط، لا 5.
    expect(r.sustainedMinutesAbove340).toBe(3);
  });

  it('H-03.3: كل القراءات =340 بالضبط (لا تتجاوز) → لا استمرار مؤكَّد إطلاقاً', () => {
    const readings = readingsBackFromNow(NOW, [
      { minutesAgo: 5, pm10: 340, source: 'device' },
      { minutesAgo: 4, pm10: 340, source: 'device' },
      { minutesAgo: 0, pm10: 340, source: 'device' },
    ]);
    const r = computeSustainedPm10Status(readings, NOW);
    expect(r.sustainedMinutesAbove340).toBe(0);
    expect(r.isConfirmedViolation340).toBe(false);
    // isAbove340Now يشترط >340 صراحة — 340 بالضبط ليست تجاوزاً، فلا حتى معلَّقة.
    expect(r.isPendingViolation340).toBe(false);
  });

  // خطأ مكتشَف ومُصلَح (مراجعة كود خبير خارجي — H-03.1: "مصدر مجهول يتحول
  // إلى device"): كان source ?? 'device' يمنح قراءة بلا مصدر مسجَّل أعلى
  // درجة ثقة ممكنة. الآن تُعامَل كأضعف ثقة ('open-meteo')، فتبقى معلَّقة
  // دائماً، أبداً مؤكَّدة، حتى لو استمرت لفترة طويلة وكانت حديثة جداً.
  it('H-03.1: قراءات بلا source مسجَّل إطلاقاً (undefined) → لا تصل أبداً لحالة مؤكَّدة رغم الاستمرار والحداثة', () => {
    const readings = readingsBackFromNow(NOW, [
      { minutesAgo: 3, pm10: 350 }, // source غائب تماماً
      { minutesAgo: 2, pm10: 348 },
      { minutesAgo: 1, pm10: 345 },
      { minutesAgo: 0, pm10: 342 },
    ]);
    const r = computeSustainedPm10Status(readings, NOW);
    expect(r.sustainedMinutesAbove340).toBeGreaterThanOrEqual(2);
    expect(r.isConfirmedViolation340).toBe(false);
    expect(r.isPendingViolation340).toBe(true);
  });

  // خطأ مكتشَف ومُصلَح (مراجعة كود خبير خارجي — H-03.2: "قراءة بوقت مستقبلي
  // لا تُرفض"): latestReadingAgeMinutes سالبة (recordedAt مستقبلي، مثال:
  // ساعة جهاز غير متزامنة) كانت تحقق `<= 4` دائماً فتُعامَل كحديثة جداً. الآن
  // عمر سالب يُبطل الحداثة صراحة.
  it('H-03.2: قراءة بوقت مستقبلي (recordedAt بعد "الآن") لا تُعامَل كحديثة — تمنع التأكيد رغم استمرار ظاهري', () => {
    const futureIso = new Date(NOW + 5 * 60000).toISOString(); // 5 دقائق بالمستقبل
    const readings = [
      { pm10UgM3: 350, recordedAt: futureIso, source: 'device' as const },
      { pm10UgM3: 345, recordedAt: new Date(NOW - 1 * 60000).toISOString(), source: 'device' as const },
      { pm10UgM3: 342, recordedAt: new Date(NOW - 3 * 60000).toISOString(), source: 'device' as const },
    ];
    const r = computeSustainedPm10Status(readings, NOW);
    expect(r.isConfirmedViolation340).toBe(false);
    expect(r.isPendingViolation340).toBe(true);
  });
});

describe('computeStoppedSince (تأكيد عدم كسر السلوك الحالي بعد إضافة قواعد PM10 الجديدة)', () => {
  it('لا يزال يعمل بنفس المنطق السابق', () => {
    expect(computeStoppedSince('ALLOW', null, 'ALLOW')).toBeNull();
  });
});

// =====================================================================
// اختبارات fetchPm10SustainedStatus — خطأ مكتشَف ومُصلَح (مراجعة كود مدير —
// ملاحظة #4): كان الاستعلام يجلب كل قراءات المشروع بحسب project_id فقط،
// بلا فلترة device_id. مشروع فيه جهازان (A مرتبط بنشاط 1، B مرتبط بنشاط 2)
// كان يخلط قراءاتهما معاً، فقراءات جهاز B قد "تُثبت" استمراراً جزئياً
// لنشاط 1 غير مرتبط به إطلاقاً. اختبار القبول المطلوب: ثلاث قراءات من B
// لا يجوز أن تؤكد مخالفة نشاط مرتبط بـA.
// =====================================================================
describe('fetchPm10SustainedStatus — عزل قراءات الأجهزة بحسب device_id', () => {
  // عميل Supabase مموّه بأقل ما يلزم من السلسلة المستخدمة فعلياً:
  // from().select().eq().gte().order() يُرجع { data: rows } مباشرة (لا
  // .maybeSingle()، القراءات مصفوفة لا صفاً واحداً).
  function mockSupabase(rows: Record<string, unknown>[]): SupabaseClient {
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: () => chain,
      gte: () => chain,
      order: async () => ({ data: rows }),
    };
    return { from: vi.fn(() => chain) } as unknown as SupabaseClient;
  }

  const NOW = Date.now();
  function readingRow(
    minutesAgo: number,
    pm10: number,
    deviceId: string | null,
    activityGroupId: string | null = null,
    source: 'device' | 'manual' | 'open-meteo' = 'device',
    isLate = false,
    id?: string
  ) {
    return {
      id: id ?? `row-${minutesAgo}-${pm10}`,
      pm10_ug_m3: pm10,
      recorded_at: new Date(NOW - minutesAgo * 60000).toISOString(),
      activity_group_id: activityGroupId,
      source,
      device_id: deviceId,
      is_late: isLate,
    };
  }

  it('اختبار القبول: ثلاث قراءات متناوبة من جهازين (A وB) — نشاط مرتبط بـA فقط لا يتأكد من قراءات B المتخللة', () => {
    // 12:00 A=350، 12:01 B=355، 12:02 A=360 — بلا فلترة device_id كانت هذه
    // السلسلة (project_id واحد، activity_group_id=null للثلاثة) تُحسب
    // كاستمرار واحد متواصل رغم أن لا جهاز منفرد أثبت استمراراً فعلياً.
    const rows = [
      readingRow(2, 350, 'device-A'),
      readingRow(1, 355, 'device-B'),
      readingRow(0, 360, 'device-A'),
    ];
    const supabase = mockSupabase(rows);

    // النشاط 1 مرتبط بجهاز A تحديداً.
    // (لاحظ: fetchPm10SustainedStatus تستدعي Date.now() داخلياً عبر
    // computeSustainedPm10Status الافتراضية — نستخدم توقيتاً قريباً بما فيه
    // الكفاية من NOW أعلاه بحيث تبقى القراءات ضمن نافذة الجلب الزمنية.)
    return fetchPm10SustainedStatus(supabase, 'project-1', 'group-1', 'device-A').then((r) => {
      // القراءتان الفعليتان من A فقط (12:00 و12:02) بينهما فجوة 2 دقيقة —
      // ضمن هامش التحمّل، لكن قراءة B الوسيطة لا تدخل السلسلة إطلاقاً لأن
      // مصدرها device-B لا device-A، فلا تُحسَب "قراءة متناوبة تُثبت شيئاً".
      expect(r.currentReadingUgM3).toBe(360); // آخر قراءة من A تحديداً، لا 355 (B)
    });
  });

  it('نشاط مرتبط بجهاز A، وكل القراءات المسجَّلة من جهاز B فقط → لا قراءات جهاز إطلاقاً لهذا النشاط', () => {
    const rows = [
      readingRow(2, 350, 'device-B'),
      readingRow(1, 355, 'device-B'),
      readingRow(0, 360, 'device-B'),
    ];
    const supabase = mockSupabase(rows);
    return fetchPm10SustainedStatus(supabase, 'project-1', 'group-1', 'device-A').then((r) => {
      expect(r.currentReadingUgM3).toBeNull();
      expect(r.isConfirmedViolation340).toBe(false);
      expect(r.isPendingViolation340).toBe(false);
    });
  });

  it('نشاط بلا جهاز مرتبط (deviceId=null) → لا يستقبل أي قراءة device على مستوى المشروع، حتى لو وُجدت', () => {
    const rows = [
      readingRow(2, 350, 'device-A'),
      readingRow(1, 355, 'device-A'),
      readingRow(0, 360, 'device-A'),
    ];
    const supabase = mockSupabase(rows);
    return fetchPm10SustainedStatus(supabase, 'project-1', 'group-1', null).then((r) => {
      expect(r.currentReadingUgM3).toBeNull();
    });
  });

  // خطأ مكتشَف ومُصلَح (مراجعة خبير خارجي — "لا قدرة Replay كاملة"):
  // fetchPm10SustainedStatus يجب أن يجلب عمود id من pm10_readings_history
  // ويُمرِّره كما هو إلى computeSustainedPm10Status — evidenceReadingIds في
  // النتيجة النهائية يجب أن تحمل معرّفات صفوف قاعدة البيانات الفعلية، لا
  // معرّفات مصطنعة أو فارغة.
  it('evidenceReadingIds في النتيجة النهائية تحمل معرّفات صفوف pm10_readings_history الفعلية (id)', () => {
    const rows = [
      readingRow(3, 350, 'device-A', null, 'device', false, 'db-id-1'),
      readingRow(2, 345, 'device-A', null, 'device', false, 'db-id-2'),
      readingRow(1, 355, 'device-A', null, 'device', false, 'db-id-3'),
      readingRow(0, 342, 'device-A', null, 'device', false, 'db-id-4'),
    ];
    const supabase = mockSupabase(rows);
    return fetchPm10SustainedStatus(supabase, 'project-1', 'group-1', 'device-A').then((r) => {
      expect(r.isConfirmedViolation340).toBe(true);
      expect(r.evidenceReadingIds.sort()).toEqual(['db-id-1', 'db-id-2', 'db-id-3', 'db-id-4'].sort());
    });
  });

  it('نشاط مرتبط بجهاز A، وسلسلة كاملة متجانسة من A فقط (لا خلط) → تُحتسب صح مع تجاهل قراءات B المتخللة', () => {
    const rows = [
      readingRow(3, 345, 'device-A'),
      readingRow(2, 355, 'device-B'), // متخلل — يُتجاهَل تماماً
      readingRow(1.5, 350, 'device-A'),
      readingRow(0, 342, 'device-A'),
    ];
    const supabase = mockSupabase(rows);
    return fetchPm10SustainedStatus(supabase, 'project-1', 'group-1', 'device-A').then((r) => {
      // 3 قراءات فعلية من A (3، 1.5، 0 دقائق) بفجوة أقصاها 1.5 دقيقة بينها —
      // ضمن هامش التحمّل الفعلي (90 ثانية، ACTIVE_RULE_BUNDLE.pm10.evidence.
      // maxContinuityGapMs)، فتُحسب سلسلة متصلة بمعزل عن B.
      expect(r.sustainedMinutesAbove340).toBeGreaterThanOrEqual(2);
      expect(r.isConfirmedViolation340).toBe(true);
    });
  });

  // خطأ مكتشَف ومُصلَح (مراجعة خبير خارجي — "القراءات المتأخرة يجب أن تُمنَع
  // من تغيير الحالة التشغيلية الحالية"): قراءة is_late=true (وصلت للخادم
  // بعد أكثر من 40 دقيقة من observed_at الفعلي — راجع deviceReadingWriter.ts)
  // لا يجوز أن "تُثبت" استمرار مخالفة رغم بقائها في الجدول التاريخي للتدقيق.
  it('قراءة is_late=true لا تُحتسب ضمن استمرار المخالفة رغم قيمتها العالية وحداثة توقيتها الظاهري', () => {
    const rows = [
      readingRow(3, 350, 'device-A', null, 'device', false),
      readingRow(2, 355, 'device-A', null, 'device', true), // متأخرة — يجب استبعادها
      readingRow(1.5, 350, 'device-A', null, 'device', false),
      readingRow(0, 342, 'device-A', null, 'device', false),
    ];
    const supabase = mockSupabase(rows);
    return fetchPm10SustainedStatus(supabase, 'project-1', 'group-1', 'device-A').then((r) => {
      // القراءة المتأخرة استُبعدت تماماً — الاستمرار يُحسب فقط من القراءات
      // الثلاث غير المتأخرة (3، 1.5، 0 دقائق)، لا من كل الأربع.
      expect(r.currentReadingUgM3).toBe(342);
      expect(r.isConfirmedViolation340).toBe(true);
    });
  });

  it('كل القراءات is_late=true → لا استمرار إطلاقاً (كأن لا قراءات وصلت)', () => {
    const rows = [
      readingRow(2, 350, 'device-A', null, 'device', true),
      readingRow(1, 355, 'device-A', null, 'device', true),
      readingRow(0, 360, 'device-A', null, 'device', true),
    ];
    const supabase = mockSupabase(rows);
    return fetchPm10SustainedStatus(supabase, 'project-1', 'group-1', 'device-A').then((r) => {
      expect(r.currentReadingUgM3).toBeNull();
      expect(r.isConfirmedViolation340).toBe(false);
      expect(r.isPendingViolation340).toBe(false);
    });
  });
});
