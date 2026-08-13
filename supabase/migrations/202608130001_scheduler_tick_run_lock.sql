-- =====================================================================
-- DCR — 202608130001_scheduler_tick_run_lock.sql
-- =====================================================================
-- تنبيه فعلي من Supabase (2026-08-13): "Disk IO Budget" لمشروع الإنتاج
-- (jwagoleclwiaavfuxexl) يقترب من النفاد. تقليل تكرار استدعاء cron jobs
-- الخارجية (cron-job.org) غير مسموح به (طلب صريح من المستخدم) — الحل
-- الوحيد المتاح هو تقليل كمية الـI/O التي تستهلكها كل تشغيلة، لا عددها.
--
-- fetch من cron-job.org يستدعي /api/cron/scheduler-tick كل دقيقة واحدة،
-- لكن الدورة الفعلية مصمَّمة لنافذة دقيقتين (SCHEDULER_BUCKET_MS) —
-- تقريباً نصف الاستدعاءات (تلك التي تقع في نفس نافذة الدقيقتين لاستدعاء
-- سابق) كانت تنفّذ SELECT كامل على كل صف في projects (WHERE archived_at
-- IS NULL) ثم تُحاول INSERT تسلسلي لكل مشروع نشط على project_evaluation_
-- jobs فقط لترتطم كلها تقريباً بتعارض unique(project_id, dedupe_key)
-- (23505) وتُهدَر بالكامل — القفل الحالي كان "بعد الحقيقة" (على مستوى كل
-- صف بعد فحص الجدول كله)، لا قفل مبكر يمنع القراءة/الكتابة الهادرة من
-- الأساس.
--
-- الإصلاح: نفس نمط provider_pull_run_lock (202608081002) — قفل دورة كاملة
-- واحدة بمفتاح PRIMARY KEY على نافذة زمنية (نفس SCHEDULER_BUCKET_MS
-- المستخدَمة أصلاً في dedupeKey، لا نافذة جديدة). scheduler-tick/route.ts
-- الآن يحاول INSERT واحد فقط في هذا الجدول أولاً؛ فشل بـ23505 يعني أن
-- تشغيلة أخرى ضمن نفس النافذة عالجت المشاريع بالفعل (أو تعالجها الآن)،
-- فيخرج فوراً بلا أي SELECT على projects وبلا أي محاولة INSERT على
-- project_evaluation_jobs إطلاقاً — يُسقط تقريباً كل الـI/O الهادر من
-- التشغيلات المكررة داخل نفس نافذة الدقيقتين.
create table if not exists public.scheduler_tick_run_lock (
  run_bucket bigint primary key,
  started_at timestamptz not null default now()
);

create index if not exists idx_scheduler_tick_run_lock_started_at
  on public.scheduler_tick_run_lock (started_at);

alter table public.scheduler_tick_run_lock enable row level security;
-- عمداً بلا أي سياسة RLS — service_role فقط (نفس نمط scheduler_locks/
-- provider_pull_run_lock).

revoke all on public.scheduler_tick_run_lock from anon, authenticated;

-- تحديث allowlist الجداول المسموح تنظيفها بالعمر (cleanup_transient_table_
-- batch_by_age، 202608110001) لتشمل الجدول الجديد أعلاه — db-cleanup-worker/
-- route.ts يضيفه إلى AGE_TARGETS، لكن الدالة نفسها ترفض أي اسم جدول غير
-- مُدرَج صراحة هنا (طبقة أمان مقصودة، لا مجرد تفصيل تنفيذي) بصرف النظر عمّا
-- يرسله الكود.
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
    'db_cleanup_run_lock', 'scheduler_tick_run_lock'
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
