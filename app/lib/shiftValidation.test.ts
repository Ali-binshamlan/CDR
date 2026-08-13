import { describe, it, expect } from 'vitest';
import { isActivityTimeWithinWorkHours } from './shiftValidation';

describe('isActivityTimeWithinWorkHours', () => {
  it('لا أوقات دوام مُعرَّفة (null) → أي وقت مقبول (لا قيد)', () => {
    expect(isActivityTimeWithinWorkHours(null, null, '02:00', 3)).toBe(true);
  });

  it('أحد الحقلين فقط مُعرَّف → لا قيد (نفس فشل آمن منطق الإنشاء)', () => {
    expect(isActivityTimeWithinWorkHours('07:00', null, '02:00', 3)).toBe(true);
    expect(isActivityTimeWithinWorkHours(null, '17:00', '02:00', 3)).toBe(true);
  });

  it('نشاط يقع بالكامل ضمن أوقات الدوام (7-17) → مقبول', () => {
    expect(isActivityTimeWithinWorkHours('07:00', '17:00', '09:00', 2)).toBe(true);
  });

  it('نشاط يبدأ قبل بداية الدوام → مرفوض', () => {
    expect(isActivityTimeWithinWorkHours('07:00', '17:00', '06:00', 2)).toBe(false);
  });

  it('نشاط ينتهي بعد نهاية الدوام (11:00 PM خارج 7-17) → مرفوض', () => {
    expect(isActivityTimeWithinWorkHours('07:00', '17:00', '23:00', 0.5)).toBe(false);
  });

  it('نشاط يطابق أوقات الدوام بالضبط (نفس البداية والنهاية) → مقبول', () => {
    expect(isActivityTimeWithinWorkHours('07:00', '17:00', '07:00', 10)).toBe(true);
  });

  it('نشاط يمتد دقيقة واحدة بعد نهاية الدوام → مرفوض', () => {
    expect(isActivityTimeWithinWorkHours('07:00', '17:00', '16:00', 1.1)).toBe(false);
  });
});
