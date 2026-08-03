import { timingSafeEqual } from 'crypto';

// مقارنة آمنة زمنياً لسر (Bearer token، API key، إلخ) — timingSafeEqual
// يتطلب طولاً متطابقاً للمخزنين، فنقارن الطول أولاً (تسريب طفيف لطول السر،
// غير حسّاس عملياً مقارنة بتسريب محتواه عبر توقيت المقارنة العادية !==).
// مُستخرَجة من app/api/alerts/generate/route.ts لإعادة الاستخدام في أي
// مسار cron جديد (مثل app/api/cron/provider-pull/route.ts).
export function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
