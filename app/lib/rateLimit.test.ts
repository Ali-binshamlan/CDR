import { describe, it, expect, vi, afterEach } from 'vitest';
import { checkRateLimit } from './rateLimit';

// =====================================================================
// اختبارات محدِّد المعدّل — يحمي POST /api/devices/ingest من الإغراق
// بمفتاح جهاز مسرَّب (راجع app/api/devices/ingest/route.ts).
// =====================================================================

describe('checkRateLimit', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('يسمح بالطلبات ضمن الحد ثم يمنع ما تجاوزه في نفس النافذة', () => {
    const key = `dev-${Math.random()}`;
    for (let i = 0; i < 5; i++) {
      expect(checkRateLimit(key, 5, 60_000)).toBe(true);
    }
    expect(checkRateLimit(key, 5, 60_000)).toBe(false);
    expect(checkRateLimit(key, 5, 60_000)).toBe(false);
  });

  it('مفاتيح مختلفة لها عدّادات مستقلة تماماً — جهاز لا يستهلك حصة جهاز آخر', () => {
    const keyA = `dev-a-${Math.random()}`;
    const keyB = `dev-b-${Math.random()}`;
    expect(checkRateLimit(keyA, 1, 60_000)).toBe(true);
    expect(checkRateLimit(keyA, 1, 60_000)).toBe(false);
    // keyB لم يُستهلك بعد رغم استنفاد keyA
    expect(checkRateLimit(keyB, 1, 60_000)).toBe(true);
  });

  it('تُفتح نافذة جديدة بعد انقضاء المدة، فيُسمح بالطلبات من جديد', () => {
    vi.useFakeTimers();
    const key = `dev-${Math.random()}`;
    expect(checkRateLimit(key, 2, 60_000)).toBe(true);
    expect(checkRateLimit(key, 2, 60_000)).toBe(true);
    expect(checkRateLimit(key, 2, 60_000)).toBe(false);

    vi.advanceTimersByTime(60_001);
    expect(checkRateLimit(key, 2, 60_000)).toBe(true);
  });

  it('الحد الفعلي المستخدم في مسار الأجهزة (30/دقيقة) يستوعب دورة إرسال كل دقيقتين بهامش واسع', () => {
    const key = `dev-${Math.random()}`;
    // دورة الإرسال التصميمية دقيقتان = طلب واحد لكل نافذة دقيقة تقريباً؛
    // حتى مع إعادة محاولات متعددة يبقى ضمن الحد بفارق كبير.
    for (let i = 0; i < 30; i++) {
      expect(checkRateLimit(key, 30, 60_000)).toBe(true);
    }
    expect(checkRateLimit(key, 30, 60_000)).toBe(false);
  });
});
