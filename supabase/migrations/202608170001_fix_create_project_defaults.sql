-- =====================================================================
-- DCR — 202608170001_fix_create_project_defaults.sql
-- =====================================================================
-- خطأ حرج مكتشَف ومُصلَح (خطأ فعلي شوهد إنتاجياً — "project insert failed:
-- null value in column "id" of relation "projects" violates not-null
-- constraint"، عند إنشاء مشروع جديد من Projects/create):
--
-- create_project_with_shifts (202608120016) كانت تبني صف الإدراج عبر:
--   insert into public.projects
--   select * from jsonb_populate_record(null::public.projects, p_project || ...)
--
-- jsonb_populate_record مع سجل أساس NULL (لا صف موجود فعلياً) يملأ كل عمود
-- غائب عن الـjsonb بقيمة NULL صريحة — لا يطبّق أي DEFAULT معرَّف على الجدول.
-- ثم "insert ... select *" يُدرج تلك القيم الصريحة (NULL) لكل عمود، بما
-- فيها id/project_status/wind_exposure/terrain_type/dmp_approval_status/
-- work_days_list/data_accuracy_confirmed/created_at — كل عمود له DEFAULT في
-- تعريف الجدول (202607290001_baseline_final.sql) كان يُتجاوَز تماماً لأي
-- حقل لا يرسله العميل صراحة. id هو العمود الوحيد الذي NOT NULL بلا أي
-- DEFAULT بديل (default gen_random_uuid() نفسه أُلغي بنفس الآلية)، فهو من
-- أظهر العطل الفعلي كخطأ NOT NULL صريح — لكن بقية الأعمدة المعرَّضة لنفس
-- الخلل كانت ستُخزَّن NULL بصمت (لا عطل ظاهر) لأي طلب لا يرسلها، بدل قيمها
-- الافتراضية الصحيحة (مثال: مشروع بلا project_status مُرسَل صراحة كان
-- سيُخزَّن NULL بدل 'not_started').
--
-- الإصلاح: بناء صف الإدراج بشكل صريح بعمود عمود — id عبر gen_random_uuid()
-- مباشرة (لا يعتمد على DEFAULT الجدول إطلاقاً بعد الآن)، وكل عمود آخر له
-- DEFAULT في الجدول يُغلَّف بـcoalesce(القيمة من jsonb، نفس قيمة DEFAULT
-- المعرَّفة في الجدول حرفياً) — يحفظ نفس ضمان "غياب الحقل من الطلب يعني
-- القيمة الافتراضية الصحيحة" الذي كانت INSERT/DEFAULT العادية توفره قبل
-- إدخال jsonb_populate_record، بلا الاعتماد على آلية INSERT/DEFAULT التي لا
-- تعمل مع select * من سجل مبني مسبقاً بهذا الأسلوب.
-- =====================================================================

create or replace function public.create_project_with_shifts(
  p_user_id uuid,
  p_project jsonb,
  p_shifts jsonb default null
)
returns public.projects
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_project public.projects;
  v_shift jsonb;
  v_sort_order integer := 0;
  v_record public.projects;
begin
  if p_user_id is null then
    raise exception using errcode = '22023', message = 'user_id إلزامي';
  end if;
  if p_project is null or jsonb_typeof(p_project) <> 'object' then
    raise exception using errcode = '22023', message = 'project يجب أن يكون كائن JSON';
  end if;

  -- jsonb_populate_record(null::public.projects, ...) يملأ كل عمود غائب
  -- عن p_project بـNULL — نقرأ منه الحقول المُرسَلة فقط، ونطبّق DEFAULT
  -- الجدول يدوياً أدناه لأي عمود لم يُرسَل (نفس دلالة NULL من
  -- jsonb_populate_record = "لم يُرسَل" بما أن الجدول لا يقبل NULL صريحة
  -- ذات معنى مختلف عن "غائب" لأي من هذه الأعمدة أصلاً).
  select * into v_record
  from jsonb_populate_record(null::public.projects, p_project || jsonb_build_object('user_id', p_user_id::text));

  insert into public.projects (
    id, user_id, name, client_name, city, neighborhood, project_status,
    project_type, site_nature, soil_type,
    latitude, longitude, coordinates, zone_type, zone_polygon, zone_radius_m,
    site_location_nature, wind_exposure, terrain_type,
    start_date, end_date, work_days, work_days_list, work_hours_start, work_hours_end,
    project_manager, contact_number,
    site_area_m2, daily_truck_movements, has_onsite_crusher, has_onsite_batching_plant,
    dmp_approval_status, dmp_submitted_at, dmp_approved_at,
    baseline_monitoring_days, monitoring_logging_interval_minutes, anemometer_height_m,
    entry_exit_cameras_installed, camera_retention_days, sensitivity_map_prepared,
    data_accuracy_confirmed, data_accuracy_confirmed_at,
    created_at
  )
  values (
    gen_random_uuid(),
    v_record.user_id,
    v_record.name,
    v_record.client_name,
    v_record.city,
    v_record.neighborhood,
    coalesce(v_record.project_status, 'not_started'),
    v_record.project_type,
    v_record.site_nature,
    v_record.soil_type,
    v_record.latitude,
    v_record.longitude,
    v_record.coordinates,
    v_record.zone_type,
    v_record.zone_polygon,
    v_record.zone_radius_m,
    v_record.site_location_nature,
    coalesce(v_record.wind_exposure, 'medium'),
    coalesce(v_record.terrain_type, 'suburban'),
    v_record.start_date,
    v_record.end_date,
    v_record.work_days,
    coalesce(v_record.work_days_list, '[]'::jsonb),
    v_record.work_hours_start,
    v_record.work_hours_end,
    v_record.project_manager,
    v_record.contact_number,
    v_record.site_area_m2,
    v_record.daily_truck_movements,
    v_record.has_onsite_crusher,
    v_record.has_onsite_batching_plant,
    coalesce(v_record.dmp_approval_status, 'UNKNOWN'),
    v_record.dmp_submitted_at,
    v_record.dmp_approved_at,
    v_record.baseline_monitoring_days,
    v_record.monitoring_logging_interval_minutes,
    v_record.anemometer_height_m,
    v_record.entry_exit_cameras_installed,
    v_record.camera_retention_days,
    v_record.sensitivity_map_prepared,
    coalesce(v_record.data_accuracy_confirmed, false),
    v_record.data_accuracy_confirmed_at,
    now()
  )
  returning * into v_project;

  if p_shifts is not null and jsonb_typeof(p_shifts) = 'array' and jsonb_array_length(p_shifts) > 0 then
    for v_shift in select * from jsonb_array_elements(p_shifts)
    loop
      insert into public.project_shifts (project_id, name, start_time, end_time, sort_order)
      values (
        v_project.id,
        v_shift->>'name',
        (v_shift->>'start_time')::time,
        (v_shift->>'end_time')::time,
        v_sort_order
      );
      v_sort_order := v_sort_order + 1;
    end loop;
  end if;

  return v_project;
end;
$$;

revoke all on function public.create_project_with_shifts(uuid, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.create_project_with_shifts(uuid, jsonb, jsonb)
  to service_role;
