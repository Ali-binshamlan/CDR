// إعادة محاولة محدودة (لا لانهائي) بـexponential backoff — طلب صريح: "لا
// تستخدم retry لا نهائي" و"إذا فشل Supabase، لا يجب أن يسبب انهيار استقبال
// البيانات الحية بالكامل". هذا بديل عن queue خارجية دائمة (Redis/ملف) غير
// متاحة على منصة serverless (Vercel) بلا خدمة مدفوعة — قيد موثَّق صراحة،
// لا حل كامل لفقدان القراءات عند تعطّل Supabase لفترة أطول من محاولات هذا
// الـhelper (ثوانٍ قليلة كحد أقصى)، فقط تحمّل انقطاعات عابرة قصيرة.

export interface RetryOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_INITIAL_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 4000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// fn يجب أن تُرجع { ok: true, value } أو { ok: false, error } — لا ترمي
// استثناءً للتحكم بالتدفق (الاستدعاءات الحالية لـSupabase JS ترجع
// { data, error } بالفعل، لا تحتاج try/catch لتمييز الفشل).
export async function retryWithBackoff<T>(
  fn: () => Promise<{ ok: true; value: T } | { ok: false; error: string }>,
  options: RetryOptions = {}
): Promise<{ ok: true; value: T } | { ok: false; error: string; attempts: number }> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const initialDelayMs = options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;

  let lastError = 'محاولة لم تُنفَّذ';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await fn();
    if (result.ok) return result;
    lastError = result.error;
    if (attempt === maxAttempts) break;
    const delayMs = Math.min(initialDelayMs * 2 ** (attempt - 1), maxDelayMs);
    await sleep(delayMs);
  }
  return { ok: false, error: lastError, attempts: maxAttempts };
}
