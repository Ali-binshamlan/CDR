import { Redis } from '@upstash/redis';

// خطأ مكتشَف ومُصلَح (طلب صريح من المستخدم — مراجعة كود خارجي: "محدد المعدل
// غير موزّع"): checkRateLimit (rateLimit.ts) يعتمد على Map بالذاكرة — خاص
// بكل instance، وعلى Vercel (serverless) قد تتعدد الـinstances أو تُعاد
// تهيئتها بلا حالة مشتركة، فيسهل تجاوزه (كل instance جديدة = عدّاد جديد من
// الصفر). هذا الملف مخصص لمسارات تحتاج حداً حقيقياً موزَّعاً عبر كل الـ
// instances معاً (auth/register تحديداً — إنشاء حسابات وهمية جماعياً خطر
// أعلى من إغراق قراءة جهاز واحد).
//
// Upstash Redis (REST API، لا اتصال TCP دائم — يعمل من Edge/Serverless بلا
// مشاكل connection pooling) — نفس المخزن المُستخدَم قياسياً لهذا الغرض على
// Vercel. متغيرا البيئة (UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN)
// اختياريان عمداً: المشروع لا يملك حساب Upstash متصلاً بعد وقت كتابة هذا
// الملف — fail-open (يسمح بالطلب + تحذير في السجل) بدل fail-closed (يمنع
// كل تسجيل) حتى تُضاف القيم فعلياً. هذا يعني عملياً "لا حماية موزَّعة فعلية
// حتى الإعداد" — نفس مستوى الحماية الحالي (rateLimit.ts بالذاكرة يبقى خط
// دفاع أول محلي مستقلاً، لا يُستبدَل هنا) لا تراجعاً عنه.
let redisClient: Redis | null = null;
let redisInitAttempted = false;

function getRedisClient(): Redis | null {
  if (redisInitAttempted) return redisClient;
  redisInitAttempted = true;

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    console.warn(
      'distributedRateLimit: UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN غير مُعرَّفين — الحد الموزَّع معطَّل (fail-open)، يبقى فقط الحد المحلي بالذاكرة (rateLimit.ts) فعّالاً.'
    );
    return null;
  }

  redisClient = new Redis({ url, token });
  return redisClient;
}

/**
 * حد معدّل موزَّع حقيقي عبر Redis — نافذة ثابتة بسيطة (INCR + EXPIRE عند أول
 * زيادة)، تعمل بشكل صحيح عبر كل instances/مناطق Vercel معاً (بخلاف
 * checkRateLimit المحلي في rateLimit.ts).
 *
 * fail-open صريح في حالتين فقط، موثَّقتين بوضوح في السجل: (1) لا اتصال Redis
 * مُهيَّأ (متغيرات البيئة غائبة)، (2) خطأ اتصال/مهلة فعلية أثناء الاستدعاء.
 * كلا الحالتين تعني "لا يمكن التحقق فعلياً"، فيُسمح بالطلب بدل حجب تسجيل
 * مستخدمين حقيقيين بسبب عطل بنية تحتية خارجية — يبقى الحد المحلي بالذاكرة
 * (rateLimit.ts) خط الدفاع الاحتياطي في هذه الحالة بالذات.
 */
export async function checkDistributedRateLimit(
  key: string,
  maxRequests: number,
  windowSeconds: number
): Promise<{ allowed: boolean; distributed: boolean }> {
  const redis = getRedisClient();
  if (!redis) {
    return { allowed: true, distributed: false };
  }

  try {
    const redisKey = `ratelimit:${key}`;
    const count = await redis.incr(redisKey);
    if (count === 1) {
      // أول زيادة لهذا المفتاح ضمن نافذة جديدة — نضبط انتهاء الصلاحية الآن،
      // لا عند كل زيادة (EXPIRE يُطبَّق مرة واحدة فقط لكل نافذة، لا يُمدَّد
      // مع كل طلب لاحق — نافذة ثابتة، لا منزلقة).
      await redis.expire(redisKey, windowSeconds);
    }
    return { allowed: count <= maxRequests, distributed: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('distributedRateLimit: فشل استدعاء Redis — fail-open (السماح بالطلب):', message);
    return { allowed: true, distributed: false };
  }
}
