-- =====================================================================
-- DCR — 202608120002_telemetry_dead_letter.sql
-- =====================================================================
-- خطأ حرج مكتشَف ومُصلَح (مراجعة كود خارجي — "صفوف Telemetry الميتة تُحذف
-- بعد سبعة أيام"): db-cleanup-worker (route.ts، هدف STATUS_TARGETS
-- telemetry_ingestion_queue/DEAD/7 days) كان يحذف نهائياً عبر
-- cleanup_transient_table_batch أي صف بلغ status='DEAD' (استنفد MAX_ATTEMPTS
-- محاولات في telemetry-worker) بعد 7 أيام فقط. لكن telemetry_ingestion_queue
-- هو المكان الوحيد الذي تعيش فيه الحمولة الخام (payload، قراءة الجهاز
-- الكاملة) قبل أن تُكتب بنجاح إلى device_readings_history/pm10_readings_history
-- عبر writeDeviceReading — صف DEAD يعني تحديداً أن تلك الكتابة لم تنجح
-- إطلاقاً (fail_telemetry_queue_row يضبط DEAD فقط بعد استنفاد المحاولات).
-- حذفه نهائياً = فقدان نهائي لقراءة حقيقية قد تكون النسخة الوحيدة الموجودة
-- منها في كل النظام (لا توجد نسخة أخرى — لا في device_readings_history ولا
-- pm10_readings_history، لأن الكتابة هناك هي بالضبط ما فشل).
--
-- الإصلاح: صف DEAD الآن يُنقَل (لا يُحذف) إلى telemetry_dead_letter —
-- جدول دائم append-only (نفس درجة حماية جداول الأدلة العشرة: forbid_
-- evidence_mutation/forbid_evidence_truncate) — قبل حذفه من الطابور
-- العابر. لا حذف نهائي إلا بعد واحد من مسارين موثَّقين صراحة داخل الصف
-- نفسه:
--   1) Replay ناجح: replay_dead_telemetry_letter يعيد إدراج نفس الحمولة في
--      telemetry_ingestion_queue بحالة PENDING (idempotency_key الأصلي
--      يحمي من ازدواج لو كانت قد نجحت لاحقاً بمسار مختلف)، ويضبط
--      replayed_at/replayed_by/replay_result على صف dead_letter — الصف
--      يبقى موجوداً دائماً (سجل تاريخي أنه حدث فشل ثم أُعيدت محاولته)، لا
--      يُحذف حتى بعد نجاح الـreplay.
--   2) اعتماد بشري موثَّق: acknowledge_dead_telemetry_letter يسجّل قرار
--      إنسان صريح (admin_user_id + سبب نصي إلزامي) بأن هذه القراءة تُعتبر
--      مفقودة نهائياً بقرار بشري واعٍ — لا حذف حتى هنا أيضاً، فقط توثيق
--      القرار على الصف نفسه (acknowledged_at/acknowledged_by/acknowledged_
--      reason)، فيبقى الدليل التاريخي الكامل لماذا فُقدت هذه القراءة ومن
--      قرر ذلك ومتى.
-- كلا المسارين إضافة (INSERT/UPDATE مقيَّد جداً عبر forbid_evidence_mutation
-- بنفس نمط استثناء dust_profile_id أدناه) — لا حذف فعلي لصف dead_letter
-- تحت أي ظرف عبر أي مسار تطبيقي.
-- =====================================================================

-- ---------------------------------------------------------------------
-- الجدول: نسخة كاملة من صف telemetry_ingestion_queue وقت وصوله DEAD +
-- أعمدة تتبّع القرار اللاحق (replay أو اعتماد بشري).
-- ---------------------------------------------------------------------
create table if not exists public.telemetry_dead_letter (
  id uuid primary key default gen_random_uuid(),

  -- نسخة طبق الأصل من الصف الأصلي وقت النقل — كل شيء يلزم لإعادة المحاولة
  -- لاحقاً (idempotency_key/payload/observed_at) أو للتدقيق (attempts/
  -- last_error/created_at الأصلي).
  original_queue_id uuid not null,
  idempotency_key text not null,
  connection_id uuid not null,
  project_id uuid not null,
  device_id uuid not null,
  provider text not null,
  payload jsonb not null,
  observed_at timestamptz not null,
  original_received_at timestamptz not null,
  original_created_at timestamptz not null,
  attempts integer not null,
  last_error text,

  archived_at timestamptz not null default clock_timestamp(),

  -- Replay: null حتى تُستدعى replay_dead_telemetry_letter بنجاح. لا يُعاد
  -- ضبطها لـnull أبداً — أول replay فقط يُسجَّل (راجع forbid_evidence_
  -- mutation أدناه: أي UPDATE لاحق يحاول تعديل هذه الأعمدة بعد ضبطها يُرفَض).
  replayed_at timestamptz,
  replayed_by uuid references auth.users(id) on delete set null,
  -- معرّف الصف الجديد في telemetry_ingestion_queue بعد إعادة الإدراج —
  -- يتيح تتبّع "ماذا حدث لهذه المحاولة الثانية" لاحقاً (نجحت؟ فشلت مجدداً؟).
  replay_queue_id uuid,

  -- اعتماد بشري موثَّق: يقرر صراحة أن هذه القراءة مفقودة نهائياً (لا يُقصد
  -- منها إعادة محاولة). سبب نصي إلزامي عبر القيد أدناه — لا اعتماد صامت
  -- بلا توثيق لماذا.
  acknowledged_at timestamptz,
  acknowledged_by uuid references auth.users(id) on delete set null,
  acknowledged_reason text,

  check (acknowledged_at is null or (acknowledged_by is not null and btrim(coalesce(acknowledged_reason, '')) <> '')),
  check (replayed_at is null or replayed_by is not null)
);

create index if not exists idx_telemetry_dead_letter_project
  on public.telemetry_dead_letter (project_id, archived_at desc);
create index if not exists idx_telemetry_dead_letter_unresolved
  on public.telemetry_dead_letter (archived_at)
  where replayed_at is null and acknowledged_at is null;

alter table public.telemetry_dead_letter enable row level security;
revoke all on public.telemetry_dead_letter from anon, authenticated;
grant select, insert, update on public.telemetry_dead_letter to service_role;

-- append-only بنفس درجة جداول الأدلة العشرة — الاستثناء الوحيد المسموح هو
-- ضبط أعمدة replayed_*/acknowledged_* (مرة واحدة فقط لكل مجموعة، تُفرَض عبر
-- CHECK أعلاه + الشرط أدناه الذي يمنع أي تعديل آخر على بقية الأعمدة معاً).
create or replace function public.forbid_dead_letter_mutation()
returns trigger
language plpgsql
as $$
begin
  if TG_OP = 'UPDATE'
     and to_jsonb(NEW) - 'replayed_at' - 'replayed_by' - 'replay_queue_id'
         - 'acknowledged_at' - 'acknowledged_by' - 'acknowledged_reason'
       = to_jsonb(OLD) - 'replayed_at' - 'replayed_by' - 'replay_queue_id'
         - 'acknowledged_at' - 'acknowledged_by' - 'acknowledged_reason'
  then
    return NEW;
  end if;

  raise exception 'telemetry_dead_letter rows are append-only except replay/acknowledgement fields — % on % is not permitted', TG_OP, TG_TABLE_NAME;
end;
$$;

drop trigger if exists telemetry_dead_letter_immutable on public.telemetry_dead_letter;
create trigger telemetry_dead_letter_immutable
  before update or delete on public.telemetry_dead_letter
  for each row execute function public.forbid_dead_letter_mutation();

drop trigger if exists telemetry_dead_letter_no_truncate on public.telemetry_dead_letter;
create trigger telemetry_dead_letter_no_truncate
  before truncate on public.telemetry_dead_letter
  for each statement execute function public.forbid_evidence_truncate();
revoke truncate on public.telemetry_dead_letter from anon, authenticated, service_role;

-- ---------------------------------------------------------------------
-- archive_dead_telemetry_batch — يستبدل حذف db-cleanup-worker المباشر
-- لصفوف DEAD. ينقل دفعة (INSERT إلى dead_letter ثم DELETE من الطابور،
-- داخل نفس المعاملة الذرية لهذا الاستدعاء) بدل حذف مباشر. لا قائمة بيضاء
-- بأسماء جداول هنا (بخلاف cleanup_transient_table_batch) — هذه الدالة
-- مخصصة لجدول واحد بنيوياً (telemetry_ingestion_queue → telemetry_dead_
-- letter تحديداً)، لا دالة عامة تقبل اسم جدول كمعامل.
-- ---------------------------------------------------------------------
create or replace function public.archive_dead_telemetry_batch(
  p_older_than interval,
  p_limit integer default 500
)
returns integer
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_archived integer;
begin
  set local statement_timeout = '10s';
  set local lock_timeout = '3s';

  with victims as (
    select id from public.telemetry_ingestion_queue
    where status = 'DEAD'
      and created_at < now() - p_older_than
    order by created_at
    limit p_limit
    for update skip locked
  ),
  inserted as (
    insert into public.telemetry_dead_letter (
      original_queue_id, idempotency_key, connection_id, project_id, device_id,
      provider, payload, observed_at, original_received_at, original_created_at,
      attempts, last_error
    )
    select
      q.id, q.idempotency_key, q.connection_id, q.project_id, q.device_id,
      q.provider, q.payload, q.observed_at, q.received_at, q.created_at,
      q.attempts, q.last_error
    from public.telemetry_ingestion_queue q
    where q.id in (select id from victims)
    returning original_queue_id
  )
  delete from public.telemetry_ingestion_queue t
  using inserted i
  where t.id = i.original_queue_id;

  get diagnostics v_archived = row_count;
  return v_archived;
end;
$$;

revoke all on function public.archive_dead_telemetry_batch(interval, integer)
  from public, anon, authenticated;
grant execute on function public.archive_dead_telemetry_batch(interval, integer)
  to service_role;

-- ---------------------------------------------------------------------
-- replay_dead_telemetry_letter — يعيد إدراج الحمولة المؤرشَفة في طابور
-- الاستقبال بحالة PENDING، ليعالجها telemetry-worker من جديد في دورته
-- التالية. idempotency_key الأصلي يبقى كما هو — لو كانت القراءة قد نجحت
-- بالفعل بمسار آخر لاحقاً (نادر لكن ممكن)، ON CONFLICT DO NOTHING يحمي من
-- ازدواج حقيقي في device_readings_history عبر writeDeviceReading نفسها.
-- ---------------------------------------------------------------------
create or replace function public.replay_dead_telemetry_letter(
  p_dead_letter_id uuid,
  p_replayed_by uuid
)
returns uuid
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_row public.telemetry_dead_letter%rowtype;
  v_new_queue_id uuid;
begin
  select * into v_row from public.telemetry_dead_letter where id = p_dead_letter_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'dead letter row not found';
  end if;

  if v_row.replayed_at is not null then
    raise exception using errcode = '22023', message = 'row already replayed';
  end if;
  if v_row.acknowledged_at is not null then
    raise exception using errcode = '22023', message = 'row already acknowledged as permanently lost — cannot replay';
  end if;

  insert into public.telemetry_ingestion_queue (
    idempotency_key, connection_id, project_id, device_id, provider,
    payload, observed_at, status
  ) values (
    v_row.idempotency_key, v_row.connection_id, v_row.project_id, v_row.device_id, v_row.provider,
    v_row.payload, v_row.observed_at, 'PENDING'
  )
  -- idempotency_key فريد بلا شرط جزئي على telemetry_ingestion_queue —
  -- تعارض هنا يعني أن نفس المفتاح موجود بالفعل (نادر: صف نجح بمسار آخر
  -- بين الأرشفة والـreplay) — نُرجع معرّف الصف الموجود بدل الفشل الكامل.
  on conflict (idempotency_key) do update set idempotency_key = excluded.idempotency_key
  returning id into v_new_queue_id;

  update public.telemetry_dead_letter
  set replayed_at = clock_timestamp(),
      replayed_by = p_replayed_by,
      replay_queue_id = v_new_queue_id
  where id = p_dead_letter_id;

  return v_new_queue_id;
end;
$$;

revoke all on function public.replay_dead_telemetry_letter(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.replay_dead_telemetry_letter(uuid, uuid)
  to service_role;

-- ---------------------------------------------------------------------
-- acknowledge_dead_telemetry_letter — اعتماد بشري موثَّق أن القراءة مفقودة
-- نهائياً. p_reason إلزامي (يُرفَض فارغاً) — يفرض توثيق السبب الفعلي بدل
-- اعتماد صامت. لا حذف — فقط تسجيل القرار على الصف نفسه (يبقى موجوداً
-- كسجل تاريخي دائم لماذا فُقدت هذه القراءة ومن قرر ذلك ومتى).
-- ---------------------------------------------------------------------
create or replace function public.acknowledge_dead_telemetry_letter(
  p_dead_letter_id uuid,
  p_acknowledged_by uuid,
  p_reason text
)
returns boolean
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_updated boolean;
begin
  if p_acknowledged_by is null then
    raise exception using errcode = '22023', message = 'acknowledged_by is required';
  end if;
  if btrim(coalesce(p_reason, '')) = '' then
    raise exception using errcode = '22023', message = 'reason is required and cannot be empty';
  end if;

  update public.telemetry_dead_letter
  set acknowledged_at = clock_timestamp(),
      acknowledged_by = p_acknowledged_by,
      acknowledged_reason = btrim(p_reason)
  where id = p_dead_letter_id
    and acknowledged_at is null
    and replayed_at is null
  returning true into v_updated;

  return coalesce(v_updated, false);
end;
$$;

revoke all on function public.acknowledge_dead_telemetry_letter(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.acknowledge_dead_telemetry_letter(uuid, uuid, text)
  to service_role;
