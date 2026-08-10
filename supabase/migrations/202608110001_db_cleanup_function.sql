-- =====================================================================
-- DCR — 202608110001_db_cleanup_function.sql
-- =====================================================================
-- خطة الاحتفاظ طويلة المدى (retention plan، معتمدة 2026-08-10) — القسم 1:
-- تنظيف الجداول العابرة الستة غير المحمية بـforbid_evidence_mutation/
-- forbid_evidence_truncate: telemetry_ingestion_queue, decision_alert_outbox,
-- provider_pull_run_lock, scheduler_locks, forecast_snapshots,
-- project_evaluation_jobs. لا تُمس أي جداول أدلة هنا إطلاقاً — لا DELETE
-- على أي من العشرة جداول append-only بأي شرط.
--
-- دالة واحدة عامة بدل ست دوال منفصلة — كل استدعاء يحذف دفعة محدودة من جدول
-- واحد محدد بالاسم، بحد أقصى LIMIT صفوف، بشرط عمر محدد. db-cleanup-worker
-- (route.ts) يستدعيها لكل جدول بحلقة تكرار حتى يرجع عدد محذوف أقل من
-- الدفعة (استنفاد) أو بلوغ حد أقصى للتكرارات لكل تشغيلة.
--
-- SET LOCAL statement_timeout من الداخل — نفس المبدأ المطبَّق في كل RPC
-- حساسة بالنظام (لا الاعتماد على Promise.race جانب العميل وحده).
-- =====================================================================

create or replace function public.cleanup_transient_table_batch(
  p_table_name text,
  p_timestamp_column text,
  p_status_column text,
  p_status_values text[],
  p_older_than interval,
  p_limit integer default 500
)
returns integer
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_deleted integer;
  v_allowed_tables text[] := array[
    'telemetry_ingestion_queue',
    'decision_alert_outbox',
    'project_evaluation_jobs'
  ];
begin
  -- قائمة بيضاء صريحة داخل الدالة نفسها — حتى لو استُدعيت هذه الدالة
  -- بمعطيات خاطئة من أي مصدر مستقبلي، لا يمكنها لمس أي جدول خارج هذه
  -- الثلاثة (تحديداً: لا يمكنها أبداً تمرير اسم أحد جداول الأدلة العشرة).
  if not (p_table_name = any(v_allowed_tables)) then
    raise exception 'cleanup_transient_table_batch: % is not an allowed transient table', p_table_name;
  end if;

  set local statement_timeout = '10s';
  set local lock_timeout = '3s';

  execute format(
    'with victims as (
       select ctid from public.%I
       where %I = any($1)
         and %I < now() - $2
       limit $3
     )
     delete from public.%I t
     using victims v
     where t.ctid = v.ctid',
    p_table_name, p_status_column, p_timestamp_column, p_table_name
  )
  using p_status_values, p_older_than, p_limit;

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function public.cleanup_transient_table_batch(text, text, text, text[], interval, integer)
  from public, anon, authenticated;
grant execute on function public.cleanup_transient_table_batch(text, text, text, text[], interval, integer)
  to service_role;

-- =====================================================================
-- cleanup_transient_table_batch_by_age — نفس المنطق بلا شرط status، لجداول
-- لا تملك عمود حالة أصلاً (provider_pull_run_lock, scheduler_locks,
-- forecast_snapshots) — فرض شرط status وهمي عليها كان أسوأ من دالة إضافية
-- صغيرة منفصلة.
-- =====================================================================
create or replace function public.cleanup_transient_table_batch_by_age(
  p_table_name text,
  p_timestamp_column text,
  p_older_than interval,
  p_limit integer default 500
)
returns integer
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_deleted integer;
  v_allowed_tables text[] := array['provider_pull_run_lock', 'scheduler_locks', 'forecast_snapshots', 'db_cleanup_run_lock'];
begin
  if not (p_table_name = any(v_allowed_tables)) then
    raise exception 'cleanup_transient_table_batch_by_age: % is not an allowed transient table', p_table_name;
  end if;

  set local statement_timeout = '10s';
  set local lock_timeout = '3s';

  execute format(
    'with victims as (
       select ctid from public.%I where %I < now() - $1 limit $2
     )
     delete from public.%I t using victims v where t.ctid = v.ctid',
    p_table_name, p_timestamp_column, p_table_name
  )
  using p_older_than, p_limit;

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function public.cleanup_transient_table_batch_by_age(text, text, interval, integer)
  from public, anon, authenticated;
grant execute on function public.cleanup_transient_table_batch_by_age(text, text, interval, integer)
  to service_role;

-- =====================================================================
-- db_cleanup_run_lock — قفل تداخل الدورة، نفس نمط provider_pull_run_lock/
-- scheduler_locks حرفياً (PRIMARY KEY على نافذة زمنية 5 دقائق — أطول من
-- provider-pull لأن هذه الدورة قد تنفّذ حتى 7 عمليات حذف دفعية متتالية).
-- يُنظَّف هو نفسه (24 ساعة) عبر cleanup_transient_table_batch_by_age أعلاه
-- ضمن نفس تشغيلة db-cleanup-worker — يمنع نموه الذاتي بلا حد.
-- =====================================================================
create table if not exists public.db_cleanup_run_lock (
  run_bucket bigint primary key,
  started_at timestamptz not null default now()
);

create index if not exists idx_db_cleanup_run_lock_started_at
  on public.db_cleanup_run_lock (started_at);

alter table public.db_cleanup_run_lock enable row level security;
revoke all on public.db_cleanup_run_lock from anon, authenticated;
