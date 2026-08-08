-- =====================================================================
-- DCR (مرقاب) — merged_schema_final.sql
-- =====================================================================
-- ⚠ هذا ملف SQL مدموج واحد يمثّل الحالة النهائية الكاملة لقاعدة بيانات
-- نظام "مرقاب" (DCR) — نظام امتثال تنظيمي لمراقبة الغبار — بعد دمج الـ62
-- ملف هجرة (migration) الموجودة في supabase/migrations/ بترتيبها الزمني
-- (من 202607290001_baseline_final.sql حتى
-- 202608080002_allow_retention_delete_on_evidence_tables.sql)، بتاريخ
-- 2026-08-08.
--
-- طريقة البناء: مراجعة يدوية دقيقة لكل سطر في كل ملف من الـ62، بلا أي
-- تشغيل SQL فعلي (لا يوجد Docker/قاعدة بيانات محلية متاحة في بيئة هذا
-- العمل) — استخراج/تجميع نصي بحت. لكل جدول/دالة/trigger تتبّعنا كل تعديل
-- تراكمي عبر كل الملفات وأخذنا **آخر نسخة نهائية فقط** (مثال: عمود أُضيف
-- في ملف ثم عُدِّل نوعه أو أُعيد استخدامه لاحقاً → يظهر هنا مباشرة بحالته
-- النهائية ضمن CREATE TABLE، لا كسلسلة ALTER منفصلة؛ دالة عُدِّلت 6 مرات
-- عبر create or replace → تظهر هنا بآخر نسخة فقط).
--
-- ⚠ يُنصَح بشدة بتشغيل هذا الملف على بيئة اختبار (مشروع Supabase تجريبي
-- فارغ تماماً) والتحقق من نجاحه بالكامل، ومقارنة مخطط الناتج بمخطط قاعدة
-- مبنية من الـ62 ملف الأصلية (schema diff)، قبل اعتماده على أي قاعدة
-- إنتاج حقيقية. لم يُشغَّل هذا الملف فعلياً على أي قاعدة بيانات من هذه
-- الجلسة.
--
-- ترتيب هذا الملف: (1) الامتدادات، (2) الجداول بترتيب يحترم foreign keys،
-- (3) الفهارس، (4) RLS enable + policies، (5) الدوال/RPCs، (6) الـtriggers،
-- (7) GRANT/REVOKE النهائية، (8) بيانات أولية (seed)، (9) Default
-- Privileges على مستوى المخطط، (10) ملاحظات تحقق ما بعد التشغيل.
--
-- التعليقات العربية المهمة (أسباب معمارية/أمنية، أخطاء اكتُشفت وأُصلحت)
-- من الملفات الأصلية أُبقيت أو لُخِّصت هنا عند كل كائن — هي توثيق حي
-- لقرارات تصميم حقيقية اتُّخذت عبر مراجعات كود متتالية لهذا المشروع.
-- =====================================================================

create extension if not exists pgcrypto;


-- =====================================================================
-- ============================ 1) الجداول ==============================
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1.1) profiles — ملف تعريف المستخدم فوق auth.users
-- ---------------------------------------------------------------------
-- account_role/is_super_admin لا يظهران هنا إطلاقاً — نُقلا نهائياً إلى
-- user_authorizations (جدول منفصل تماماً) بعد إغلاق ثغرة أمنية حرجة:
-- ترقية صلاحيات ذاتية (مستخدم يقدر يرفع نفسه Super Admin عبر تعديل صف
-- profiles الخاص به مباشرة من المتصفح، لو كان العمود موجوداً هنا وقابلاً
-- للتحديث الذاتي).
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  company_name text,
  username text unique,
  phone_number text,
  role text,
  created_at timestamptz not null default now()
);


-- ---------------------------------------------------------------------
-- 1.2) user_authorizations — صلاحيات is_super_admin/account_role، معزولة
--      تماماً عن profiles، بلا أي منح افتراضي لـanon/authenticated
-- ---------------------------------------------------------------------
create table if not exists public.user_authorizations (
  user_id uuid primary key references auth.users(id) on delete cascade,
  is_super_admin boolean not null default false,
  account_role text not null default 'user'
    check (account_role in ('user', 'viewer')),
  updated_at timestamptz not null default now()
);


-- ---------------------------------------------------------------------
-- 1.3) projects — المشروع الأساسي + ملف امتثال الغبار التنظيمي الكامل
-- ---------------------------------------------------------------------
-- monitoring_station_count/monitoring_station_locations لا يظهران هنا —
-- استُبدلا نهائياً بصفوف project_devices الحقيقية. archived_at/archived_by
-- (202607290004) مدموجان هنا مباشرة كحالة نهائية — يفعّلان الأرشفة بدل
-- الحذف الفعلي للمشروع (خطأ أمني مُصلَح: DELETE كان يحذف فعلياً
-- alerts/decision_records/dust_evaluations المرتبطة، يمحو دليل مخالفة
-- تنظيمية موثَّقة بضغطة واحدة بلا أي أثر تدقيق).
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

  -- يوثّق ما إذا كانت محطة الرصد (على مستوى المشروع، النسخة القديمة —
  -- الحالة النهائية الفعلية للمعايرة أصبحت لكل جهاز على حدة، راجع
  -- project_devices.true_north_alignment_documented أدناه) معايَرة على
  -- الشمال الحقيقي. العمود هنا لم يُحذف (قد تعتمد عليه صفوف/مسارات قديمة)
  -- لكن لم يعد يُقرأ من أي مسار قرار حي بعد 202608060001.
  true_north_alignment_documented boolean,

  data_accuracy_confirmed boolean default false,
  data_accuracy_confirmed_at timestamptz,

  created_at timestamptz not null default now(),

  -- أرشفة بدل حذف فعلي (202607290004) — المشروع لا يُحذف أبداً، فقط يُؤرشف.
  archived_at timestamptz,
  archived_by uuid references auth.users(id)
);


-- ---------------------------------------------------------------------
-- 1.4) project_shifts — ورديات عمل حقيقية (اختياري) لكل مشروع
-- ---------------------------------------------------------------------
create table if not exists public.project_shifts (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  name text not null,
  start_time time not null,
  end_time time not null,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),

  -- مفتاح فريد مركّب (id, project_id) — هدف FK مركّب صالح لجداول تابعة
  -- (project_dust_profiles) تفرض عزلاً بين المشاريع على مستوى القاعدة
  -- (202608040019/20 — القسم 18.5 "Current Pointer: Device/Shift في
  -- مشروع A يشير إلى B يفشل"). بديهي (id مفتاح أساسي بالفعل) لكن مطلوب
  -- بنيوياً كهدف FK مركّب.
  constraint project_shifts_id_project_id_key unique (id, project_id)
);


-- ---------------------------------------------------------------------
-- 1.5) project_devices — أجهزة رصد فعلية (يسبق project_dust_profiles/
--      pm10_readings_history/إلخ، كلها تشير إليه بـ FK)
-- ---------------------------------------------------------------------
-- كل الأعمدة أدناه هي الحالة النهائية المتراكمة من: الباسلاين الأصلي
-- (202607290001) + timestamps لكل حقل قياس (202607290006) + last_pm25/
-- last_received_at (202608020004) + true_north_* الستة (202608060001) +
-- lat/lng إجبارية (202607290008 — طلب صريح من المستخدم: الربط التلقائي
-- بأقرب جهاز يحتاج موقعاً فعلياً معروفاً دائماً).
create table if not exists public.project_devices (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,

  name text not null,
  lat numeric not null,
  lng numeric not null,

  api_key_hash text not null,
  api_key_prefix text not null,
  is_active boolean not null default true,

  last_reading_at timestamptz,
  last_received_at timestamptz,

  last_wind_speed_kmh numeric,
  last_wind_speed_at timestamptz,
  last_wind_gust_kmh numeric,
  last_wind_gust_at timestamptz,
  last_wind_direction_deg numeric,
  last_wind_direction_at timestamptz,
  -- حداثة PM10 تحديداً، مستقلة عن last_reading_at العام (لا تتحدّث بمجرد
  -- push جزئي لحقل آخر). للعرض/اللقطة العامة فقط — ليست مصدر حساب استمرار
  -- المخالفة الفعلي (ذاك pm10_readings_history.observed_at حصراً، راجع
  -- تعليق ذلك الجدول أدناه) ولا مصدر القرار الحي (ذاك device_metric_latest).
  last_pm10 numeric,
  last_pm10_at timestamptz,
  last_pm25 numeric,
  last_pm25_at timestamptz,
  last_visibility_m numeric,
  last_visibility_at timestamptz,
  last_relative_humidity_percent numeric,
  last_relative_humidity_at timestamptz,
  last_temperature_c numeric,
  last_temperature_at timestamptz,

  -- توثيق معايرة الشمال الحقيقي لهذه المحطة تحديداً (202608060001 —
  -- استبدل عمود projects.true_north_alignment_documented الوحيد على
  -- مستوى المشروع كله، الذي لم يكن يميّز بين محطتين مختلفتين لنفس المشروع
  -- ولا يحمل أي تفصيل عن عملية المعايرة نفسها).
  true_north_alignment_documented boolean,
  true_north_alignment_type text
    check (true_north_alignment_type in ('TRUE_NORTH', 'MAGNETIC_NORTH') or true_north_alignment_type is null),
  true_north_verification_method text,
  true_north_verified_by text,
  true_north_verified_at timestamptz,
  true_north_deviation_deg numeric,
  true_north_evidence_url text,

  created_at timestamptz not null default now(),
  revoked_at timestamptz,

  -- مفتاح فريد مركّب (id, project_id) — هدف FK مركّب صالح لعزل project_id
  -- على كل جدول تابع (project_dust_profiles/pm10_readings_history/
  -- provider_connections/device_events/device_measurements/
  -- device_metric_latest)، نفس مبدأ project_shifts أعلاه.
  constraint project_devices_id_project_id_key unique (id, project_id)
);

comment on column public.project_devices.true_north_alignment_documented is
  'هل محطة الرصد هذه معايَرة فعلياً على الشمال الحقيقي (لا مغناطيسي/تقريبي)؟ null=غير موثّق، يُعامَل معاملة false في القرار.';
comment on column public.project_devices.true_north_alignment_type is
  'TRUE_NORTH (شمال حقيقي فعلي) أو MAGNETIC_NORTH (مغناطيسي، يتطلب انحراف مُطبَّق) — null إن لم يُوثَّق بعد.';
comment on column public.project_devices.true_north_verification_method is
  'طريقة التحقق من المحاذاة (نص حر: مساحة GPS، بوصلة معايَرة، مقارنة مرجع فلكي، إلخ).';
comment on column public.project_devices.true_north_verified_by is
  'اسم/هوية الشخص أو الجهة التي نفّذت عملية التحقق من المحاذاة.';
comment on column public.project_devices.true_north_verified_at is
  'تاريخ إجراء التحقق من المحاذاة فعلياً — منفصل عن created_at الجهاز (قد تُعاد المعايرة لاحقاً).';
comment on column public.project_devices.true_north_deviation_deg is
  'الانحراف المُطبَّق (بالدرجات) بين الشمال المغناطيسي المقروء والشمال الحقيقي — يُضاف إلى last_wind_direction_deg الخام قبل استخدامه في أي قاعدة اتجاه رياح.';
comment on column public.project_devices.true_north_evidence_url is
  'رابط مستند أو صورة إثبات عملية المعايرة (شهادة مساحة، صورة تركيب الجهاز مع مرجع الاتجاه، إلخ).';


-- ---------------------------------------------------------------------
-- 1.6) activity_groups — جدول هوية لمجموعات النشاط (project_id, id)
-- ---------------------------------------------------------------------
-- (202608040006 — القسم 12.3): activity_group_id كان نصاً حراً nullable
-- على project_dust_profiles بلا جدول هوية مستقل يفرض أن كل
-- (project_id, activity_group_id) موجود وينتمي فعلاً لمشروعه. المجموعة قد
-- تضم أكثر من صف نشاط واحد (وحدات متعددة: عدة كسارات/محطات خلط لنفس
-- النشاط التنظيمي)، فلا يجوز أن يكون project_dust_profiles نفسه جدول
-- الهوية. يجب أن يُنشأ قبل project_dust_profiles (يُشار إليه بـ FK مركّب).
create table if not exists public.activity_groups (
  project_id uuid not null references public.projects(id) on delete restrict,
  id text not null,
  archived_at timestamptz,
  archived_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (project_id, id),
  check (length(btrim(id)) between 1 and 200)
);


-- ---------------------------------------------------------------------
-- 1.7) project_dust_profiles — أكبر جدول: صف واحد لكل نشاط غبار/امتثال
-- ---------------------------------------------------------------------
-- device_id (يعتمد على project_devices) وarchived_at/archived_by
-- (202608020005 — أرشفة بدل حذف فعلي لـDELETE /api/activities) وactivity_
-- group_id NOT NULL + FK مركّب لـactivity_groups (202608040006/7/8) وFK
-- مركّب device_id/shift_id مع project_id (202608040019/20) كلها مدموجة
-- هنا كحالة نهائية واحدة.
create table if not exists public.project_dust_profiles (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  activity_group_id text not null,
  shift_id uuid references public.project_shifts(id) on delete set null,
  -- محطة الرصد المرتبطة بهذا النشاط تحديداً. on delete set null (لا
  -- cascade): حذف جهاز لاحقاً لا يحذف صفوف أنشطة تاريخية مرتبطة به.
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

  created_at timestamptz not null default now(),

  -- أرشفة بدل حذف فعلي (202608020005) — DELETE /api/activities يُحوَّل
  -- لـUPDATE archived_at بدل حذف فعلي (يحافظ على رابط سلسلة الأدلة
  -- التاريخية بـdust_profile_id).
  archived_at timestamptz,
  archived_by uuid references auth.users(id) on delete set null,

  -- كل صف نشاط ينتمي فعلياً لهوية مجموعة مسجَّلة في activity_groups (لا
  -- NOT NULL وحده كافياً — يضمن أيضاً أن project_id يطابق فعلياً؛
  -- 202608040007/8، عبر NOT VALID ثم VALIDATE على قاعدة إنتاج قائمة —
  -- هنا على قاعدة جديدة فارغة القيد عادي منذ الإنشاء).
  constraint project_dust_profiles_activity_group_fk
    foreign key (project_id, activity_group_id)
    references public.activity_groups (project_id, id),

  -- عزل device_id/shift_id بين المشاريع على مستوى القاعدة نفسها (لا فقط
  -- اعتماد على التطبيق) — 202608040019/20، القسم 18.5.
  constraint project_dust_profiles_device_project_fk
    foreign key (device_id, project_id)
    references public.project_devices (id, project_id),
  constraint project_dust_profiles_shift_project_fk
    foreign key (shift_id, project_id)
    references public.project_shifts (id, project_id)
);


-- ---------------------------------------------------------------------
-- 1.8) dust_evaluations / current_dust_decisions — محرك DVI الفيزيائي
-- ---------------------------------------------------------------------
-- dust_profile_id: on delete restrict (الحالة النهائية بعد 202608040030 —
-- كان set null منذ الباسلاين كبديل عن cascade الأقدم الذي كان يصطدم
-- بـtrigger append-only ويُفشل حذف النشاط؛ لكن set null نفسه غير مثالي —
-- لو حُذف صف project_dust_profiles فعلياً (لا يوجد اليوم أي مسار كود يفعل
-- هذا، DELETE تحوَّل لأرشفة)، تفقد سجلات التقييم مرجعها بصمت، يخالف فلسفة
-- append-only. restrict يمنع الحذف بدل فقدان المرجع).
create table if not exists public.dust_evaluations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  dust_profile_id uuid references public.project_dust_profiles(id) on delete restrict,
  activity_group_id text,
  result jsonb not null,
  triggered_by text not null,
  created_at timestamptz not null default now(),

  -- يمنع أي صف دليل من الإشارة لمعرّف مجموعة نشاط غير موجود/لا ينتمي
  -- لنفس المشروع (202608040007/8).
  constraint dust_evaluations_activity_group_fk
    foreign key (project_id, activity_group_id)
    references public.activity_groups (project_id, id)
);
create index if not exists idx_dust_evaluations_project_id on public.dust_evaluations (project_id);
create index if not exists idx_dust_evaluations_profile on public.dust_evaluations (dust_profile_id, created_at desc);

-- current_dust_decisions: مفتاح أساسي مركّب (project_id, activity_group_id)
-- منذ الإنشاء هنا (الحالة النهائية بعد 202608030006 — كان activity_group_id
-- وحده PK في الباسلاين، خطأ معماري: لا شيء كان يمنع صفاً بمعرّف مجموعة
-- خاطئ من الانتماء لمشروع مختلف عمّا يُفترض، وعدة استعلامات بالتطبيق كانت
-- تفلتر بـactivity_group_id فقط بلا project_id في شرط WHERE).
create table if not exists public.current_dust_decisions (
  activity_group_id text not null,
  project_id uuid not null references public.projects(id) on delete cascade,
  latest_evaluation_id uuid not null references public.dust_evaluations(id),
  decision text not null,
  triggered_rules jsonb not null default '[]'::jsonb,
  short_reason text,
  updated_at timestamptz not null default now(),
  primary key (project_id, activity_group_id),
  constraint current_dust_decisions_activity_group_fk
    foreign key (project_id, activity_group_id)
    references public.activity_groups (project_id, id)
);
create index if not exists idx_current_dust_decisions_project_id on public.current_dust_decisions (project_id);


-- ---------------------------------------------------------------------
-- 1.9) dust_compliance_evaluations / current_dust_compliance_decisions —
--      طبقة الامتثال التنظيمي
-- ---------------------------------------------------------------------
-- stopped_since/pending_resume_since/deciding_rule_code/stop_cause مدموجة
-- مباشرة كحالة نهائية. dust_profile_id: on delete restrict (نفس تصحيح
-- dust_evaluations أعلاه، 202608040030).
create table if not exists public.dust_compliance_evaluations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  dust_profile_id uuid references public.project_dust_profiles(id) on delete restrict,
  activity_group_id text,
  result jsonb not null,
  rulebook_version text not null,
  triggered_by text not null,
  created_at timestamptz not null default now(),
  constraint dust_compliance_evaluations_activity_group_fk
    foreign key (project_id, activity_group_id)
    references public.activity_groups (project_id, id)
);
create index if not exists idx_dust_compliance_evaluations_project_id on public.dust_compliance_evaluations (project_id);
create index if not exists idx_dust_compliance_evaluations_profile on public.dust_compliance_evaluations (dust_profile_id, created_at desc);

create table if not exists public.current_dust_compliance_decisions (
  activity_group_id text not null,
  project_id uuid not null references public.projects(id) on delete cascade,
  latest_evaluation_id uuid not null references public.dust_compliance_evaluations(id),
  decision text not null,
  triggered_rules jsonb not null default '[]'::jsonb,
  short_reason text,
  updated_at timestamptz not null default now(),
  -- منذ متى بدأ آخر إيقاف مستمر.
  stopped_since timestamptz,
  -- منذ متى أصبحت القراءة جيدة فعلياً (عداد استئناف 10 دقائق).
  pending_resume_since timestamptz,
  -- كود القاعدة الفعلية الفائزة + وصفها العربي المختصر.
  deciding_rule_code text,
  stop_cause text,
  primary key (project_id, activity_group_id),
  constraint current_dust_compliance_decisions_activity_group_fk
    foreign key (project_id, activity_group_id)
    references public.activity_groups (project_id, id)
);
create index if not exists idx_current_dust_compliance_decisions_project_id on public.current_dust_compliance_decisions (project_id);


-- ---------------------------------------------------------------------
-- 1.10) pm10_readings_history — سجل أدلة ميداني (device/manual فقط)
-- ---------------------------------------------------------------------
-- external_event_id/sequence_no/observed_at (202607290005) وdevice_id
-- (يعتمد على project_devices) وreceived_at (202608020006) وis_late
-- (202608060002) كلها مدموجة كحالة نهائية. activity_group_id nullable
-- عمداً — قراءات مستوى المشروع بلا نشاط محدد ممكنة.
--
-- ملاحظة جوهرية (202608040025): observed_at/recorded_at هنا يجب أن يعكسا
-- وقت رصد PM10 الفعلي تحديداً (v_pm10_observed_at في ingest_device_
-- reading_and_event_atomic) لا وقتاً عاماً مشتركاً للحمولة كلها — هذا
-- الجدول تحديداً هو مصدر computeSustainedPm10Status (حساب استمرار
-- المخالفة المؤكَّد)، فأي وقت غير دقيق هنا يُنتج دليلاً حديثاً زائفاً من
-- قراءة قديمة فعلياً.
create table if not exists public.pm10_readings_history (
  id uuid primary key default gen_random_uuid(),
  activity_group_id text,
  project_id uuid not null references public.projects(id) on delete cascade,
  -- الجهاز الذي أرسل هذه القراءة تحديداً (nullable — قراءات manual لا تخص
  -- جهازاً).
  device_id uuid references public.project_devices(id) on delete set null,
  pm10_ug_m3 numeric not null,
  source text not null check (source in ('device', 'manual')),
  recorded_at timestamptz not null default now(),
  external_event_id text,
  sequence_no bigint,
  observed_at timestamptz,
  received_at timestamptz,
  is_late boolean not null default false,

  -- عزل device_id بين المشاريع على مستوى القاعدة (202608040019/20).
  constraint pm10_readings_history_device_project_fk
    foreign key (device_id, project_id)
    references public.project_devices (id, project_id)
);

comment on column public.pm10_readings_history.is_late is
  'true يعني هذه القراءة لا تُستخدَم لإثبات استمرار مخالفة/تعليق (computeSustainedPm10Status يستبعدها) — سُجِّلت للتدقيق فقط.';

create index if not exists idx_pm10_readings_history_group_time
  on public.pm10_readings_history (activity_group_id, recorded_at desc);
create index if not exists idx_pm10_readings_history_device_time
  on public.pm10_readings_history (device_id, recorded_at desc);
create unique index if not exists idx_pm10_readings_history_device_event_unique
  on public.pm10_readings_history (device_id, external_event_id)
  where external_event_id is not null;


-- ---------------------------------------------------------------------
-- 1.11) weather_forecasts — توقعات Open-Meteo (منفصلة عن سجل الأدلة الميداني)
-- ---------------------------------------------------------------------
-- evidence_eligible ثابتة false دائماً — توقّع للتخطيط/التحذير الاستباقي
-- فقط، لا يُستخدَم دليلاً لإثبات استمرار مخالفة.
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


-- ---------------------------------------------------------------------
-- 1.12) sensitive_receptors — مستقبِلات حساسة (مدارس/مستشفيات/سكني/مساجد)
-- ---------------------------------------------------------------------
create table if not exists public.sensitive_receptors (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  receptor_type text not null default 'OTHER',
  lat numeric not null,
  lng numeric not null,
  created_at timestamptz not null default now()
);


-- ---------------------------------------------------------------------
-- 1.13) project_evaluation_jobs — طابور مهام تقييم حقيقي (يسبق
--       evaluation_runs وfinal_decisions اللذين يشيران إليه)
-- ---------------------------------------------------------------------
-- (202608040004 — القسم 10.1/10.2): scheduler_locks (أدناه) يمنع تكراراً
-- داخل نافذة زمنية فقط لكنه لا يملك Lease قابل للاسترداد ولا إعادة محاولة
-- بعد فشل. طابور حقيقي بحالات صريحة (PENDING/RUNNING/RETRY/SUCCEEDED/DEAD)
-- وLease زمني قابل للاسترداد (FOR UPDATE SKIP LOCKED) وBackoff.
create table if not exists public.project_evaluation_jobs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  dedupe_key text not null,
  trigger_type text not null check (trigger_type in (
    'SCHEDULED', 'DEVICE_EVENT', 'PROVIDER_PULL', 'USER_REQUEST'
  )),
  status text not null default 'PENDING' check (status in (
    'PENDING', 'RUNNING', 'RETRY', 'SUCCEEDED', 'DEAD'
  )),
  run_after timestamptz not null default clock_timestamp(),
  attempts integer not null default 0,
  worker_id uuid,
  lease_until timestamptz,
  last_error text,
  created_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  unique (project_id, dedupe_key)
);

create index if not exists idx_project_evaluation_jobs_claim
  on public.project_evaluation_jobs (status, run_after, created_at);
create index if not exists idx_project_evaluation_jobs_project
  on public.project_evaluation_jobs (project_id, created_at desc);


-- ---------------------------------------------------------------------
-- 1.14) evaluation_runs — يربط كل دورة تقييم فعلية بمعرّف واحد
-- ---------------------------------------------------------------------
-- (القسم 11.2): بصرف النظر عن مصدر التحفيز (Scheduled/Device Event/
-- Provider Pull/User Request). final_decisions يشير إليه لاحقاً.
create table if not exists public.evaluation_runs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  evaluation_job_id uuid references public.project_evaluation_jobs(id) on delete set null,
  trigger_type text not null check (trigger_type in (
    'SCHEDULED', 'DEVICE_EVENT', 'PROVIDER_PULL', 'USER_REQUEST'
  )),
  as_of timestamptz not null,
  status text not null check (status in ('RUNNING', 'SUCCEEDED', 'FAILED')),
  activities_evaluated integer not null default 0,
  activities_failed integer not null default 0,
  error text,
  started_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz
);

create index if not exists idx_evaluation_runs_project_time
  on public.evaluation_runs (project_id, started_at desc);


-- ---------------------------------------------------------------------
-- 1.15) final_decisions — لقطة واحدة موثوقة لكل قرار نهائي (decideFinal)
-- ---------------------------------------------------------------------
-- evaluation_run_id/input_snapshot_hash (202608040021 — القسم 20 بند 7)
-- مدموجان هنا كحالة نهائية: يربطان القرار بدورة التقييم الفعلية التي
-- أنتجته وببصمة مدخلاتها، لإثبات "نفس المدخلات تنتج نفس القرار" لاحقاً.
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
  created_at timestamptz not null default now(),

  evaluation_run_id uuid references public.evaluation_runs(id) on delete set null,
  input_snapshot_hash text,

  constraint final_decisions_activity_group_fk
    foreign key (project_id, activity_group_id)
    references public.activity_groups (project_id, id)
);

create index if not exists idx_final_decisions_activity_group_time
  on public.final_decisions (activity_group_id, created_at desc);
create index if not exists idx_final_decisions_project_time
  on public.final_decisions (project_id, created_at desc);
create index if not exists idx_final_decisions_evaluation_run
  on public.final_decisions (evaluation_run_id);


-- ---------------------------------------------------------------------
-- 1.16) alerts — تنبيهات مولَّدة تلقائياً (قبل/أثناء التنفيذ)
-- ---------------------------------------------------------------------
-- viewer_message وfinal_decision_id (202608040029 — يربط التنبيه بالقرار
-- الحي الذي فتحه فعلياً) مدموجان هنا كحالة نهائية.
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
  created_at timestamptz not null default now(),
  final_decision_id uuid references public.final_decisions(id) on delete set null
);

create index if not exists idx_alerts_project_id on public.alerts (project_id);
create index if not exists idx_alerts_project_state on public.alerts (project_id, state);
create index if not exists idx_alerts_source_activity on public.alerts (activity_source, activity_id);
create index if not exists idx_alerts_final_decision_id on public.alerts (final_decision_id);


-- ---------------------------------------------------------------------
-- 1.17) alert_state_events — سجل أحداث append-only لتغييرات حالة التنبيه
-- ---------------------------------------------------------------------
-- alerts.state (أعلاه) عمود مشتق فعلياً من هذا الجدول عبر trigger — لا
-- كتابة مباشرة لأي كود تطبيق على alerts.state بعد الآن.
create table if not exists public.alert_state_events (
  id uuid primary key default gen_random_uuid(),
  alert_id uuid not null references public.alerts(id) on delete restrict,
  previous_state text,
  new_state text not null check (
    new_state in ('NEW', 'REVIEWED', 'ACTION_TAKEN', 'CLOSED')
  ),
  -- nullable عمداً: null = تغيير آلي (نظام/Cron)، غير null = مستخدم بشري
  -- فعلي عبر PATCH.
  actor_user_id uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index if not exists idx_alert_state_events_alert_id
  on public.alert_state_events (alert_id, created_at desc);


-- ---------------------------------------------------------------------
-- 1.18) decision_records — قرارات موثَّقة يدوياً (اعتماد/تأجيل/تقييد/إيقاف)
-- ---------------------------------------------------------------------
-- final_decision_id (يعتمد على final_decisions) يربط قرار المستخدم بالقرار
-- الآلي الذي كان معروضاً له لحظة اتخاذ القرار.
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
  created_at timestamptz not null default now(),
  final_decision_id uuid references public.final_decisions(id) on delete set null
);

create index if not exists idx_decision_records_project_id on public.decision_records (project_id);
create index if not exists idx_decision_records_source_activity on public.decision_records (activity_source, activity_id);
create index if not exists idx_decision_records_final_decision_id on public.decision_records (final_decision_id);


-- ---------------------------------------------------------------------
-- 1.19) admin_audit_log — سجل تدقيق لعمليات سوبر أدمن على مشروع لا يملكه
-- ---------------------------------------------------------------------
-- admin_user_id: on delete restrict صريح (202608030002) — يمنع حذف حساب
-- auth.users لأي مسؤول له سجل تدقيق (سلوك متعمَّد: سجل التدقيق هو مصدر
-- المحاسبة الوحيد للإجراءات الإدارية، لا يجوز أن يختفي بحذف حساب المسؤول).
create table if not exists public.admin_audit_log (
  id uuid primary key default gen_random_uuid(),
  admin_user_id uuid not null references auth.users(id) on delete restrict,
  action text not null,
  target_project_id uuid,
  target_project_name text,
  target_owner_user_id uuid,
  details jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_admin_audit_log_admin on public.admin_audit_log (admin_user_id);


-- ---------------------------------------------------------------------
-- 1.20) device_readings_history — سجل تاريخي append-only لكل قراءات الجهاز
-- ---------------------------------------------------------------------
-- external_event_id/sequence_no/observed_at (202607290005)، received_at
-- (202608020006)، is_late (202608060002) مدموجة هنا كحالة نهائية.
create table if not exists public.device_readings_history (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  device_id uuid not null references public.project_devices(id) on delete cascade,
  wind_speed_kmh numeric,
  wind_gust_kmh numeric,
  wind_direction_deg numeric,
  pm10_ug_m3 numeric,
  pm25_ug_m3 numeric,
  visibility_m numeric,
  relative_humidity_percent numeric,
  temperature_c numeric,
  recorded_at timestamptz not null default now(),
  external_event_id text,
  sequence_no bigint,
  observed_at timestamptz,
  received_at timestamptz,
  is_late boolean not null default false
);

comment on column public.device_readings_history.is_late is
  'true إن كانت observed_at أقدم من نافذة القبول الحية وقت الاستقبال — سُجِّلت للتدقيق فقط، لم تُحدِّث project_devices.last_*/device_metric_latest.';

create index if not exists idx_device_readings_history_device_time
  on public.device_readings_history (device_id, recorded_at desc);
create index if not exists idx_device_readings_history_project_time
  on public.device_readings_history (project_id, recorded_at desc);
create unique index if not exists idx_device_readings_history_device_event_unique
  on public.device_readings_history (device_id, external_event_id)
  where external_event_id is not null;


-- ---------------------------------------------------------------------
-- 1.21) provider_instances — سجل منصات معتمدة (يديره سوبر أدمن)
-- ---------------------------------------------------------------------
-- (202608040015 — القسم 15.1، إغلاق SSRF): بدل أن يكتب المستخدم base_url
-- حراً ضمن provider_connections.credentials، يختار من قائمة معتمدة فقط.
-- origin مقيَّد بـhttps:// وport=443 فقط.
create table if not exists public.provider_instances (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  origin text not null unique,
  hostname text not null,
  port integer not null default 443 check (port = 443),
  is_approved boolean not null default false,
  approved_by uuid references auth.users(id),
  approved_at timestamptz,
  is_active boolean not null default true,
  created_at timestamptz not null default clock_timestamp(),
  check (origin like 'https://%')
);

create index if not exists idx_provider_instances_provider on public.provider_instances (provider) where is_active and is_approved;


-- ---------------------------------------------------------------------
-- 1.22) provider_connections — ربط محطة رصد بمصدر بيانات خارجي (Pull)
-- ---------------------------------------------------------------------
-- الحالة النهائية بعد ترقية تشفير Credentials كاملة (202608040016/17/18 —
-- القسم 15.2): العمود الأصلي credentials (jsonb، نص صريح) أُزيل نهائياً
-- بعد الترحيل الكامل لـcredentials_ciphertext (enc:v2:...، NOT NULL) +
-- credentials_key_version (NOT NULL) + credentials_migrated_at. كذلك
-- provider_instance_id (202608040015) وFK مركّب device_id/project_id
-- (202608040019/20) مدموجة هنا.
--
-- ⚠ ملاحظة حرجة لمن يطبّق هذا الملف: الحالة هنا تفترض أن الترحيل الكامل
-- (scripts/migrate-provider-credentials-v2.mjs) قد اكتمل بالفعل على أي
-- بيانات قديمة — لا ينطبق على قاعدة فارغة جديدة (لا بيانات قديمة أصلاً).
create table public.provider_connections (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references public.project_devices(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,

  -- معرّف الشركة/الـConnector — نص حر لا enum/CHECK صارم عمداً: إضافة شركة
  -- جديدة يجب ألا تحتاج migration جديد.
  provider text not null,

  -- بيانات الاتصال مشفَّرة (enc:v2:...) — القيمة الخام السابقة (jsonb نص
  -- صريح) أُزيلت بالكامل بعد الترحيل. يجب عدم عرض هذا العمود أبداً في أي
  -- استجابة API تصل للواجهة.
  credentials_ciphertext text not null,
  credentials_key_version integer not null,
  credentials_migrated_at timestamptz,

  -- معرّف المحطة عند الشركة (بعد اختيار المستخدم من نتيجة listStations) —
  -- null حتى يُختار فعلياً.
  vendor_station_id text,
  vendor_station_name text,

  is_active boolean not null default true,

  last_pull_at timestamptz,
  last_pull_success boolean,
  last_pull_error text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  provider_instance_id uuid references public.provider_instances(id) on delete restrict,

  -- محطة واحدة (device_id) لا يجوز أن تُربط بنفس الشركة مرتين.
  constraint provider_connections_device_provider_unique unique (device_id, provider),

  constraint provider_credentials_v2_shape
    check (
      credentials_ciphertext is null or (
        credentials_ciphertext like 'enc:v2:%'
        and credentials_key_version is not null
      )
    ),

  constraint provider_connections_device_project_fk
    foreign key (device_id, project_id)
    references public.project_devices (id, project_id)
);

create index idx_provider_connections_project on public.provider_connections (project_id);
create index idx_provider_connections_active on public.provider_connections (is_active) where is_active = true;


-- ---------------------------------------------------------------------
-- 1.23) device_events / device_measurements / device_metric_latest —
--       عقد حدث الجهاز V2 (Event V2، وقت رصد مستقل لكل قياس)
-- ---------------------------------------------------------------------
-- (202608040001 — دليل الإصلاح الجذري، القسم 2.2/7/8): الحمولة القديمة
-- كانت تُخزَّن بوقت رصد واحد مشترك لكل الحقول — صحيح فقط إن أخذت كل
-- الحساسات عينتها بنفس اللحظة، خاطئ لموصلات pull (ThingsBoard) التي تجلب
-- "آخر نقطة" لكل حقل على حدة، وقد تختلف توقيتاتها الفعلية.
--
-- device_events: سجل الحدث الخام append-only. sequence_no NOT NULL
-- (202608040023 — القسم 5.10: "عقد الحدث كامل فقط في Push").
create table if not exists public.device_events (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  device_id uuid not null references public.project_devices(id) on delete cascade,
  external_event_id text,
  sequence_no bigint not null check (sequence_no >= 0),
  source text not null default 'device',
  received_at timestamptz not null default clock_timestamp(),
  created_at timestamptz not null default clock_timestamp(),

  constraint device_events_device_project_fk
    foreign key (device_id, project_id)
    references public.project_devices (id, project_id)
);

create unique index if not exists idx_device_events_device_event_unique
  on public.device_events (device_id, external_event_id)
  where external_event_id is not null;
create index if not exists idx_device_events_project_device
  on public.device_events (project_id, device_id, created_at desc);

-- device_measurements: قياس واحد لكل حقل ضمن الحدث، بوقت رصد (observed_at)
-- ووقت وصول (received_at) مستقلَّين لكل قياس — الدليل التاريخي الفعلي.
create table if not exists public.device_measurements (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.device_events(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  device_id uuid not null references public.project_devices(id) on delete cascade,
  metric text not null check (metric in (
    'windSpeedKmh', 'windGustKmh', 'windDirectionDeg',
    'pm10', 'pm25', 'visibilityM',
    'relativeHumidityPercent', 'temperatureC'
  )),
  value numeric not null,
  observed_at timestamptz not null,
  received_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),

  constraint device_measurements_device_project_fk
    foreign key (device_id, project_id)
    references public.project_devices (id, project_id)
);

create index if not exists idx_device_measurements_event
  on public.device_measurements (event_id);
create index if not exists idx_device_measurements_latest_lookup
  on public.device_measurements (device_id, metric, observed_at desc);

-- device_metric_latest: Projection قابل لإعادة البناء الكامل من device_
-- measurements — "آخر قيمة معروفة" لكل (project_id, device_id, metric)،
-- مصدر القرار الحي الفوري.
create table if not exists public.device_metric_latest (
  project_id uuid not null references public.projects(id) on delete cascade,
  device_id uuid not null references public.project_devices(id) on delete cascade,
  metric text not null,
  value numeric not null,
  observed_at timestamptz not null,
  received_at timestamptz not null,
  source_measurement_id uuid not null references public.device_measurements(id) on delete restrict,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (project_id, device_id, metric),

  constraint device_metric_latest_device_project_fk
    foreign key (device_id, project_id)
    references public.project_devices (id, project_id)
);

create index if not exists idx_device_metric_latest_project_device
  on public.device_metric_latest (project_id, device_id);


-- ---------------------------------------------------------------------
-- 1.24) forecast_snapshots — كاش توقعات ساعات الدوام (Hourly Forecasts)
-- ---------------------------------------------------------------------
-- (202608040003 — القسم 9 "فصل Live عن Planning"): القرار الحي لا يجوز أن
-- ينتظر Open-Meteo. جدول كاش قابل لإعادة الحساب بالكامل، لا دليل تاريخي
-- (لا Append-only، upsert طبيعي).
create table if not exists public.forecast_snapshots (
  project_id uuid not null references public.projects(id) on delete cascade,
  activity_group_id text not null,
  hourly jsonb not null default '[]'::jsonb,
  fetched_at timestamptz not null default clock_timestamp(),
  activity_start_iso timestamptz,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (project_id, activity_group_id)
);

create index if not exists idx_forecast_snapshots_updated_at
  on public.forecast_snapshots (updated_at);


-- ---------------------------------------------------------------------
-- 1.25) scheduler_heartbeat — إثبات تشغيلي: صف واحد لحالة الـscheduler
-- ---------------------------------------------------------------------
create table if not exists public.scheduler_heartbeat (
  id boolean primary key default true check (id),
  last_heartbeat_at timestamptz not null default clock_timestamp(),
  last_successful_project_evaluation_at timestamptz
);


-- ---------------------------------------------------------------------
-- 1.26) scheduler_locks — قفل بسيط بمفتاح مركب (تاريخي — يبقى موجوداً،
--       project_evaluation_jobs هو الآلية الفعلية الحالية)
-- ---------------------------------------------------------------------
create table if not exists public.scheduler_locks (
  project_id uuid not null references public.projects(id) on delete cascade,
  time_bucket bigint not null,
  locked_at timestamptz not null default now(),
  primary key (project_id, time_bucket)
);

create index if not exists idx_scheduler_locks_locked_at on public.scheduler_locks (locked_at);


-- ---------------------------------------------------------------------
-- 1.27) decision_alert_outbox — جدول نوايا تنبيه (Outbox Pattern)
-- ---------------------------------------------------------------------
-- (202608040012/13/26/34 — القسم 11): يُدرَج ضمن نفس معاملة
-- persist_activity_decision_atomic فور نجاح حفظ final_decisions. alert_id/
-- locked_by (202608040026) وstatus شامل 'RETRY' (202608040034) مدموجة هنا.
create table if not exists public.decision_alert_outbox (
  id uuid primary key default gen_random_uuid(),
  final_decision_id uuid not null references public.final_decisions(id) on delete restrict,
  project_id uuid not null references public.projects(id) on delete restrict,
  activity_group_id text not null,
  activity_id uuid not null references public.project_dust_profiles(id) on delete restrict,
  kind text not null check (kind in ('SAFETY_BREACH', 'COMPLIANCE_VIOLATION', 'COMPLIANCE_RESTRICTION')),
  action text not null default 'OPEN' check (action in ('OPEN', 'CLOSE')),
  payload jsonb not null,
  status text not null default 'PENDING' check (status in ('PENDING', 'RUNNING', 'RETRY', 'PROCESSED', 'DEAD')),
  attempts integer not null default 0,
  available_at timestamptz not null default clock_timestamp(),
  locked_until timestamptz,
  processed_at timestamptz,
  last_error text,
  created_at timestamptz not null default clock_timestamp(),
  alert_id uuid references public.alerts(id) on delete set null,
  locked_by uuid,
  evaluation_run_id uuid references public.evaluation_runs(id) on delete set null,
  unique (final_decision_id, kind, action)
);

create index if not exists idx_decision_alert_outbox_claim
  on public.decision_alert_outbox (status, available_at, created_at);
create index if not exists idx_decision_alert_outbox_project
  on public.decision_alert_outbox (project_id, created_at desc);
create index if not exists idx_decision_alert_outbox_claim_lease
  on public.decision_alert_outbox (status, locked_until)
  where status = 'RUNNING';
-- يمنع أكثر من نية OPEN واحدة غير معالَجة (PENDING/RUNNING) لنفس
-- (project_id, activity_id, kind) في آن واحد — القسم 18.5.
create unique index if not exists idx_decision_alert_outbox_open_unprocessed
  on public.decision_alert_outbox (project_id, activity_id, kind)
  where action = 'OPEN' and status in ('PENDING', 'RUNNING');


-- ---------------------------------------------------------------------
-- 1.28) rule_parameter_definitions / rule_parameter_versions — نظام نسخ
--       حقيقي للعتبات الرقمية القابلة للضبط في محرك القواعد
-- ---------------------------------------------------------------------
-- (202608060003): مقصور عمداً على العتبات "الآمنة للتعديل التشغيلي"
-- (مسافات، سرعات رياح، أزمنة، نسب) — لا عتبات PM10 التشغيلية (تبقى حصراً
-- من ACTIVE_RULE_BUNDLE، طلب صريح من المستخدم بعدم لمسها)، ولا عتبات
-- تصنيف فئة المشروع.
create table if not exists public.rule_parameter_definitions (
  code text primary key,
  label_ar text not null,
  description_ar text not null,
  unit text not null,
  value_type text not null default 'NUMBER' check (value_type in ('NUMBER', 'INTEGER')),
  min_value numeric,
  max_value numeric,
  -- القيمة المكتوبة في الكود (rulebook.ts/engine.ts) — fallback الوحيد
  -- عند عدم وجود أي نسخة PUBLISHED بعد لهذا المعامل.
  code_default_value numeric not null,
  created_at timestamptz not null default clock_timestamp()
);

create table if not exists public.rule_parameter_versions (
  id uuid primary key default gen_random_uuid(),
  parameter_code text not null references public.rule_parameter_definitions(code) on delete cascade,
  value numeric not null,
  status text not null default 'DRAFT' check (status in ('DRAFT', 'PUBLISHED', 'SUPERSEDED', 'ARCHIVED')),
  effective_from timestamptz,
  published_by uuid references auth.users(id) on delete set null,
  published_at timestamptz,
  -- سبب النشر/التراجع (نص حر إلزامي عند النشر). null فقط لنسخ DRAFT.
  change_reason_ar text,
  -- true فقط للنسخة التي أُنشئت بفعل rollback صريح.
  is_rollback boolean not null default false,
  -- النسخة PUBLISHED السابقة التي حلّت محلها هذه النسخة.
  supersedes_version_id uuid references public.rule_parameter_versions(id) on delete set null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default clock_timestamp()
);

create index if not exists idx_rule_parameter_versions_param_status
  on public.rule_parameter_versions (parameter_code, status);
create index if not exists idx_rule_parameter_versions_param_time
  on public.rule_parameter_versions (parameter_code, created_at desc);
-- نسخة PUBLISHED واحدة فقط في كل لحظة لكل معامل.
create unique index if not exists uq_rule_parameter_versions_one_published
  on public.rule_parameter_versions (parameter_code)
  where status = 'PUBLISHED';



-- =====================================================================
-- ==================== 2) Row Level Security ==========================
-- =====================================================================
-- كل جدول في هذا المشروع مفعَّل عليه RLS. الفلسفة العامة الثابتة عبر كل
-- الملفات: الكتابة الفعلية تمر حصراً عبر service_role (supabaseAdmin) من
-- app/api/** بعد تحقق ملكية/صلاحية صريح في كود التطبيق — RLS + REVOKE
-- الصريح هما حاجز دفاعي إضافي يمنع anon/authenticated من الوصول المباشر
-- عبر عميل متصفح، لا الآلية الأساسية للتفويض.

alter table public.profiles enable row level security;
alter table public.user_authorizations enable row level security;
alter table public.projects enable row level security;
alter table public.project_shifts enable row level security;
alter table public.project_devices enable row level security;
alter table public.activity_groups enable row level security;
alter table public.project_dust_profiles enable row level security;
alter table public.dust_evaluations enable row level security;
alter table public.current_dust_decisions enable row level security;
alter table public.dust_compliance_evaluations enable row level security;
alter table public.current_dust_compliance_decisions enable row level security;
alter table public.pm10_readings_history enable row level security;
alter table public.weather_forecasts enable row level security;
alter table public.sensitive_receptors enable row level security;
alter table public.project_evaluation_jobs enable row level security;
alter table public.evaluation_runs enable row level security;
alter table public.final_decisions enable row level security;
alter table public.alerts enable row level security;
alter table public.alert_state_events enable row level security;
alter table public.decision_records enable row level security;
alter table public.admin_audit_log enable row level security;
alter table public.device_readings_history enable row level security;
alter table public.provider_instances enable row level security;
alter table public.provider_connections enable row level security;
alter table public.device_events enable row level security;
alter table public.device_measurements enable row level security;
alter table public.device_metric_latest enable row level security;
alter table public.forecast_snapshots enable row level security;
alter table public.scheduler_heartbeat enable row level security;
alter table public.scheduler_locks enable row level security;
alter table public.decision_alert_outbox enable row level security;
alter table public.rule_parameter_definitions enable row level security;
alter table public.rule_parameter_versions enable row level security;


-- ---------------------------------------------------------------------
-- 2.1) profiles — سياسات مقيَّدة بعمود بدل "for all" شاملة (202607290002)
-- ---------------------------------------------------------------------
create policy "profiles_owner_select"
  on public.profiles for select
  to authenticated
  using (auth.uid() = id);

create policy "profiles_owner_update"
  on public.profiles for update
  to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);

create policy "profiles_insert_own"
  on public.profiles for insert
  to authenticated
  with check (auth.uid() = id);


-- ---------------------------------------------------------------------
-- 2.2) projects / project_shifts / project_dust_profiles / alerts /
--      decision_records — SELECT فقط لصاحب المشروع (202608020003)
-- ---------------------------------------------------------------------
-- خطأ أمني مُصلَح: سياسات "for all" الأصلية (الباسلاين) كانت تسمح لصاحب
-- المشروع بالكتابة المباشرة عبر Supabase (anon/publishable key)، متجاوزاً
-- كل التحقق الخادمي في app/api/**. التطبيق لا يستخدم أي عميل متصفح
-- للكتابة إطلاقاً — تحويلها لـ"for select" فقط + سحب DML من anon/
-- authenticated لا يكسر أي مسار كتابة موجود فعلياً.
create policy "projects_owner_select"
  on public.projects for select
  to authenticated
  using (auth.uid() = user_id);

create policy "project_shifts_owner_select"
  on public.project_shifts for select
  to authenticated
  using (
    exists (
      select 1 from public.projects
      where projects.id = project_shifts.project_id
        and projects.user_id = auth.uid()
    )
  );

create policy "project_dust_profiles_owner_select"
  on public.project_dust_profiles for select
  to authenticated
  using (
    exists (
      select 1 from public.projects
      where projects.id = project_dust_profiles.project_id
        and projects.user_id = auth.uid()
    )
  );

create policy "alerts_owner_select"
  on public.alerts for select
  to authenticated
  using (
    exists (
      select 1 from public.projects
      where projects.id = alerts.project_id
        and projects.user_id = auth.uid()
    )
  );

create policy "decision_records_owner_select"
  on public.decision_records for select
  to authenticated
  using (
    exists (
      select 1 from public.projects
      where projects.id = decision_records.project_id
        and projects.user_id = auth.uid()
    )
  );


-- ---------------------------------------------------------------------
-- 2.3) final_decisions — SELECT لصاحب المشروع (202608020002) — يفعّل
--      اشتراك Supabase Realtime المباشر من المتصفح لصفحة تفاصيل المشروع.
-- ---------------------------------------------------------------------
-- بلا فرع super_admin عمداً — user_authorizations بلا أي policy إطلاقاً
-- (service_role فقط)، فمحاولة الاستعلام منها هنا كانت ستفشل دائماً. تحسين
-- تجربة عرض لمالك المشروع العادي فقط، لا ميزة إدارية.
create policy "final_decisions_owner_select"
  on public.final_decisions for select
  to authenticated
  using (
    exists (
      select 1 from public.projects
      where projects.id = final_decisions.project_id
        and projects.user_id = auth.uid()
    )
  );

-- كل الجداول المتبقية (user_authorizations، project_devices،
-- dust_evaluations، current_dust_decisions، dust_compliance_evaluations،
-- current_dust_compliance_decisions، pm10_readings_history،
-- weather_forecasts، sensitive_receptors، admin_audit_log،
-- device_readings_history، provider_instances، provider_connections،
-- device_events، device_measurements، device_metric_latest،
-- forecast_snapshots، scheduler_heartbeat، scheduler_locks،
-- decision_alert_outbox، rule_parameter_definitions،
-- rule_parameter_versions، alert_state_events، activity_groups،
-- evaluation_runs، project_evaluation_jobs) عمداً بلا أي policy — RLS
-- مفعَّل بلا سياسة = رفض كل شيء لـanon/authenticated افتراضياً؛ القسم 3
-- (GRANT/REVOKE) يسحب صراحة أي امتياز قد يفتحها بالخطأ لاحقاً
-- (202608030002 — "لا تعتمد على سلوك الرفض الافتراضي وحده، اجعله موصوفاً
-- صراحة في SQL نفسه").


-- =====================================================================
-- =========================== 3) الدوال (RPCs) =========================
-- =====================================================================
-- كل دالة أدناه هي **آخر نسخة فعلية** بعد تتبّع كل create or replace
-- عبر الملفات الـ62 — راجع تعليق كل دالة للمرجع الزمني (رقم آخر migration
-- عدّلها فعلياً). دوال بتوقيع (signature) تغيّر عدد/نوع معاملاته عبر
-- الزمن (ingest_device_reading_atomic، persist_activity_decision_atomic،
-- ingest_device_reading_and_event_atomic، list_active_provider_connections)
-- تحققنا يدوياً من وجود DROP FUNCTION صريح للتوقيع القديم قبل كل تغيير
-- توقيع في الملفات الأصلية (PostgreSQL لا يستبدل دالة بتوقيع مختلف عبر
-- CREATE OR REPLACE — ينشئ overload منفصلاً) — لذلك هنا نظهر فقط بتوقيعها
-- النهائي الواحد، بلا أي overload قديم متبقٍ.


-- ---------------------------------------------------------------------
-- 3.1) forbid_evidence_mutation — يمنع UPDATE/DELETE على جداول الأدلة
-- ---------------------------------------------------------------------
-- آخر نسخة: 202608080002. التطور: 202607290004 (نسخة أصلية، تسمح فقط
-- باستثناء UPDATE الناتج عن ON DELETE SET NULL على dust_profile_id) →
-- 202608080002 (يضيف استثناء DELETE ضيق: صفوف أقدم من 30 يوماً على 4
-- جداول محدَّدة فقط — قرار مستخدم صريح 2026-08-08 لمعالجة تضخّم مساحة
-- التخزين الفعلي لهذه الجداول append-only بلا أي تنظيف).
--
-- ملاحظة: بما أن dust_evaluations/dust_compliance_evaluations أعلاه بُنيا
-- في هذا الملف بـdust_profile_id "on delete restrict" (الحالة النهائية
-- الصحيحة بعد 202608040030) لا "on delete set null" كما كانا في الباسلاين
-- الأصلي، فرع الاستثناء الأول أدناه (شرط dust_profile_id is null) لن
-- يتفعّل عملياً على قاعدة جديدة مبنية من هذا الملف (لا ON DELETE SET NULL
-- يُطلقه بعد الآن) — أُبقي على منطقه الكامل بلا حذف لأنه لا يزال جزءاً من
-- التعريف الفعلي التراكمي للدالة عبر الـ62 ملف، وغير ضار (فرع ميت آمن).
create or replace function public.forbid_evidence_mutation()
returns trigger
language plpgsql
as $$
begin
  if TG_OP = 'UPDATE'
     and TG_TABLE_NAME in ('dust_evaluations', 'dust_compliance_evaluations')
     and NEW.dust_profile_id is null
     and OLD.dust_profile_id is distinct from NEW.dust_profile_id
     and to_jsonb(NEW) - 'dust_profile_id' = to_jsonb(OLD) - 'dust_profile_id'
  then
    return NEW;
  end if;

  -- استثناء احتفاظ ضيق (202608080002): DELETE فقط، فقط على 4 جداول محدَّدة
  -- (مصدر تضخّم المساحة الفعلي المشخَّص)، وفقط لصف يتجاوز عمره 30 يوماً
  -- فعلياً وقت الحذف — الشرط على بيانات الصف نفسه، لا على من يستدعي.
  if TG_OP = 'DELETE' then
    if TG_TABLE_NAME in ('dust_evaluations', 'dust_compliance_evaluations') and OLD.created_at < now() - interval '30 days' then
      return OLD;
    end if;
    if TG_TABLE_NAME in ('pm10_readings_history', 'device_readings_history') and OLD.recorded_at < now() - interval '30 days' then
      return OLD;
    end if;
  end if;

  raise exception 'audit/evidence rows are append-only — % on % is not permitted (retention delete requires row age > 30 days)', TG_OP, TG_TABLE_NAME;
end;
$$;


-- ---------------------------------------------------------------------
-- 3.2) forbid_evidence_truncate — يمنع TRUNCATE على جداول الأدلة
-- ---------------------------------------------------------------------
-- (202608040014 — القسم 5.9/14): forbid_evidence_mutation أعلاه trigger
-- على مستوى الصف (FOR EACH ROW) — لا يمنع TRUNCATE إطلاقاً (لا يُطلِق
-- triggers على مستوى الصف). trigger منفصل على مستوى العبارة مطلوب.
create or replace function public.forbid_evidence_truncate()
returns trigger
language plpgsql
as $$
begin
  raise exception 'evidence tables cannot be truncated — % on % is not permitted', TG_OP, TG_TABLE_NAME;
end;
$$;


-- ---------------------------------------------------------------------
-- 3.3) forbid_outbox_truncate — يمنع TRUNCATE على decision_alert_outbox
-- ---------------------------------------------------------------------
-- (202608040031): decision_alert_outbox ليس جدول أدلة append-only (يُحدَّث
-- عمداً بكثرة: status/attempts/locked_by)، فلا يجوز إضافته لقائمة
-- forbid_evidence_truncate/forbid_evidence_mutation (يكسر عمل الـworker) —
-- منع TRUNCATE فقط، بدالة/trigger منفصلين تماماً.
create or replace function public.forbid_outbox_truncate()
returns trigger
language plpgsql
as $$
begin
  raise exception 'decision_alert_outbox cannot be truncated — % on % is not permitted', TG_OP, TG_TABLE_NAME;
end;
$$;


-- ---------------------------------------------------------------------
-- 3.4) sync_alert_state_from_event — يحدّث alerts.state من alert_state_events
-- ---------------------------------------------------------------------
-- (202607290004): alerts.state يبقى عموداً عادياً (لا generated column)،
-- لكن المنع الفعلي لتعديله مباشرة يأتي من REVOKE على العمود + هذا الـtrigger
-- هو المسار الوحيد الفعلي لتحديثه (عبر INSERT في alert_state_events).
create or replace function public.sync_alert_state_from_event()
returns trigger
language plpgsql
as $$
begin
  update public.alerts
  set state = new.new_state
  where id = new.alert_id;
  return new;
end;
$$;


-- ---------------------------------------------------------------------
-- 3.5) cascade_device_deactivation_to_provider_connections
-- ---------------------------------------------------------------------
-- (202608030003): يعطّل provider_connections تلقائياً عند تعطيل
-- project_devices (is_active: true→false) — ضمانة على مستوى القاعدة، لا
-- اعتماداً على كل مسار تطبيقي مستقبلي يتذكّر فعل هذا يدوياً.
create or replace function public.cascade_device_deactivation_to_provider_connections()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.is_active = false and old.is_active = true then
    update public.provider_connections
    set is_active = false, updated_at = now()
    where device_id = new.id and is_active = true;
  end if;
  return new;
end;
$$;


-- ---------------------------------------------------------------------
-- 3.6) forbid_published_rule_parameter_mutation
-- ---------------------------------------------------------------------
-- (202608060003): append-only بعد النشر لـrule_parameter_versions — نسخة
-- PUBLISHED/SUPERSEDED/ARCHIVED لا يجوز تعديلها إطلاقاً بعد إنشائها،
-- باستثناء انتقال الحالة الوحيد المسموح: PUBLISHED→SUPERSEDED (الذي تكتبه
-- publish_rule_parameter_version نفسها عند نشر نسخة جديدة). DRAFT وحدها
-- قابلة للتعديل الحر.
create or replace function public.forbid_published_rule_parameter_mutation()
returns trigger
language plpgsql
as $$
begin
  if old.status = 'DRAFT' then
    return new;
  end if;

  if old.status = 'PUBLISHED' and new.status = 'SUPERSEDED'
     and new.value = old.value and new.parameter_code = old.parameter_code
     and new.published_at = old.published_at and new.published_by is not distinct from old.published_by
     and new.change_reason_ar = old.change_reason_ar and new.is_rollback = old.is_rollback
     and new.supersedes_version_id is not distinct from old.supersedes_version_id then
    return new;
  end if;

  raise exception using errcode = '0A000',
    message = 'rule_parameter_versions: لا يجوز تعديل نسخة منشورة/مُستبدَلة/مؤرشَفة إلا انتقال PUBLISHED→SUPERSEDED — append-only بعد النشر';
end;
$$;


-- ---------------------------------------------------------------------
-- 3.7) archive_project_atomic — أرشفة ذرّية كاملة للمشروع
-- ---------------------------------------------------------------------
-- (202608040009 — القسم 13): قفل المشروع (pg_advisory_xact_lock بمفتاح
-- 'project:'||project_id) ثم أرشفة + تعطيل كل الأجهزة النشطة (trigger
-- cascade_device_deactivation... يُعطِّل provider_connections تبعاً لذلك
-- تلقائياً) + إلغاء أي مهمة تقييم معلَّقة + سجل تدقيق — كل ذلك ذرياً.
-- نفس مفتاح القفل بالضبط مستخدَم في كل RPC كتابة أخرى تخص المشروع (ترتيب
-- موحَّد: قفل المشروع → فحص archived_at → قفل الأضيق → الكتابة، يمنع
-- Deadlocks وسباق أرشفة/تقييم/إدخال).
create or replace function public.archive_project_atomic(
  p_project_id uuid,
  p_actor_id uuid
)
returns void
language plpgsql
security invoker
set search_path = pg_catalog, public
set lock_timeout = '8s'
as $$
begin
  perform pg_advisory_xact_lock(
    hashtextextended('project:' || p_project_id::text, 0)
  );

  update public.projects
  set archived_at = clock_timestamp(), archived_by = p_actor_id
  where id = p_project_id and archived_at is null;

  if not found then
    raise exception using errcode = 'P0001', message = 'PROJECT_NOT_FOUND_OR_ARCHIVED';
  end if;

  update public.project_devices
  set is_active = false,
      revoked_at = coalesce(revoked_at, clock_timestamp())
  where project_id = p_project_id and is_active = true;

  update public.project_evaluation_jobs
  set status = 'DEAD', last_error = 'PROJECT_ARCHIVED', lease_until = null, completed_at = clock_timestamp()
  where project_id = p_project_id and status in ('PENDING', 'RETRY', 'RUNNING');

  insert into public.admin_audit_log (admin_user_id, action, target_project_id, details)
  values (p_actor_id, 'project_archive', p_project_id, null);
end;
$$;


-- ---------------------------------------------------------------------
-- 3.8) persist_activity_decision_atomic — حفظ ذرّي كامل لقرار نشاط واحد
-- ---------------------------------------------------------------------
-- آخر نسخة فعلية: 202608060004 (إصلاح تعارض on conflict على decision_
-- alert_outbox). تطوّرت عبر: 202607290007 (أصل الدالة — DVI + Compliance +
-- FinalDecision في معاملة ذرية واحدة) → 202608030005 (يصلح "أول إدراج
-- متزامن ينتج نجاحاً زائفاً") → 202608030006 (مفتاح current_dust_decisions/
-- current_dust_compliance_decisions أصبح مركّباً project_id+activity_group_id)
-- → 202608040011 (يضيف قفل المشروع + فحص archived_at قبل قفل النشاط) →
-- 202608040013 (يضيف إدراج نية OPEN في decision_alert_outbox) →
-- 202608040022 (يضيف p_evaluation_run_id/p_input_snapshot_hash) →
-- 202608040026 (يضيف مقارنة بالقرار السابق لإنتاج نوايا CLOSE) →
-- 202608060004 (يصلح هدف on conflict على decision_alert_outbox ليطابق
-- القيد الجزئي الفعلي القابل للتعارض، لا القيد الجدولي الذي لا يمكن أن
-- يتعارض إطلاقاً مع final_decision_id جديد — بدونه كان القرار يتجمّد عند
-- أول قراءة مخالفة ولا يتحدّث أبداً بعدها).
create or replace function public.persist_activity_decision_atomic(
  p_project_id uuid,
  p_activity_group_id text,
  p_activity_id text,

  -- dust_evaluations + current_dust_decisions (null = لا يوجد DVI لهذا النشاط)
  p_dvi_result jsonb,
  p_dvi_triggered_by text,
  p_dvi_expected_updated_at timestamptz,

  -- dust_compliance_evaluations + current_dust_compliance_decisions
  p_compliance_result jsonb,
  p_compliance_rulebook_version text,
  p_compliance_triggered_by text,
  p_compliance_expected_updated_at timestamptz,
  p_compliance_dust_profile_id uuid,
  p_compliance_stopped_since timestamptz,
  p_compliance_pending_resume_since timestamptz,

  -- final_decisions (null = تخطّي هذه المرحلة)
  p_final_decision jsonb,
  p_final_evaluated_at timestamptz,

  p_evaluation_run_id uuid default null,
  p_input_snapshot_hash text default null
)
returns table (
  dvi_persisted boolean,
  compliance_persisted boolean,
  final_decision_persisted boolean
)
language plpgsql
set lock_timeout = '8s'
as $$
declare
  v_dvi_evaluation_id uuid;
  v_compliance_evaluation_id uuid;
  v_dvi_persisted boolean := false;
  v_compliance_persisted boolean := false;
  v_final_persisted boolean := false;
  v_affected_rows integer := 0;
  v_project_archived_at timestamptz;
  v_final_decision_id uuid;
  v_operational_decision text;
  v_mode text;
  v_outbox_kind text;
  v_previous_operational_decision text;
  v_previous_kind text;
begin
  -- تسلسل تنفيذي واحد فقط لكل مشروع في نفس اللحظة (يمنع سباق أرشفة
  -- متزامنة)، ثم لكل (project_id, activity_group_id) (يمنع سباق قراءة
  -- existing.updated_at في TypeScript وكتابة current_* هنا).
  perform pg_advisory_xact_lock(
    hashtextextended('project:' || p_project_id::text, 0)
  );

  select archived_at into v_project_archived_at
  from public.projects
  where id = p_project_id;

  if v_project_archived_at is not null then
    raise exception using errcode = 'P0001', message = 'PROJECT_ARCHIVED';
  end if;

  perform pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_project_id::text || ':' || p_activity_group_id, 0)
  );

  -- يمنع كتابة قرار لنشاط لا ينتمي فعلياً لـp_project_id/p_activity_group_id
  -- المرسَلين.
  perform 1
  from public.project_dust_profiles p
  where p.id = p_activity_id::uuid
    and p.project_id = p_project_id
    and coalesce(p.activity_group_id, 'dust-' || p.id::text) = p_activity_group_id;

  if not found then
    raise exception using errcode = '23503',
      message = format('activity/project/activity_group mismatch for activity_id=%s', p_activity_id);
  end if;

  -- ===================================================================
  -- 1) dust_evaluations + current_dust_decisions
  -- ===================================================================
  if p_dvi_result is not null then
    insert into public.dust_evaluations (project_id, dust_profile_id, activity_group_id, result, triggered_by)
    values (p_project_id, p_activity_id::uuid, p_activity_group_id, p_dvi_result, p_dvi_triggered_by)
    returning id into v_dvi_evaluation_id;

    if v_dvi_evaluation_id is null then
      raise exception 'فشل إدراج dust_evaluations للنشاط %', p_activity_id;
    end if;

    if p_dvi_expected_updated_at is not null then
      update public.current_dust_decisions
      set latest_evaluation_id = v_dvi_evaluation_id,
          decision = p_dvi_result->>'decisionCategory',
          triggered_rules = coalesce(p_dvi_result->'triggeredRules', '[]'::jsonb),
          short_reason = p_dvi_result->>'shortReason',
          updated_at = now()
      where project_id = p_project_id
        and activity_group_id = p_activity_group_id
        and updated_at = p_dvi_expected_updated_at;

      get diagnostics v_affected_rows = row_count;
      if v_affected_rows <> 1 then
        raise exception using errcode = '40001',
          message = format('CAS conflict on current_dust_decisions for activity_group_id=%s', p_activity_group_id);
      end if;
    else
      insert into public.current_dust_decisions (
        activity_group_id, project_id, latest_evaluation_id, decision, triggered_rules, short_reason, updated_at
      )
      values (
        p_activity_group_id, p_project_id, v_dvi_evaluation_id, p_dvi_result->>'decisionCategory',
        coalesce(p_dvi_result->'triggeredRules', '[]'::jsonb), p_dvi_result->>'shortReason', now()
      )
      on conflict (project_id, activity_group_id) do nothing;

      get diagnostics v_affected_rows = row_count;
      if v_affected_rows <> 1 then
        -- منافس متزامن سبقنا لإدراج أول صف — لا تحديث احتياطي آمن ممكن
        -- (لا شرط WHERE يميّزه بأمان)؛ نفشل بنفس كود CAS بدل نجاح زائف.
        raise exception using errcode = '40001',
          message = format('CAS conflict (first-insert race) on current_dust_decisions for activity_group_id=%s', p_activity_group_id);
      end if;
    end if;

    v_dvi_persisted := true;
  end if;

  -- ===================================================================
  -- 2) dust_compliance_evaluations + current_dust_compliance_decisions
  -- ===================================================================
  if p_compliance_result is not null then
    insert into public.dust_compliance_evaluations (
      project_id, dust_profile_id, activity_group_id, result, rulebook_version, triggered_by
    )
    values (
      p_project_id, p_compliance_dust_profile_id, p_activity_group_id, p_compliance_result,
      p_compliance_rulebook_version, p_compliance_triggered_by
    )
    returning id into v_compliance_evaluation_id;

    if v_compliance_evaluation_id is null then
      raise exception 'فشل إدراج dust_compliance_evaluations للنشاط %', p_activity_id;
    end if;

    if p_compliance_expected_updated_at is not null then
      update public.current_dust_compliance_decisions
      set latest_evaluation_id = v_compliance_evaluation_id,
          decision = p_compliance_result->>'decisionCategory',
          triggered_rules = coalesce(p_compliance_result->'triggeredRules', '[]'::jsonb),
          short_reason = p_compliance_result->>'shortReasonAr',
          updated_at = now(),
          stopped_since = p_compliance_stopped_since,
          pending_resume_since = p_compliance_pending_resume_since,
          deciding_rule_code = p_compliance_result->>'decidingRuleCode',
          stop_cause = p_compliance_result->>'decidingRuleMessageAr'
      where project_id = p_project_id
        and activity_group_id = p_activity_group_id
        and updated_at = p_compliance_expected_updated_at;

      get diagnostics v_affected_rows = row_count;
      if v_affected_rows <> 1 then
        raise exception using errcode = '40001',
          message = format('CAS conflict on current_dust_compliance_decisions for activity_group_id=%s', p_activity_group_id);
      end if;
    else
      insert into public.current_dust_compliance_decisions (
        activity_group_id, project_id, latest_evaluation_id, decision, triggered_rules, short_reason,
        updated_at, stopped_since, pending_resume_since, deciding_rule_code, stop_cause
      )
      values (
        p_activity_group_id, p_project_id, v_compliance_evaluation_id, p_compliance_result->>'decisionCategory',
        coalesce(p_compliance_result->'triggeredRules', '[]'::jsonb), p_compliance_result->>'shortReasonAr',
        now(), p_compliance_stopped_since, p_compliance_pending_resume_since,
        p_compliance_result->>'decidingRuleCode', p_compliance_result->>'decidingRuleMessageAr'
      )
      on conflict (project_id, activity_group_id) do nothing;

      get diagnostics v_affected_rows = row_count;
      if v_affected_rows <> 1 then
        raise exception using errcode = '40001',
          message = format('CAS conflict (first-insert race) on current_dust_compliance_decisions for activity_group_id=%s', p_activity_group_id);
      end if;
    end if;

    v_compliance_persisted := true;
  end if;

  -- ===================================================================
  -- 3) final_decisions — append-only، يعتمد على نجاح المرحلتين أعلاه
  -- ===================================================================
  if p_final_decision is not null then
    -- آخر قرار مُشغَّل (LIVE_OPERATIONAL) محفوظ سابقاً لنفس النشاط، *قبل*
    -- إدراج الصف الجديد أدناه — أساس مقارنة "هل تحسّن القرار؟" لبناء نوايا
    -- CLOSE. PLANNING مستبعد من المقارنة.
    select operational_decision into v_previous_operational_decision
    from public.final_decisions
    where project_id = p_project_id
      and activity_group_id = p_activity_group_id
      and mode = 'LIVE_OPERATIONAL'
    order by created_at desc
    limit 1;

    insert into public.final_decisions (
      project_id, activity_group_id, dust_profile_id, mode, operational_decision, regulatory_finding,
      mandatory_stop, overridable, short_reason_ar, decision_label_ar, level, pending_confirmation,
      reason_codes, evidence_quality, rule_bundle_version, evaluated_at,
      evaluation_run_id, input_snapshot_hash
    )
    values (
      p_project_id, p_activity_group_id, p_activity_id::uuid,
      p_final_decision->>'mode', p_final_decision->>'operationalDecision', p_final_decision->>'regulatoryFinding',
      (p_final_decision->>'mandatoryStop')::boolean, (p_final_decision->>'overridable')::boolean,
      p_final_decision->>'shortReasonAr', p_final_decision->>'decisionLabelAr', p_final_decision->>'level',
      (p_final_decision->>'pendingConfirmation')::boolean,
      array(select jsonb_array_elements_text(coalesce(p_final_decision->'reasonCodes', '[]'::jsonb))),
      p_final_decision->>'evidenceQuality', p_final_decision->>'ruleBundleVersion', p_final_evaluated_at,
      p_evaluation_run_id, p_input_snapshot_hash
    )
    returning id into v_final_decision_id;

    v_final_persisted := true;

    -- =================================================================
    -- 4) decision_alert_outbox — نية تنبيه واحدة على الأكثر لكل قرار،
    --    بدلالة operationalDecision/mode المحفوظَين للتو فقط. mode=PLANNING
    --    لا يُنتج نية إطلاقاً. تحسّن حقيقي (SAFETY_BREACH/COMPLIANCE_
    --    RESTRICTION سابق ← ALLOW/MONITOR الآن) ينتج نية CLOSE.
    --    on conflict يستهدف (project_id, activity_id, kind) — يطابق
    --    idx_decision_alert_outbox_open_unprocessed الجزئي فعلياً (نفس شرط
    --    where)، لا القيد الجدولي (final_decision_id, kind, action) الذي
    --    لا يمكن أن يتعارض إطلاقاً مع final_decision_id جديد.
    -- =================================================================
    v_mode := p_final_decision->>'mode';
    v_operational_decision := p_final_decision->>'operationalDecision';

    if v_mode = 'LIVE_OPERATIONAL' then
      v_outbox_kind := case
        when v_operational_decision in ('MANDATORY_STOP', 'PROTECTIVE_STOP') then 'SAFETY_BREACH'
        when v_operational_decision = 'RESTRICT' then 'COMPLIANCE_RESTRICTION'
        else null
      end;

      if v_outbox_kind is not null then
        insert into public.decision_alert_outbox (
          final_decision_id, project_id, activity_group_id, activity_id, kind, action, payload, evaluation_run_id
        )
        values (
          v_final_decision_id, p_project_id, p_activity_group_id, p_activity_id::uuid, v_outbox_kind, 'OPEN',
          jsonb_build_object(
            'shortReasonAr', p_final_decision->>'shortReasonAr',
            'decisionLabelAr', p_final_decision->>'decisionLabelAr',
            'mandatoryStop', p_final_decision->>'mandatoryStop',
            'level', p_final_decision->>'level'
          ),
          p_evaluation_run_id
        )
        on conflict (project_id, activity_id, kind) where action = 'OPEN' and status in ('PENDING', 'RUNNING')
        do nothing;
      else
        v_previous_kind := case
          when v_previous_operational_decision in ('MANDATORY_STOP', 'PROTECTIVE_STOP') then 'SAFETY_BREACH'
          when v_previous_operational_decision = 'RESTRICT' then 'COMPLIANCE_RESTRICTION'
          else null
        end;

        if v_previous_kind is not null then
          insert into public.decision_alert_outbox (
            final_decision_id, project_id, activity_group_id, activity_id, kind, action, payload, evaluation_run_id
          )
          values (
            v_final_decision_id, p_project_id, p_activity_group_id, p_activity_id::uuid, v_previous_kind, 'CLOSE',
            jsonb_build_object(
              'shortReasonAr', p_final_decision->>'shortReasonAr',
              'decisionLabelAr', p_final_decision->>'decisionLabelAr',
              'level', p_final_decision->>'level'
            ),
            p_evaluation_run_id
          )
          on conflict (final_decision_id, kind, action) do nothing;
        end if;
      end if;
    end if;
  end if;

  return query select v_dvi_persisted, v_compliance_persisted, v_final_persisted;
end;
$$;


-- ---------------------------------------------------------------------
-- 3.9) ingest_device_reading_atomic — كتابة ذرّية V1 (legacy)
-- ---------------------------------------------------------------------
-- آخر نسخة فعلية: 202608040025 (يضيف p_pm10_observed_at لتصحيح توقيت
-- pm10_readings_history المستقل). تبقى معرَّفة توافقاً مع أي استدعاء
-- تاريخي/اختباري مباشر لها، لكن deviceReadingWriter.ts يستدعي
-- ingest_device_reading_and_event_atomic (أدناه) حصراً منذ 202608040027.
-- ⚠ ملاحظة تصميم مهمة: هذه الدالة **لا** تكتب p_is_late (لا يوجد معامل
-- لهذا في توقيعها النهائي — الميزة أُضيفت فقط للدالة الموحَّدة
-- ingest_device_reading_and_event_atomic في 202608060002). استدعاء مباشر
-- لهذه الدالة تحديداً على قراءة متأخرة سيُحدِّث last_*/_at كالمعتاد بلا
-- وسم is_late (يبقى عمود is_late الافتراضي false لكل صف يُكتَب عبرها).
create or replace function public.ingest_device_reading_atomic(
  p_project_id uuid,
  p_device_id uuid,
  p_external_event_id text,
  p_sequence_no bigint,
  p_observed_at timestamptz,
  p_received_at timestamptz,
  p_measurements jsonb,
  p_pm10_observed_at timestamptz default null
)
returns table (is_duplicate boolean, event_row_id uuid)
language plpgsql
security invoker
set search_path = pg_catalog, public
set lock_timeout = '8s'
as $$
declare
  v_event_row_id uuid;
  v_actual_project_id uuid;
  v_is_active boolean;
  v_project_archived_at timestamptz;
  v_has_measurement boolean;
  v_pm10_observed_at timestamptz;
begin
  if p_device_id is null or p_project_id is null then
    raise exception using errcode = '22023', message = 'device_id and project_id are required';
  end if;

  if p_observed_at is null or p_received_at is null then
    raise exception using errcode = '22023', message = 'observed_at and received_at are required';
  end if;

  if p_measurements is null or jsonb_typeof(p_measurements) <> 'object' then
    raise exception using errcode = '22023', message = 'measurements must be a JSON object';
  end if;

  v_pm10_observed_at := coalesce(p_pm10_observed_at, p_observed_at);

  select
    (p_measurements ? 'windSpeedKmh') or (p_measurements ? 'windGustKmh') or
    (p_measurements ? 'windDirectionDeg') or (p_measurements ? 'pm10') or
    (p_measurements ? 'pm25') or (p_measurements ? 'visibilityM') or
    (p_measurements ? 'relativeHumidityPercent') or (p_measurements ? 'temperatureC')
  into v_has_measurement;

  if not v_has_measurement then
    raise exception using errcode = '22023', message = 'at least one measurement is required';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('project:' || p_project_id::text, 0)
  );

  select archived_at into v_project_archived_at
  from public.projects
  where id = p_project_id;

  if v_project_archived_at is not null then
    raise exception using errcode = 'P0001', message = 'PROJECT_ARCHIVED';
  end if;

  select d.project_id, d.is_active
  into v_actual_project_id, v_is_active
  from public.project_devices d
  where d.id = p_device_id
  for update;

  if not found or v_actual_project_id <> p_project_id or not v_is_active then
    raise exception using errcode = '42501', message = 'device not found, revoked, or project mismatch';
  end if;

  insert into public.device_readings_history (
    project_id, device_id,
    wind_speed_kmh, wind_gust_kmh, wind_direction_deg,
    pm10_ug_m3, pm25_ug_m3, visibility_m,
    relative_humidity_percent, temperature_c,
    recorded_at, observed_at, received_at,
    external_event_id, sequence_no
  ) values (
    p_project_id, p_device_id,
    (p_measurements->>'windSpeedKmh')::numeric,
    (p_measurements->>'windGustKmh')::numeric,
    (p_measurements->>'windDirectionDeg')::numeric,
    (p_measurements->>'pm10')::numeric,
    (p_measurements->>'pm25')::numeric,
    (p_measurements->>'visibilityM')::numeric,
    (p_measurements->>'relativeHumidityPercent')::numeric,
    (p_measurements->>'temperatureC')::numeric,
    p_observed_at, p_observed_at, p_received_at,
    nullif(btrim(coalesce(p_external_event_id, '')), ''), p_sequence_no
  )
  on conflict (device_id, external_event_id) where external_event_id is not null
  do nothing
  returning id into v_event_row_id;

  if v_event_row_id is null and p_external_event_id is not null then
    select h.id into v_event_row_id
    from public.device_readings_history h
    where h.device_id = p_device_id
      and h.external_event_id = btrim(p_external_event_id);

    return query select true, v_event_row_id;
    return;
  end if;

  if p_measurements ? 'pm10' then
    insert into public.pm10_readings_history (
      project_id, device_id, pm10_ug_m3, source,
      recorded_at, observed_at, received_at,
      external_event_id, sequence_no
    ) values (
      p_project_id, p_device_id, (p_measurements->>'pm10')::numeric, 'device',
      v_pm10_observed_at, v_pm10_observed_at, p_received_at,
      nullif(btrim(coalesce(p_external_event_id, '')), ''), p_sequence_no
    )
    on conflict (device_id, external_event_id) where external_event_id is not null
    do nothing;
  end if;

  update public.project_devices d
  set
    last_received_at = greatest(coalesce(d.last_received_at, p_received_at), p_received_at),
    last_reading_at = greatest(coalesce(d.last_reading_at, p_received_at), p_received_at),

    last_wind_speed_kmh = case
      when p_measurements ? 'windSpeedKmh' and (d.last_wind_speed_at is null or p_observed_at >= d.last_wind_speed_at)
        then (p_measurements->>'windSpeedKmh')::numeric else d.last_wind_speed_kmh end,
    last_wind_speed_at = case
      when p_measurements ? 'windSpeedKmh' and (d.last_wind_speed_at is null or p_observed_at >= d.last_wind_speed_at)
        then p_observed_at else d.last_wind_speed_at end,

    last_wind_gust_kmh = case
      when p_measurements ? 'windGustKmh' and (d.last_wind_gust_at is null or p_observed_at >= d.last_wind_gust_at)
        then (p_measurements->>'windGustKmh')::numeric else d.last_wind_gust_kmh end,
    last_wind_gust_at = case
      when p_measurements ? 'windGustKmh' and (d.last_wind_gust_at is null or p_observed_at >= d.last_wind_gust_at)
        then p_observed_at else d.last_wind_gust_at end,

    last_wind_direction_deg = case
      when p_measurements ? 'windDirectionDeg' and (d.last_wind_direction_at is null or p_observed_at >= d.last_wind_direction_at)
        then (p_measurements->>'windDirectionDeg')::numeric else d.last_wind_direction_deg end,
    last_wind_direction_at = case
      when p_measurements ? 'windDirectionDeg' and (d.last_wind_direction_at is null or p_observed_at >= d.last_wind_direction_at)
        then p_observed_at else d.last_wind_direction_at end,

    -- last_pm10/last_pm10_at (project_devices) بقيتا عمداً بالوقت العام
    -- p_observed_at — للعرض فقط، لا مصدر حساب استمرار المخالفة الفعلي
    -- (ذاك pm10_readings_history أعلاه بـv_pm10_observed_at).
    last_pm10 = case
      when p_measurements ? 'pm10' and (d.last_pm10_at is null or p_observed_at >= d.last_pm10_at)
        then (p_measurements->>'pm10')::numeric else d.last_pm10 end,
    last_pm10_at = case
      when p_measurements ? 'pm10' and (d.last_pm10_at is null or p_observed_at >= d.last_pm10_at)
        then p_observed_at else d.last_pm10_at end,

    last_pm25 = case
      when p_measurements ? 'pm25' and (d.last_pm25_at is null or p_observed_at >= d.last_pm25_at)
        then (p_measurements->>'pm25')::numeric else d.last_pm25 end,
    last_pm25_at = case
      when p_measurements ? 'pm25' and (d.last_pm25_at is null or p_observed_at >= d.last_pm25_at)
        then p_observed_at else d.last_pm25_at end,

    last_visibility_m = case
      when p_measurements ? 'visibilityM' and (d.last_visibility_at is null or p_observed_at >= d.last_visibility_at)
        then (p_measurements->>'visibilityM')::numeric else d.last_visibility_m end,
    last_visibility_at = case
      when p_measurements ? 'visibilityM' and (d.last_visibility_at is null or p_observed_at >= d.last_visibility_at)
        then p_observed_at else d.last_visibility_at end,

    last_relative_humidity_percent = case
      when p_measurements ? 'relativeHumidityPercent' and (d.last_relative_humidity_at is null or p_observed_at >= d.last_relative_humidity_at)
        then (p_measurements->>'relativeHumidityPercent')::numeric else d.last_relative_humidity_percent end,
    last_relative_humidity_at = case
      when p_measurements ? 'relativeHumidityPercent' and (d.last_relative_humidity_at is null or p_observed_at >= d.last_relative_humidity_at)
        then p_observed_at else d.last_relative_humidity_at end,

    last_temperature_c = case
      when p_measurements ? 'temperatureC' and (d.last_temperature_at is null or p_observed_at >= d.last_temperature_at)
        then (p_measurements->>'temperatureC')::numeric else d.last_temperature_c end,
    last_temperature_at = case
      when p_measurements ? 'temperatureC' and (d.last_temperature_at is null or p_observed_at >= d.last_temperature_at)
        then p_observed_at else d.last_temperature_at end
  where d.id = p_device_id;

  return query select false, v_event_row_id;
end;
$$;


-- ---------------------------------------------------------------------
-- 3.10) ingest_device_event_v2 — كتابة ذرّية V2 (device_events/
--       device_measurements/device_metric_latest، وقت رصد مستقل لكل قياس)
-- ---------------------------------------------------------------------
-- آخر نسخة فعلية: 202608040024 (يعيد فرض قفل المشروع + فحص archived_at
-- بعد أن حذفتهما نسخة 202608040023/002 الوسيطة بالخطأ — راجع تعليق الملف
-- الأصلي: "بُنيت بالخطأ فوق نسخة الدالة القديمة، لا الأحدث"). تبقى معرَّفة
-- توافقاً مع استدعاء مباشر، لكن deviceReadingWriter.ts يستدعي الدالة
-- الموحَّدة (أدناه) حصراً منذ 202608040027.
create or replace function public.ingest_device_event_v2(
  p_project_id uuid,
  p_device_id uuid,
  p_external_event_id text,
  p_sequence_no bigint,
  p_received_at timestamptz,
  p_measurements jsonb
)
returns table (is_duplicate boolean, event_row_id uuid)
language plpgsql
security invoker
set search_path = pg_catalog, public
set lock_timeout = '8s'
as $$
declare
  v_event_row_id uuid;
  v_actual_project_id uuid;
  v_is_active boolean;
  v_project_archived_at timestamptz;
  v_metric text;
  v_point jsonb;
  v_value numeric;
  v_observed_at timestamptz;
  v_measurement_id uuid;
  v_has_measurement boolean := false;
begin
  if p_device_id is null or p_project_id is null then
    raise exception using errcode = '22023', message = 'device_id and project_id are required';
  end if;

  if p_received_at is null then
    raise exception using errcode = '22023', message = 'received_at is required';
  end if;

  if p_measurements is null or jsonb_typeof(p_measurements) <> 'object' then
    raise exception using errcode = '22023', message = 'measurements must be a JSON object';
  end if;

  if p_sequence_no is null then
    raise exception using errcode = '22023', message = 'sequence_no is required (non-negative integer)';
  end if;

  if p_sequence_no < 0 then
    raise exception using errcode = '22023', message = 'sequence_no must be non-negative';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('project:' || p_project_id::text, 0)
  );

  select archived_at into v_project_archived_at
  from public.projects
  where id = p_project_id;

  if v_project_archived_at is not null then
    raise exception using errcode = 'P0001', message = 'PROJECT_ARCHIVED';
  end if;

  select d.project_id, d.is_active
  into v_actual_project_id, v_is_active
  from public.project_devices d
  where d.id = p_device_id
  for update;

  if not found or v_actual_project_id <> p_project_id or not v_is_active then
    raise exception using errcode = '42501', message = 'device not found, revoked, or project mismatch';
  end if;

  insert into public.device_events (
    project_id, device_id, external_event_id, sequence_no, source, received_at
  ) values (
    p_project_id, p_device_id,
    nullif(btrim(coalesce(p_external_event_id, '')), ''),
    p_sequence_no, 'device', p_received_at
  )
  on conflict (device_id, external_event_id) where external_event_id is not null
  do nothing
  returning id into v_event_row_id;

  if v_event_row_id is null and p_external_event_id is not null then
    select e.id into v_event_row_id
    from public.device_events e
    where e.device_id = p_device_id
      and e.external_event_id = btrim(p_external_event_id);

    return query select true, v_event_row_id;
    return;
  end if;

  for v_metric, v_point in select * from jsonb_each(p_measurements)
  loop
    if v_point is null or jsonb_typeof(v_point) <> 'object' then
      continue;
    end if;

    v_value := (v_point->>'value')::numeric;
    v_observed_at := (v_point->>'observedAtIso')::timestamptz;
    if v_value is null or v_observed_at is null then
      continue;
    end if;

    v_has_measurement := true;

    insert into public.device_measurements (
      event_id, project_id, device_id, metric, value, observed_at, received_at
    ) values (
      v_event_row_id, p_project_id, p_device_id, v_metric, v_value, v_observed_at, p_received_at
    )
    returning id into v_measurement_id;

    insert into public.device_metric_latest (
      project_id, device_id, metric, value, observed_at, received_at, source_measurement_id, updated_at
    ) values (
      p_project_id, p_device_id, v_metric, v_value, v_observed_at, p_received_at, v_measurement_id, clock_timestamp()
    )
    on conflict (project_id, device_id, metric) do update
    set value = excluded.value,
        observed_at = excluded.observed_at,
        received_at = excluded.received_at,
        source_measurement_id = excluded.source_measurement_id,
        updated_at = clock_timestamp()
    where device_metric_latest.observed_at <= excluded.observed_at;
  end loop;

  if not v_has_measurement then
    raise exception using errcode = '22023', message = 'at least one valid measurement ({value, observedAtIso}) is required';
  end if;

  return query select false, v_event_row_id;
end;
$$;


-- ---------------------------------------------------------------------
-- 3.11) ingest_device_reading_and_event_atomic — دالة موحَّدة V1+V2
-- ---------------------------------------------------------------------
-- آخر نسخة فعلية: 202608060002 (يضيف p_is_late). أصل الدالة: 202608040027
-- (القسم "دمج كامل لمنطق V1+V2 داخل RPC ذرّي واحد" — خطأ حرج مُصلَح:
-- deviceReadingWriter.ts كان يستدعي V1 ثم V2 كاستدعاءين شبكة منفصلين
-- بمعاملتين مستقلتين، فشل الثاني كان يُبتلَع بصمت بلا rollback للأول،
-- فتتباعد مصادر "آخر قراءة PM10" بصمت). هذه الدالة هي المستدعاة فعلياً من
-- deviceReadingWriter.ts منذ 202608040027 — ingest_device_reading_atomic/
-- ingest_device_event_v2 أعلاه تبقيان فقط توافقاً تاريخياً.
--
-- p_is_late=true (202608060002 — "لا يجوز رفض قراءة متأخرة بالكامل، بل
-- تُسجَّل للتدقيق وتُمنَع من تغيير الحالة الحية"): يكتب device_readings_
-- history/pm10_readings_history بوسم is_late=true للتدقيق، لكن يتوقف قبل
-- أي تحديث لـproject_devices.last_*/device_metric_latest إطلاقاً — قراءة
-- وصلت متأخرة لا يجوز أن "تُثبت" حالة حية حالية.
create or replace function public.ingest_device_reading_and_event_atomic(
  p_project_id uuid,
  p_device_id uuid,
  p_external_event_id text,
  p_sequence_no bigint,
  p_observed_at timestamptz,
  p_received_at timestamptz,
  p_measurements jsonb,
  p_pm10_observed_at timestamptz default null,
  -- كل مفتاح {value, observedAtIso} مستقل لكل حقل — نفس صيغة p_measurements
  -- في ingest_device_event_v2. NULL/غائب = لا مصدر توقيت مستقل لأي حقل،
  -- تُستخدَم p_observed_at المشتركة كـfallback لكل حقل.
  p_measurements_v2 jsonb default null,
  p_is_late boolean default false
)
returns table (is_duplicate boolean, event_row_id uuid)
language plpgsql
security invoker
set search_path = pg_catalog, public
set lock_timeout = '8s'
as $$
declare
  v_event_row_id uuid;
  v_actual_project_id uuid;
  v_is_active boolean;
  v_project_archived_at timestamptz;
  v_has_measurement boolean;
  v_pm10_observed_at timestamptz;
  v_metric text;
  v_point jsonb;
  v_value numeric;
  v_observed_at_v2 timestamptz;
  v_measurement_id uuid;
  v_v2_event_row_id uuid;
begin
  if p_device_id is null or p_project_id is null then
    raise exception using errcode = '22023', message = 'device_id and project_id are required';
  end if;

  if p_observed_at is null or p_received_at is null then
    raise exception using errcode = '22023', message = 'observed_at and received_at are required';
  end if;

  if p_measurements is null or jsonb_typeof(p_measurements) <> 'object' then
    raise exception using errcode = '22023', message = 'measurements must be a JSON object';
  end if;

  if p_sequence_no is null then
    raise exception using errcode = '22023', message = 'sequence_no is required (non-negative integer)';
  end if;

  if p_sequence_no < 0 then
    raise exception using errcode = '22023', message = 'sequence_no must be non-negative';
  end if;

  v_pm10_observed_at := coalesce(p_pm10_observed_at, p_observed_at);

  select
    (p_measurements ? 'windSpeedKmh') or (p_measurements ? 'windGustKmh') or
    (p_measurements ? 'windDirectionDeg') or (p_measurements ? 'pm10') or
    (p_measurements ? 'pm25') or (p_measurements ? 'visibilityM') or
    (p_measurements ? 'relativeHumidityPercent') or (p_measurements ? 'temperatureC')
  into v_has_measurement;

  if not v_has_measurement then
    raise exception using errcode = '22023', message = 'at least one measurement is required';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('project:' || p_project_id::text, 0)
  );

  select archived_at into v_project_archived_at
  from public.projects
  where id = p_project_id;

  if v_project_archived_at is not null then
    raise exception using errcode = 'P0001', message = 'PROJECT_ARCHIVED';
  end if;

  select d.project_id, d.is_active
  into v_actual_project_id, v_is_active
  from public.project_devices d
  where d.id = p_device_id
  for update;

  if not found or v_actual_project_id <> p_project_id or not v_is_active then
    raise exception using errcode = '42501', message = 'device not found, revoked, or project mismatch';
  end if;

  -- ============================ الجزء الأول (V1) ============================
  insert into public.device_readings_history (
    project_id, device_id,
    wind_speed_kmh, wind_gust_kmh, wind_direction_deg,
    pm10_ug_m3, pm25_ug_m3, visibility_m,
    relative_humidity_percent, temperature_c,
    recorded_at, observed_at, received_at,
    external_event_id, sequence_no, is_late
  ) values (
    p_project_id, p_device_id,
    (p_measurements->>'windSpeedKmh')::numeric,
    (p_measurements->>'windGustKmh')::numeric,
    (p_measurements->>'windDirectionDeg')::numeric,
    (p_measurements->>'pm10')::numeric,
    (p_measurements->>'pm25')::numeric,
    (p_measurements->>'visibilityM')::numeric,
    (p_measurements->>'relativeHumidityPercent')::numeric,
    (p_measurements->>'temperatureC')::numeric,
    p_observed_at, p_observed_at, p_received_at,
    nullif(btrim(coalesce(p_external_event_id, '')), ''), p_sequence_no, coalesce(p_is_late, false)
  )
  on conflict (device_id, external_event_id) where external_event_id is not null
  do nothing
  returning id into v_event_row_id;

  if v_event_row_id is null and p_external_event_id is not null then
    select h.id into v_event_row_id
    from public.device_readings_history h
    where h.device_id = p_device_id
      and h.external_event_id = btrim(p_external_event_id);

    return query select true, v_event_row_id;
    return;
  end if;

  if p_measurements ? 'pm10' then
    insert into public.pm10_readings_history (
      project_id, device_id, pm10_ug_m3, source,
      recorded_at, observed_at, received_at,
      external_event_id, sequence_no, is_late
    ) values (
      p_project_id, p_device_id, (p_measurements->>'pm10')::numeric, 'device',
      v_pm10_observed_at, v_pm10_observed_at, p_received_at,
      nullif(btrim(coalesce(p_external_event_id, '')), ''), p_sequence_no, coalesce(p_is_late, false)
    )
    on conflict (device_id, external_event_id) where external_event_id is not null
    do nothing;
  end if;

  -- p_is_late=true يوقف تماماً هنا — device_readings_history/pm10_readings_
  -- history أعلاه سُجِّلا للتدقيق، لكن project_devices.last_*/device_metric_
  -- latest (القرار الحي) لا يعكسان قراءة وصلت متأخرة.
  if coalesce(p_is_late, false) then
    return query select false, v_event_row_id;
    return;
  end if;

  update public.project_devices d
  set
    last_received_at = greatest(coalesce(d.last_received_at, p_received_at), p_received_at),
    last_reading_at = greatest(coalesce(d.last_reading_at, p_received_at), p_received_at),

    last_wind_speed_kmh = case
      when p_measurements ? 'windSpeedKmh' and (d.last_wind_speed_at is null or p_observed_at >= d.last_wind_speed_at)
        then (p_measurements->>'windSpeedKmh')::numeric else d.last_wind_speed_kmh end,
    last_wind_speed_at = case
      when p_measurements ? 'windSpeedKmh' and (d.last_wind_speed_at is null or p_observed_at >= d.last_wind_speed_at)
        then p_observed_at else d.last_wind_speed_at end,

    last_wind_gust_kmh = case
      when p_measurements ? 'windGustKmh' and (d.last_wind_gust_at is null or p_observed_at >= d.last_wind_gust_at)
        then (p_measurements->>'windGustKmh')::numeric else d.last_wind_gust_kmh end,
    last_wind_gust_at = case
      when p_measurements ? 'windGustKmh' and (d.last_wind_gust_at is null or p_observed_at >= d.last_wind_gust_at)
        then p_observed_at else d.last_wind_gust_at end,

    last_wind_direction_deg = case
      when p_measurements ? 'windDirectionDeg' and (d.last_wind_direction_at is null or p_observed_at >= d.last_wind_direction_at)
        then (p_measurements->>'windDirectionDeg')::numeric else d.last_wind_direction_deg end,
    last_wind_direction_at = case
      when p_measurements ? 'windDirectionDeg' and (d.last_wind_direction_at is null or p_observed_at >= d.last_wind_direction_at)
        then p_observed_at else d.last_wind_direction_at end,

    last_pm10 = case
      when p_measurements ? 'pm10' and (d.last_pm10_at is null or p_observed_at >= d.last_pm10_at)
        then (p_measurements->>'pm10')::numeric else d.last_pm10 end,
    last_pm10_at = case
      when p_measurements ? 'pm10' and (d.last_pm10_at is null or p_observed_at >= d.last_pm10_at)
        then p_observed_at else d.last_pm10_at end,

    last_pm25 = case
      when p_measurements ? 'pm25' and (d.last_pm25_at is null or p_observed_at >= d.last_pm25_at)
        then (p_measurements->>'pm25')::numeric else d.last_pm25 end,
    last_pm25_at = case
      when p_measurements ? 'pm25' and (d.last_pm25_at is null or p_observed_at >= d.last_pm25_at)
        then p_observed_at else d.last_pm25_at end,

    last_visibility_m = case
      when p_measurements ? 'visibilityM' and (d.last_visibility_at is null or p_observed_at >= d.last_visibility_at)
        then (p_measurements->>'visibilityM')::numeric else d.last_visibility_m end,
    last_visibility_at = case
      when p_measurements ? 'visibilityM' and (d.last_visibility_at is null or p_observed_at >= d.last_visibility_at)
        then p_observed_at else d.last_visibility_at end,

    last_relative_humidity_percent = case
      when p_measurements ? 'relativeHumidityPercent' and (d.last_relative_humidity_at is null or p_observed_at >= d.last_relative_humidity_at)
        then (p_measurements->>'relativeHumidityPercent')::numeric else d.last_relative_humidity_percent end,
    last_relative_humidity_at = case
      when p_measurements ? 'relativeHumidityPercent' and (d.last_relative_humidity_at is null or p_observed_at >= d.last_relative_humidity_at)
        then p_observed_at else d.last_relative_humidity_at end,

    last_temperature_c = case
      when p_measurements ? 'temperatureC' and (d.last_temperature_at is null or p_observed_at >= d.last_temperature_at)
        then (p_measurements->>'temperatureC')::numeric else d.last_temperature_c end,
    last_temperature_at = case
      when p_measurements ? 'temperatureC' and (d.last_temperature_at is null or p_observed_at >= d.last_temperature_at)
        then p_observed_at else d.last_temperature_at end
  where d.id = p_device_id;

  -- ============================ الجزء الثاني (V2) ============================
  insert into public.device_events (
    project_id, device_id, external_event_id, sequence_no, source, received_at
  ) values (
    p_project_id, p_device_id,
    nullif(btrim(coalesce(p_external_event_id, '')), ''),
    p_sequence_no, 'device', p_received_at
  )
  on conflict (device_id, external_event_id) where external_event_id is not null
  do nothing
  returning id into v_v2_event_row_id;

  if v_v2_event_row_id is null and p_external_event_id is not null then
    null;
  else
    for v_metric, v_point in
      select * from jsonb_each(coalesce(p_measurements_v2, '{}'::jsonb))
    loop
      if v_point is null or jsonb_typeof(v_point) <> 'object' then
        continue;
      end if;

      v_value := (v_point->>'value')::numeric;
      v_observed_at_v2 := (v_point->>'observedAtIso')::timestamptz;
      if v_value is null or v_observed_at_v2 is null then
        continue;
      end if;

      insert into public.device_measurements (
        event_id, project_id, device_id, metric, value, observed_at, received_at
      ) values (
        v_v2_event_row_id, p_project_id, p_device_id, v_metric, v_value, v_observed_at_v2, p_received_at
      )
      returning id into v_measurement_id;

      insert into public.device_metric_latest (
        project_id, device_id, metric, value, observed_at, received_at, source_measurement_id, updated_at
      ) values (
        p_project_id, p_device_id, v_metric, v_value, v_observed_at_v2, p_received_at, v_measurement_id, clock_timestamp()
      )
      on conflict (project_id, device_id, metric) do update
      set value = excluded.value,
          observed_at = excluded.observed_at,
          received_at = excluded.received_at,
          source_measurement_id = excluded.source_measurement_id,
          updated_at = clock_timestamp()
      where device_metric_latest.observed_at <= excluded.observed_at;
    end loop;

    for v_metric in select jsonb_object_keys(p_measurements)
    loop
      if p_measurements_v2 is not null and p_measurements_v2 ? v_metric then
        continue;
      end if;

      v_value := (p_measurements->>v_metric)::numeric;
      if v_value is null then
        continue;
      end if;

      insert into public.device_measurements (
        event_id, project_id, device_id, metric, value, observed_at, received_at
      ) values (
        v_v2_event_row_id, p_project_id, p_device_id, v_metric, v_value, p_observed_at, p_received_at
      )
      returning id into v_measurement_id;

      insert into public.device_metric_latest (
        project_id, device_id, metric, value, observed_at, received_at, source_measurement_id, updated_at
      ) values (
        p_project_id, p_device_id, v_metric, v_value, p_observed_at, p_received_at, v_measurement_id, clock_timestamp()
      )
      on conflict (project_id, device_id, metric) do update
      set value = excluded.value,
          observed_at = excluded.observed_at,
          received_at = excluded.received_at,
          source_measurement_id = excluded.source_measurement_id,
          updated_at = clock_timestamp()
      where device_metric_latest.observed_at <= excluded.observed_at;
    end loop;
  end if;

  return query select false, v_event_row_id;
end;
$$;

-- الدالة القديمة (9 معاملات، بلا p_is_late) أُسقِطت صراحة في 202608060002
-- (drop function) بعد نشر النسخة 10 معاملات أعلاه — لا overload قديم متبقٍ.


-- ---------------------------------------------------------------------
-- 3.12) claim_evaluation_jobs / complete_evaluation_job / fail_evaluation_job
-- ---------------------------------------------------------------------
-- claim_evaluation_jobs آخر نسخة: 202608040028 (يضيف استرداد Lease منتهي
-- لصفوف RUNNING عالقة — خطأ حرج مُصلَح: النسخة الأصلية 202608040005 كانت
-- تفحص فقط PENDING/RETRY، فمهمة تعطّل عاملها (Crash/timeout) قبل استدعاء
-- complete/fail تبقى RUNNING للأبد بلا استرداد تلقائي).
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
  with union_ids as (
    select id
    from public.project_evaluation_jobs
    where status in ('PENDING', 'RETRY')
      and run_after <= clock_timestamp()
      and (lease_until is null or lease_until < clock_timestamp())
    union all
    select id
    from public.project_evaluation_jobs
    where status = 'RUNNING'
      and lease_until is not null
      and lease_until < clock_timestamp()
  ),
  candidates as (
    select id
    from public.project_evaluation_jobs
    where id in (select id from union_ids)
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


-- ---------------------------------------------------------------------
-- 3.13) create_alert_atomic / close_alert_atomic — إنشاء/إغلاق تنبيه ذرّي
-- ---------------------------------------------------------------------
-- create_alert_atomic آخر نسخة: 202608040029 (يكتب final_decision_id
-- فعلياً على alerts — كان معاملاً مُهمَلاً صامتاً منذ 202608040012 لأن
-- العمود لم يكن موجوداً على alerts بعد ذلك التاريخ).
create or replace function public.create_alert_atomic(
  p_project_id uuid,
  p_activity_id text,
  p_timing text,
  p_kind text,
  p_message text,
  p_viewer_message text,
  p_metric_label text,
  p_metric_actual text,
  p_metric_threshold text,
  p_recommended_action text,
  p_opened_by_final_decision_id uuid
)
returns uuid
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_alert_id uuid;
  v_existing_id uuid;
begin
  select id into v_existing_id
  from public.alerts
  where project_id = p_project_id
    and activity_id = p_activity_id
    and kind = p_kind
    and state <> 'CLOSED'
  order by created_at desc
  limit 1
  for update;

  if v_existing_id is not null then
    update public.alerts
    set final_decision_id = coalesce(p_opened_by_final_decision_id, final_decision_id)
    where id = v_existing_id;
    return v_existing_id;
  end if;

  insert into public.alerts (
    project_id, activity_source, activity_id, timing, kind, state, message,
    viewer_message, metric_label, metric_actual, metric_threshold, recommended_action,
    final_decision_id
  ) values (
    p_project_id, 'dust', p_activity_id, p_timing, p_kind, 'NEW', p_message,
    p_viewer_message, p_metric_label, p_metric_actual, p_metric_threshold, p_recommended_action,
    p_opened_by_final_decision_id
  )
  returning id into v_alert_id;

  insert into public.alert_state_events (alert_id, previous_state, new_state, actor_user_id)
  values (v_alert_id, null, 'NEW', null);

  return v_alert_id;
end;
$$;

-- close_alert_atomic (202608040026): يغلق أحدث تنبيه مفتوح (state <>
-- 'CLOSED') لنفس (project_id, activity_id, kind) عبر alert_state_events —
-- trigger alert_state_events_sync يحدّث alerts.state تلقائياً بعد الإدراج.
create or replace function public.close_alert_atomic(
  p_project_id uuid,
  p_activity_id text,
  p_kind text
)
returns uuid
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_alert_id uuid;
  v_current_state text;
begin
  select id, state into v_alert_id, v_current_state
  from public.alerts
  where project_id = p_project_id
    and activity_id = p_activity_id
    and kind = p_kind
    and state <> 'CLOSED'
  order by created_at desc
  limit 1
  for update;

  if v_alert_id is null then
    return null;
  end if;

  insert into public.alert_state_events (alert_id, previous_state, new_state, actor_user_id)
  values (v_alert_id, v_current_state, 'CLOSED', null);

  return v_alert_id;
end;
$$;


-- ---------------------------------------------------------------------
-- 3.14) claim_alert_outbox_batch / complete_alert_outbox_row /
--       fail_alert_outbox_row — طابور عامل الـOutbox (202608040026)
-- ---------------------------------------------------------------------
create or replace function public.claim_alert_outbox_batch(
  p_worker_id uuid,
  p_batch_size integer default 50,
  p_lease_seconds integer default 60
)
returns setof public.decision_alert_outbox
language sql
security invoker
set search_path = pg_catalog, public
as $$
  with union_ids as (
    select id
    from public.decision_alert_outbox
    where status in ('PENDING', 'RETRY')
      and available_at <= clock_timestamp()
    union all
    select id
    from public.decision_alert_outbox
    where status = 'RUNNING'
      and locked_until is not null
      and locked_until < clock_timestamp()
  ),
  candidates as (
    select id
    from public.decision_alert_outbox
    where id in (select id from union_ids)
    order by id
    for update skip locked
    limit greatest(1, p_batch_size)
  )
  update public.decision_alert_outbox o
  set status = 'RUNNING',
      locked_by = p_worker_id,
      locked_until = clock_timestamp() + make_interval(secs => greatest(1, p_lease_seconds))
  from candidates c
  where o.id = c.id
  returning o.*;
$$;

create or replace function public.complete_alert_outbox_row(
  p_row_id uuid,
  p_worker_id uuid,
  p_alert_id uuid
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
  set status = 'PROCESSED',
      alert_id = p_alert_id,
      processed_at = clock_timestamp(),
      locked_until = null,
      locked_by = null,
      last_error = null
  where id = p_row_id and locked_by = p_worker_id
  returning true into v_updated;

  return coalesce(v_updated, false);
end;
$$;

create or replace function public.fail_alert_outbox_row(
  p_row_id uuid,
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
  select attempts into v_attempts from public.decision_alert_outbox where id = p_row_id;
  if not found then
    return;
  end if;

  if v_attempts >= p_max_attempts then
    update public.decision_alert_outbox
    set status = 'DEAD',
        last_error = p_error,
        locked_until = null,
        locked_by = null
    where id = p_row_id;
  else
    update public.decision_alert_outbox
    set status = 'RETRY',
        attempts = attempts + 1,
        last_error = p_error,
        locked_until = null,
        locked_by = null,
        available_at = clock_timestamp() + make_interval(secs => least(600, power(2, v_attempts) * 5))
    where id = p_row_id;
  end if;
end;
$$;


-- ---------------------------------------------------------------------
-- 3.15) list_active_provider_connections — تفادي خلل schema cache لـPostgREST
-- ---------------------------------------------------------------------
-- آخر نسخة: 202608040033 (يضيف last_pull_at للعمود المُرجَع — provider-
-- pull/route.ts يحتاجه لطلب كل العينات منذ آخر سحب، لا آخر عينة فقط).
-- (202608040032 — خطأ تشغيلي مكتشَف في الإنتاج: PostgREST رفض رؤية عمود
-- credentials_ciphertext رغم تأكيد وجوده الفعلي عبر information_schema —
-- schema cache عالق. الحل: RPC تُنفَّذ داخل قاعدة البيانات مباشرة، لا عبر
-- آلية "قراءة قائمة أعمدة الجدول" المتأثرة بالخلل).
create or replace function public.list_active_provider_connections()
returns table (
  id uuid,
  device_id uuid,
  project_id uuid,
  provider text,
  credentials_ciphertext text,
  credentials_key_version integer,
  vendor_station_id text,
  provider_instance_id uuid,
  last_pull_at timestamptz
)
language sql
security invoker
set search_path = pg_catalog, public
stable
as $$
  select
    pc.id, pc.device_id, pc.project_id, pc.provider,
    pc.credentials_ciphertext, pc.credentials_key_version,
    pc.vendor_station_id, pc.provider_instance_id, pc.last_pull_at
  from public.provider_connections pc
  where pc.is_active = true
    and pc.vendor_station_id is not null;
$$;


-- ---------------------------------------------------------------------
-- 3.16) publish_rule_parameter_version / rollback_rule_parameter_version
-- ---------------------------------------------------------------------
-- (202608060003): نشر ذرّي — يتحقق من المدى الآمن (min_value/max_value)،
-- يُنهي (SUPERSEDED) النسخة PUBLISHED الحالية إن وُجدت، وينشئ النسخة
-- الجديدة PUBLISHED، كل ذلك في معاملة واحدة (قفل صف تعريف المعامل يمنع
-- نشرين متزامنين من التصادم).
create or replace function public.publish_rule_parameter_version(
  p_parameter_code text,
  p_value numeric,
  p_published_by uuid,
  p_change_reason_ar text,
  p_is_rollback boolean default false,
  p_rollback_to_version_id uuid default null
)
returns public.rule_parameter_versions
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_min numeric;
  v_max numeric;
  v_previous_id uuid;
  v_new_row public.rule_parameter_versions;
begin
  if p_change_reason_ar is null or btrim(p_change_reason_ar) = '' then
    raise exception using errcode = '22023', message = 'change_reason_ar إلزامي عند النشر';
  end if;

  select min_value, max_value into v_min, v_max
  from public.rule_parameter_definitions
  where code = p_parameter_code
  for update;

  if not found then
    raise exception using errcode = '23503', message = format('معامل غير معروف: %s', p_parameter_code);
  end if;

  if v_min is not null and p_value < v_min then
    raise exception using errcode = '22023', message = format('القيمة %s أقل من الحد الأدنى الآمن %s', p_value, v_min);
  end if;
  if v_max is not null and p_value > v_max then
    raise exception using errcode = '22023', message = format('القيمة %s أعلى من الحد الأقصى الآمن %s', p_value, v_max);
  end if;

  select id into v_previous_id
  from public.rule_parameter_versions
  where parameter_code = p_parameter_code and status = 'PUBLISHED';

  if v_previous_id is not null then
    update public.rule_parameter_versions
    set status = 'SUPERSEDED'
    where id = v_previous_id;
  end if;

  insert into public.rule_parameter_versions (
    parameter_code, value, status, effective_from, published_by, published_at,
    change_reason_ar, is_rollback, supersedes_version_id, created_by
  ) values (
    p_parameter_code, p_value, 'PUBLISHED', clock_timestamp(), p_published_by, clock_timestamp(),
    p_change_reason_ar, coalesce(p_is_rollback, false),
    coalesce(p_rollback_to_version_id, v_previous_id), p_published_by
  )
  returning * into v_new_row;

  return v_new_row;
end;
$$;

create or replace function public.rollback_rule_parameter_version(
  p_version_id uuid,
  p_published_by uuid,
  p_change_reason_ar text
)
returns public.rule_parameter_versions
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_target public.rule_parameter_versions;
  v_result public.rule_parameter_versions;
begin
  select * into v_target from public.rule_parameter_versions where id = p_version_id;
  if not found then
    raise exception using errcode = '23503', message = format('نسخة غير موجودة: %s', p_version_id);
  end if;

  select * into v_result from public.publish_rule_parameter_version(
    v_target.parameter_code, v_target.value, p_published_by, p_change_reason_ar, true, v_target.id
  );

  return v_result;
end;
$$;


-- =====================================================================
-- ============================ 4) الـ Triggers =========================
-- =====================================================================

-- append-only على جداول الأدلة (202607290004 + 202608030007 لـadmin_audit_log)
create trigger decision_records_immutable
  before update or delete on public.decision_records
  for each row execute function public.forbid_evidence_mutation();

create trigger dust_evaluations_immutable
  before update or delete on public.dust_evaluations
  for each row execute function public.forbid_evidence_mutation();

create trigger compliance_evaluations_immutable
  before update or delete on public.dust_compliance_evaluations
  for each row execute function public.forbid_evidence_mutation();

create trigger pm10_readings_history_immutable
  before update or delete on public.pm10_readings_history
  for each row execute function public.forbid_evidence_mutation();

create trigger alert_state_events_immutable
  before update or delete on public.alert_state_events
  for each row execute function public.forbid_evidence_mutation();

create trigger device_readings_history_immutable
  before update or delete on public.device_readings_history
  for each row execute function public.forbid_evidence_mutation();

create trigger final_decisions_immutable
  before update or delete on public.final_decisions
  for each row execute function public.forbid_evidence_mutation();

create trigger admin_audit_log_immutable
  before update or delete on public.admin_audit_log
  for each row execute function public.forbid_evidence_mutation();

-- alerts.state مشتق من alert_state_events (202607290004)
create trigger alert_state_events_sync
  after insert on public.alert_state_events
  for each row execute function public.sync_alert_state_from_event();

-- تعطيل تلقائي لـprovider_connections عند تعطيل project_devices (202608030003)
create trigger trg_cascade_device_deactivation
  after update on public.project_devices
  for each row
  execute function public.cascade_device_deactivation_to_provider_connections();

-- append-only لنسخ rule_parameter_versions المنشورة (202608060003)
create trigger trg_forbid_published_rule_parameter_mutation
  before update on public.rule_parameter_versions
  for each row
  execute function public.forbid_published_rule_parameter_mutation();

-- منع TRUNCATE على مستوى العبارة لكل جداول الأدلة (202608040014 — القسم
-- 5.9/14: forbid_evidence_mutation على مستوى الصف لا يمنع TRUNCATE).
create trigger decision_records_no_truncate
  before truncate on public.decision_records
  for each statement execute function public.forbid_evidence_truncate();
create trigger dust_evaluations_no_truncate
  before truncate on public.dust_evaluations
  for each statement execute function public.forbid_evidence_truncate();
create trigger dust_compliance_evaluations_no_truncate
  before truncate on public.dust_compliance_evaluations
  for each statement execute function public.forbid_evidence_truncate();
create trigger pm10_readings_history_no_truncate
  before truncate on public.pm10_readings_history
  for each statement execute function public.forbid_evidence_truncate();
create trigger alert_state_events_no_truncate
  before truncate on public.alert_state_events
  for each statement execute function public.forbid_evidence_truncate();
create trigger device_readings_history_no_truncate
  before truncate on public.device_readings_history
  for each statement execute function public.forbid_evidence_truncate();
create trigger final_decisions_no_truncate
  before truncate on public.final_decisions
  for each statement execute function public.forbid_evidence_truncate();
create trigger admin_audit_log_no_truncate
  before truncate on public.admin_audit_log
  for each statement execute function public.forbid_evidence_truncate();
create trigger device_events_no_truncate
  before truncate on public.device_events
  for each statement execute function public.forbid_evidence_truncate();
create trigger device_measurements_no_truncate
  before truncate on public.device_measurements
  for each statement execute function public.forbid_evidence_truncate();

-- منع TRUNCATE على decision_alert_outbox تحديداً (202608040031 — جدول
-- عامل نشط، لا يجوز إضافته لقائمة forbid_evidence_mutation/truncate أعلاه
-- التي تمنع UPDATE/DELETE أيضاً على مستوى الصف، فهذا يكسر عمل الـworker).
create trigger decision_alert_outbox_no_truncate
  before truncate on public.decision_alert_outbox
  for each statement execute function public.forbid_outbox_truncate();


-- =====================================================================
-- ==================== 5) GRANT / REVOKE النهائية =======================
-- =====================================================================
-- الفلسفة الثابتة عبر كل الملفات: anon/authenticated لا يملكان أي DML
-- مباشر (INSERT/UPDATE/DELETE/TRUNCATE) على أي جدول من هذه القاعدة —
-- الكتابة الفعلية الوحيدة تمر عبر service_role (supabaseAdmin) من
-- app/api/**. القراءة (SELECT) تُمنَح فقط حيث تحتاجها policy فعلية (RLS
-- تبقى المُصفّي الحقيقي)، أو تُسحَب صراحة حيث لا حاجة إطلاقاً.

-- ---------------------------------------------------------------------
-- 5.1) جداول بلا أي وصول لـanon/authenticated (service_role فقط)
-- ---------------------------------------------------------------------
revoke all on public.user_authorizations from anon, authenticated;
revoke all on public.project_devices from anon, authenticated;
revoke all on public.dust_evaluations from anon, authenticated;
revoke all on public.current_dust_decisions from anon, authenticated;
revoke all on public.dust_compliance_evaluations from anon, authenticated;
revoke all on public.current_dust_compliance_decisions from anon, authenticated;
revoke all on public.pm10_readings_history from anon, authenticated;
revoke all on public.weather_forecasts from anon, authenticated;
revoke all on public.sensitive_receptors from anon, authenticated;
revoke all on public.alert_state_events from anon, authenticated;
revoke all on public.device_readings_history from anon, authenticated;
revoke all on public.provider_connections from anon, authenticated;
revoke all on public.provider_instances from anon, authenticated;
revoke all on public.forecast_snapshots from anon, authenticated;
revoke all on public.project_evaluation_jobs from anon, authenticated;
revoke all on public.evaluation_runs from anon, authenticated;
revoke all on public.scheduler_locks from anon, authenticated;
revoke all on public.scheduler_heartbeat from anon, authenticated;
revoke all on public.decision_alert_outbox from anon, authenticated;
revoke all on public.activity_groups from anon, authenticated;
revoke all on public.rule_parameter_definitions from anon, authenticated;
revoke all on public.rule_parameter_versions from anon, authenticated;
-- device_events/device_measurements: append-only حتى عن service_role
-- لـUPDATE/DELETE (راجع REVOKE مخصَّص أدناه)، لكن SELECT/INSERT ممنوعان
-- كذلك عن anon/authenticated هنا.
revoke all on public.device_events from anon, authenticated;
revoke all on public.device_measurements from anon, authenticated;
revoke all on public.device_metric_latest from anon, authenticated;

-- ---------------------------------------------------------------------
-- 5.2) DML صريح مسحوب من anon/authenticated لجداول لها SELECT عبر RLS
--      (202608020003/202608030002 — سحب صريح على مستوى الجدول، لا فقط
--      الاعتماد على غياب policy توافقه)
-- ---------------------------------------------------------------------
revoke insert, update, delete, truncate, references, trigger
  on public.projects,
     public.project_shifts,
     public.project_dust_profiles,
     public.alerts,
     public.decision_records
  from anon, authenticated;

-- final_decisions: SELECT صريح فقط (يخدم policy final_decisions_owner_select
-- + اشتراك Realtime)، بلا أي DML.
grant select on public.final_decisions to authenticated;
revoke insert, update, delete, truncate, references, trigger
  on public.final_decisions from anon, authenticated;

-- alerts: SELECT صريح فقط (202608030002 — يخدم alerts_owner_select).
grant select on public.alerts to authenticated;

-- admin_audit_log: بلا أي policy وبلا أي منح — service_role فقط.
revoke all on public.admin_audit_log from anon, authenticated;

-- ---------------------------------------------------------------------
-- 5.3) profiles — تحديث مقيَّد بعمود فقط (202607290002)
-- ---------------------------------------------------------------------
revoke update on public.profiles from authenticated;
grant update (
  company_name,
  username,
  phone_number,
  role
) on public.profiles to authenticated;

-- alerts.state: يُمنع تحديثه المباشر (مشتق من alert_state_events فقط عبر
-- trigger — راجع 202607290004).
revoke update (state) on public.alerts from authenticated;

-- ---------------------------------------------------------------------
-- 5.4) append-only كامل — REVOKE TRUNCATE صريح حتى عن service_role
--      (202608040014/202608040031 — لا تعتمد سلامة الجدول على أن أحداً
--      لم ينسَ سحب TRUNCATE يدوياً؛ الحماية على مستوى الصلاحية والـtrigger
--      معاً)
-- ---------------------------------------------------------------------
revoke truncate on public.decision_records from anon, authenticated, service_role;
revoke truncate on public.dust_evaluations from anon, authenticated, service_role;
revoke truncate on public.dust_compliance_evaluations from anon, authenticated, service_role;
revoke truncate on public.pm10_readings_history from anon, authenticated, service_role;
revoke truncate on public.alert_state_events from anon, authenticated, service_role;
revoke truncate on public.device_readings_history from anon, authenticated, service_role;
revoke truncate on public.final_decisions from anon, authenticated, service_role;
revoke truncate on public.admin_audit_log from anon, authenticated, service_role;
revoke truncate on public.device_events from anon, authenticated, service_role;
revoke truncate on public.device_measurements from anon, authenticated, service_role;
revoke truncate on public.decision_alert_outbox from anon, authenticated, service_role;

-- device_events/device_measurements: append-only حتى عن service_role
-- لـUPDATE/DELETE تحديداً (202608040001) — الإدراج/القراءة فقط.
revoke update, delete on public.device_events from anon, authenticated, service_role;
revoke update, delete on public.device_measurements from anon, authenticated, service_role;
grant select, insert on public.device_events to service_role;
grant select, insert on public.device_measurements to service_role;
grant select, insert, update on public.device_metric_latest to service_role;

-- ---------------------------------------------------------------------
-- 5.5) service_role — منح صريح على الجداول التي لا تُقرَأ/تُكتَب إلا منه
-- ---------------------------------------------------------------------
grant select, insert, update on public.forecast_snapshots to service_role;
grant select, insert, update on public.project_evaluation_jobs to service_role;
grant select, insert, update on public.evaluation_runs to service_role;
grant select, insert, update on public.scheduler_heartbeat to service_role;
grant select, insert, update on public.decision_alert_outbox to service_role;
grant select, insert, update on public.activity_groups to service_role;
grant select, insert, update on public.provider_instances to service_role;
grant select, insert, update on public.rule_parameter_definitions to service_role;
grant select, insert, update on public.rule_parameter_versions to service_role;

-- ---------------------------------------------------------------------
-- 5.6) الدوال (RPCs) — REVOKE من PUBLIC ثم GRANT صريح لـservice_role فقط
-- ---------------------------------------------------------------------
-- "revoke all ... from anon, authenticated" وحده لا يكفي: PostgreSQL يمنح
-- EXECUTE على الدوال الجديدة لدور PUBLIC افتراضياً عند الإنشاء، وanon/
-- authenticated يرثانها عبر عضويتهما الضمنية في PUBLIC — لذلك: سحب صريح
-- عن PUBLIC أولاً، ثم منح صريح لـservice_role وحده، لكل دالة.

revoke execute on function public.persist_activity_decision_atomic(
  uuid, text, text, jsonb, text, timestamptz, jsonb, text,
  text, timestamptz, uuid, timestamptz, timestamptz, jsonb, timestamptz,
  uuid, text
) from public, anon, authenticated;
grant execute on function public.persist_activity_decision_atomic(
  uuid, text, text, jsonb, text, timestamptz, jsonb, text,
  text, timestamptz, uuid, timestamptz, timestamptz, jsonb, timestamptz,
  uuid, text
) to service_role;

revoke all on function public.ingest_device_reading_atomic(
  uuid, uuid, text, bigint, timestamptz, timestamptz, jsonb, timestamptz
) from public, anon, authenticated;
grant execute on function public.ingest_device_reading_atomic(
  uuid, uuid, text, bigint, timestamptz, timestamptz, jsonb, timestamptz
) to service_role;

revoke all on function public.ingest_device_event_v2(
  uuid, uuid, text, bigint, timestamptz, jsonb
) from public, anon, authenticated;
grant execute on function public.ingest_device_event_v2(
  uuid, uuid, text, bigint, timestamptz, jsonb
) to service_role;

revoke all on function public.ingest_device_reading_and_event_atomic(
  uuid, uuid, text, bigint, timestamptz, timestamptz, jsonb, timestamptz, jsonb, boolean
) from public, anon, authenticated;
grant execute on function public.ingest_device_reading_and_event_atomic(
  uuid, uuid, text, bigint, timestamptz, timestamptz, jsonb, timestamptz, jsonb, boolean
) to service_role;

revoke all on function public.archive_project_atomic(uuid, uuid) from public, anon, authenticated;
grant execute on function public.archive_project_atomic(uuid, uuid) to service_role;

revoke all on function public.claim_evaluation_jobs(uuid, integer, integer)
  from public, anon, authenticated;
grant execute on function public.claim_evaluation_jobs(uuid, integer, integer) to service_role;

revoke all on function public.complete_evaluation_job(uuid, uuid) from public, anon, authenticated;
grant execute on function public.complete_evaluation_job(uuid, uuid) to service_role;

revoke all on function public.fail_evaluation_job(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.fail_evaluation_job(uuid, text, integer) to service_role;

revoke all on function public.create_alert_atomic(
  uuid, text, text, text, text, text, text, text, text, text, uuid
) from public, anon, authenticated;
grant execute on function public.create_alert_atomic(
  uuid, text, text, text, text, text, text, text, text, text, uuid
) to service_role;

revoke all on function public.close_alert_atomic(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.close_alert_atomic(uuid, text, text) to service_role;

revoke all on function public.claim_alert_outbox_batch(uuid, integer, integer)
  from public, anon, authenticated;
grant execute on function public.claim_alert_outbox_batch(uuid, integer, integer) to service_role;

revoke all on function public.complete_alert_outbox_row(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.complete_alert_outbox_row(uuid, uuid, uuid) to service_role;

revoke all on function public.fail_alert_outbox_row(uuid, text, integer)
  from public, anon, authenticated;
grant execute on function public.fail_alert_outbox_row(uuid, text, integer) to service_role;

revoke all on function public.list_active_provider_connections() from public, anon, authenticated;
grant execute on function public.list_active_provider_connections() to service_role;

revoke all on function public.publish_rule_parameter_version(text, numeric, uuid, text, boolean, uuid)
  from public, anon, authenticated;
grant execute on function public.publish_rule_parameter_version(text, numeric, uuid, text, boolean, uuid) to service_role;

revoke all on function public.rollback_rule_parameter_version(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.rollback_rule_parameter_version(uuid, uuid, text) to service_role;

-- forbid_evidence_mutation/forbid_evidence_truncate/forbid_outbox_truncate/
-- sync_alert_state_from_event/cascade_device_deactivation_to_provider_
-- connections/forbid_published_rule_parameter_mutation: دوال trigger فقط،
-- لا تُستدعى مباشرة عبر RPC — لا حاجة لـGRANT EXECUTE صريح لـservice_role
-- (الـtrigger نفسه يُنفَّذ بصلاحيات مالك الجدول/الدالة تلقائياً)، لكن
-- Default Privileges أدناه (القسم 6) يسحب EXECUTE عنها من public/anon/
-- authenticated مثل أي دالة أخرى في المخطط.


-- =====================================================================
-- ============ 6) Default Privileges على مستوى المخطط ==================
-- =====================================================================
-- (202608040014 — القسم 14.3): يمنع أي جدول/دالة جديدة مستقبلاً من
-- الانفتاح تلقائياً بصلاحيات افتراضية لـpublic/anon/authenticated.
revoke create on schema public from public, anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;

alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated;

alter default privileges for role postgres in schema public
  revoke execute on functions from public, anon, authenticated;


-- =====================================================================
-- =============== 7) Supabase Realtime Publication ======================
-- =====================================================================
-- (202608020002/202608030004): final_decisions وalerts منضمّان لـ
-- supabase_realtime — يفعّل اشتراك WebSocket مباشر من المتصفح لتحديث
-- القرار/عدّاد التنبيهات فوراً بلا انتظار دورة polling.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'final_decisions'
  ) then
    alter publication supabase_realtime add table public.final_decisions;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'alerts'
  ) then
    alter publication supabase_realtime add table public.alerts;
  end if;
end $$;


-- =====================================================================
-- ==================== 8) ضبط autovacuum صريح ===========================
-- =====================================================================
-- (202608080001): جداول append-only عالية التكرار — autovacuum الافتراضي
-- (نسبة مئوية من حجم الجدول، ~20%) لا يعمل بفعالية على جداول تبدأ صغيرة
-- وتنمو باستمرار (bloat حقيقي شُوهد فعلياً: 402MB/74MB لجداول بـ12 صفاً
-- حياً فقط). عتبات أقل بكثير هنا صريحة بدل الاعتماد على الافتراضي.
alter table public.dust_evaluations set (
  autovacuum_vacuum_scale_factor = 0.05,
  autovacuum_analyze_scale_factor = 0.02
);

alter table public.dust_compliance_evaluations set (
  autovacuum_vacuum_scale_factor = 0.05,
  autovacuum_analyze_scale_factor = 0.02
);

alter table public.pm10_readings_history set (
  autovacuum_vacuum_scale_factor = 0.05,
  autovacuum_analyze_scale_factor = 0.02
);

alter table public.device_readings_history set (
  autovacuum_vacuum_scale_factor = 0.05,
  autovacuum_analyze_scale_factor = 0.02
);


-- =====================================================================
-- ========================= 9) بيانات أولية (Seed) ======================
-- =====================================================================
-- (202608060003): كتالوج المعاملات القابلة للضبط في محرك القواعد —
-- code_default_value مطابقة تماماً لقيمة كل ثابت في rulebook.ts/engine.ts
-- وقت كتابة الهجرة الأصلية. مُستبعَد صراحةً: عتبات PM10 التشغيلية/
-- التنظيمية (تبقى حصراً من ACTIVE_RULE_BUNDLE، طلب صريح من المستخدم)،
-- وعتبات تصنيف فئة المشروع.
insert into public.rule_parameter_definitions (code, label_ar, description_ar, unit, value_type, min_value, max_value, code_default_value) values
  ('CRUSHER_SENSITIVE_RECEPTOR_DISTANCE_M', 'مسافة الكسارة عن المستقبِل الحساس', 'الحد الأدنى لمسافة الكسارة عن أقرب مستقبِل حساس (سكني/مدرسي/صحي) — دون هذه المسافة تُفعَّل قاعدة CRUSHER-RECEPTOR-*.', 'متر', 'NUMBER', 0, 5000, 500),
  ('CRUSHER_GENERAL_RECEPTOR_DISTANCE_M', 'مسافة الكسارة عن المستقبِل العام', 'الحد الأدنى لمسافة الكسارة عن مستقبِل عام (غير حساس تحديداً).', 'متر', 'NUMBER', 0, 5000, 200),
  ('STOCKPILE_SENSITIVE_RECEPTOR_DISTANCE_M', 'مسافة أكوام المواد عن المستقبِل الحساس', 'الحد الأدنى لمسافة تخزين/أكوام المواد عن أقرب مستقبِل حساس.', 'متر', 'NUMBER', 0, 5000, 200),
  ('DEMOLITION_MAX_AREA_M2', 'أقصى مساحة هدم بلا ضوابط إضافية', 'مساحة الهدم التي تتجاوزها تستوجب ضوابط إضافية.', 'م²', 'NUMBER', 0, 100000, 100),
  ('IDLE_SURFACE_MAX_DAYS', 'أقصى مدة سطح مكشوف غير نشط', 'عدد الأيام التي يجوز أن يبقى فيها سطح مكشوف غير نشط بلا تغطية إلزامية.', 'يوم', 'INTEGER', 0, 90, 5),
  ('UNPAVED_SPEED_LIMIT_KMH', 'حد سرعة الطرق غير المرصوفة', 'الحد الأقصى لسرعة الشاحنات/المعدات على الطرق الداخلية غير المرصوفة.', 'كم/س', 'NUMBER', 0, 60, 10),
  ('PAVED_SPEED_LIMIT_KMH', 'حد سرعة الطرق المرصوفة', 'الحد الأقصى لسرعة الشاحنات/المعدات على الطرق الداخلية المرصوفة.', 'كم/س', 'NUMBER', 0, 60, 20),
  ('SPILL_CLEANUP_LIMIT_MIN', 'مهلة تنظيف الانسكاب', 'الحد الأقصى بالدقائق لتنظيف أي انسكاب مواد على الطرق.', 'دقيقة', 'INTEGER', 0, 120, 15),
  ('DROP_HEIGHT_NORMAL_LIMIT_M', 'أقصى ارتفاع تفريغ (ظروف عادية)', 'الحد الأقصى لارتفاع تفريغ المواد السائبة في الظروف العادية.', 'متر', 'NUMBER', 0, 10, 1.5),
  ('DROP_HEIGHT_HIGH_WIND_LIMIT_M', 'أقصى ارتفاع تفريغ (رياح عالية)', 'الحد الأقصى لارتفاع تفريغ المواد السائبة أثناء رياح 15-25 كم/س.', 'متر', 'NUMBER', 0, 10, 1),
  ('DEBRIS_PILE_MAX_HEIGHT_M', 'أقصى ارتفاع كومة مخلفات', 'الحد الأقصى المسموح لارتفاع أكوام مخلفات الهدم/البناء.', 'متر', 'NUMBER', 0, 20, 3),
  ('IMMERSION_ZONE_MIN_LENGTH_M', 'أقصر طول لمنطقة الغمر (غسيل الإطارات)', 'الحد الأدنى لطول منطقة غمر/غسيل إطارات المركبات عند نقاط الخروج.', 'متر', 'NUMBER', 0, 50, 8),
  ('WHEEL_WASH_CYCLE_MIN_SEC', 'أقل مدة دورة غسيل إطارات', 'الحد الأدنى بالثواني لدورة غسيل إطارات واحدة عند نقاط الخروج.', 'ثانية', 'INTEGER', 0, 300, 20),
  ('STONE_CUTTING_WIND_STOP_KMH', 'سرعة إيقاف قطع الأحجار المكشوف', 'سرعة الرياح التي يجب إيقاف قطع الأحجار المكشوف عندها إلزامياً.', 'كم/س', 'NUMBER', 0, 100, 15),
  ('BATCHING_PM10_FILTER_MIN_PERCENT', 'أدنى كفاءة فلتر PM10 لمحطة الخلط', 'الحد الأدنى لكفاءة فلتر PM10 في الصوامع/محطات الخلط المغلقة للاستمرار أثناء إيقاف الرياح.', '%', 'NUMBER', 0, 100, 99),
  ('IDLE_SURFACE_COVER_INSPECTION_WIND_KMH', 'سرعة فحص أغطية الأسطح المكشوفة', 'سرعة الرياح التي تستوجب فحص أغطية الأسطح غير النشطة وإصلاحها فوراً.', 'كم/س', 'NUMBER', 0, 100, 20),
  ('WIND_GATE_ENHANCED_MIN_KMH', 'بداية نطاق الرياح المعزَّز (15-25)', 'سرعة الرياح التي يبدأ عندها تفعيل التثبيط المعزَّز (النطاق البرتقالي).', 'كم/س', 'NUMBER', 0, 100, 15),
  ('WIND_GATE_STOP_KMH', 'بداية نطاق إيقاف الرياح (فوق 25)', 'سرعة الرياح التي يُوقَف عندها إلزامياً الأنشطة المكشوفة المولّدة للغبار.', 'كم/س', 'NUMBER', 0, 100, 25),
  ('WIND_GUST_SAFETY_THRESHOLD_KMH', 'حد هبّة الرياح الاحترازية', 'سرعة هبّة الرياح العابرة التي تستوجب احترازاً إضافياً بلا اعتبارها مخالفة.', 'كم/س', 'NUMBER', 0, 150, 50),
  ('CONFIDENCE_MIN_FOR_ALLOW', 'أدنى ثقة مطلوبة للسماح التلقائي', 'الحد الأدنى لدرجة ثقة DVI اللازمة لإصدار قرار سماح تلقائي بلا تحفّظ.', '%', 'NUMBER', 0, 100, 70)
on conflict (code) do nothing;

insert into public.scheduler_heartbeat (id) values (true) on conflict (id) do nothing;


-- =====================================================================
-- ==================== 10) تحقق ما بعد التشغيل ==========================
-- =====================================================================
-- بعد تشغيل هذا الملف على قاعدة فارغة، تحقق يدوياً:
--
--   select count(*) from information_schema.tables
--   where table_schema = 'public';
--
--   select count(*) from information_schema.routines
--   where routine_schema = 'public' and routine_type = 'FUNCTION';
--
--   select grantee, table_name, privilege_type
--   from information_schema.role_table_grants
--   where table_schema = 'public' and grantee in ('anon', 'authenticated')
--   order by table_name, privilege_type;
--   -- راجع أن كل صف مطابق للقسم 5 أعلاه فقط (SELECT محدود على عدد قليل من
--   -- الجداول، بلا أي INSERT/UPDATE/DELETE/TRUNCATE لـanon/authenticated
--   -- على أي جدول).
--
-- ثم قارن مخطط هذه القاعدة (pg_dump --schema-only) بمخطط قاعدة أخرى بُنيت
-- من تشغيل الـ62 ملف الأصلية بالترتيب — يجب أن يكون الفرق صفراً (باستثناء
-- ترتيب داخلي لا يؤثر على السلوك، مثل ترتيب الأعمدة الناتج عن ALTER TABLE
-- ADD COLUMN تراكمية مقابل CREATE TABLE مباشر بنفس الأعمدة).
-- =====================================================================
