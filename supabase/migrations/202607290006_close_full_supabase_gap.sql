-- =====================================================================
-- DCR — 202607290006_close_full_supabase_gap.sql
-- =====================================================================
-- يجمع 4 تعديلات كانت موجودة فقط في full-supabase/ (مجلد قديم غير
-- متتبَّع بـgit) ولم تنتقل بعد إلى مسار supabase/migrations/ الرسمي:
--   1. device_readings_history (جدول كامل) — full-supabase/
--      supabase-add-device-readings-history-migration.sql
--   2. final_decisions (جدول كامل) — full-supabase/
--      supabase-add-final-decisions-migration.sql
--   3. decision_records.final_decision_id — full-supabase/
--      supabase-add-decision-records-final-decision-link-migration.sql
--      (يعتمد على final_decisions أعلاه، لذا يُنشأ بعده هنا)
--   4. أعمدة last_*_at لكل حقل قياس على project_devices — full-supabase/
--      supabase-add-device-per-field-timestamps-migration.sql
--
-- ترتيب الإنشاء هنا: device_readings_history وfinal_decisions أولاً (كلاهما
-- مستقل عن بعضه لكن كلاهما يعتمد على projects/project_devices/
-- project_dust_profiles الموجودة منذ 202607290001)، ثم عمود
-- decision_records.final_decision_id (يعتمد على final_decisions)، ثم
-- أعمدة project_devices الجديدة (مستقلة، تعديل ALTER بسيط).
-- =====================================================================


-- =====================================================================
-- 1) device_readings_history — سجل تاريخي append-only لكل قراءات الجهاز
--    (create table نُقل إلى 202607290005 — يجب أن يوجد الجدول قبل أن
--    يعدّله ALTER هناك؛ هنا نكمل الفهارس/RLS/trigger فقط)
-- =====================================================================
create index if not exists idx_device_readings_history_device_time
  on public.device_readings_history (device_id, recorded_at desc);

create index if not exists idx_device_readings_history_project_time
  on public.device_readings_history (project_id, recorded_at desc);

alter table public.device_readings_history enable row level security;

drop trigger if exists device_readings_history_immutable on public.device_readings_history;
create trigger device_readings_history_immutable
  before update or delete on public.device_readings_history
  for each row execute function public.forbid_evidence_mutation();

revoke all on public.device_readings_history from anon, authenticated;


-- =====================================================================
-- 2) final_decisions — لقطة واحدة موثوقة لكل قرار نهائي (decideFinal)
-- =====================================================================
create table if not exists public.final_decisions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  activity_group_id text not null,
  dust_profile_id uuid references public.project_dust_profiles(id) on delete set null,

  mode text not null check (mode in ('LIVE_OPERATIONAL', 'PLANNING')),
  operational_decision text not null check (operational_decision in (
    'ALLOW', 'MONITOR', 'RESTRICT', 'HOLD_FOR_VERIFICATION', 'PROTECTIVE_STOP', 'MANDATORY_STOP'
  )),
  regulatory_finding text not null check (regulatory_finding in (
    'COMPLIANT', 'PENDING_CONFIRMATION', 'NON_COMPLIANT', 'NOT_DETERMINABLE'
  )),
  mandatory_stop boolean not null,
  overridable boolean not null,
  short_reason_ar text not null,
  decision_label_ar text not null,
  level text not null check (level in ('GREEN', 'YELLOW', 'ORANGE', 'RED', 'DARK_RED', 'BLACK')),
  pending_confirmation boolean not null,
  reason_codes text[] not null default '{}',
  evidence_quality text not null check (evidence_quality in ('OK', 'PARTIAL', 'STALE', 'UNAVAILABLE')),
  rule_bundle_version text not null,

  evaluated_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_final_decisions_activity_group_time
  on public.final_decisions (activity_group_id, created_at desc);

create index if not exists idx_final_decisions_project_time
  on public.final_decisions (project_id, created_at desc);

alter table public.final_decisions enable row level security;

drop trigger if exists final_decisions_immutable on public.final_decisions;
create trigger final_decisions_immutable
  before update or delete on public.final_decisions
  for each row execute function public.forbid_evidence_mutation();

revoke all on public.final_decisions from anon, authenticated;


-- =====================================================================
-- 3) decision_records.final_decision_id — ربط قرار المستخدم بالقرار
--    الآلي (final_decisions) الذي كان معروضاً له لحظة اتخاذ القرار
-- =====================================================================
alter table public.decision_records
  add column if not exists final_decision_id uuid references public.final_decisions(id) on delete set null;

create index if not exists idx_decision_records_final_decision_id
  on public.decision_records (final_decision_id);


-- =====================================================================
-- 4) project_devices — أعمدة timestamp منفصلة لكل حقل قياس (بخلاف
--    last_reading_at العام، ولا last_pm10_at وحده)
-- =====================================================================
alter table public.project_devices
  add column if not exists last_wind_speed_at timestamptz,
  add column if not exists last_wind_gust_at timestamptz,
  add column if not exists last_wind_direction_at timestamptz,
  add column if not exists last_visibility_at timestamptz,
  add column if not exists last_relative_humidity_at timestamptz,
  add column if not exists last_temperature_at timestamptz;

update public.project_devices
  set last_wind_speed_at = last_reading_at
  where last_wind_speed_kmh is not null and last_wind_speed_at is null;

update public.project_devices
  set last_wind_gust_at = last_reading_at
  where last_wind_gust_kmh is not null and last_wind_gust_at is null;

update public.project_devices
  set last_wind_direction_at = last_reading_at
  where last_wind_direction_deg is not null and last_wind_direction_at is null;

update public.project_devices
  set last_visibility_at = last_reading_at
  where last_visibility_m is not null and last_visibility_at is null;

update public.project_devices
  set last_relative_humidity_at = last_reading_at
  where last_relative_humidity_percent is not null and last_relative_humidity_at is null;

update public.project_devices
  set last_temperature_at = last_reading_at
  where last_temperature_c is not null and last_temperature_at is null;


-- =====================================================================
-- نهاية — تحقق سريع بعد التنفيذ:
--   select table_name from information_schema.tables
--   where table_schema = 'public' and table_name in
--   ('device_readings_history', 'final_decisions');
-- يجب أن يُرجع الصفّين. وتحقق الأعمدة:
--   select column_name from information_schema.columns
--   where table_name = 'decision_records' and column_name = 'final_decision_id';
--   select column_name from information_schema.columns
--   where table_name = 'project_devices' and column_name like 'last_%_at';
-- =====================================================================
