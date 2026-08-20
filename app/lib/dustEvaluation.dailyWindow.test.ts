import { describe, it, expect } from 'vitest';
import { isDustProfileWithinDailyWindow, hasDustProfileWindowEnded, computeCurrentDayWindow } from './dustEvaluation';

// المستخدم سأل: "مشروع مستمر 3 أيام والدوام 8 ساعات، هل يُحتسب من وقت
// العمل فقط؟" — كشف أن duration_hours الإجمالية (= dailyHours × عدد أيام
// العمل، راجع computeDurationHours في AddActivityModal/index.tsx) كانت
// تُعامَل في كل مكان كفترة واحدة متصلة بلا انقطاع ليلي. هذه الاختبارات
// تغطي بالتحديد السيناريو متعدد الأيام الذي لم يكن مُختبَراً من قبل.

describe('isDustProfileWithinDailyWindow', () => {
  // نشاط 3 أيام (أحد/اثنين/ثلاثاء)، دوام 08:00-16:00 بتوقيت الرياض
  // (planned_time='08:00' = 05:00 UTC)، duration_hours=24 (8×3),
  // daily_duration_hours=8. الأحد 2026-08-09 بتوقيت الرياض.
  const THREE_DAY_ROW = {
    planned_date: '2026-08-09', // أحد
    planned_time: '08:00',
    duration_hours: 24,
    daily_duration_hours: 8,
  };
  const WORK_DAYS = ['sun', 'mon', 'tue', 'wed', 'thu']; // أحد-خميس

  it('يعتبر النشاط جارياً أثناء دوام اليوم الأول (10ص بتوقيت الرياض)', () => {
    // 10:00 الرياض = 07:00 UTC، اليوم الأول (أحد) — ضمن 08:00-16:00.
    const nowMs = new Date('2026-08-09T07:00:00.000Z').getTime();
    expect(isDustProfileWithinDailyWindow(THREE_DAY_ROW, WORK_DAYS, nowMs)).toBe(true);
  });

  it('لا يعتبر النشاط جارياً بعد نهاية دوام اليوم الأول (9م بتوقيت الرياض)', () => {
    // 9م الرياض = 18:00 UTC، اليوم الأول — بعد نهاية الدوام (16:00 الرياض = 13:00 UTC).
    const nowMs = new Date('2026-08-09T18:00:00.000Z').getTime();
    expect(isDustProfileWithinDailyWindow(THREE_DAY_ROW, WORK_DAYS, nowMs)).toBe(false);
  });

  it('لا يعتبر النشاط جارياً في الفجر بين اليوم الأول والثاني (3ص بتوقيت الرياض)', () => {
    // هذا هو صلب الإصلاح: الليل بين الأيام ليس جزءاً من النافذة رغم أن
    // duration_hours الإجمالية (24 ساعة) كانت تجعله يبدو "جارياً" في
    // المنطق القديم (فترة متصلة من بداية اليوم الأول).
    // 3ص الرياض يوم الاثنين = 2026-08-10T00:00:00Z.
    const nowMs = new Date('2026-08-10T00:00:00.000Z').getTime();
    expect(isDustProfileWithinDailyWindow(THREE_DAY_ROW, WORK_DAYS, nowMs)).toBe(false);
  });

  it('يعتبر النشاط جارياً أثناء دوام اليوم الثاني (10ص الاثنين)', () => {
    // 10ص الرياض يوم الاثنين = 07:00 UTC.
    const nowMs = new Date('2026-08-10T07:00:00.000Z').getTime();
    expect(isDustProfileWithinDailyWindow(THREE_DAY_ROW, WORK_DAYS, nowMs)).toBe(true);
  });

  it('يعتبر النشاط جارياً أثناء دوام اليوم الثالث والأخير (10ص الثلاثاء)', () => {
    const nowMs = new Date('2026-08-11T07:00:00.000Z').getTime();
    expect(isDustProfileWithinDailyWindow(THREE_DAY_ROW, WORK_DAYS, nowMs)).toBe(true);
  });

  it('لا يعتبر النشاط جارياً بعد اليوم الثالث والأخير (الأربعاء، خارج مدى النشاط)', () => {
    const nowMs = new Date('2026-08-12T07:00:00.000Z').getTime();
    expect(isDustProfileWithinDailyWindow(THREE_DAY_ROW, WORK_DAYS, nowMs)).toBe(false);
  });

  it('يتخطى يوم إجازة ضمن المدى (الجمعة ليست من أيام العمل) عند عدّ الأيام النشطة', () => {
    // نشاط يبدأ الخميس (day count=1)، الجمعة إجازة (تُتخطى)، السبت إجازة
    // أيضاً (work_days_list هنا لا يشمل fri/sat) — اليوم الثاني الفعلي هو
    // الأحد التالي.
    const row = { planned_date: '2026-08-06', planned_time: '08:00', duration_hours: 16, daily_duration_hours: 8 }; // 2026-08-06 خميس
    // الأحد التالي (2026-08-09) عند 10ص بتوقيت الرياض = 07:00 UTC.
    const nowMs = new Date('2026-08-09T07:00:00.000Z').getTime();
    expect(isDustProfileWithinDailyWindow(row, WORK_DAYS, nowMs)).toBe(true);
  });

  it('fallback: بلا daily_duration_hours، يُعامَل كفترة متصلة واحدة (السلوك القديم)', () => {
    const row = { planned_date: '2026-08-09', planned_time: '08:00', duration_hours: 24, daily_duration_hours: null };
    // منتصف الليلة الأولى (23:00 الرياض = 20:00 UTC) — ضمن الفترة المتصلة
    // 24 ساعة من planned_time (05:00 UTC)، رغم كونها "ليلاً" فعلياً.
    const nowMs = new Date('2026-08-09T20:00:00.000Z').getTime();
    expect(isDustProfileWithinDailyWindow(row, WORK_DAYS, nowMs)).toBe(true);
  });

  it('لا يستبعد صفاً بلا duration_hours (بيانات ناقصة — فشل آمن)', () => {
    const row = { planned_date: '2026-08-09', planned_time: '08:00', duration_hours: null, daily_duration_hours: 8 };
    expect(isDustProfileWithinDailyWindow(row, WORK_DAYS, Date.now())).toBe(true);
  });
});

describe('hasDustProfileWindowEnded', () => {
  const THREE_DAY_ROW = {
    planned_date: '2026-08-09', // أحد
    planned_time: '08:00',
    duration_hours: 24,
    daily_duration_hours: 8,
  };
  const WORK_DAYS = ['sun', 'mon', 'tue', 'wed', 'thu'];

  it('لا يعتبر النشاط منتهياً أثناء الفجر بين اليوم الأول والثاني (لا يزال ضمن المدى الكلي)', () => {
    // هذا هو الفرق الجوهري عن isDustProfileWithinDailyWindow: نفس اللحظة
    // (3ص بين يوم 1 ويوم 2) تُعتبر "غير جارية الآن" لكن أيضاً "لم تنتهِ
    // بعد" — النشاط سيُستأنف صباحاً، فلا يجوز استبعاده من دورة التقييم.
    const nowMs = new Date('2026-08-10T00:00:00.000Z').getTime();
    expect(hasDustProfileWindowEnded(THREE_DAY_ROW, WORK_DAYS, nowMs)).toBe(false);
  });

  it('لا يعتبر النشاط منتهياً أثناء دوام اليوم الأخير', () => {
    const nowMs = new Date('2026-08-11T07:00:00.000Z').getTime(); // 10ص الثلاثاء
    expect(hasDustProfileWindowEnded(THREE_DAY_ROW, WORK_DAYS, nowMs)).toBe(false);
  });

  it('يعتبر النشاط منتهياً بعد نهاية دوام اليوم الأخير', () => {
    // نهاية دوام الثلاثاء (اليوم الثالث): 16:00 الرياض = 13:00 UTC. بعدها بساعة.
    const nowMs = new Date('2026-08-11T14:00:00.000Z').getTime();
    expect(hasDustProfileWindowEnded(THREE_DAY_ROW, WORK_DAYS, nowMs)).toBe(true);
  });

  it('لا يعتبر النشاط منتهياً قبل بدايته أصلاً', () => {
    const nowMs = new Date('2026-08-08T00:00:00.000Z').getTime(); // قبل الأحد
    expect(hasDustProfileWindowEnded(THREE_DAY_ROW, WORK_DAYS, nowMs)).toBe(false);
  });

  it('fallback: بلا daily_duration_hours، يُعامَل كفترة متصلة واحدة (السلوك القديم)', () => {
    const row = { planned_date: '2026-08-09', planned_time: '08:00', duration_hours: 1, daily_duration_hours: null };
    // planned 05:00 UTC + 1 ساعة = 06:00 UTC — قبل هذه اللحظة بساعتين.
    const nowMs = new Date('2026-08-09T08:00:00.000Z').getTime();
    expect(hasDustProfileWindowEnded(row, WORK_DAYS, nowMs)).toBe(true);
  });

  it('لا يستبعد صفاً بلا duration_hours (بيانات ناقصة — فشل آمن نحو عدم الانتهاء)', () => {
    const row = { planned_date: '2026-08-09', planned_time: '08:00', duration_hours: null, daily_duration_hours: 8 };
    expect(hasDustProfileWindowEnded(row, WORK_DAYS, Date.now())).toBe(false);
  });
});

// طلب مستخدم صريح ("اريد فصل تماماً" — نشاطان بنفس الجهاز لا يجوز أن
// يتشاركا نفس قراءات استمرار PM10): computeCurrentDayWindow ترجع حدود
// [startMs, endMs] الفعلية بدل true/false فقط — تُستهلَك في
// fetchPm10SustainedStatus لتصفية قراءات الجهاز الخام بنافذة النشاط
// الدقيقة. نفس منطق isDustProfileWithinDailyWindow أعلاه بالضبط.
describe('computeCurrentDayWindow', () => {
  const THREE_DAY_ROW = {
    planned_date: '2026-08-09', // أحد
    planned_time: '08:00',
    duration_hours: 24,
    daily_duration_hours: 8,
  };
  const WORK_DAYS = ['sun', 'mon', 'tue', 'wed', 'thu'];

  it('أثناء دوام اليوم الأول → يرجع حدود ذلك اليوم تحديداً [08:00, 16:00 بتوقيت الرياض]', () => {
    const nowMs = new Date('2026-08-09T07:00:00.000Z').getTime(); // 10ص الرياض
    const window = computeCurrentDayWindow(THREE_DAY_ROW, WORK_DAYS, nowMs);
    expect(window).not.toBeNull();
    expect(window!.startMs).toBe(new Date('2026-08-09T05:00:00.000Z').getTime()); // 08:00 الرياض
    expect(window!.endMs).toBe(new Date('2026-08-09T13:00:00.000Z').getTime()); // 16:00 الرياض
  });

  it('أثناء دوام اليوم الثاني → يرجع حدود اليوم الثاني تحديداً، لا الأول', () => {
    const nowMs = new Date('2026-08-10T07:00:00.000Z').getTime(); // 10ص الاثنين
    const window = computeCurrentDayWindow(THREE_DAY_ROW, WORK_DAYS, nowMs);
    expect(window).not.toBeNull();
    expect(window!.startMs).toBe(new Date('2026-08-10T05:00:00.000Z').getTime());
    expect(window!.endMs).toBe(new Date('2026-08-10T13:00:00.000Z').getTime());
  });

  it('منتصف الليل بين اليومين (خارج نافذة الدوام) → null', () => {
    const nowMs = new Date('2026-08-10T00:00:00.000Z').getTime(); // 3ص الرياض بين اليومين
    expect(computeCurrentDayWindow(THREE_DAY_ROW, WORK_DAYS, nowMs)).toBeNull();
  });

  it('بعد انتهاء مدى النشاط بالكامل → null', () => {
    const nowMs = new Date('2026-08-12T07:00:00.000Z').getTime(); // الأربعاء، خارج المدى
    expect(computeCurrentDayWindow(THREE_DAY_ROW, WORK_DAYS, nowMs)).toBeNull();
  });

  it('fallback: بلا daily_duration_hours → فترة متصلة واحدة [بداية، بداية+duration]', () => {
    const row = { planned_date: '2026-08-09', planned_time: '08:00', duration_hours: 24, daily_duration_hours: null };
    const window = computeCurrentDayWindow(row, WORK_DAYS, Date.now());
    expect(window).not.toBeNull();
    expect(window!.startMs).toBe(new Date('2026-08-09T05:00:00.000Z').getTime());
    expect(window!.endMs).toBe(new Date('2026-08-09T05:00:00.000Z').getTime() + 24 * 3600000);
  });

  it('بيانات ناقصة (بلا planned_date) → null (فشل آمن نحو "بلا نافذة" لا "نافذة وهمية")', () => {
    const row = { planned_date: null, planned_time: '08:00', duration_hours: 8, daily_duration_hours: 8 };
    expect(computeCurrentDayWindow(row, WORK_DAYS, Date.now())).toBeNull();
  });
});
