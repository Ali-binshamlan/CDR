// إعادة محاولة تلقائية لاستعلامات Supabase مع مهلة صريحة على مستوى العميل.
//
// خطأ حرج مكتشَف فعلياً في الإنتاج (2026-08-08): طلب PostgREST قد لا يفشل
// بخطأ إطلاقاً — قد يبقى معلَّقاً بلا رد نهائي (hang) إذا تعطّل الاتصال
// أثناء تنفيذ معاملة على جانب قاعدة البيانات (مثال: انقطاع Cloudflare 522
// أثناء pg_advisory_xact_lock). withSupabaseRetry السابقة كانت تنتظر
// operation() حتى *ترجع* نتيجة (نجاح أو فشل) قبل أن تقرر إعادة المحاولة —
// عديمة الفائدة ضد طلب لا يرجع شيئاً أبداً. الإصلاح: سباق (Promise.race)
// بين operation() ومهلة صريحة (AbortController) — إن انقضت المهلة قبل رد
// فعلي، الطلب يُعتبَر فاشلاً فوراً وتبدأ محاولة جديدة، بدل انتظار Vercel/
// cron-job.org لإنهاء الاتصال من الخارج.
const RETRYABLE_CODES = new Set(['PGRST003']);
const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 300;
const PER_ATTEMPT_TIMEOUT_MS = 10_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class SupabaseCallTimeoutError extends Error {
  constructor() {
    super('Supabase call exceeded per-attempt timeout');
    this.name = 'SupabaseCallTimeoutError';
  }
}

async function withTimeout<T>(promise: PromiseLike<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SupabaseCallTimeoutError()), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timer!);
  }
}

export async function withSupabaseRetry<T>(
  operation: () => PromiseLike<{ data: T; error: { code?: string; message: string } | null }>
): Promise<{ data: T; error: { code?: string; message: string } | null }> {
  let lastResult: { data: T; error: { code?: string; message: string } | null };

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      lastResult = await withTimeout(operation(), PER_ATTEMPT_TIMEOUT_MS);
    } catch (err) {
      // معلَّق (timeout) أو استثناء شبكي فعلي — يُعامَل كخطأ قابل لإعادة
      // المحاولة، نفس PGRST003.
      lastResult = { data: null as T, error: { code: 'PGRST003', message: err instanceof Error ? err.message : String(err) } };
    }

    if (!lastResult.error || !RETRYABLE_CODES.has(lastResult.error.code ?? '')) {
      return lastResult;
    }

    if (attempt < MAX_ATTEMPTS) {
      await sleep(BASE_DELAY_MS * attempt);
    }
  }

  return lastResult!;
}
