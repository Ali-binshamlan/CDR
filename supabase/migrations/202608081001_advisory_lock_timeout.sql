-- =====================================================================
-- إصلاح جذري: pg_advisory_xact_lock بلا مهلة زمنية يسبب انسداد كامل
-- =====================================================================
-- المشكلة المكتشَفة فعلياً في الإنتاج (2026-08-08): استدعاء واحد لأي من
-- الدوال أدناه بدأ معاملته وأخذ pg_advisory_xact_lock على مشروع، ثم انقطع
-- اتصاله (Cloudflare 522 / انقطاع شبكة عابر بين Vercel وSupabase) قبل أن
-- يُكمل أو يفشل بوضوح — بقيت المعاملة "idle in transaction (aborted)"،
-- والقفل الذي أخذته لم يتحرر. كل استدعاء تالٍ (من cron-job.org كل دقيقة)
-- لنفس المشروع انتظر نفس القفل *للأبد* (pg_advisory_xact_lock بلا مهلة)،
-- فتراكمت عشرات الاستدعاءات المعلَّقة فوق بعضها حتى تعطّل /api/cron/
-- provider-pull بالكامل (60+ ثانية بلا رد لكل طلب).
--
-- الإصلاح: ALTER FUNCTION ... SET lock_timeout يفرض مهلة زمنية صريحة على
-- أي عملية "انتظار قفل" (بما فيها pg_advisory_xact_lock) تُنفَّذ داخل نطاق
-- تنفيذ هذه الدالة تحديداً — بعد انقضاء المهلة، PostgreSQL نفسه يُفشل
-- محاولة أخذ القفل بخطأ (error code 55P03: lock_not_available) بدل
-- الانتظار اللانهائي، فتفشل الدالة بوضوح ويتلقى المستدعي (route.ts) خطأً
-- فورياً بدل تعليق الطلب حتى انتهاء مهلة Vercel/cron-job.org نفسها.
--
-- 8 ثوانٍ (أقل من مهلة cron-job.org البالغة 30 ثانية بهامش كافٍ لبقية
-- منطق الدالة) — إن فشلت محاولة أخذ القفل، الاستدعاء التالي (خلال دقيقة)
-- يحاول من جديد بدل الانتظار أبداً.
alter function public.archive_project_atomic(uuid, uuid)
  set lock_timeout = '8s';

alter function public.persist_activity_decision_atomic(
  uuid, text, text, jsonb, text, timestamptz, jsonb, text,
  text, timestamptz, uuid, timestamptz, timestamptz, jsonb, timestamptz,
  uuid, text
) set lock_timeout = '8s';

alter function public.ingest_device_reading_atomic(
  uuid, uuid, text, bigint, timestamptz, timestamptz, jsonb, timestamptz
) set lock_timeout = '8s';

alter function public.ingest_device_event_v2(
  uuid, uuid, text, bigint, timestamptz, jsonb
) set lock_timeout = '8s';

alter function public.ingest_device_reading_and_event_atomic(
  uuid, uuid, text, bigint, timestamptz, timestamptz, jsonb, timestamptz, jsonb, boolean
) set lock_timeout = '8s';
