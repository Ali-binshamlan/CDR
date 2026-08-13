import { describe, it, expect } from 'vitest';
import { computePendingResumeSince } from './dustEvaluation';

// =====================================================================
// اختبارات computePendingResumeSince — يحل خللاً حقيقياً رصده المستخدم:
// عداد "منع الاستئناف الفوري" (RESUME_STABILITY_MINUTES في engine.ts)
// كان يقرأ stopped_since ("منذ متى بدأ الإيقاف") بدل "منذ متى أصبحت
// القراءة جيدة فعلياً". لو استمر الإيقاف 16 دقيقة (بقراءات سيئة متفرقة)
// قبل أن تتحسّن القراءة أخيراً، كان النظام يعتبر عداد الـ10 دقائق منقضياً
// بالفعل منذ بداية الإيقاف نفسه، فيسمح باستئناف فوري رغم عدم تراكم أي
// دقيقة فعلية من القراءة الجيدة بعد. pending_resume_since يتتبّع "بداية
// الاستقرار" منفصلاً تماماً عن stopped_since.
// =====================================================================

describe('computePendingResumeSince', () => {
  it('resumeHoldApplied=true ولا قيمة سابقة → بداية استقرار جديدة (الآن)', () => {
    const before = Date.now();
    const result = computePendingResumeSince(null, true);
    const after = Date.now();
    expect(result).not.toBeNull();
    const resultMs = new Date(result!).getTime();
    expect(resultMs).toBeGreaterThanOrEqual(before);
    expect(resultMs).toBeLessThanOrEqual(after);
  });

  it('resumeHoldApplied=true وقيمة سابقة موجودة → تبقى كما هي، لا تتجدّد', () => {
    const oldTimestamp = new Date(Date.now() - 7 * 60000).toISOString();
    const result = computePendingResumeSince(oldTimestamp, true);
    expect(result).toBe(oldTimestamp);
  });

  it('resumeHoldApplied=false (تم الاستئناف فعلاً أو ساءت القراءة من جديد) → null بصرف النظر عن القيمة السابقة', () => {
    const oldTimestamp = new Date(Date.now() - 7 * 60000).toISOString();
    expect(computePendingResumeSince(oldTimestamp, false)).toBeNull();
    expect(computePendingResumeSince(null, false)).toBeNull();
  });
});
