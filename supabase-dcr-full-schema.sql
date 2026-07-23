-- =====================================================================
-- DCR (Dust Compliance & AEI) — المخطط الكامل لقاعدة البيانات
-- =====================================================================
-- هذا الملف هو المصدر الوحيد والكامل لمخطط قاعدة بيانات DCR، تطبيق
-- مستقل جديد استُخرج من مرقاب (مشروع مرجعي في c:\Users\ZAYED\mirqab-app)
-- ويغطي حصراً نطاق الغبار/الامتثال التنظيمي/AEI — بلا أي جدول أو عمود
-- خاص بالرافعات (crane) أو الإجهاد الحراري (heat)، والتي بقيت حصراً في
-- مرقاب.
--
-- الاستخدام: نفّذه دفعة واحدة (top-to-bottom) في SQL Editor الخاص
-- بمشروع Supabase فارغ تماماً وجديد. الملف يستخدم `create table if not
-- exists` في كل مكان فيمكن إعادة تنفيذه بأمان لو تعذّر إكماله من أول
-- مرة، لكنه مصمَّم لقاعدة بيانات لا تحتوي أياً من هذه الجداول أصلاً
-- (CREATE TABLE من الصفر، وليس ALTER TABLE فوق مخطط موجود مسبقاً كما في
-- ملفات مرقاب الأصلية).
--
-- خلفية: جداول مرقاب الأساسية (profiles, projects, alerts,
-- decision_records, project_dust_profiles) أُنشئت يدوياً عبر واجهة
-- Supabase dashboard ولا يوجد أي CREATE TABLE موثّق لها في أي ملف —
-- فقط ملفات ALTER TABLE incremental. لذلك تعريف هذه الجداول هنا مبني
-- على قراءة كاملة لكود مرقاب (كل مسارات app/api/**، صفحات إنشاء/إعدادات
-- المشروع، AddActivityModal، craneEvaluation.ts) لا على أي ملف SQL
-- واحد. الجداول التي كانت موثّقة أصلاً عبر ALTER TABLE (project_shifts،
-- dust_evaluations، dust_compliance_evaluations، sensitive_receptors)
-- أُعيد كتابتها هنا كـ CREATE TABLE واحد يجمع كل الأعمدة المتراكمة.
--
-- ترتيب الإنشاء أدناه يحترم الاعتماديات (foreign keys): profiles قبل
-- projects (لا تعتمد عليه فعلياً لكن نفس ترتيب مرقاب المنطقي)، projects
-- قبل كل الجداول الفرعية، project_dust_profiles قبل الجداول التي تشير
-- إليها (dust_evaluations، dust_compliance_evaluations)، وأخيراً
-- الجداول المستقلة (sensitive_receptors) وجداول القرار/التنبيه
-- (alerts، decision_records) التي تُنشأ في أي ترتيب بعد projects.
-- =====================================================================

-- امتداد pgcrypto لتوليد UUID عبر gen_random_uuid() — متوفر افتراضياً في
-- كل مشاريع Supabase، نفعّله صراحة للتأكد فقط.
create extension if not exists pgcrypto;


-- =====================================================================
-- 1) profiles — ملف تعريف المستخدم فوق auth.users
-- =====================================================================
-- المصدر: app/api/auth/register/route.ts (POST) — الأعمدة الأربعة
-- الأساسية (id, company_name, username, phone_number, role) هي بالضبط
-- ما يُدرَج هناك عند التسجيل. id مرتبط مباشرة بـ auth.users(id) وليس
-- عموداً مستقلاً (نفس نمط Supabase القياسي: "extend auth.users").
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  company_name text,
  username text unique,
  phone_number text,
  role text,
  -- صلاحية "سوبر أدمن" — مصدرها supabase-add-super-admin.sql في مرقاب،
  -- حيث تتحكم بالوصول لصفحة سجل قواعد محركات القرار (heat/dust/crane)
  -- عبر كل مشاريع كل المستخدمين. DCR الحالي لا يملك ميزة admin/rules
  -- مكافئة في نطاقه الأولي، فهذا العمود غير مُستهلَك فعلياً بعد — أُبقي
  -- عليه فقط تحسباً لإضافة صفحة مشابهة لاحقاً (future-proofing)، بلا أي
  -- مسار في الواجهة أو الـ API لتفعيله ذاتياً (يُمنح يدوياً عبر SQL
  -- Editor فقط، تماماً كما في مرقاب).
  is_super_admin boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "profiles_owner_all" on public.profiles;
create policy "profiles_owner_all"
  on public.profiles for all
  to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);


-- =====================================================================
-- 2) projects — المشروع الأساسي + ملف امتثال الغبار التنظيمي الكامل
-- =====================================================================
-- المصادر المدمجة هنا في CREATE TABLE واحد:
--   • الأعمدة الأساسية (identity/location/scheduling): استُنتجت من
--     app/api/projects/route.ts (POST insert)، app/dashboard/Projects/
--     create/page.tsx (حمولة الحفظ الكاملة)، وapp/dashboard/Projects/
--     [id]/settings/page.tsx (حقول القراءة/التعديل).
--   • zone_type/zone_polygon/zone_radius_m: supabase-project-zone-migration.sql
--   • soil_type/monitoring_station_locations/data_accuracy_confirmed*:
--     supabase-project-create-form-enhancements-migration.sql
--   • site_area_m2 .. sensitivity_map_prepared (كتلة امتثال الغبار
--     التنظيمي): supabase-dust-compliance-migration.sql (القسم 1)
-- لا يوجد أي عمود crane_*/heat_* هنا (مستبعدة عمداً من نطاق DCR).
create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,

  -- هوية المشروع الأساسية — create/page.tsx + settings/page.tsx
  name text not null,
  client_name text,
  city text,
  neighborhood text,
  -- 'not_started' | 'in_progress' — توحيد قيم قديمة متعددة إلى قيمتين
  -- فقط (راجع normalizedStatus في settings/page.tsx)
  project_status text not null default 'not_started',
  project_type text,
  -- حقل نصي حر قديم لطبيعة الموقع الإنشائية — يبقى منفصلاً عن
  -- site_location_nature (قائمة اختيار محددة أدناه) لأغراض توافق خلفي،
  -- كلاهما مُستخدم فعلياً في settings/page.tsx.
  site_nature text,
  -- نوع التربة: SANDY_FINE / SANDY_COARSE / CLAY / MIXED — قائمة اختيار
  -- محددة (supabase-project-create-form-enhancements-migration.sql)
  soil_type text,

  -- الموقع الجغرافي — نقطة تمثيلية (centroid المضلع أو مركز الدائرة)
  -- يعتمد عليها مباشرة كل من محرك الغبار وجلب الطقس
  latitude numeric,
  longitude numeric,
  coordinates text,
  -- منطقة المشروع الكاملة (zone) — مضلع حر أو دائرة بنصف قطر، بدل نقطة
  -- واحدة فقط. مصدر: supabase-project-zone-migration.sql
  zone_type text,        -- 'polygon' | 'circle' | null (مشروع قديم بنقطة فقط)
  zone_polygon jsonb,     -- [{lat, lng}, ...] عند zone_type='polygon'
  zone_radius_m numeric,  -- بالمتر عند zone_type='circle'؛ المركز = latitude/longitude

  -- بيانات الموقع الإضافية — create/page.tsx (حقول site_location_nature/
  -- wind_exposure/terrain_type)
  site_location_nature text,
  wind_exposure text default 'medium',
  terrain_type text default 'suburban',

  -- الجدولة والعمل
  start_date date,
  end_date date,
  work_days text,                          -- نص عربي معروض (مشتق من work_days_list)
  work_days_list jsonb default '[]'::jsonb, -- ['sun','mon',...] بمعرّفات ثابتة (0=الأحد)
  work_hours_start time,
  work_hours_end time,
  project_manager text,
  -- رقم E.164 كامل (مثال: +966501234567) — راجع isValidInternationalPhone
  contact_number text,

  -- ============================================================
  -- ملف امتثال الغبار التنظيمي (Riyadh Dust Compliance) للمشروع —
  -- مصدر: supabase-dust-compliance-migration.sql القسم 1 (كامل)
  -- ============================================================
  site_area_m2 numeric,
  daily_truck_movements integer,
  has_onsite_crusher boolean,
  has_onsite_batching_plant boolean,
  -- حالة اعتماد خطة إدارة الغبار (DMP): NOT_REQUIRED / NOT_STARTED /
  -- DRAFT / SUBMITTED / APPROVED / REJECTED / UNKNOWN
  dmp_approval_status text default 'UNKNOWN',
  dmp_submitted_at timestamptz,
  dmp_approved_at timestamptz,
  baseline_monitoring_days integer,
  monitoring_station_count integer,
  monitoring_logging_interval_minutes integer,
  anemometer_height_m numeric,
  entry_exit_cameras_installed boolean,
  camera_retention_days integer,
  sensitivity_map_prepared boolean,
  -- مواقع محطات رصد الغبار/PM10 — [{lat, lng, label}]، مصدر:
  -- supabase-project-create-form-enhancements-migration.sql
  monitoring_station_locations jsonb default '[]'::jsonb,

  -- إقرار المستخدم بصحة البيانات وتحمّل المسؤولية — نفس الملف أعلاه
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
-- مصدر: supabase-project-shifts-migration.sql (مطابق حرفياً، بما فيه
-- سياسة RLS shifts_owner_all — هذا الجدول يُقرأ ويُكتب من عميل المتصفح
-- مباشرة، لا فقط عبر service_role).
-- work_hours_start/work_hours_end في projects أعلاه يبقيان "الدوام
-- الافتراضي" لمشروع بلا ورديات مخصصة — لا تعارض بين الاثنين.
create table if not exists public.project_shifts (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  name text not null,
  start_time time not null,
  end_time time not null,
  -- يحفظ ترتيب إدخال المستخدم للورديات (لا ترتيباً أبجدياً/زمنياً مفروضاً)
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
-- 4) project_dust_profiles — أكبر جدول: صف واحد لكل نشاط غبار/امتثال
-- =====================================================================
-- هذا الجدول لم يكن موثقاً بـ CREATE TABLE أصلي في أي مكان بمرقاب (فقط
-- ALTER TABLE incremental) — تعريفه هنا مبني على دمج كل الأعمدة من:
--   • القاعدة الفيزيائية (DVI): app/components/AddActivityModal/
--     constants.ts (DUST_FORM_DEFAULTS) + app/lib/craneEvaluation.ts
--     (buildDustInput) + app/api/dust-profiles/route.ts — activity_type
--     وحقول site.* (has_earthworks..open_concrete_pour) وonsite_*
--   • activity_lat/activity_lng: supabase-activity-location-migration.sql
--   • shift_id: supabase-project-shifts-migration.sql
--   • regulatory_activity + is_dust_generating..idle_surface_stabilized
--     + القياسات (demolition_active_area_m2..visible_trackout_beyond_15m):
--     supabase-dust-compliance-migration.sql (القسم 2)
--   • surface_watered/exposed_soil_area_m2: A1-camera-migration.sql
--   • silos_sealed..idle_surface_cover_intact: a6-a4-migration.sql
--   • batching_lat/batching_lng: batching-crusher-multi-unit-migration.sql
--   • stockpile_lat/stockpile_lng: stockpile-receptor-migration.sql
--   • كل أعمدة A1..A5 + الهدم/الكسارات/قطع الأحجار/نقل المخلفات
--     (truck_routes_designated .. debris_pile_height_m):
--     full-questionnaire-migration.sql (الأضخم، يغطي معظم الأعمدة)
--   • aei_score/aei_status: غير موثّقين في أي ملف migration — استُنتجا
--     من buildDustBaseInsert في AddActivityModal/index.tsx حيث يُحفظ
--     ناتج evaluateAei(...) مباشرة على نفس صف project_dust_profiles.
create table if not exists public.project_dust_profiles (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  -- يربط عدة صفوف project_dust_profiles (نشاط تنظيمي واحد لكل صف) بنفس
  -- النشاط الفيزيائي الواحد (نفس الوقت/الموقع) عند إضافة أكثر من نشاط
  -- تنظيمي في نفس الجلسة عبر AddActivityModal
  activity_group_id text,
  -- أي وردية (project_shifts) يتبعها هذا النشاط — null = الدوام الافتراضي
  shift_id uuid references public.project_shifts(id) on delete set null,

  -- ============================================================
  -- التصنيف الفيزيائي + الجدولة (DVI الأساسي)
  -- ============================================================
  activity_type text not null,             -- ActivityCategory (مثال: GRADING, EXCAVATION...)
  activity_lat numeric,                    -- موقع النشاط المستقل (داخل zone المشروع)
  activity_lng numeric,
  planned_date date,
  planned_time time,
  duration_hours numeric,

  -- ============================================================
  -- عوامل موقع/سطح مولّدة للغبار (DustEngineInput.site) — الأعمدة
  -- الفيزيائية الأصلية للنشاط، تُستخدم في buildDustInput/DustStep
  -- ============================================================
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
  receptor_type text,                      -- ReceptorType (مثال: NONE_NEARBY)
  receptor_distance text,                  -- DistanceBand (مثال: OVER_500M)
  receptor_is_downwind boolean,
  visible_dust_plume_reported boolean,
  open_concrete_pour boolean,
  onsite_visibility_m numeric,
  onsite_pm10 numeric,
  onsite_pm25 numeric,

  -- نتيجة AEI (Activity Executability Index) المحسوبة وقت الحفظ —
  -- استُنتجت من buildDustBaseInsert، غير موثّقة بملف migration منفصل
  aei_score numeric,
  aei_status text,

  -- ============================================================
  -- محرك الامتثال التنظيمي (Riyadh Dust Compliance) — أعمدة عامة على
  -- مستوى النشاط التنظيمي (مصدر: dust-compliance-migration.sql §2)
  -- ============================================================
  regulatory_activity text default 'OTHER', -- RegulatoryActivityKey (EARTHWORKS/SITE_TRAFFIC/...)
  is_dust_generating boolean default true,
  is_enclosed_operation boolean default false,
  is_active_or_planned boolean default true,
  -- ضوابط التحكم (DustControlEvidence)
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
  -- قياسات (DustActivityMeasurements)
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

  -- ============================================================
  -- A1 — تجهيز الموقع وأعمال الحفر والأعمال الترابية
  -- (a1-camera-migration.sql + full-questionnaire-migration.sql)
  -- ============================================================
  surface_watered boolean,
  exposed_soil_area_m2 numeric,
  truck_routes_designated boolean,
  path_cover_material text,                -- GRAVEL/RECYCLED_ASPHALT/STABILIZER/OTHER/NONE
  water_spray_method text,                 -- SPRAY/FLOODING
  soil_compacted_after_excavation boolean,
  stabilizer_used_during_pause boolean,
  pause_duration_over_5_days boolean,
  spray_used_during_soil_unloading boolean,
  work_area_phased boolean,

  -- ============================================================
  -- A2 — النقل داخل الموقع والطرق الخدمية
  -- ============================================================
  unpaved_roads_watered_daily boolean,
  dust_control_method text,                -- WATER_SPRAY/SUPPRESSANT/BOTH/NONE
  speed_limit_signs_posted boolean,
  containers_covered_before_moving boolean,
  containers_inspected_before_departure boolean,
  load_height_exceeds_container_limit boolean,
  adjacent_roads_swept_mechanically boolean,
  sweep_frequency_band text,               -- HOURLY/DAILY/LESS_THAN_REQUIRED/NOT_SWEPT
  wheel_wash_at_exit boolean,
  wheel_wash_maintained_regularly boolean,
  wash_water_recycled boolean,
  all_loads_covered boolean,
  trucks_inspected_before_departure boolean,
  load_side_coverage_adequate boolean,
  public_roads_vacuum_swept_daily boolean,
  water_used_routinely_for_cleaning boolean,

  -- ============================================================
  -- A3 — منطقة الدخول والخروج للمشروع
  -- ============================================================
  entry_point_lat numeric,
  entry_point_lng numeric,
  exit_point_lat numeric,
  exit_point_lng numeric,
  access_road_paved boolean,
  tire_cleaning_method text,               -- WHEEL_WASH/WATER_IMMERSION
  sand_trap_present boolean,
  oil_separator_present boolean,
  wash_cycle_duration_adequate boolean,
  wheel_wash_operation_method text,        -- AUTO_SENSOR/MANUAL_PRESSURE
  wash_water_reused boolean,
  anti_slip_mesh_present boolean,
  immersion_zone_length_adequate boolean,
  collection_basin_present boolean,
  truck_path_cleaned_within_15_min boolean,
  water_traces_beyond_15m_from_gate boolean,

  -- ============================================================
  -- A4 — تخفيف تطاير الغبار الناتج عن هبوب الرياح (أسطح غير نشطة)
  -- ============================================================
  idle_surface_cover_intact boolean,       -- a6-a4-migration.sql
  exposed_area_currently_idle boolean,
  stabilization_method text,               -- POLYMERS/PROTECTIVE_COVERS/BOTH/OTHER
  stockpile_area_exists boolean,
  suppressant_used_at_stockpile_area boolean,
  wind_barriers_near_stockpiles boolean,
  construction_scheduled_immediately_after_prep boolean,

  -- ============================================================
  -- A5 — تحميل/تنزيل/تخزين المواد (أكوام) + محطة خلط خرساني (A6)
  -- ============================================================
  stockpile_lat numeric,                   -- stockpile-receptor-migration.sql
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

  -- A6 — محطة خلط الخرسانة (batching plant) — وحدة واحدة لكل صف، موقعها
  -- مستقل عن stockpile_lat/lng (batching-crusher-multi-unit-migration.sql)
  batching_lat numeric,
  batching_lng numeric,
  silos_sealed boolean,
  pm10_filter_efficiency_percent numeric,
  leak_detected boolean,
  dry_cleaning_method_used boolean,

  -- ============================================================
  -- مصادر الغبار الأخرى (استكمال BATCHING_PLANT)
  -- ============================================================
  filter_maintenance_performed_regularly boolean,
  leak_prevention_inspected_regularly boolean,
  suppression_system_checked_daily boolean,
  manual_dry_sweeping_banned boolean,
  compressed_air_banned boolean,
  site_cleaning_method text,               -- MECHANICAL_WATER_SWEEP/MANUAL_SWEEP/COMPRESSED_AIR/OTHER
  waste_humidity_maintained_during_transport boolean,
  waste_loads_covered boolean,

  -- ============================================================
  -- الهدم (Demolition)
  -- ============================================================
  spray_cannon_range_band text,            -- M20/M30/UNDER_20/UNAVAILABLE
  crushers_covered_demolition boolean,
  loading_points_have_sprinklers boolean,
  demolition_cutting_method text,          -- WATER_FED_SAWS/EXTRACTION_SYSTEMS/ORDINARY_TOOLS
  sandblasting_used boolean,
  sandblasting_in_enclosed_box boolean,

  -- ============================================================
  -- الكسارات (Crusher) — وحدة واحدة لكل صف، موقعها الخاص
  -- ============================================================
  crusher_lat numeric,
  crusher_lng numeric,
  crusher_units_fully_covered boolean,
  loading_points_have_spray_systems boolean,
  spray_cannons_around_crusher boolean,
  conveyors_covered_crusher boolean,
  drop_height_reduced_at_crusher boolean,
  suction_and_filtration_systems_present boolean,
  critical_schedule_applies boolean,

  -- ============================================================
  -- قطع الأحجار (Stone Cutting)
  -- ============================================================
  cutting_residues_cleaned_after_completion boolean,

  -- ============================================================
  -- نقل مخلفات الهدم والبناء (C&D Waste Transport)
  -- ============================================================
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
-- 5) dust_evaluations / current_dust_decisions — محرك DVI الفيزيائي
-- =====================================================================
-- مصدر: supabase-heat-dust-evaluations.sql — النصف الخاص بالغبار فقط
-- (heat_evaluations/current_heat_decisions مُستبعدان، خاصان بمرقاب فقط).
-- insert-only لكل تقييم + جدول "القرار الحالي الفعّال" منفصل يُقرأ منه
-- مباشرة بدل إعادة تشغيل المحرك (وطلبات الطقس الخارجية) في كل مرة.
create table if not exists public.dust_evaluations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  dust_profile_id uuid not null references public.project_dust_profiles(id) on delete cascade,
  activity_group_id text,
  result jsonb not null,              -- DviEvaluationResult (windowEval.worst) كامل
  triggered_by text not null,         -- 'user_refresh' | 'scheduled_recheck' | ...
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

-- لا سياسات RLS على هذين الجدولين — نفس قرار مرقاب الأصلي: كل القراءة/
-- الكتابة تمر حصراً عبر service_role من داخل app/api/** بعد تحقق ملكية
-- صريح (verifyProjectOwnership)، ولا يُستدعيان من عميل المتصفح مباشرة.
alter table public.dust_evaluations enable row level security;
alter table public.current_dust_decisions enable row level security;


-- =====================================================================
-- 6) dust_compliance_evaluations / current_dust_compliance_decisions —
--    طبقة الامتثال التنظيمي (منفصلة تماماً عن DVI الفيزيائي أعلاه)
-- =====================================================================
-- مصدر: supabase-dust-compliance-migration.sql القسم 3 — نفس نمط
-- dust_evaluations/current_dust_decisions تماماً، لكن في جدولين منفصلين
-- حتى لا يختلط قرار الامتثال التنظيمي بقرار DVI الفيزيائي.
create table if not exists public.dust_compliance_evaluations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  dust_profile_id uuid not null references public.project_dust_profiles(id) on delete cascade,
  activity_group_id text,
  result jsonb not null,              -- DustComplianceResult كامل
  rulebook_version text not null,
  triggered_by text not null,         -- 'user_refresh' | 'scheduled_recheck' | ...
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
  updated_at timestamptz not null default now()
);
create index if not exists idx_current_dust_compliance_decisions_project_id on public.current_dust_compliance_decisions (project_id);

-- لا سياسات RLS هنا أيضاً — نفس المنطق (service_role فقط من app/api/**)
alter table public.dust_compliance_evaluations enable row level security;
alter table public.current_dust_compliance_decisions enable row level security;


-- =====================================================================
-- 7) sensitive_receptors — مستقبِلات حساسة (مدارس/مستشفيات/سكني/مساجد)
-- =====================================================================
-- مصدر: supabase-dust-compliance-full-questionnaire-migration.sql —
-- تُستخدم لحساب مسافة الكسارة/محطة الخلط عن أقرب مستقبل حساس تلقائياً
-- (بدل سؤال المستخدم مباشرة عن الإجابة). جدول عام على مستوى النظام (لا
-- يتبع مشروعاً واحداً) لأن نفس المستقبلات قد تُستخدم لأكثر من مشروع في
-- نفس المدينة.
create table if not exists public.sensitive_receptors (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  receptor_type text not null default 'OTHER',
  lat numeric not null,
  lng numeric not null,
  created_at timestamptz not null default now()
);

-- لا سياسات RLS مطلوبة هنا بنفس منطق dust_compliance_evaluations: القراءة
-- تمر حصراً عبر service_role من داخل app/api/** ولا يُستدعى هذا الجدول
-- من عميل المتصفح مباشرة.
alter table public.sensitive_receptors enable row level security;


-- =====================================================================
-- 8) alerts — تنبيهات مولَّدة تلقائياً (قبل/أثناء التنفيذ)
-- =====================================================================
-- مصدر: app/api/alerts/generate/route.ts (insertAlert + التعليق العلوي
-- الموثِّق لأعمدة الجدول). activity_source مقيَّد بـ CHECK على 'dust'
-- فقط — DCR لا يملك أنشطة heat/crane، بعكس مرقاب حيث تشمل القيمة
-- 'heat'/'crane' أيضاً.
create table if not exists public.alerts (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  activity_source text not null default 'dust' check (activity_source = 'dust'),
  activity_id text not null,           -- نص لا uuid: يُقارَن بـ String(row.id) في الكود
  timing text not null,                -- 'BEFORE' | 'DURING'
  kind text not null,                  -- BEFORE_2H / BEFORE_1H / BEFORE_START / DUST / SAFETY_BREACH / NO_DECISION_YET
  state text not null default 'NEW',   -- NEW / ... / CLOSED
  message text not null,
  metric_label text,
  metric_actual text,
  metric_threshold text,
  recommended_action text,
  assignee text,
  created_at timestamptz not null default now()
);

-- فهارس مطابقة لأنماط الاستعلام الفعلية في alerts/generate/route.ts
-- (alertExists: activity_source+activity_id+kind، وتصفية state != CLOSED)
-- ودوال القراءة الأخرى (project_id+state في لوحات التحكم).
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


-- =====================================================================
-- 9) decision_records — قرارات موثَّقة يدوياً (اعتماد/تأجيل/تقييد/إيقاف)
-- =====================================================================
-- مصدر: app/api/decisions/route.ts (GET/POST) + حمولة الإدراج الفعلية في
-- app/components/dashborad/projectdashborad/MultiIndicatorActivityBox.tsx
-- (saveDecision). activity_source مقيَّد بـ CHECK على 'dust' فقط لنفس
-- سبب alerts أعلاه.
create table if not exists public.decision_records (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  activity_source text not null default 'dust' check (activity_source = 'dust'),
  activity_id text not null,           -- نص لا uuid: يُقارَن بـ String(activityId) في الكود
  -- 'safe' | 'caution' | 'restricted' | 'postpone' | 'stopped' —
  -- راجع decisionStatusLabel في app/api/projects/[projectId]/route.ts
  status text not null,
  reason text,
  required_action text,
  -- هوية من اتّخذ القرار — نص حر يُرسَل من الواجهة (حالياً قيمة ثابتة
  -- "مستخدم النظام (مدير الموقع)"، لا مرتبط بجدول profiles عبر FK)
  approved_by text,
  approval_note text,
  -- لقطة الظروف الجوية/المقاييس وقت اتخاذ القرار — مصفوفة
  -- [{label, value}, ...] تُبنى في route.ts (decisionTargets.weatherSnapshot)
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
-- نهاية الملف — تحقق سريع بعد التنفيذ:
--   select table_name from information_schema.tables
--   where table_schema = 'public' order by table_name;
-- يجب أن يُرجع: alerts, current_dust_compliance_decisions,
-- current_dust_decisions, decision_records, dust_compliance_evaluations,
-- dust_evaluations, profiles, project_dust_profiles, project_shifts,
-- projects, sensitive_receptors  (11 جدولاً)
-- =====================================================================
