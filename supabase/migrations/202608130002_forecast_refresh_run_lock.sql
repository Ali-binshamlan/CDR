-- =====================================================================
-- DCR — 202608130002_forecast_refresh_run_lock.sql
-- =====================================================================
-- استمرار لإصلاح Disk IO Budget (202608130001 — راجع تعليقه للسياق الكامل:
-- تنبيه Supabase الفعلي 2026-08-13، تقليل تكرار cron jobs غير مسموح، الحل
-- الوحيد تقليل كمية I/O لكل تشغيلة).
--
-- forecast-refresh/route.ts (يُستدعى كل 15-30 دقيقة عبر cron-job.org) كان
-- بلا أي قفل تداخل دورة إطلاقاً — على عكس provider-pull/scheduler-tick/
-- db-cleanup-worker. لو تأخرت دورة (طلبات Open-Meteo خارجية بطيئة تحت حمل)،
-- دورة تالية تبدأ فوقها بلا أي حماية، تضاعف I/O والطلبات الخارجية المتزامنة.
-- نفس نمط provider_pull_run_lock (202608081002) حرفياً — قفل دورة كاملة
-- واحدة بمفتاح PRIMARY KEY على نافذة زمنية 15 دقيقة (أقصر نافذة معلنة
-- لتكرار هذا المسار في تعليق route.ts).
--
-- بالتوازي، أُزيل نمط N+1 استعلام من نفس الملف (SELECT * منفصل على
-- project_dust_profiles وproject_shifts لكل مشروع داخل الحلقة) لصالح
-- استعلامين مُجمَّعين واحدين خارج الحلقة (IN على كل project_ids) — تغيير في
-- route.ts وحده، بلا حاجة لتغيير بنية قاعدة بيانات.
create table if not exists public.forecast_refresh_run_lock (
  run_bucket bigint primary key,
  started_at timestamptz not null default now()
);

create index if not exists idx_forecast_refresh_run_lock_started_at
  on public.forecast_refresh_run_lock (started_at);

alter table public.forecast_refresh_run_lock enable row level security;
-- عمداً بلا أي سياسة RLS — service_role فقط (نفس نمط scheduler_locks/
-- provider_pull_run_lock/scheduler_tick_run_lock).

revoke all on public.forecast_refresh_run_lock from anon, authenticated;

-- تحديث allowlist cleanup_transient_table_batch_by_age (202608110001، آخر
-- تحديث 202608130001) لتشمل الجدول الجديد — db-cleanup-worker/route.ts
-- يضيفه إلى AGE_TARGETS، والدالة ترفض أي اسم جدول غير مُدرَج صراحة هنا.
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
  v_allowed_tables text[] := array[
    'provider_pull_run_lock', 'scheduler_locks', 'forecast_snapshots',
    'db_cleanup_run_lock', 'scheduler_tick_run_lock', 'forecast_refresh_run_lock'
  ];
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
