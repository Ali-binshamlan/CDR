import { describe, it, expect } from 'vitest';
import { computeStoppedSince } from './dustEvaluation';

// =====================================================================
// اختبارات computeStoppedSince — يحل مشكلة رصدها المستخدم فعلياً: عمود
// updated_at في current_dust_compliance_decisions كان يتحدّث حتى عند
// إعادة كتابة *نفس* القرار الموقِف (كل فتح لصفحة المشروع أثناء إيقاف قائم
// كان يمدّد عداد "منع الاستئناف الفوري" 10 دقائق من جديد بلا قصد).
// stopped_since يجب أن يبقى ثابتاً طالما الإيقاف مستمر بلا انقطاع، ولا
// يتغيّر إلا عند دخول/خروج فعلي من حالة الإيقاف.
// =====================================================================

describe('computeStoppedSince', () => {
  it('لم يكن موقِفاً سابقاً، أصبح موقِفاً الآن → بداية إيقاف جديدة (الآن)', () => {
    const before = Date.now();
    const result = computeStoppedSince('ALLOW', null, 'MANDATORY_STOP');
    const after = Date.now();
    expect(result).not.toBeNull();
    const resultMs = new Date(result!).getTime();
    expect(resultMs).toBeGreaterThanOrEqual(before);
    expect(resultMs).toBeLessThanOrEqual(after);
  });

  it('كان موقِفاً وما زال موقِفاً (نفس الفئة) → stopped_since يبقى كما هو، لا يتجدّد', () => {
    const oldTimestamp = new Date(Date.now() - 20 * 60000).toISOString(); // قبل 20 دقيقة
    const result = computeStoppedSince('STOP_AFFECTED_ACTIVITY', oldTimestamp, 'STOP_AFFECTED_ACTIVITY');
    expect(result).toBe(oldTimestamp);
  });

  it('كان موقِفاً بفئة، وما زال موقِفاً بفئة أشد (MANDATORY_STOP بعد STOP_AFFECTED_ACTIVITY) → stopped_since يبقى كما هو (إيقاف مستمر)', () => {
    const oldTimestamp = new Date(Date.now() - 15 * 60000).toISOString();
    const result = computeStoppedSince('STOP_AFFECTED_ACTIVITY', oldTimestamp, 'MANDATORY_STOP');
    expect(result).toBe(oldTimestamp);
  });

  it('كان موقِفاً لكن stopped_since غائب (صف قديم قبل الترحيل) → يُعامَل كبداية جديدة الآن', () => {
    const before = Date.now();
    const result = computeStoppedSince('STOP_AFFECTED_ACTIVITY', null, 'STOP_AFFECTED_ACTIVITY');
    expect(result).not.toBeNull();
    expect(new Date(result!).getTime()).toBeGreaterThanOrEqual(before);
  });

  it('تحسّن القرار الآن (لم يعد موقِفاً) → null بصرف النظر عن الحالة السابقة', () => {
    const oldTimestamp = new Date(Date.now() - 5 * 60000).toISOString();
    expect(computeStoppedSince('STOP_AFFECTED_ACTIVITY', oldTimestamp, 'ALLOW')).toBeNull();
    expect(computeStoppedSince('MANDATORY_STOP', oldTimestamp, 'ALLOW_WITH_CONTROLS')).toBeNull();
  });

  it('لا قرار سابق إطلاقاً (أول تقييم) وموقِف الآن → بداية إيقاف جديدة (الآن)', () => {
    const before = Date.now();
    const result = computeStoppedSince(null, null, 'MANDATORY_STOP');
    expect(result).not.toBeNull();
    expect(new Date(result!).getTime()).toBeGreaterThanOrEqual(before);
  });

  it('لا قرار سابق ولا موقِف الآن → null', () => {
    expect(computeStoppedSince(null, null, 'ALLOW')).toBeNull();
  });
});
