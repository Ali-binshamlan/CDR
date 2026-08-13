-- =====================================================================
-- DCR — 202608040005_claim_evaluation_jobs.sql
-- =====================================================================
-- القسم 10.2 من "دليل الإصلاح الجذري لمنظومة مرقاب" — العامل يطالب بدفعة
-- باستخدام FOR UPDATE SKIP LOCKED وLease، لا ينشئ Jobs بنفسه. RPC ذرية
-- (لا استعلامين منفصلين من التطبيق يفتحان نافذة سباق بين القراءة والتحديث).
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
    order by run_after, created_at
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

-- إنهاء مهمة بنجاح — ذرية، تتحقق من أن worker_id ما زال يطابق (لا تُنهي
-- مهمة استرجعها عامل آخر بعد انتهاء Lease هذا العامل).
create or replace function public.complete_evaluation_job(
  p_job_id uuid,
  p_worker_id uuid
)
returns boolean
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_updated boolean;
begin
  update public.project_evaluation_jobs
  set status = 'SUCCEEDED',
      completed_at = clock_timestamp(),
      lease_until = null,
      last_error = null
  where id = p_job_id and worker_id = p_worker_id
  returning true into v_updated;

  return coalesce(v_updated, false);
end;
$$;

revoke all on function public.complete_evaluation_job(uuid, uuid) from public, anon, authenticated;
grant execute on function public.complete_evaluation_job(uuid, uuid) to service_role;

-- فشل مهمة — RETRY مع Backoff أُسّي (حد أقصى 10 دقائق) حتى p_max_attempts،
-- ثم DEAD نهائياً. لا يشترط worker_id (فشل قد يُسجَّل بعد انتهاء Lease هذا
-- العامل فعلياً — لا يزال يجب تسجيل الخطأ ودفع الجدولة قدماً بأمان).
create or replace function public.fail_evaluation_job(
  p_job_id uuid,
  p_error text,
  p_max_attempts integer default 5
)
returns void
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_attempts integer;
begin
  select attempts into v_attempts from public.project_evaluation_jobs where id = p_job_id;
  if not found then
    return;
  end if;

  if v_attempts >= p_max_attempts then
    update public.project_evaluation_jobs
    set status = 'DEAD',
        last_error = p_error,
        lease_until = null,
        completed_at = clock_timestamp()
    where id = p_job_id;
  else
    update public.project_evaluation_jobs
    set status = 'RETRY',
        last_error = p_error,
        lease_until = null,
        run_after = clock_timestamp() + make_interval(secs => least(600, power(2, v_attempts) * 5))
    where id = p_job_id;
  end if;
end;
$$;

revoke all on function public.fail_evaluation_job(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.fail_evaluation_job(uuid, text, integer) to service_role;
