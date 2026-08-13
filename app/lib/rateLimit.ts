// محدِّد معدّل بسيط بالذاكرة (نافذة منزلقة ثابتة) — يمنع إغراق مسار
// استقبال قراءات الأجهزة بطلبات غير محدودة من مفتاح واحد (مسرَّب أو
// مُساء استخدامه)، وهو ما كان يسمح بتضخيم جدول pm10_readings_history
// وتشويه حساب الاستمرار الزمني (computeSustainedPm10Status) بقراءات
// كثيفة مصطنعة، بجانب استهلاك موارد Supabase بلا سقف.
//
// حدود هذا الحل بوضوح: الحالة بالذاكرة تخص كل instance على حدة، وعلى
// Vercel (serverless) قد تتعدد الـinstances أو تُعاد تهيئتها — فهذا
// تخفيف عملي (يوقف الإغراق من مصدر واحد بسرعة) لا حاجز مطلق. الحل
// الكامل يحتاج مخزناً مشتركاً (Redis/Upstash) أو حدّاً على مستوى الحافة،
// وهو خارج نطاق التبعيات الحالية للمشروع.
type Bucket = { count: number; windowStartMs: number };

const buckets = new Map<string, Bucket>();

// تنظيف دوري كسول: نمسح النوافذ المنتهية عند كل استدعاء بحجم معيّن، حتى
// لا تتضخم الخريطة بمفاتيح أجهزة لم تعد ترسل (تسريب ذاكرة بطيء).
const CLEANUP_THRESHOLD = 1000;

function cleanupExpired(nowMs: number, windowMs: number) {
  for (const [key, bucket] of buckets) {
    if (nowMs - bucket.windowStartMs >= windowMs) buckets.delete(key);
  }
}

/**
 * يرجع true إن كان الطلب مسموحاً، false إن تجاوز الحد ضمن النافذة.
 * key: معرّف فريد للمصدر (deviceId هنا — لا IP، لأن الأجهزة قد تشترك في
 * نفس مخرج الشبكة بالموقع، والهوية الفعلية هي المفتاح نفسه).
 */
export function checkRateLimit(key: string, maxRequests: number, windowMs: number): boolean {
  const nowMs = Date.now();

  if (buckets.size > CLEANUP_THRESHOLD) cleanupExpired(nowMs, windowMs);

  const bucket = buckets.get(key);
  if (!bucket || nowMs - bucket.windowStartMs >= windowMs) {
    buckets.set(key, { count: 1, windowStartMs: nowMs });
    return true;
  }

  if (bucket.count >= maxRequests) return false;

  bucket.count += 1;
  return true;
}
