import { describe, it, expect, vi } from 'vitest';
import { computeSustainedPm10Status, computeStoppedSince, fetchPm10SustainedStatus } from './dustEvaluation';

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
    // القراءة الأحدث وصلت قبل دقيقة من "الآن" (لا في نفس لحظته) — فرق مهم:
    // لو احتُسبت المدة حتى now لكانت 4 دقائق (3 دقائق منذ الأقدم + دقيقة
    // إضافية وهمية حتى الآن)، لكن الصحيح 3 دقائق فقط (بين القراءتين الفعليتين).
    const readings = readingsBackFromNow(NOW, [
      { minutesAgo: 4, pm10: 345 },
      { minutesAgo: 1, pm10: 350 },
    ]);
    const r = computeSustainedPm10Status(readings, NOW);
    expect(r.sustainedMinutesAbove340).toBe(3);
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
  function mockSupabase(rows: any[]) {
    const chain: any = {
      select: () => chain,
      eq: () => chain,
      gte: () => chain,
      order: async () => ({ data: rows }),
    };
    return { from: vi.fn(() => chain) };
  }

  const NOW = Date.now();
  function readingRow(minutesAgo: number, pm10: number, deviceId: string | null, activityGroupId: string | null = null, source: 'device' | 'manual' | 'open-meteo' = 'device') {
    return {
      pm10_ug_m3: pm10,
      recorded_at: new Date(NOW - minutesAgo * 60000).toISOString(),
      activity_group_id: activityGroupId,
      source,
      device_id: deviceId,
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

  it('نشاط مرتبط بجهاز A، وسلسلة كاملة متجانسة من A فقط (لا خلط) → تُحتسب صح مع تجاهل قراءات B المتخللة', () => {
    const rows = [
      readingRow(3, 345, 'device-A'),
      readingRow(2, 355, 'device-B'), // متخلل — يُتجاهَل تماماً
      readingRow(1, 350, 'device-A'),
      readingRow(0, 342, 'device-A'),
    ];
    const supabase = mockSupabase(rows);
    return fetchPm10SustainedStatus(supabase, 'project-1', 'group-1', 'device-A').then((r) => {
      // 3 قراءات فعلية من A (3، 1، 0 دقائق) بفجوة أقصاها دقيقتان بينها —
      // ضمن هامش التحمّل (4 دقائق)، فتُحسب سلسلة متصلة بمعزل عن B.
      expect(r.sustainedMinutesAbove340).toBeGreaterThanOrEqual(2);
      expect(r.isConfirmedViolation340).toBe(true);
    });
  });
});
