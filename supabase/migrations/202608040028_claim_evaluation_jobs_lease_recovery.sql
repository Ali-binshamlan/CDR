-- =====================================================================
-- DCR — 202608040028_claim_evaluation_jobs_lease_recovery.sql
-- =====================================================================
-- خطأ حرج مكتشَف ومُصلَح (مراجعة خبير خارجي — "دالة Claim كذلك لا تستعيد
-- مهمة RUNNING بعد انتهاء Lease؛ إذا تعطل العامل تبقى المهمة عالقة إلى
-- الأبد. الاختبار المسمّى Recovery لا يحاكي Crash؛ فهو يستدعي fail يدوياً
-- أولاً ثم RETRY"):
--
-- claim_evaluation_jobs (202608040005) كانت تفحص فقط
-- `status in ('PENDING', 'RETRY')` — لا `RUNNING` مع `lease_until` منتهٍ
-- إطلاقاً، بعكس claim_alert_outbox_batch (202608040026) التي تفحص كلا
-- الحالتين عبر `union all` منذ البداية. فمهمة تعطّل عاملها فعلياً (Vercel
-- timeout، إعادة نشر، Crash) قبل استدعاء complete_evaluation_job أو
-- fail_evaluation_job تبقى بحالة RUNNING للأبد — لا آلية استرداد تلقائية
-- تعيدها لدورة claim لاحقة، بعكس ما يوحي به التعليق الأصلي ("Lease منتهية
-- تسمح لعامل آخر باسترداد المهمة تلقائياً" في scheduler-worker/route.ts —
-- هذا كان صحيحاً في التصميم المقصود فقط، لا في تنفيذ claim_evaluation_jobs
-- الفعلي). اختبار concurrency.dbtest.ts القديم لم يكشف هذا لأنه كان يستدعي
-- fail_evaluation_job يدوياً أولاً (يُعيد الحالة صراحةً لـRETRY) قبل
-- الـclaim الجديد — محاكاة "استدعاء fail الناجح بعد Crash"، لا محاكاة
-- Crash نفسه (حيث لا يُستدعى fail إطلاقاً).
--
-- الإصلاح: نفس نمط claim_alert_outbox_batch بالضبط — union مع فرع ثانٍ
-- يفحص status='RUNNING' and lease_until < clock_timestamp() مباشرة.
-- =====================================================================

create or replace function public.claim_evaluation_jobs(
  p_worker_id uuid,
  p_batch_size integer default 20,
  p_lease_seconds integer default 90
)
returns setof public.project_evaluation_jobs
language sql
security invoker
set search_path = pg_catalog, public
as $$
  with candidates as (
    select id
    from public.project_evaluation_jobs
    where status in ('PENDING', 'RETRY')
      and run_after <= clock_timestamp()
      and (lease_until is null or lease_until < clock_timestamp())
    union all
    -- خطأ مُصلَح هنا: مهمة RUNNING عالقة (عامل تعطّل بلا استدعاء complete/
    -- fail) وانتهت مهلة Lease الخاصة بها — تعود متاحة للمطالبة تلقائياً،
    -- بلا انتظار أي تدخل يدوي أو استدعاء fail_evaluation_job صريح.
    select id
    from public.project_evaluation_jobs
    where status = 'RUNNING'
      and lease_until is not null
      and lease_until < clock_timestamp()
    order by id
    for update skip locked
    limit greatest(1, p_batch_size)
  )
  update public.project_evaluation_jobs j
  set status = 'RUNNING',
      worker_id = p_worker_id,
      lease_until = clock_timestamp() + make_interval(secs => greatest(1, p_lease_seconds)),
      attempts = attempts + 1
  from candidates c
  where j.id = c.id
  returning j.*;
$$;

revoke all on function public.claim_evaluation_jobs(uuid, integer, integer)
  from public, anon, authenticated;
grant execute on function public.claim_evaluation_jobs(uuid, integer, integer) to service_role;
