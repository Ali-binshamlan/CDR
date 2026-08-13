import { describe, it, expect, vi } from 'vitest';
import { retryWithBackoff } from './retryWithBackoff';

describe('retryWithBackoff', () => {
  it('ينجح من المحاولة الأولى بلا أي انتظار', async () => {
    const fn = vi.fn(async () => ({ ok: true as const, value: 'done' }));
    const result = await retryWithBackoff(fn);
    expect(result).toEqual({ ok: true, value: 'done' });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('ينجح بعد فشلين، بإجمالي 3 محاولات كحد أقصى (الافتراضي)', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const fn = vi.fn(async () => {
      attempts++;
      if (attempts < 3) return { ok: false as const, error: 'مؤقت' };
      return { ok: true as const, value: 'نجح أخيراً' };
    });

    const resultPromise = retryWithBackoff(fn);
    await vi.runAllTimersAsync();
    const result = await resultPromise;
    vi.useRealTimers();

    expect(result).toEqual({ ok: true, value: 'نجح أخيراً' });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('يتوقف بعد maxAttempts ويرجع فشلاً نهائياً — لا محاولات إضافية بعدها', async () => {
    vi.useFakeTimers();
    const fn = vi.fn(async () => ({ ok: false as const, error: 'فشل دائم' }));

    const resultPromise = retryWithBackoff(fn, { maxAttempts: 2 });
    await vi.runAllTimersAsync();
    const result = await resultPromise;
    vi.useRealTimers();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('فشل دائم');
      expect(result.attempts).toBe(2);
    }
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('لا ينتظر أبداً بعد المحاولة الأخيرة (لا تأخير زائد قبل إرجاع الفشل)', async () => {
    const fn = vi.fn(async () => ({ ok: false as const, error: 'فشل' }));
    const start = Date.now();
    await retryWithBackoff(fn, { maxAttempts: 1 });
    const elapsedMs = Date.now() - start;
    expect(fn).toHaveBeenCalledTimes(1);
    // محاولة واحدة فقط — بلا أي backoff، يجب أن يكون فورياً تقريباً.
    expect(elapsedMs).toBeLessThan(100);
  });
});
