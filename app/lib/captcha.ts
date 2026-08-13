// خطأ مكتشَف ومُصلَح (طلب صريح من المستخدم — مراجعة كود خارجي: "محدد المعدل
// غير موزّع ومسار التسجيل يحتاج إعادة ضبط"، بند CAPTCHA للتسجيل العام):
// Cloudflare Turnstile — مجاني بالكامل بلا حدود استخدام (بخلاف hCaptcha/
// reCAPTCHA المجانيان بحد أقصى شهري)، ويعمل من الخادم عبر REST بسيط بلا
// أي SDK إضافي. يتحقق من رمز turnstile الذي تُرسله الواجهة (بعد أن يحله
// المستخدم عبر ودجت Turnstile المضمَّنة في صفحة التسجيل — راجع تعليق
// verifyTurnstileToken الكامل لسبب عدم فرضه بلا شرط).
//
// TURNSTILE_SECRET_KEY اختياري عمداً (نفس مبدأ UPSTASH_REDIS_REST_URL في
// distributedRateLimit.ts): المشروع لا يملك مفتاح Turnstile متصلاً بعد وقت
// كتابة هذا الملف — fail-open (يسمح بالتسجيل، تحذير في السجل) حتى يُضاف
// المفتاح فعلياً، بدل تعطيل التسجيل بالكامل بلا سبب واضح للمستخدم.
const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const REQUEST_TIMEOUT_MS = 5000;

export type CaptchaVerifyResult =
  | { ok: true; configured: true }
  | { ok: false; configured: true; reason: string }
  | { ok: true; configured: false }; // fail-open — لا مفتاح مُعرَّف بعد

/**
 * يتحقق من رمز Cloudflare Turnstile الذي أرسله العميل. configured=false
 * يعني "لا CAPTCHA فعلياً مفعَّلة على هذا الخادم بعد" — المستدعي يقرر إن
 * كان يريد المتابعة (fail-open حالياً) أو الرفض الصارم لاحقاً بعد إضافة
 * المفتاح.
 */
export async function verifyTurnstileToken(token: string | undefined | null, remoteIp?: string): Promise<CaptchaVerifyResult> {
  const secretKey = process.env.TURNSTILE_SECRET_KEY;
  if (!secretKey) {
    console.warn('captcha: TURNSTILE_SECRET_KEY غير مُعرَّف — التحقق من CAPTCHA معطَّل (fail-open).');
    return { ok: true, configured: false };
  }

  if (!token || typeof token !== 'string') {
    return { ok: false, configured: true, reason: 'رمز CAPTCHA مفقود' };
  }

  try {
    const body = new URLSearchParams({ secret: secretKey, response: token });
    if (remoteIp) body.set('remoteip', remoteIp);

    const response = await fetch(TURNSTILE_VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      return { ok: false, configured: true, reason: `فشل الاتصال بخدمة التحقق (HTTP ${response.status})` };
    }

    const result = (await response.json()) as { success: boolean; 'error-codes'?: string[] };
    if (!result.success) {
      return { ok: false, configured: true, reason: `فشل التحقق من CAPTCHA: ${(result['error-codes'] ?? []).join(', ') || 'غير معروف'}` };
    }

    return { ok: true, configured: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // فشل اتصال/مهلة أثناء التحقق نفسه (لا فشل تحقق منطقي) — يُعامَل بنفس
    // فلسفة fail-open أعلاه (عطل بنية تحتية خارجية لا يجوز أن يمنع تسجيل
    // مستخدمين حقيقيين)، لكن يُسجَّل بوضوح كخطأ لا تحذيراً عادياً.
    console.error('captcha: خطأ أثناء الاتصال بخدمة Turnstile — fail-open:', message);
    return { ok: true, configured: false };
  }
}
