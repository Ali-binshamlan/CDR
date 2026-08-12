-- =====================================================================
-- DCR — 202608110018_worker_lease_ownership.sql
-- =====================================================================
-- خطأ مكتشَف ومُصلَح (مراجعة كود خارجي — "ملكية Lease غير آمنة في
-- العمال"): fail_telemetry_queue_row (202608091004)، fail_evaluation_job
-- (202608040005)، وfail_alert_outbox_row (202608040026) — ثلاثتها لا
-- تشترط worker_id/locked_by إطلاقاً، بخلاف complete_* الشقيقة لكل منها
-- (تشترطه بالفعل وتُرجع boolean). السيناريو الفعلي: عامل A يُطالِب بصف،
-- Lease تنتهي (Vercel timeout/إعادة نشر/تعطّل) قبل أن يستدعي fail، عامل B
-- يُطالِب بنفس الصف (claim_* يسترد صفوف PROCESSING/RUNNING منتهية الـlease
-- تلقائياً — هذا سلوك صحيح ومقصود)، عامل B يبدأ معالجته، ثم يعود عامل A
-- (كان لا يزال يعالج، لم يتحقق من انتهاء مهلته) ويستدعي fail_* على نفس
-- الصف — يُعيد صف عامل B (قيد المعالجة الفعلية الآن) إلى RETRY/DEAD رغم
-- أن عامل B قد ينجح لاحقاً وينهيه بنجاح فعلياً في نفس اللحظة تقريباً، أو
-- يُهدر محاولة عامل B (attempts تتضاعف زوراً) بلا أي علاقة بنتيجة عمل B
-- الفعلي.
--
-- الإصلاح: كل fail_* الثلاثة تشترط الآن (id, status='PROCESSING'/'RUNNING',
-- worker_id/locked_by) بالضبط كما تفعل complete_* الشقيقة — وتُرجع boolean
-- (true=نجح التحديث فعلياً، false=لم يعد العامل يملك الصف، لا تُعتبر
-- "فشلت" منطقياً؛ ببساطة عامل آخر بات مسؤولاً عنه الآن). المستدعي (route.ts
-- في العمال الثلاثة) يتحقق من هذه القيمة صراحة — false تعني توقّف فوري بلا
-- أي محاولة أخرى على هذا الصف (لا استدعاء fail بعدها، تماماً كما طلب
-- التقرير: "عند false اعتبر أن العامل فقد الملكية، ولا تستدعِ fail بعدها").
--
-- إضافة أخرى مطلوبة صراحة: renew_*_lease لكل جدول ثلاثة — يُستدعى قبل
-- معالجة كل صف (لا دفعة كاملة بلا تجديد) لتمديد lease_until/locked_until
-- بنفس مدة الإيجار الأصلية بشرط ownership مطابق أيضاً — يمنع انتهاء الـlease
-- منتصف معالجة صف واحد طويل نسبياً ضمن دفعة (حتى لو صُغِّرت الدفعات، صف
-- واحد بطيء لا يزال يحتاج ضماناً صريحاً لا افتراضاً ضمنياً بأن الدفعة كلها
-- ستُعالَج أسرع من مدة الـlease).
-- =====================================================================

-- ---------------------------------------------------------------------
-- fail_telemetry_queue_row — إضافة p_worker_id إلزامي (لا default — كل
-- استدعاء حالي في telemetry-worker/route.ts سيُحدَّث بنفس الدفعة).
-- ---------------------------------------------------------------------
drop function if exists public.fail_telemetry_queue_row(uuid, text, integer);

create or replace function public.fail_telemetry_queue_row(
  p_row_id uuid,
  p_worker_id uuid,
  p_error text,
  p_max_attempts integer default 5
)
returns boolean
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_attempts integer;
  v_updated boolean;
begin
  select attempts into v_attempts
  from public.telemetry_ingestion_queue
  where id = p_row_id and status = 'PROCESSING' and worker_id = p_worker_id;

  if not found then
    -- إما الصف غير موجود، أو لم يعد PROCESSING، أو عامل آخر يملكه الآن
    -- (استرجعه بعد انتهاء lease هذا العامل) — لا تعديل، فشل ملكية صامت.
    return false;
  end if;

  if v_attempts >= p_max_attempts then
    update public.telemetry_ingestion_queue
    set status = 'DEAD',
        last_error = p_error,
        lease_until = null,
        processed_at = clock_timestamp()
    where id = p_row_id and status = 'PROCESSING' and worker_id = p_worker_id
    returning true into v_updated;
  else
    update public.telemetry_ingestion_queue
    set status = 'PENDING',
        last_error = p_error,
        lease_until = clock_timestamp() + make_interval(secs => least(600, power(2, v_attempts) * 5))
    where id = p_row_id and status = 'PROCESSING' and worker_id = p_worker_id
    returning true into v_updated;
  end if;

  return coalesce(v_updated, false);
end;
$$;

revoke all on function public.fail_telemetry_queue_row(uuid, uuid, text, integer) from public, anon, authenticated;
grant execute on function public.fail_telemetry_queue_row(uuid, uuid, text, integer) to service_role;

-- تجديد Lease قبل معالجة صف واحد — نفس مدة p_lease_seconds الأصلية، بشرط
-- ownership مطابق (نفس شرط complete/fail بالضبط). false يعني فقدان الملكية
-- فعلياً *قبل* بدء المعالجة — المستدعي يجب أن يتخطى الصف فوراً بلا معالجة.
create or replace function public.renew_telemetry_queue_lease(
  p_row_id uuid,
  p_worker_id uuid,
  p_lease_seconds integer default 60
)
returns boolean
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_updated boolean;
begin
  update public.telemetry_ingestion_queue
  set lease_until = clock_timestamp() + make_interval(secs => greatest(1, p_lease_seconds))
  where id = p_row_id and status = 'PROCESSING' and worker_id = p_worker_id
  returning true into v_updated;

  return coalesce(v_updated, false);
end;
$$;

revoke all on function public.renew_telemetry_queue_lease(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.renew_telemetry_queue_lease(uuid, uuid, integer) to service_role;

-- ---------------------------------------------------------------------
-- fail_evaluation_job — نفس الإصلاح بالضبط، مطبَّق على project_evaluation_jobs
-- (status='RUNNING'، عمود worker_id نفسه).
-- ---------------------------------------------------------------------
drop function if exists public.fail_evaluation_job(uuid, text, integer);

create or replace function public.fail_evaluation_job(
  p_job_id uuid,
  p_worker_id uuid,
  p_error text,
  p_max_attempts integer default 5
)
returns boolean
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_attempts integer;
  v_updated boolean;
begin
  select attempts into v_attempts
  from public.project_evaluation_jobs
  where id = p_job_id and status = 'RUNNING' and worker_id = p_worker_id;

  if not found then
    return false;
  end if;

  if v_attempts >= p_max_attempts then
    update public.project_evaluation_jobs
    set status = 'DEAD',
        last_error = p_error,
        lease_until = null,
        completed_at = clock_timestamp()
    where id = p_job_id and status = 'RUNNING' and worker_id = p_worker_id
    returning true into v_updated;
  else
    update public.project_evaluation_jobs
    set status = 'RETRY',
        last_error = p_error,
        lease_until = null,
        run_after = clock_timestamp() + make_interval(secs => least(600, power(2, v_attempts) * 5))
    where id = p_job_id and status = 'RUNNING' and worker_id = p_worker_id
    returning true into v_updated;
  end if;

  return coalesce(v_updated, false);
end;
$$;

revoke all on function public.fail_evaluation_job(uuid, uuid, text, integer) from public, anon, authenticated;
grant execute on function public.fail_evaluation_job(uuid, uuid, text, integer) to service_role;

create or replace function public.renew_evaluation_job_lease(
  p_job_id uuid,
  p_worker_id uuid,
  p_lease_seconds integer default 90
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
  set lease_until = clock_timestamp() + make_interval(secs => greatest(1, p_lease_seconds))
  where id = p_job_id and status = 'RUNNING' and worker_id = p_worker_id
  returning true into v_updated;

  return coalesce(v_updated, false);
end;
$$;

revoke all on function public.renew_evaluation_job_lease(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.renew_evaluation_job_lease(uuid, uuid, integer) to service_role;

-- ---------------------------------------------------------------------
-- fail_alert_outbox_row — نفس الإصلاح، مطبَّق على decision_alert_outbox
-- (status='RUNNING'، عمود locked_by لا worker_id — تسمية مختلفة، نفس
-- الدور). complete_alert_outbox_row (202608040026) لم تُمس — تشترط
-- locked_by بالفعل وتُرجع boolean، لا تغيير مطلوب هناك.
-- ---------------------------------------------------------------------
drop function if exists public.fail_alert_outbox_row(uuid, text, integer);

create or replace function public.fail_alert_outbox_row(
  p_row_id uuid,
  p_worker_id uuid,
  p_error text,
  p_max_attempts integer default 5
)
returns boolean
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_attempts integer;
  v_updated boolean;
begin
  select attempts into v_attempts
  from public.decision_alert_outbox
  where id = p_row_id and status = 'RUNNING' and locked_by = p_worker_id;

  if not found then
    return false;
  end if;

  if v_attempts >= p_max_attempts then
    update public.decision_alert_outbox
    set status = 'DEAD',
        last_error = p_error,
        locked_until = null,
        locked_by = null
    where id = p_row_id and status = 'RUNNING' and locked_by = p_worker_id
    returning true into v_updated;
  else
    update public.decision_alert_outbox
    set status = 'RETRY',
        attempts = attempts + 1,
        last_error = p_error,
        locked_until = null,
        locked_by = null,
        available_at = clock_timestamp() + make_interval(secs => least(600, power(2, v_attempts) * 5))
    where id = p_row_id and status = 'RUNNING' and locked_by = p_worker_id
    returning true into v_updated;
  end if;

  return coalesce(v_updated, false);
end;
$$;

revoke all on function public.fail_alert_outbox_row(uuid, uuid, text, integer) from public, anon, authenticated;
grant execute on function public.fail_alert_outbox_row(uuid, uuid, text, integer) to service_role;

create or replace function public.renew_alert_outbox_lease(
  p_row_id uuid,
  p_worker_id uuid,
  p_lease_seconds integer default 60
)
returns boolean
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_updated boolean;
begin
  update public.decision_alert_outbox
  set locked_until = clock_timestamp() + make_interval(secs => greatest(1, p_lease_seconds))
  where id = p_row_id and status = 'RUNNING' and locked_by = p_worker_id
  returning true into v_updated;

  return coalesce(v_updated, false);
end;
$$;

revoke all on function public.renew_alert_outbox_lease(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.renew_alert_outbox_lease(uuid, uuid, integer) to service_role;
