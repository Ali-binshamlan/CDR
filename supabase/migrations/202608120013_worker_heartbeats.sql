-- =====================================================================
-- DCR — 202608120013_worker_heartbeats.sql
-- =====================================================================
-- خطأ مكتشَف ومُصلَح (طلب صريح من المستخدم — مراجعة كود خارجي: "Health
-- endpoint قد يظهر أخضر رغم تعطل النظام"): scheduler-heartbeat/route.ts
-- كان يستدل على صحة كل عامل بشكل غير مباشر (عمق طابور/عمر أقدم صف/started_at
-- عند البدء) بدل نبضة صريحة بدء/نجاح/فشل يكتبها العامل نفسه — لا وسيلة
-- للتمييز بين "لا يوجد عمل" و"العامل معطَّل تماماً"، ولا بين "بدأت دورة"
-- و"اكتملت دورة بنجاح فعلاً".
--
-- جدول واحد موحَّد (لا جدول منفصل لكل عامل) — نفس فلسفة evidence_hash_ledger
-- (دفتر واحد لكل الجداول العشرة بدل عشر جداول منفصلة): يبسّط الفحص
-- (استعلام واحد بدل خمسة) ويضمن نفس الحقول/الدلالة لكل عامل بلا انحراف.
-- =====================================================================

create table if not exists public.worker_heartbeats (
  worker_name text primary key,
  last_run_started_at timestamptz,
  last_run_succeeded_at timestamptz,
  last_run_failed_at timestamptz,
  last_error text,
  updated_at timestamptz not null default clock_timestamp()
);

comment on table public.worker_heartbeats is
  'نبضة صريحة لكل عامل cron (بدء/نجاح/فشل مستقلة) — راجع تعليق migration 202608120013 الكامل. صف واحد لكل عامل (worker_name)، يُحدَّث ذرّياً عبر upsert_worker_heartbeat() أدناه.';

alter table public.worker_heartbeats enable row level security;
revoke all on public.worker_heartbeats from anon, authenticated;
grant select on public.worker_heartbeats to service_role;

-- الكتابة تمر حصراً عبر هذه الدالة (لا INSERT/UPDATE مباشرين من service_role
-- — نفس مبدأ evidence_hash_ledger بعد migration 202608120012، وإن كان
-- السبب هنا تشغيلياً لا أمنياً: توحيد "بدء دورة" مع upsert أول مرة، بدل
-- احتمال صفين منفصلين لنفس worker_name عبر INSERT/UPDATE منفصلين متزامنين).
create or replace function public.upsert_worker_heartbeat(
  p_worker_name text,
  -- 'started' | 'succeeded' | 'failed' — يحدد أي عمود last_run_*_at يتحدَّث.
  p_event text,
  p_error text default null
)
returns void
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  if p_event not in ('started', 'succeeded', 'failed') then
    raise exception using errcode = '22023', message = format('p_event غير معروف: %s (يجب أن يكون started/succeeded/failed)', p_event);
  end if;

  insert into public.worker_heartbeats (worker_name, last_run_started_at, last_run_succeeded_at, last_run_failed_at, last_error, updated_at)
  values (
    p_worker_name,
    case when p_event = 'started' then clock_timestamp() else null end,
    case when p_event = 'succeeded' then clock_timestamp() else null end,
    case when p_event = 'failed' then clock_timestamp() else null end,
    case when p_event = 'failed' then p_error else null end,
    clock_timestamp()
  )
  on conflict (worker_name) do update
  set last_run_started_at = case when p_event = 'started' then excluded.last_run_started_at else worker_heartbeats.last_run_started_at end,
      last_run_succeeded_at = case when p_event = 'succeeded' then excluded.last_run_succeeded_at else worker_heartbeats.last_run_succeeded_at end,
      last_run_failed_at = case when p_event = 'failed' then excluded.last_run_failed_at else worker_heartbeats.last_run_failed_at end,
      last_error = case when p_event = 'failed' then excluded.last_error when p_event = 'succeeded' then null else worker_heartbeats.last_error end,
      updated_at = excluded.updated_at;
end;
$$;

revoke all on function public.upsert_worker_heartbeat(text, text, text) from public, anon, authenticated;
grant execute on function public.upsert_worker_heartbeat(text, text, text) to service_role;
