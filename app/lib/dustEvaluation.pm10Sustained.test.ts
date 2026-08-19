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
  values: { minutesAgo: number; pm10: number; source?: 'device' | 'manual' | 'open-meteo'; id?: string; isSnapshotOnly?: boolean }[]
): { pm10UgM3: number; recordedAt: string; source?: 'device' | 'manual' | 'open-meteo'; id?: string; isSnapshotOnly?: boolean }[] {
  return values.map((v) => ({
    pm10UgM3: v.pm10,
    recordedAt: new Date(now - v.minutesAgo * 60000).toISOString(),
    source: v.source,
    id: v.id,
    isSnapshotOnly: v.isSnapshotOnly,
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

    // قرار تنظيمي مُعاد النظر فيه (طلب صريح من المستخدم — "الإيقاف الفعلي
    // فقط عند استمرار التجاوز فوق 340 لمدة 30 دقيقة"): 30 دقيقة كاملة عند
    // 255 (داخل [250,340]، لا تتجاوز 340 أبداً) لم تعد تُفعِّل التعليق —
    // عداد الـ30 دقيقة أصبح مقصوراً على زمن التجاوز الفعلي فوق 340 حصراً.
    it('30 دقيقة متواصلة عند 255 (داخل [250,340]، لا تتجاوز 340 أبداً) → لا تعليق (لم تعد ضمن عدّاد الـ30 دقيقة)، evidenceReadingIds فارغة', () => {
      const readings = readingsBackFromNow(
        NOW,
        Array.from({ length: 31 }, (_, i) => ({ minutesAgo: 30 - i, pm10: 255, source: 'device' as const, id: `r${i}` }))
      );
      const r = computeSustainedPm10Status(readings, NOW);
      expect(r.isSuspended250For30Min).toBe(false);
      expect(r.isConfirmedViolation340).toBe(false);
      expect(r.evidenceReadingIds).toEqual([]);
    });

    it('30 دقيقة متواصلة فوق 340 → evidenceReadingIds تحمل معرّفات سلسلة الـ340 نفسها (المصدر الوحيد الآن لكلا الحالتين)', () => {
      const readings = readingsBackFromNow(
        NOW,
        Array.from({ length: 31 }, (_, i) => ({ minutesAgo: 30 - i, pm10: 350, source: 'device' as const, id: `r${i}` }))
      );
      const r = computeSustainedPm10Status(readings, NOW);
      expect(r.isSuspended250For30Min).toBe(true);
      expect(r.isConfirmedViolation340).toBe(true);
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

  // قرار تنظيمي مُعاد النظر فيه (طلب صريح من المستخدم — "في حال استمر
  // دقيقتين بالضبط يتم تسجيل مخالفة"): اكتمال الدقيقتين (≥2) أصبح كافياً
  // لتأكيد المخالفة، لا يشترط تجاوزهما (`>=` بدل `>` سابقاً).
  it('استمرار فعلي = دقيقتان بالضبط (لا أكثر) فوق 340 → مؤكَّدة الآن (اكتمال الدقيقتين كافٍ)', () => {
    const readings = readingsBackFromNow(NOW, [
      { minutesAgo: 2, pm10: 350, source: 'device' },
      { minutesAgo: 1, pm10: 348, source: 'device' },
      { minutesAgo: 0, pm10: 345, source: 'device' },
    ]);
    const r = computeSustainedPm10Status(readings, NOW);
    expect(r.sustainedMinutesAbove340).toBe(2);
    expect(r.isConfirmedViolation340).toBe(true);
    expect(r.isPendingViolation340).toBe(false);
  });

  it('استمرار فعلي أقل بقليل من دقيقتين (119.999 ثانية، أقصر بمللي ثانية واحدة فقط) فوق 340 → لا تزال معلَّقة، ليست مؤكَّدة بعد', () => {
    const readings = [
      { pm10UgM3: 350, recordedAt: new Date(NOW - 119_999).toISOString(), source: 'device' as const },
      { pm10UgM3: 348, recordedAt: new Date(NOW - 60_000).toISOString(), source: 'device' as const },
      { pm10UgM3: 345, recordedAt: new Date(NOW).toISOString(), source: 'device' as const },
    ];
    const r = computeSustainedPm10Status(readings, NOW);
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
  // قرار تنظيمي مُعاد النظر فيه (طلب صريح من المستخدم): 30 دقيقة عند 255
  // (داخل [250,340]) لم تعد تُفعِّل التعليق — عدّاد الـ30 دقيقة مقصور على
  // زمن التجاوز الفعلي فوق 340. الاختبار المكافئ للسلوك الجديد بفوق 340
  // موجود أدناه.
  it('استمرار عند 255 (داخل [250,340]) لمدة 30 دقيقة متواصلة بالضبط (قراءات كل دقيقة) → لا تعليق (لا يتجاوز 340 أبداً)', () => {
    // source='device' صراحة — راجع تعليق H-03.1 في الاختبار السابق.
    const readings = readingsBackFromNow(
      NOW,
      Array.from({ length: 31 }, (_, i) => ({ minutesAgo: 30 - i, pm10: 255, source: 'device' as const }))
    );
    const r = computeSustainedPm10Status(readings, NOW);
    expect(r.isSuspended250For30Min).toBe(false);
  });

  it('استمرار فوق 340 لمدة 30 دقيقة متواصلة بالضبط (قراءات كل دقيقة) → تعليق مفعَّل', () => {
    const readings = readingsBackFromNow(
      NOW,
      Array.from({ length: 31 }, (_, i) => ({ minutesAgo: 30 - i, pm10: 350, source: 'device' as const }))
    );
    const r = computeSustainedPm10Status(readings, NOW);
    expect(r.isSuspended250For30Min).toBe(true);
  });

  it('استمرار فوق 340 لمدة 29:59 دقيقة (أقصر بثانية واحدة فقط من 30 دقيقة) → لا تعليق بعد، شرط الـ30 دقيقة غير مكتمل', () => {
    const readings = [
      { pm10UgM3: 350, recordedAt: new Date(NOW - 1_799_000).toISOString(), source: 'device' as const }, // 29:59 قبل الآن
      ...Array.from({ length: 29 }, (_, i) => ({
        pm10UgM3: 350,
        recordedAt: new Date(NOW - (29 - i) * 60_000).toISOString(),
        source: 'device' as const,
      })),
      { pm10UgM3: 350, recordedAt: new Date(NOW).toISOString(), source: 'device' as const },
    ];
    const r = computeSustainedPm10Status(readings, NOW);
    expect(r.isConfirmedViolation340).toBe(true);
    expect(r.isSuspended250For30Min).toBe(false);
  });

  it('استمرار فوق 340 لمدة 25 دقيقة فقط (أقل من 30، قراءات كل دقيقتين) → لا تعليق بعد', () => {
    const readings = readingsBackFromNow(
      NOW,
      Array.from({ length: 13 }, (_, i) => ({ minutesAgo: 24 - i * 2, pm10: 350, source: 'device' as const }))
    );
    const r = computeSustainedPm10Status(readings, NOW);
    expect(r.isSuspended250For30Min).toBe(false);
  });

  // اختبارات قبول صريحة (طلب المستخدم — تقرير المراجعة الخارجي: "الموصل
  // Snapshot-only لا يصلح لإثبات الاستمرارية"): قراءة isSnapshotOnly=true
  // (وصلت عبر fetchLatestReading الاحتياطي، لا fetchReadingsSince) لا يجوز
  // أن تُثبت أو تُمدِّد أي سلسلة استمرار — streakMinutesAbove يقطع عندها
  // تماماً كفجوة زمنية غير مقبولة (راجع migration 202608110017).
  describe('قراءة isSnapshotOnly=true لا تُثبت استمراراً (اختبار قبول صريح)', () => {
    it('قراءة snapshot-only وحيدة ≥340 → معلَّق فقط أبداً، لا مؤكَّدة (لا فرق عن قراءة عادية وحيدة، sampleCount<2)', () => {
      const readings = readingsBackFromNow(NOW, [{ minutesAgo: 0, pm10: 350, source: 'device', isSnapshotOnly: true }]);
      const r = computeSustainedPm10Status(readings, NOW);
      expect(r.isPendingViolation340).toBe(true);
      expect(r.isConfirmedViolation340).toBe(false);
    });

    it('قراءتان تاريخيتان كاملتان (>دقيقتين استمرار حقيقي) ثم قراءة snapshot-only أحدث فوقهما → لا تُصعِّد الاستمرار المؤكَّد أصلاً، فلا فرق هنا (يبقى مؤكَّداً من القراءتين الحقيقيتين فقط)', () => {
      // القراءتان الأقدم (device، HISTORY_COMPLETE ضمنياً) تُثبتان استمراراً
      // >دقيقتين بالفعل بمعزل عن الأحدث — الأحدث (snapshot-only) لا تُضيف
      // ولا تُنقِص من ذلك الإثبات المُسبَق؛ فقط لا يجوز أن *تكون* هي مصدر
      // الإثبات بذاتها.
      const readings = readingsBackFromNow(NOW, [
        { minutesAgo: 3, pm10: 350, source: 'device' },
        { minutesAgo: 1, pm10: 345, source: 'device' },
        { minutesAgo: 0, pm10: 360, source: 'device', isSnapshotOnly: true },
      ]);
      const r = computeSustainedPm10Status(readings, NOW);
      // القراءة الحالية (الأحدث زمنياً) هي نفسها snapshot-only — السلسلة
      // تبدأ منها وتتوقف فوراً بعدها (لا تمتد للقراءتين الأقدم رغم كونهما
      // فعليتين)، فـsampleCount=1 من نقطة الانطلاق فقط → لا استمرار مؤكَّد.
      expect(r.isConfirmedViolation340).toBe(false);
      expect(r.isPendingViolation340).toBe(true);
    });

    it('سلسلة تاريخية كاملة (3 قراءات device حقيقية، استمرار >دقيقتين) لا تحوي أي snapshot-only → تبقى مؤكَّدة كما كانت (لا تراجع في السلوك الحالي)', () => {
      const readings = readingsBackFromNow(NOW, [
        { minutesAgo: 3, pm10: 350, source: 'device', isSnapshotOnly: false },
        { minutesAgo: 2, pm10: 345, source: 'device', isSnapshotOnly: false },
        { minutesAgo: 1, pm10: 355, source: 'device', isSnapshotOnly: false },
        { minutesAgo: 0, pm10: 342, source: 'device', isSnapshotOnly: false },
      ]);
      const r = computeSustainedPm10Status(readings, NOW);
      expect(r.isConfirmedViolation340).toBe(true);
    });

    it('قراءة snapshot-only في منتصف سلسلة تاريخية كاملة → تقطع الاستمرار عندها تماماً كفجوة زمنية (القراءات الأقدم منها لا تُحتسَب ضمن السلسلة الحالية)', () => {
      const readings = readingsBackFromNow(NOW, [
        { minutesAgo: 5, pm10: 350, source: 'device' }, // أقدم من نقطة القطع — لا يدخل السلسلة الحالية
        { minutesAgo: 3, pm10: 345, source: 'device', isSnapshotOnly: true }, // نقطة القطع
        { minutesAgo: 1, pm10: 355, source: 'device' },
        { minutesAgo: 0, pm10: 342, source: 'device' },
      ]);
      const r = computeSustainedPm10Status(readings, NOW);
      // السلسلة الحالية (من الأحدث للخلف): 0د، 1د تدخلان، ثم 3د (snapshot-only)
      // تدخل هي نفسها ثم تقطع الحلقة فوراً — 3 عينات فقط (لا 4)، فارق حقيقي
      // بين أقدم/أحدث في السلسلة = دقيقتان بالضبط (0 إلى 3 دقائق) — لا يتجاوز
      // دقيقتين فعلياً (>)، فيبقى معلَّقاً لا مؤكَّداً؛ الأهم: القراءة الأقدم
      // (5 دقائق) مستبعدة تماماً من evidenceReadingIds/الحساب.
      expect(r.isPendingViolation340).toBe(true);
      expect(r.isConfirmedViolation340).toBe(false);
    });

    it('تعليق 250 لمدة 30 دقيقة يتطلب استمراراً حقيقياً — سلسلة كلها snapshot-only لا تصل أبداً لتعليق رغم 31 نقطة', () => {
      const readings = readingsBackFromNow(
        NOW,
        Array.from({ length: 31 }, (_, i) => ({ minutesAgo: 30 - i, pm10: 255, source: 'device' as const, isSnapshotOnly: true }))
      );
      const r = computeSustainedPm10Status(readings, NOW);
      // كل نقطة snapshot-only تقطع السلسلة فور دخولها — أقصى ما يمكن إثباته
      // هو نقطة واحدة في كل مرة (sampleCount=1 دائماً)، فلا تعليق 30 دقيقة
      // يمكن إثباته إطلاقاً من بيانات لحظية بحتة.
      expect(r.isSuspended250For30Min).toBe(false);
    });
  });

  // قرار تنظيمي مُعاد النظر فيه مرتين (طلب صريح من المستخدم في كل مرة):
  // الجولة الأولى وحَّدت عدّاد الـ30 دقيقة عبر [250,340] و>340 معاً — تلك
  // الجولة أُلغيت الآن (الجولة الثانية): "الإيقاف الفعلي فقط عند استمرار
  // التجاوز فوق 340 لمدة 30 دقيقة" — زمن نطاق التحذير [250,340] لا يُسهم
  // إطلاقاً في عدّاد الإيقاف بعد الآن؛ يلزم 30 دقيقة متواصلة فوق 340 فعلياً
  // لوحدها. تأكيد مخالفة الدقيقتين (above340Streak/isConfirmedViolation340)
  // ونافذة الـ30 دقيقة كلاهما يُبنيان الآن من نفس السلسلة (above340Streak) —
  // لا حساب منفصل.
  describe('عدّاد الـ30 دقيقة مقصور على زمن التجاوز الفعلي فوق 340 (لا نطاق التحذير)', () => {
    it('قراءة واحدة >340 في منتصف سلسلة 250 → لا تُسهم بقية النطاق [250,340] في العدّاد؛ فقط زمن التجاوز الفعلي فوق 340 (نقطة واحدة، سلسلة بلا استمرار حقيقي) → لا تعليق', () => {
      const readings = readingsBackFromNow(NOW, [
        ...Array.from({ length: 15 }, (_, i) => ({ minutesAgo: 30 - i, pm10: 255, source: 'device' as const })),
        { minutesAgo: 15, pm10: 350, source: 'device' as const }, // نقطة >340 وحيدة معزولة بين قراءات [250,340]
        ...Array.from({ length: 15 }, (_, i) => ({ minutesAgo: 14 - i, pm10: 255, source: 'device' as const })),
      ]);
      const r = computeSustainedPm10Status(readings, NOW);
      // above340Streak تبدأ من القراءة الحالية (255، لا تتجاوز 340) فتكون
      // صفراً فوراً — القراءة المعزولة عند 350 لا تصل لأنها ليست القراءة
      // الحالية ولا متصلة بسلسلة >340 حقيقية من الحالية للخلف.
      expect(r.isSuspended250For30Min).toBe(false);
      expect(r.sustainedMinutesAbove250).toBe(0);
    });

    it('القراءة الحالية نفسها >340 مع سلسلة [250,340] سابقة متصلة → above340Streak تتوقف فور أول قراءة ≤340 رجوعاً للخلف (لا تمتد لسلسلة 250)', () => {
      const readings = readingsBackFromNow(NOW, [
        ...Array.from({ length: 30 }, (_, i) => ({ minutesAgo: 30 - i, pm10: 255, source: 'device' as const })),
        { minutesAgo: 0, pm10: 350, source: 'device' as const }, // القراءة الحالية فقط تتجاوز 340
      ]);
      const r = computeSustainedPm10Status(readings, NOW);
      // نقطة واحدة فقط >340 (الحالية) — sampleCount<2 ضمن سلسلة >340 نفسها
      // (القراءة السابقة لها 255، تقطع السلسلة فوراً) → لا استمرار مُثبَت.
      expect(r.sustainedMinutesAbove250).toBe(0);
      expect(r.isSuspended250For30Min).toBe(false);
    });

    it('سلسلة كاملة داخل النطاق [250,340] بلا أي قراءة تتجاوز 340 → لا تعليق (لم تعد ضمن عدّاد الـ30 دقيقة)', () => {
      const readings = readingsBackFromNow(
        NOW,
        Array.from({ length: 31 }, (_, i) => ({ minutesAgo: 30 - i, pm10: 340, source: 'device' as const }))
      );
      const r = computeSustainedPm10Status(readings, NOW);
      expect(r.isSuspended250For30Min).toBe(false);
    });

    // طلب صريح من المستخدم — سيناريو كامل يثبت أن زمن نطاق التحذير
    // [250,340] لا يُسهم في عدّاد الـ30 دقيقة إطلاقاً، حتى لو سبق أو تلا
    // فترة تجاوز فعلي فوق 340.
    it('سلسلة مختلطة كاملة: [250,340] ثم >340 لأكثر من دقيقتين (مخالفة مؤكَّدة) ثم عودة لـ[250,340] — عدّاد الـ30 دقيقة يقيس فقط فترة التجاوز الفعلي (5 دقائق)، لا يكتمل بعد', () => {
      // فواصل دقيقة واحدة بين كل قراءتين (أقل من حد تسامح الفجوة 90 ثانية)
      // لضمان عدم قطع السلسلة بفجوة زمنية عادية.
      const readings = readingsBackFromNow(NOW, [
        // 20 دقيقة أولى ضمن [250,340] — لا تُسهم في عدّاد الـ30 دقيقة بعد الآن
        ...Array.from({ length: 21 }, (_, i) => ({ minutesAgo: 30 - i, pm10: 260, source: 'device' as const })),
        // 5 دقائق تتجاوز 340 (أكثر من دقيقتين — تُنتج isConfirmedViolation340)
        { minutesAgo: 9, pm10: 350, source: 'device' as const },
        { minutesAgo: 8, pm10: 355, source: 'device' as const },
        { minutesAgo: 7, pm10: 345, source: 'device' as const },
        { minutesAgo: 6, pm10: 350, source: 'device' as const },
        { minutesAgo: 5, pm10: 342, source: 'device' as const },
        // تعود لـ[250,340] حتى الآن
        { minutesAgo: 4, pm10: 260, source: 'device' as const },
        { minutesAgo: 3, pm10: 260, source: 'device' as const },
        { minutesAgo: 2, pm10: 260, source: 'device' as const },
        { minutesAgo: 1, pm10: 260, source: 'device' as const },
        { minutesAgo: 0, pm10: 255, source: 'device' as const },
      ]);
      const r = computeSustainedPm10Status(readings, NOW);
      // القراءة الحالية (255) لا تتجاوز 340 — above340Streak تبدأ منها
      // فوراً وتكون صفراً (لا تمتد لفترة الـ340 السابقة عبر قراءات 260).
      expect(r.isConfirmedViolation340).toBe(false);
      expect(r.isSuspended250For30Min).toBe(false);
      expect(r.sustainedMinutesAbove250).toBe(0);
    });

    it('نفس السلسلة المختلطة، لكن مقاسة أثناء لحظة التجاوز نفسها (>340 كقراءة حالية) → isConfirmedViolation340=true، لكن isSuspended250For30Min=false (5 دقائق فقط فوق 340، لا 30)', () => {
      const readings = readingsBackFromNow(NOW, [
        ...Array.from({ length: 26 }, (_, i) => ({ minutesAgo: 30 - i, pm10: 260, source: 'device' as const })),
        { minutesAgo: 4, pm10: 350, source: 'device' as const },
        { minutesAgo: 3, pm10: 355, source: 'device' as const },
        { minutesAgo: 2, pm10: 345, source: 'device' as const },
        { minutesAgo: 1, pm10: 350, source: 'device' as const },
        { minutesAgo: 0, pm10: 342, source: 'device' as const }, // القراءة الحالية >340، أكثر من دقيقتين مستمرة
      ]);
      const r = computeSustainedPm10Status(readings, NOW);
      expect(r.isConfirmedViolation340).toBe(true);
      // above340Streak تتوقف عند أول قراءة ≤340 رجوعاً للخلف (260 قبل 5
      // دقائق) — 5 دقائق فوق 340 فقط، لا 30.
      expect(r.sustainedMinutesAbove250).toBe(4);
      expect(r.isSuspended250For30Min).toBe(false);
    });

    it('30 دقيقة متواصلة فوق 340 فعلياً (لا نطاق تحذير مختلط) → isSuspended250For30Min=true', () => {
      const readings = readingsBackFromNow(
        NOW,
        Array.from({ length: 31 }, (_, i) => ({ minutesAgo: 30 - i, pm10: 350, source: 'device' as const }))
      );
      const r = computeSustainedPm10Status(readings, NOW);
      expect(r.isConfirmedViolation340).toBe(true);
      expect(r.isSuspended250For30Min).toBe(true);
      expect(r.sustainedMinutesAbove250).toBeGreaterThanOrEqual(29);
    });
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
      // خطأ مكتشَف ومُصلَح (مراجعة كود خارجي — "التقييم بحسب وقت المعالجة
      // قد يفوّت مخالفة كاملة"): fetchPm10SustainedStatus أضافت .lte()
      // صريحة (حد أعلى untilIso) بعد .gte() — غياب هذه الدالة من السلسلة
      // الوهمية هنا كان يُسقِط كل استدعاء داخل try/catch الدفاعي في الدالة
      // الحقيقية بصمت (TypeError: chain.lte is not a function)، فيُرجع
      // نتيجة فارغة دائماً بصرف النظر عن rows الممرَّرة — سبب فشل كل
      // اختبارات هذا القسم دفعة واحدة عند إضافة .lte() الفعلية.
      lte: () => chain,
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
    id?: string,
    isSnapshotOnly = false
  ) {
    return {
      id: id ?? `row-${minutesAgo}-${pm10}`,
      pm10_ug_m3: pm10,
      recorded_at: new Date(NOW - minutesAgo * 60000).toISOString(),
      activity_group_id: activityGroupId,
      source,
      device_id: deviceId,
      is_late: isLate,
      is_snapshot_only: isSnapshotOnly,
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
      expect(r.queryFailed).toBe(false);
      const status = r.status!;
      // القراءتان الفعليتان من A فقط (12:00 و12:02) بينهما فجوة 2 دقيقة —
      // ضمن هامش التحمّل، لكن قراءة B الوسيطة لا تدخل السلسلة إطلاقاً لأن
      // مصدرها device-B لا device-A، فلا تُحسَب "قراءة متناوبة تُثبت شيئاً".
      expect(status.currentReadingUgM3).toBe(360); // آخر قراءة من A تحديداً، لا 355 (B)
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
      const status = r.status!;
      expect(status.currentReadingUgM3).toBeNull();
      expect(status.isConfirmedViolation340).toBe(false);
      expect(status.isPendingViolation340).toBe(false);
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
      expect(r.status!.currentReadingUgM3).toBeNull();
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
      const status = r.status!;
      expect(status.isConfirmedViolation340).toBe(true);
      expect(status.evidenceReadingIds.sort()).toEqual(['db-id-1', 'db-id-2', 'db-id-3', 'db-id-4'].sort());
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
      const status = r.status!;
      // 3 قراءات فعلية من A (3، 1.5، 0 دقائق) بفجوة أقصاها 1.5 دقيقة بينها —
      // ضمن هامش التحمّل الفعلي (90 ثانية، ACTIVE_RULE_BUNDLE.pm10.evidence.
      // maxContinuityGapMs)، فتُحسب سلسلة متصلة بمعزل عن B.
      expect(status.sustainedMinutesAbove340).toBeGreaterThanOrEqual(2);
      expect(status.isConfirmedViolation340).toBe(true);
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
      const status = r.status!;
      // القراءة المتأخرة استُبعدت تماماً — الاستمرار يُحسب فقط من القراءات
      // الثلاث غير المتأخرة (3، 1.5، 0 دقائق)، لا من كل الأربع.
      expect(status.currentReadingUgM3).toBe(342);
      expect(status.isConfirmedViolation340).toBe(true);
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
      const status = r.status!;
      expect(status.currentReadingUgM3).toBeNull();
      expect(status.isConfirmedViolation340).toBe(false);
      expect(status.isPendingViolation340).toBe(false);
    });
  });

  // اختبار قبول صريح (طلب المستخدم — "الموصل Snapshot-only لا يصلح لإثبات
  // الاستمرارية"): يتحقق أن is_snapshot_only يصل فعلياً من صف قاعدة البيانات
  // (select الفعلي في fetchPm10SustainedStatus) إلى computeSustainedPm10Status
  // — لا مجرد أن المنطق يعمل بمعزل (مُختبَر أعلاه)، بل أن السلك الفعلي بين
  // القراءة من pm10_readings_history والحساب سليم بالكامل.
  it('is_snapshot_only=true من صف قاعدة البيانات يقطع الاستمرار عبر fetchPm10SustainedStatus كاملة (لا فقط computeSustainedPm10Status المعزولة)', () => {
    const rows = [
      readingRow(3, 350, 'device-A', null, 'device', false, 'r1', false),
      readingRow(1, 345, 'device-A', null, 'device', false, 'r2', false),
      readingRow(0, 360, 'device-A', null, 'device', false, 'r3', true), // snapshot-only — أحدث نقطة
    ];
    const supabase = mockSupabase(rows);
    return fetchPm10SustainedStatus(supabase, 'project-1', 'group-1', 'device-A').then((r) => {
      const status = r.status!;
      // الأحدث (snapshot-only) هي نقطة الانطلاق، تقطع الحلقة فوراً بعدها —
      // لا يمكن أن تُثبت مؤكَّدة رغم وجود قراءتين حقيقيتين أقدم منها.
      expect(status.isConfirmedViolation340).toBe(false);
      expect(status.isPendingViolation340).toBe(true);
    });
  });

  it('is_snapshot_only غائب من صف قاعدة البيانات (null، صف قديم قبل الترحيل) → يُعامَل كـfalse (HISTORY_COMPLETE ضمنياً)، لا تراجع في السلوك الحالي', () => {
    const rows = [
      { ...readingRow(2.5, 350, 'device-A', null, 'device', false, 'r1'), is_snapshot_only: null },
      { ...readingRow(1, 345, 'device-A', null, 'device', false, 'r2'), is_snapshot_only: null },
      { ...readingRow(0, 342, 'device-A', null, 'device', false, 'r3'), is_snapshot_only: null },
    ];
    const supabase = mockSupabase(rows);
    return fetchPm10SustainedStatus(supabase, 'project-1', 'group-1', 'device-A').then((r) => {
      expect(r.status!.isConfirmedViolation340).toBe(true);
    });
  });

  // اختبارات قبول صريحة (طلب المستخدم — تقرير المراجعة الخارجي: "التقييم
  // بحسب وقت المعالجة قد يفوّت مخالفة كاملة"): nowMs (الآن الجديد اختياري)
  // يُحدِّد كلاً من الحد الأدنى (sinceIso) والحد الأعلى (untilIso) لاستعلام
  // pm10_readings_history — تمرير nowMs تاريخية (لحظة رصد سابقة) يجب أن
  // يُخفي أي قراءة وقعت بعدها فعلياً، لا فقط يغيّر رقم "الآن" الممرَّر
  // لحساب المدة بمعزل عن البيانات المُستعلَمة.
  describe('nowMs يحدّد حد الاستعلام الأعلى (اختبار قبول صريح — يحاكي سيناريو 350←355←360←100 من التقرير)', () => {
    it('nowMs = لحظة ذروة التجاوز (قبل وصول القراءة الآمنة اللاحقة) → السلسلة 350←355←360 تُثبت مخالفة مؤكَّدة، رغم وجود قراءة 100 لاحقة في نفس الجدول', () => {
      const spikeStartMs = NOW - 4 * 60000; // 350 عند -4 دقائق من "الآن الحقيقي"
      const spikeEndMs = NOW - 1 * 60000; // 360 عند -1 دقيقة (نهاية الذروة، استمرار فعلي 3 دقائق > 2)
      const safeReadingMs = NOW; // 100 عند "الآن الحقيقي" — بعد الذروة بدقيقة
      const allRows = [
        { ...readingRow(0, 350, 'device-A'), recorded_at: new Date(spikeStartMs).toISOString(), id: 'spike-1' },
        {
          ...readingRow(0, 355, 'device-A'),
          recorded_at: new Date(spikeStartMs + 60_000).toISOString(),
          id: 'spike-2',
        },
        {
          ...readingRow(0, 358, 'device-A'),
          recorded_at: new Date(spikeStartMs + 120_000).toISOString(),
          id: 'spike-2b',
        },
        { ...readingRow(0, 360, 'device-A'), recorded_at: new Date(spikeEndMs).toISOString(), id: 'spike-3' },
        { ...readingRow(0, 100, 'device-A'), recorded_at: new Date(safeReadingMs).toISOString(), id: 'safe-1' },
      ];
      // mockSupabase هنا (نفس نمط بقية هذا الملف) يُرجع rows الممرَّرة إليه
      // مباشرة بلا تطبيق فعلي لـ.gte()/.lte() على القيم — فلمحاكاة الحد
      // الأعلى الحقيقي (untilIso المشتق من nowMs داخل fetchPm10SustainedStatus
      // نفسها) نُصفّي الصفوف يدوياً هنا، تماماً كما يفعل PostgREST الفعلي
      // عند استلام .lte('recorded_at', untilIso). اختبار منفصل أدناه يتحقق
      // أن .lte() تُستدعى فعلياً بالقيمة الصحيحة المشتقة من nowMs.
      const rows = allRows.filter((r) => new Date(r.recorded_at).getTime() <= spikeEndMs);
      const supabase = mockSupabase(rows);

      // evaluation_at لدقيقة الرصد التي وقعت فيها الذروة (لا "الآن" الفعلي
      // الذي يحمل القراءة الآمنة اللاحقة) — نفس ما يبنيه telemetry-worker
      // الآن (نهاية دقيقة رصد كل قراءة، لا دقيقة معالجة الدفعة).
      return fetchPm10SustainedStatus(supabase, 'project-1', 'group-1', 'device-A', spikeEndMs).then((r) => {
        const status = r.status!;
        expect(status.currentReadingUgM3).toBe(360);
        expect(status.isConfirmedViolation340).toBe(true);
        expect(status.evidenceReadingIds.sort()).toEqual(['spike-1', 'spike-2', 'spike-2b', 'spike-3'].sort());
      });
    });

    it('nowMs = وقت "الآن" الحقيقي (بلا تمرير، افتراضي) → القراءة الآمنة اللاحقة تصبح currentReadingUgM3، الذروة السابقة غير مرئية للسلسلة (نفس الخطأ الأصلي، بلا evaluation_at)', () => {
      const spikeStartMs = NOW - 3 * 60000;
      const spikeEndMs = NOW - 1 * 60000;
      const rows = [
        { ...readingRow(0, 350, 'device-A'), recorded_at: new Date(spikeStartMs).toISOString(), id: 'spike-1' },
        {
          ...readingRow(0, 355, 'device-A'),
          recorded_at: new Date(spikeStartMs + 45_000).toISOString(),
          id: 'spike-2',
        },
        { ...readingRow(0, 360, 'device-A'), recorded_at: new Date(spikeEndMs).toISOString(), id: 'spike-3' },
        { ...readingRow(0, 100, 'device-A'), recorded_at: new Date(NOW).toISOString(), id: 'safe-1' },
      ];
      const supabase = mockSupabase(rows);

      return fetchPm10SustainedStatus(supabase, 'project-1', 'group-1', 'device-A').then((r) => {
        const status = r.status!;
        // هذا هو السلوك القديم (بلا evaluation_at) — يبقى صحيحاً حين لا
        // توجد لحظة رصد محدَّدة يُطلَب إعادة البناء عندها (مهام scheduler-
        // tick الدورية مثلاً)؛ الفرق أن telemetry-worker الآن *يُمرِّر*
        // evaluation_at فعلياً بدل ترك هذا المسار الافتراضي يُخفي الذروة.
        expect(status.currentReadingUgM3).toBe(100);
        expect(status.isConfirmedViolation340).toBe(false);
      });
    });

    it('.gte و.lte يُستدعيان بالحدود الصحيحة المشتقة من nowMs الممرَّرة', async () => {
      const calls: Array<{ fn: string; value: string }> = [];
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        gte: (_col: string, value: string) => {
          calls.push({ fn: 'gte', value });
          return chain;
        },
        lte: (_col: string, value: string) => {
          calls.push({ fn: 'lte', value });
          return chain;
        },
        order: async () => ({ data: [] }),
      };
      const supabase = { from: () => chain } as unknown as Parameters<typeof fetchPm10SustainedStatus>[0];

      const nowMs = Date.parse('2026-03-01T12:10:00.000Z');
      await fetchPm10SustainedStatus(supabase, 'project-1', 'group-1', 'device-A', nowMs);

      const gteCall = calls.find((c) => c.fn === 'gte');
      const lteCall = calls.find((c) => c.fn === 'lte');
      expect(lteCall?.value).toBe(new Date(nowMs).toISOString());
      // sinceIso = nowMs - (PM10_SUSPENSION_MINUTES + 10) دقيقة — نتحقق فقط
      // أنها أقدم من nowMs فعلياً (لا القيمة الحرفية، لتفادي تكرار الثابت
      // الداخلي هنا).
      expect(new Date(gteCall!.value).getTime()).toBeLessThan(nowMs);
    });
  });

  // اختبارات قبول صريحة (طلب المستخدم — تقرير المراجعة الخارجي: "فشل
  // استعلام PM10 يتحول إلى سلسلة فارغة"): يميّزان صراحة "الاستعلام نجح بصفر
  // صفوف" (queryFailed=false، status.currentReadingUgM3=null، حالة طبيعية)
  // عن "الاستعلام فشل فعلياً" (queryFailed=true، status=null) — قبل هذا
  // الإصلاح كانت النتيجتان متطابقتين تماماً.
  describe('fetchPm10SustainedStatus — فشل الاستعلام يُميَّز صراحة عن نجاحه بصفر صفوف', () => {
    it('Supabase يُعيد {data: null, error: {...}} (فشل RLS/timeout نموذجي، بلا استثناء) → queryFailed=true، status=null', async () => {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        gte: () => chain,
        lte: () => chain,
        order: async () => ({ data: null, error: { message: 'permission denied for table pm10_readings_history' } }),
      };
      const supabase = { from: () => chain } as unknown as Parameters<typeof fetchPm10SustainedStatus>[0];

      const r = await fetchPm10SustainedStatus(supabase, 'project-1', 'group-1', 'device-A');
      expect(r.queryFailed).toBe(true);
      expect(r.status).toBeNull();
      expect(r.failureCode).toBe('PM10_HISTORY_QUERY_FAILED');
      // خطأ حرج مكتشَف ومُصلَح (مراجعة كود خارجي — تفصيل تنفيذ
      // pm10TemporalEvidenceState في DustComplianceResult.evidence): readingCount
      // لا معنى له عند فشل الاستعلام — يبقى 0 دائماً (لا يُخلَط مع "0 قراءات
      // فعلية بعد استعلام ناجح").
      expect(r.readingCount).toBe(0);
    });

    it('الاستعلام ينجح بصفر صفوف فعلياً (لا خطأ) → queryFailed=false، status غير null بقيم فارغة طبيعية، readingCount=0', async () => {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        gte: () => chain,
        lte: () => chain,
        order: async () => ({ data: [], error: null }),
      };
      const supabase = { from: () => chain } as unknown as Parameters<typeof fetchPm10SustainedStatus>[0];

      const r = await fetchPm10SustainedStatus(supabase, 'project-1', 'group-1', 'device-A');
      expect(r.queryFailed).toBe(false);
      expect(r.failureCode).toBeNull();
      expect(r.status).not.toBeNull();
      expect(r.status!.currentReadingUgM3).toBeNull();
      expect(r.status!.isConfirmedViolation340).toBe(false);
      // خطأ حرج مكتشَف ومُصلَح (نفس المراجعة أعلاه): readingCount=0 هنا يعني
      // فعلياً "لا قراءات" (NO_READINGS) — يختلف جوهرياً عن الاختبار أعلاه
      // (فشل الاستعلام نفسه، QUERY_FAILED) رغم تطابق queryFailed=false مع
      // النتيجة الظاهرية (status غير null بقيم فارغة) في كلا الحالتين على
      // مستوى status وحده.
      expect(r.readingCount).toBe(0);
    });

    it('الاستعلام ينجح بقراءات فعلية (readingCount > 0) — يميّز AVAILABLE عن NO_READINGS/QUERY_FAILED', async () => {
      const now = Date.now();
      const rows = [
        {
          id: 'r1',
          pm10_ug_m3: 200,
          recorded_at: new Date(now).toISOString(),
          activity_group_id: 'group-1',
          source: 'device',
          device_id: 'device-A',
          is_late: false,
          is_snapshot_only: false,
        },
      ];
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        gte: () => chain,
        lte: () => chain,
        order: async () => ({ data: rows, error: null }),
      };
      const supabase = { from: () => chain } as unknown as Parameters<typeof fetchPm10SustainedStatus>[0];

      const r = await fetchPm10SustainedStatus(supabase, 'project-1', 'group-1', 'device-A');
      expect(r.queryFailed).toBe(false);
      expect(r.readingCount).toBe(1);
    });

    it('استعلام يرمي استثناءً فعلياً (شبكة معطوبة تماماً، لا مجرد error من Supabase) → queryFailed=true، status=null', async () => {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        gte: () => chain,
        lte: () => {
          throw new Error('network unreachable');
        },
      };
      const supabase = { from: () => chain } as unknown as Parameters<typeof fetchPm10SustainedStatus>[0];

      const r = await fetchPm10SustainedStatus(supabase, 'project-1', 'group-1', 'device-A');
      expect(r.queryFailed).toBe(true);
      expect(r.status).toBeNull();
      expect(r.failureCode).toBe('PM10_HISTORY_QUERY_FAILED');
    });
  });

  // اختبارات قبول صريحة (طلب المستخدم — "سجل الأعطال والتدقيق"): فشل
  // استعلام سلسلة PM10 يجب أن يُنشئ حدث Telemetry حقيقي في
  // technical_fault_events (لا الاكتفاء بـconsole.error)، بحقول مُقرَّرة
  // صراحة فقط (لا نص PostgreSQL/Stack trace/بيانات اتصال قاعدة بيانات)،
  // ومفتاح idempotency مستقر لكل دقيقة كي لا يتكرر نفس الحدث كل دورة تقييم.
  describe('fetchPm10SustainedStatus — تسجيل حدث Telemetry عند فشل الاستعلام (technical_fault_events)', () => {
    function mockSupabaseWithInsertSpy(queryError: { message: string } | null, throwOnQuery = false) {
      const insertSpy = vi.fn(async (_payload: Record<string, unknown>) => ({ data: null, error: null }));
      const fromSpy = vi.fn((table: string) => {
        if (table === 'technical_fault_events') {
          return { insert: insertSpy };
        }
        const chain: Record<string, unknown> = {
          select: () => chain,
          eq: () => chain,
          gte: () => chain,
          lte: () => {
            if (throwOnQuery) throw new Error('network unreachable');
            return chain;
          },
          order: async () => ({ data: null, error: queryError }),
        };
        return chain;
      });
      const supabase = { from: fromSpy } as unknown as Parameters<typeof fetchPm10SustainedStatus>[0];
      return { supabase, insertSpy, fromSpy };
    }

    it('فشل الاستعلام (Supabase error) → يُدرج حدث PM10_HISTORY_QUERY_FAILED بحقول مُقرَّرة فقط، بلا نص PostgreSQL/Stack trace/بيانات اتصال', async () => {
      const { supabase, insertSpy } = mockSupabaseWithInsertSpy({ message: 'permission denied for table pm10_readings_history: connection string postgres://user:pass@host' });
      const nowMs = Date.parse('2026-08-19T10:15:30.000Z');

      await fetchPm10SustainedStatus(supabase, 'project-1', 'group-1', 'device-A', nowMs);

      expect(insertSpy).toHaveBeenCalledTimes(1);
      const payload = insertSpy.mock.calls[0][0] as Record<string, unknown>;
      expect(payload).toEqual({
        event_type: 'PM10_HISTORY_QUERY_FAILED',
        project_id: 'project-1',
        activity_group_id: 'group-1',
        device_id: 'device-A',
        evaluation_id: null,
        retry_count: 0,
        evaluated_at: new Date(nowMs).toISOString(),
        dedupe_key: `pm10-history-query-failed:group-1:${Math.floor(nowMs / 60_000)}`,
      });
      // لا حقل واحد في هذا الحمل يحمل نص خطأ Supabase الخام (postgres://,
      // permission denied for table...) — فقط الحقول المُقرَّرة أعلاه.
      const serialized = JSON.stringify(payload);
      expect(serialized).not.toContain('postgres://');
      expect(serialized).not.toContain('permission denied');
    });

    it('استثناء JS فعلي أثناء الاستعلام → يُدرج نفس حدث Telemetry (queryFailed=true عبر catch)', async () => {
      const { supabase, insertSpy } = mockSupabaseWithInsertSpy(null, true);

      await fetchPm10SustainedStatus(supabase, 'project-2', 'group-2', null);

      expect(insertSpy).toHaveBeenCalledTimes(1);
      const payload = insertSpy.mock.calls[0][0] as Record<string, unknown>;
      expect(payload.event_type).toBe('PM10_HISTORY_QUERY_FAILED');
      expect(payload.project_id).toBe('project-2');
      expect(payload.activity_group_id).toBe('group-2');
      expect(payload.device_id).toBeNull();
    });

    it('الاستعلام ينجح (لا فشل) → لا يُدرج أي حدث Telemetry إطلاقاً', async () => {
      const insertSpy = vi.fn(async (_payload: Record<string, unknown>) => ({ data: null, error: null }));
      const fromSpy = vi.fn((table: string) => {
        if (table === 'technical_fault_events') return { insert: insertSpy };
        const chain: Record<string, unknown> = {
          select: () => chain,
          eq: () => chain,
          gte: () => chain,
          lte: () => chain,
          order: async () => ({ data: [], error: null }),
        };
        return chain;
      });
      const supabase = { from: fromSpy } as unknown as Parameters<typeof fetchPm10SustainedStatus>[0];

      const r = await fetchPm10SustainedStatus(supabase, 'project-3', 'group-3', 'device-A');

      expect(r.queryFailed).toBe(false);
      expect(insertSpy).not.toHaveBeenCalled();
    });

    it('مفتاح idempotency (dedupe_key) مستقر لنفس (activity_group_id، الدقيقة) عبر فشلين متتاليين ضمن نفس الدقيقة، ويختلف بين نشاطين مختلفين', async () => {
      const nowMs = Date.parse('2026-08-19T10:15:45.000Z');
      const { supabase: supabaseA, insertSpy: insertSpyA } = mockSupabaseWithInsertSpy({ message: 'err' });
      const { supabase: supabaseB, insertSpy: insertSpyB } = mockSupabaseWithInsertSpy({ message: 'err' });

      await fetchPm10SustainedStatus(supabaseA, 'project-1', 'group-1', 'device-A', nowMs);
      await fetchPm10SustainedStatus(supabaseA, 'project-1', 'group-1', 'device-A', nowMs + 5000); // نفس الدقيقة
      await fetchPm10SustainedStatus(supabaseB, 'project-1', 'group-2', 'device-A', nowMs); // نشاط آخر

      const keyCall1 = (insertSpyA.mock.calls[0][0] as Record<string, unknown>).dedupe_key;
      const keyCall2 = (insertSpyA.mock.calls[1][0] as Record<string, unknown>).dedupe_key;
      const keyCallB = (insertSpyB.mock.calls[0][0] as Record<string, unknown>).dedupe_key;

      expect(keyCall1).toBe(keyCall2); // نفس النشاط، نفس الدقيقة → نفس المفتاح (القيد الفريد على الجدول يرفض التكرار الفعلي)
      expect(keyCall1).not.toBe(keyCallB); // نشاط مختلف → مفتاح مختلف
    });
  });
});
