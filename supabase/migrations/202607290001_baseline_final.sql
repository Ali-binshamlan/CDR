-- =====================================================================
-- DCR — 202607290001_baseline_final.sql
-- =====================================================================
-- ⚠ مسودة غير مُختبرة على بيئة Supabase فعلية (local CLI أو staging) —
-- بُنيت بمراجعة يدوية كاملة لكود الـSQL فقط، بلا تشغيل فعلي. راجع القسم
-- الأخير من هذا الملف ("اختبارات مطلوبة قبل الاعتماد") قبل استخدامها على
-- أي قاعدة إنتاج.
--
-- خطأ معماري مكتشَف ومُصلَح (مراجعة كود خبير خارجي — "ملف Full Schema ليس
-- Baseline نهائية"): supabase-dcr-full-schema.sql (الملف القديم، جذر
-- المشروع) كان يُفتَرض أنه المرجع الكامل والحالي لقاعدة البيانات، لكنه
-- تبيّن عند التدقيق أنه غير موثوق به كأساس تنفيذي إطلاقاً:
--   • ناقص أعمدة/جداول أضافتها هجرات لاحقة (account_role→user_authorizations،
--     pending_resume_since، last_pm10_at، last_relative_humidity_percent/
--     last_temperature_c، device_id على project_dust_profiles/pm10_readings_
--     history، deciding_rule_code/stop_cause، viewer_message، archived_at/
--     archived_by، جداول pm10_readings_history/weather_forecasts/
--     user_authorizations/alert_state_events بالكامل، وكل triggers append-only).
--   • بل ويحتوي أعمدة كان المفروض تُحذف نهائياً بهجرة أقدم منه تاريخياً
--     (monitoring_station_count/monitoring_station_locations على projects،
--     ودمج is_super_admin ضمن profiles بدل user_authorizations المنفصل).
--   • ويحمل قيوداً/FK actions قديمة عولجت لاحقاً كأخطاء حقيقية (dust_profile_id
--     كان not null + on delete cascade، صُحِّح إلى nullable + on delete set
--     null لأن الـcascade كان يصطدم بـtrigger append-only ويُفشل حذف النشاط).
--
-- هذا الملف بديل كامل من الصفر يبني الحالة النهائية الصحيحة مباشرة من
-- الـ21 ملف migration الفردي بترتيبها الزمني/الاعتمادي الصحيح (موثَّق في
-- التعليقات أدناه لكل جدول)، متجاهلاً محتوى الملف القديم تماماً كمرجع
-- تنفيذي (يبقى فقط توثيقاً تاريخياً). الملفات القديمة (supabase-*.sql في
-- جذر المشروع) لم تُحذف ولم تُعدَّل — تبقى كسجل تاريخي حتى يُعتمَد هذا
-- المسار الجديد فعلياً بعد الاختبار.
--
-- الاستخدام: نفّذه أولاً على قاعدة فارغة تماماً (مشروع Supabase جديد)، ثم
-- 202607290002_security_hardening.sql، ثم 202607290003_sensor_events.sql،
-- ثم 202607290004_append_only_audit.sql — بهذا الترتيب حصراً (كل ملف يعتمد
-- على وجود جداول/أعمدة من الملف الذي قبله).
-- =====================================================================

create extension if not exists pgcrypto;


-- =====================================================================
-- 1) profiles — ملف تعريف المستخدم فوق auth.users
-- =====================================================================
-- ملاحظة: account_role/is_super_admin لا يظهران هنا على profiles إطلاقاً
-- — نُقلا نهائياً إلى user_authorizations (جدول منفصل، راجع
-- 202607290002_security_hardening.sql) بعد إغلاق ثغرة ترقية صلاحيات ذاتية
-- (supabase-add-user-authorizations-table-migration.sql). is_super_admin
-- كان موجوداً في full-schema القديم كعمود على profiles؛ هذا الباسلاين
-- يبني الحالة النهائية الصحيحة مباشرة (بلا العمود هنا أصلاً) بدل إنشائه
-- ثم حذفه في ملف لاحق.
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  company_name text,
  username text unique,
  phone_number text,
  role text,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- سياسات profiles النهائية (بعد 202607290002) تُنشأ في ذلك الملف — لا
-- سياسة "for all" هنا لتفادي إنشاء ثم حذف سياسة وسيطة غير آمنة.


-- =====================================================================
-- 2) projects — المشروع الأساسي + ملف امتثال الغبار التنظيمي الكامل
-- =====================================================================
-- monitoring_station_count/monitoring_station_locations لا يظهران هنا —
-- استُبدلا نهائياً بصفوف project_devices الحقيقية (راجع
-- supabase-backfill-monitoring-stations-to-devices-migration.sql +
-- supabase-drop-monitoring-station-columns-migration.sql). true_north_
-- alignment_documented من supabase-add-pm10-sustained-rules-migration.sql.
-- archived_at/archived_by من 202607290004 يُضافان هناك (تعتمد على منطق
-- الأرشفة append-only)، لا هنا.
create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,

  name text not null,
  client_name text,
  city text,
  neighborhood text,
  project_status text not null default 'not_started',
  project_type text,
  site_nature text,
  soil_type text,

  latitude numeric,
  longitude numeric,
  coordinates text,
  zone_type text,
  zone_polygon jsonb,
  zone_radius_m numeric,

  site_location_nature text,
  wind_exposure text default 'medium',
  terrain_type text default 'suburban',

  start_date date,
  end_date date,
  work_days text,
  work_days_list jsonb default '[]'::jsonb,
  work_hours_start time,
  work_hours_end time,
  project_manager text,
  contact_number text,

  site_area_m2 numeric,
  daily_truck_movements integer,
  has_onsite_crusher boolean,
  has_onsite_batching_plant boolean,
  dmp_approval_status text default 'UNKNOWN',
  dmp_submitted_at timestamptz,
  dmp_approved_at timestamptz,
  baseline_monitoring_days integer,
  monitoring_logging_interval_minutes integer,
  anemometer_height_m numeric,
  entry_exit_cameras_installed boolean,
  camera_retention_days integer,
  sensitivity_map_prepared boolean,

  -- true north: يوثّق ما إذا كانت محطة الرصد معايَرة على الشمال الحقيقي —
  -- supabase-add-pm10-sustained-rules-migration.sql
  true_north_alignment_documented boolean,

  data_accuracy_confirmed boolean default false,
  data_accuracy_confirmed_at timestamptz,

  created_at timestamptz not null default now()
);

create index if not exists idx_projects_user_id on public.projects (user_id);

alter table public.projects enable row level security;

drop policy if exists "projects_owner_all" on public.projects;
create policy "projects_owner_all"
  on public.projects for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);


-- =====================================================================
-- 3) project_shifts — ورديات عمل حقيقية (اختياري) لكل مشروع
-- =====================================================================
create table if not exists public.project_shifts (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  name text not null,
  start_time time not null,
  end_time time not null,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists idx_project_shifts_project_id on public.project_shifts (project_id);

alter table public.project_shifts enable row level security;

drop policy if exists "project_shifts_owner_all" on public.project_shifts;
create policy "project_shifts_owner_all"
  on public.project_shifts for all
  to authenticated
  using (
    exists (
      select 1 from public.projects
      where projects.id = project_shifts.project_id
        and projects.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.projects
      where projects.id = project_shifts.project_id
        and projects.user_id = auth.uid()
    )
  );


-- =====================================================================
-- 4) project_devices — أجهزة رصد فعلية (يجب أن يسبق project_dust_profiles
--    وpm10_readings_history، كلاهما يشير إليه بـ FK)
-- =====================================================================
-- supabase-add-project-devices-migration.sql + supabase-add-device-
-- humidity-temperature-migration.sql + supabase-add-device-last-pm10-at-
-- migration.sql مدموجة هنا كحالة نهائية واحدة.
create table if not exists public.project_devices (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,

  name text not null,
  lat numeric,
  lng numeric,

  api_key_hash text not null,
  api_key_prefix text not null,
  is_active boolean not null default true,

  last_reading_at timestamptz,
  last_wind_speed_kmh numeric,
  last_wind_gust_kmh numeric,
  last_wind_direction_deg numeric,
  last_pm10 numeric,
  last_pm25 numeric,
  last_visibility_m numeric,
  last_relative_humidity_percent numeric,
  last_temperature_c numeric,
  -- حداثة PM10 تحديداً، مستقلة عن last_reading_at العام (لا تتحدّث بمجرد
  -- push جزئي لحقل آخر) — supabase-add-device-last-pm10-at-migration.sql
  last_pm10_at timestamptz,

  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create index if not exists idx_project_devices_project_id on public.project_devices (project_id);
create unique index if not exists idx_project_devices_api_key_hash on public.project_devices (api_key_hash);

alter table public.project_devices enable row level security;

-- سياسة RLS النهائية: لا سياسة أصلاً (REVOKE ALL) — راجع
-- 202607290002_security_hardening.sql. لا تُنشأ project_devices_owner_all
-- هنا لتفادي إنشاء ثم حذف سياسة وسيطة.


-- =====================================================================
-- 5) project_dust_profiles — أكبر جدول: صف واحد لكل نشاط غبار/امتثال
-- =====================================================================
-- device_id من supabase-add-dust-profile-device-id-migration.sql مدموج
-- هنا مباشرة (يعتمد على project_devices أعلاه).
create table if not exists public.project_dust_profiles (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  activity_group_id text,
  shift_id uuid references public.project_shifts(id) on delete set null,
  -- محطة الرصد المرتبطة بهذا النشاط تحديداً — supabase-add-dust-profile-
  -- device-id-migration.sql. on delete set null (لا cascade): حذف جهاز
  -- لاحقاً لا يحذف صفوف أنشطة تاريخية مرتبطة به.
  device_id uuid references public.project_devices(id) on delete set null,

  activity_type text not null,
  activity_lat numeric,
  activity_lng numeric,
  planned_date date,
  planned_time time,
  duration_hours numeric,

  has_earthworks boolean,
  internal_dirt_roads boolean,
  heavy_equipment_movement boolean,
  loose_materials boolean,
  large_exposed_area boolean,
  dry_surface boolean,
  surface_wet boolean,
  watering_available boolean,
  stockpiles_covered boolean,
  speed_limit_applied boolean,
  wheel_wash_available boolean,
  dust_screens_available boolean,
  field_monitoring_available boolean,
  receptor_type text,
  receptor_distance text,
  receptor_is_downwind boolean,
  visible_dust_plume_reported boolean,
  open_concrete_pour boolean,
  onsite_visibility_m numeric,
  onsite_pm10 numeric,
  onsite_pm25 numeric,

  aei_score numeric,
  aei_status text,

  regulatory_activity text default 'OTHER',
  is_dust_generating boolean default true,
  is_enclosed_operation boolean default false,
  is_active_or_planned boolean default true,
  dust_suppression_system_operational boolean,
  continuous_misting boolean,
  spray_cannon_available boolean,
  dust_screens_available_compliance boolean,
  wet_cutting_active boolean,
  hepa_extraction_active boolean,
  wheel_wash_operational boolean,
  hourly_inspection_recorded boolean,
  speed_control_applied boolean,
  load_covered boolean,
  conveyors_enclosed boolean,
  fogging_available boolean,
  idle_surface_stabilized boolean,
  demolition_active_area_m2 numeric,
  crusher_distance_to_receptor_m numeric,
  stockpile_batching_distance_to_receptor_m numeric,
  stockpile_height_m numeric,
  drop_height_m numeric,
  idle_days numeric,
  spill_cleanup_minutes numeric,
  unpaved_speed_kmh numeric,
  paved_speed_kmh numeric,
  visible_trackout_beyond_15m boolean,

  surface_watered boolean,
  exposed_soil_area_m2 numeric,
  truck_routes_designated boolean,
  path_cover_material text,
  water_spray_method text,
  soil_compacted_after_excavation boolean,
  stabilizer_used_during_pause boolean,
  pause_duration_over_5_days boolean,
  spray_used_during_soil_unloading boolean,
  work_area_phased boolean,

  unpaved_roads_watered_daily boolean,
  dust_control_method text,
  speed_limit_signs_posted boolean,
  containers_covered_before_moving boolean,
  containers_inspected_before_departure boolean,
  load_height_exceeds_container_limit boolean,
  adjacent_roads_swept_mechanically boolean,
  sweep_frequency_band text,
  wheel_wash_at_exit boolean,
  wheel_wash_maintained_regularly boolean,
  wash_water_recycled boolean,
  all_loads_covered boolean,
  trucks_inspected_before_departure boolean,
  load_side_coverage_adequate boolean,
  public_roads_vacuum_swept_daily boolean,
  water_used_routinely_for_cleaning boolean,

  entry_point_lat numeric,
  entry_point_lng numeric,
  exit_point_lat numeric,
  exit_point_lng numeric,
  access_road_paved boolean,
  tire_cleaning_method text,
  sand_trap_present boolean,
  oil_separator_present boolean,
  wash_cycle_duration_adequate boolean,
  wheel_wash_operation_method text,
  wash_water_reused boolean,
  anti_slip_mesh_present boolean,
  immersion_zone_length_adequate boolean,
  collection_basin_present boolean,
  truck_path_cleaned_within_15_min boolean,
  water_traces_beyond_15m_from_gate boolean,

  idle_surface_cover_intact boolean,
  exposed_area_currently_idle boolean,
  stabilization_method text,
  stockpile_area_exists boolean,
  suppressant_used_at_stockpile_area boolean,
  wind_barriers_near_stockpiles boolean,
  construction_scheduled_immediately_after_prep boolean,

  stockpile_lat numeric,
  stockpile_lng numeric,
  centralized_storage boolean,
  distributed_across_multiple_locations boolean,
  sprayed_immediately_after_unloading boolean,
  full_submersion_of_piles boolean,
  stockpile_shape_low_rounded boolean,
  unused_piles_covered_daily boolean,
  cement_in_sealed_silos boolean,
  silos_have_pm10_filters boolean,
  piles_behind_wind_barriers boolean,
  conveyors_use_auto_spray boolean,
  wind_barriers_aligned_with_prevailing_wind boolean,
  barrier_distance_ratio_compliant boolean,

  batching_lat numeric,
  batching_lng numeric,
  silos_sealed boolean,
  pm10_filter_efficiency_percent numeric,
  leak_detected boolean,
  dry_cleaning_method_used boolean,

  filter_maintenance_performed_regularly boolean,
  leak_prevention_inspected_regularly boolean,
  suppression_system_checked_daily boolean,
  manual_dry_sweeping_banned boolean,
  compressed_air_banned boolean,
  site_cleaning_method text,
  waste_humidity_maintained_during_transport boolean,
  waste_loads_covered boolean,

  spray_cannon_range_band text,
  crushers_covered_demolition boolean,
  loading_points_have_sprinklers boolean,
  demolition_cutting_method text,
  sandblasting_used boolean,
  sandblasting_in_enclosed_box boolean,

  crusher_lat numeric,
  crusher_lng numeric,
  crusher_units_fully_covered boolean,
  loading_points_have_spray_systems boolean,
  spray_cannons_around_crusher boolean,
  conveyors_covered_crusher boolean,
  drop_height_reduced_at_crusher boolean,
  suction_and_filtration_systems_present boolean,
  critical_schedule_applies boolean,

  cutting_residues_cleaned_after_completion boolean,

  debris_sprayed_before_loading boolean,
  central_storage_area boolean,
  small_piles_dispersed_multiple_locations boolean,
  daily_removal boolean,
  covered_if_not_removed_daily boolean,
  debris_compacted boolean,
  only_active_section_sprayed boolean,
  load_exceeds_capacity boolean,
  debris_pile_height_m numeric,

  created_at timestamptz not null default now()
);

create index if not exists idx_project_dust_profiles_project_id on public.project_dust_profiles (project_id);
create index if not exists idx_project_dust_profiles_activity_group on public.project_dust_profiles (activity_group_id);
create index if not exists idx_project_dust_profiles_shift_id on public.project_dust_profiles (shift_id);

alter table public.project_dust_profiles enable row level security;

drop policy if exists "project_dust_profiles_owner_all" on public.project_dust_profiles;
create policy "project_dust_profiles_owner_all"
  on public.project_dust_profiles for all
  to authenticated
  using (
    exists (
      select 1 from public.projects
      where projects.id = project_dust_profiles.project_id
        and projects.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.projects
      where projects.id = project_dust_profiles.project_id
        and projects.user_id = auth.uid()
    )
  );


-- =====================================================================
-- 6) dust_evaluations / current_dust_decisions — محرك DVI الفيزيائي
-- =====================================================================
-- dust_profile_id: nullable + on delete set null منذ الإنشاء (لا cascade)
-- — الحالة النهائية الصحيحة بعد supabase-fix-evidence-cascade-delete-
-- migration.sql. كان full-schema القديم يجعله not null + on delete cascade
-- (خطأ يُفشل حذف النشاط بعد تطبيق append-only في 202607290004).
create table if not exists public.dust_evaluations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  dust_profile_id uuid references public.project_dust_profiles(id) on delete set null,
  activity_group_id text,
  result jsonb not null,
  triggered_by text not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_dust_evaluations_project_id on public.dust_evaluations (project_id);
create index if not exists idx_dust_evaluations_profile on public.dust_evaluations (dust_profile_id, created_at desc);

create table if not exists public.current_dust_decisions (
  activity_group_id text primary key,
  project_id uuid not null references public.projects(id) on delete cascade,
  latest_evaluation_id uuid not null references public.dust_evaluations(id),
  decision text not null,
  triggered_rules jsonb not null default '[]'::jsonb,
  short_reason text,
  updated_at timestamptz not null default now()
);
create index if not exists idx_current_dust_decisions_project_id on public.current_dust_decisions (project_id);

alter table public.dust_evaluations enable row level security;
alter table public.current_dust_decisions enable row level security;


-- =====================================================================
-- 7) dust_compliance_evaluations / current_dust_compliance_decisions —
--    طبقة الامتثال التنظيمي
-- =====================================================================
-- dust_profile_id: nullable + on delete set null (نفس تصحيح dust_evaluations
-- أعلاه). stopped_since/pending_resume_since/deciding_rule_code/stop_cause
-- مدموجة مباشرة كحالة نهائية (supabase-add-compliance-stopped-since-
-- migration.sql + supabase-add-compliance-pending-resume-since-migration.sql
-- + supabase-add-deciding-rule-code-migration.sql).
create table if not exists public.dust_compliance_evaluations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  dust_profile_id uuid references public.project_dust_profiles(id) on delete set null,
  activity_group_id text,
  result jsonb not null,
  rulebook_version text not null,
  triggered_by text not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_dust_compliance_evaluations_project_id on public.dust_compliance_evaluations (project_id);
create index if not exists idx_dust_compliance_evaluations_profile on public.dust_compliance_evaluations (dust_profile_id, created_at desc);

create table if not exists public.current_dust_compliance_decisions (
  activity_group_id text primary key,
  project_id uuid not null references public.projects(id) on delete cascade,
  latest_evaluation_id uuid not null references public.dust_compliance_evaluations(id),
  decision text not null,
  triggered_rules jsonb not null default '[]'::jsonb,
  short_reason text,
  updated_at timestamptz not null default now(),
  -- منذ متى بدأ آخر إيقاف مستمر — supabase-add-compliance-stopped-since-migration.sql
  stopped_since timestamptz,
  -- منذ متى أصبحت القراءة جيدة فعلياً (عداد استئناف 10 دقائق) —
  -- supabase-add-compliance-pending-resume-since-migration.sql
  pending_resume_since timestamptz,
  -- كود القاعدة الفعلية الفائزة + وصفها العربي المختصر —
  -- supabase-add-deciding-rule-code-migration.sql
  deciding_rule_code text,
  stop_cause text
);
create index if not exists idx_current_dust_compliance_decisions_project_id on public.current_dust_compliance_decisions (project_id);

alter table public.dust_compliance_evaluations enable row level security;
alter table public.current_dust_compliance_decisions enable row level security;


-- =====================================================================
-- 8) pm10_readings_history — سجل أدلة ميداني (device/manual فقط)
-- =====================================================================
-- الحالة النهائية بعد supabase-add-pm10-sustained-rules-migration.sql
-- (إنشاء) + supabase-add-openmeteo-pm10-history-source-migration.sql
-- (توسيع مؤقت لـsource ليشمل 'open-meteo') + supabase-add-weather-
-- forecasts-table-migration.sql (فصل open-meteo إلى جدول منفصل، وإرجاع
-- القيد لـ('device','manual') فقط — الحالة النهائية هنا) +
-- supabase-fix-pm10-history-nullable-activity-group-migration.sql
-- (activity_group_id nullable — قراءات مستوى المشروع بلا نشاط محدد) +
-- supabase-add-pm10-history-device-id-migration.sql (device_id، يعتمد
-- على project_devices أعلاه).
create table if not exists public.pm10_readings_history (
  id uuid primary key default gen_random_uuid(),
  activity_group_id text,
  project_id uuid not null references public.projects(id) on delete cascade,
  -- الجهاز الذي أرسل هذه القراءة تحديداً (nullable — قراءات manual لا تخص
  -- جهازاً) — يمنع دمج قراءات أجهزة متعددة بالمشروع معاً عند حساب استمرار
  -- PM10 الزمني لنشاط مرتبط بجهاز واحد محدد.
  device_id uuid references public.project_devices(id) on delete set null,
  pm10_ug_m3 numeric not null,
  source text not null check (source in ('device', 'manual')),
  recorded_at timestamptz not null default now()
);

create index if not exists idx_pm10_readings_history_group_time
  on public.pm10_readings_history (activity_group_id, recorded_at desc);
create index if not exists idx_pm10_readings_history_device_time
  on public.pm10_readings_history (device_id, recorded_at desc);

alter table public.pm10_readings_history enable row level security;


-- =====================================================================
-- 9) weather_forecasts — توقعات Open-Meteo (منفصلة عن سجل الأدلة الميداني)
-- =====================================================================
-- supabase-add-weather-forecasts-table-migration.sql. evidence_eligible
-- ثابتة false دائماً — توقّع للتخطيط/التحذير الاستباقي فقط، لا يُستخدَم
-- دليلاً لإثبات استمرار مخالفة.
create table if not exists public.weather_forecasts (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  activity_group_id text,
  provider text not null default 'open-meteo',
  fetched_at timestamptz not null default now(),
  forecast_valid_at timestamptz not null,
  pm10_ug_m3 numeric,
  evidence_eligible boolean not null default false
);

create index if not exists idx_weather_forecasts_group_time
  on public.weather_forecasts (activity_group_id, forecast_valid_at desc);
create index if not exists idx_weather_forecasts_project_time
  on public.weather_forecasts (project_id, forecast_valid_at desc);

alter table public.weather_forecasts enable row level security;


-- =====================================================================
-- 10) sensitive_receptors — مستقبِلات حساسة (مدارس/مستشفيات/سكني/مساجد)
-- =====================================================================
create table if not exists public.sensitive_receptors (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  receptor_type text not null default 'OTHER',
  lat numeric not null,
  lng numeric not null,
  created_at timestamptz not null default now()
);

alter table public.sensitive_receptors enable row level security;


-- =====================================================================
-- 11) alerts — تنبيهات مولَّدة تلقائياً (قبل/أثناء التنفيذ)
-- =====================================================================
-- viewer_message من supabase-add-alerts-viewer-message-migration.sql
-- مدموج هنا كحالة نهائية.
create table if not exists public.alerts (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  activity_source text not null default 'dust' check (activity_source = 'dust'),
  activity_id text not null,
  timing text not null,
  kind text not null,
  state text not null default 'NEW',
  message text not null,
  -- رسالة رسمية بديلة لجهة الرصد (account_role='viewer') — تُملأ فقط
  -- لتنبيهات COMPLIANCE_VIOLATION، null لأي نوع آخر.
  viewer_message text,
  metric_label text,
  metric_actual text,
  metric_threshold text,
  recommended_action text,
  assignee text,
  created_at timestamptz not null default now()
);

create index if not exists idx_alerts_project_id on public.alerts (project_id);
create index if not exists idx_alerts_project_state on public.alerts (project_id, state);
create index if not exists idx_alerts_source_activity on public.alerts (activity_source, activity_id);

alter table public.alerts enable row level security;

drop policy if exists "alerts_owner_all" on public.alerts;
create policy "alerts_owner_all"
  on public.alerts for all
  to authenticated
  using (
    exists (
      select 1 from public.projects
      where projects.id = alerts.project_id
        and projects.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.projects
      where projects.id = alerts.project_id
        and projects.user_id = auth.uid()
    )
  );
-- ملاحظة: سياسة for all أعلاه تُقيَّد لاحقاً في 202607290004 (منع UPDATE
-- مباشر على العمود state — يصبح مشتقاً من alert_state_events فقط) — لا
-- تعارض، فقط REVOKE إضافي على عمود واحد فوق هذه السياسة.


-- =====================================================================
-- 12) decision_records — قرارات موثَّقة يدوياً (اعتماد/تأجيل/تقييد/إيقاف)
-- =====================================================================
create table if not exists public.decision_records (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  activity_source text not null default 'dust' check (activity_source = 'dust'),
  activity_id text not null,
  status text not null,
  reason text,
  required_action text,
  approved_by text,
  approval_note text,
  weather_snapshot jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_decision_records_project_id on public.decision_records (project_id);
create index if not exists idx_decision_records_source_activity on public.decision_records (activity_source, activity_id);

alter table public.decision_records enable row level security;

drop policy if exists "decision_records_owner_all" on public.decision_records;
create policy "decision_records_owner_all"
  on public.decision_records for all
  to authenticated
  using (
    exists (
      select 1 from public.projects
      where projects.id = decision_records.project_id
        and projects.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.projects
      where projects.id = decision_records.project_id
        and projects.user_id = auth.uid()
    )
  );


-- =====================================================================
-- 13) admin_audit_log — سجل تدقيق لعمليات سوبر أدمن على مشروع لا يملكه
-- =====================================================================
create table if not exists public.admin_audit_log (
  id uuid primary key default gen_random_uuid(),
  admin_user_id uuid not null references auth.users(id),
  action text not null,
  target_project_id uuid,
  target_project_name text,
  target_owner_user_id uuid,
  details jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_admin_audit_log_admin on public.admin_audit_log (admin_user_id);

alter table public.admin_audit_log enable row level security;
-- عمداً بلا أي سياسة RLS — service_role فقط.


-- =====================================================================
-- نهاية الباسلاين — تحقق سريع بعد التنفيذ:
--   select table_name from information_schema.tables
--   where table_schema = 'public' order by table_name;
-- يجب أن يُرجع 15 جدولاً: admin_audit_log, alerts,
-- current_dust_compliance_decisions, current_dust_decisions,
-- decision_records, dust_compliance_evaluations, dust_evaluations,
-- pm10_readings_history, profiles, project_devices, project_dust_profiles,
-- project_shifts, projects, sensitive_receptors, weather_forecasts
--
-- (user_authorizations وalert_state_events يُضافان لاحقاً في
-- 202607290002/202607290004 على التوالي — ليسا جزءاً من هذا الباسلاين)
-- =====================================================================
