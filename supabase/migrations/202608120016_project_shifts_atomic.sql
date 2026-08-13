-- =====================================================================
-- DCR — 202608120016_project_shifts_atomic.sql
-- =====================================================================
-- خطأ مكتشَف ومُصلَح (طلب صريح من المستخدم — مراجعة كود خارجي: "إنشاء
-- المشروع والورديات وتحديثها غير ذري"):
--
-- (1) POST /api/projects (route.ts:67-110): كان يُدرج المشروع أولاً، ثم
--     الورديات كخطوة منفصلة تالية — فشل إدراج الورديات (بعد نجاح المشروع)
--     كان يُترَك عمداً (تعليق صريح في الكود: "فشل هذه الخطوة لا يجوز أن
--     يُسقط المشروع بأكمله") فيُنشأ مشروع بلا ورديات رغم أن المستخدم طلب
--     كليهما معاً في نفس الطلب — نتيجة جزئية صامتة نسبياً (warning فقط).
--
-- (2) PATCH /api/projects/[projectId] (بعد السطر 814): تسلسل ثلاثي —
--     update على projects، ثم delete كامل لـproject_shifts، ثم insert
--     الورديات الجديدة. فشل الـinsert *بعد* نجاح الـdelete يترك المشروع
--     بلا أي ورديات إطلاقاً (القديمة محذوفة فعلاً، الجديدة لم تُدرَج) —
--     نافذة فشل جزئي حقيقية بين عمليتين منفصلتين.
--
-- الإصلاح: RPC ذرّية واحدة لكل عملية (create_project_with_shifts/
-- update_project_with_shifts) — كل الكتابات (المشروع + الورديات معاً) تنجح
-- أو تفشل معاً داخل معاملة SQL واحدة. مشروع بلا ورديات (p_shifts=null أو
-- '[]'::jsonb) يبقى مدعوماً بالكامل — لا تغيير في هذا السلوك، الذرّية
-- تُطبَّق فقط عندما تُرسَل ورديات فعلاً مع الطلب.
-- =====================================================================

-- ---------------------------------------------------------------------
-- create_project_with_shifts — p_project: jsonb بحقول projects المسموحة
-- (نفس ALLOWED_PROJECT_FIELDS في route.ts، يبقى التحقق/allowlist في
-- التطبيق كما هو — هذه الدالة تكتب الحقول المُمرَّرة فقط، لا تعيد فرض
-- allowlist بنفسها لتفادي ازدواج مصدر الحقيقة). p_shifts: jsonb array
-- (null أو [] يعني "بلا ورديات" — لا إدراج على project_shifts إطلاقاً).
-- ---------------------------------------------------------------------
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
begin
  if p_user_id is null then
    raise exception using errcode = '22023', message = 'user_id إلزامي';
  end if;
  if p_project is null or jsonb_typeof(p_project) <> 'object' then
    raise exception using errcode = '22023', message = 'project يجب أن يكون كائن JSON';
  end if;

  insert into public.projects
  select * from jsonb_populate_record(null::public.projects, p_project || jsonb_build_object('user_id', p_user_id::text))
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

-- ---------------------------------------------------------------------
-- update_project_with_shifts — p_shifts: null صريح يعني "لا تُغيّر
-- الورديات إطلاقاً" (نفس دلالة 'shifts' in parsed.data في route.ts الحالي)،
-- '[]'::jsonb يعني "احذف كل الورديات"، مصفوفة غير فارغة تستبدل الكل ذرّياً.
-- ---------------------------------------------------------------------
create or replace function public.update_project_with_shifts(
  p_project_id uuid,
  p_updates jsonb,
  p_shifts_provided boolean default false,
  p_shifts jsonb default null
)
returns void
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_shift jsonb;
  v_sort_order integer := 0;
  v_set_clause text;
begin
  if p_project_id is null then
    raise exception using errcode = '22023', message = 'project_id إلزامي';
  end if;
  if p_updates is null or jsonb_typeof(p_updates) <> 'object' then
    raise exception using errcode = '22023', message = 'updates يجب أن يكون كائن JSON';
  end if;

  update public.projects p
  set (name, client_name, city, neighborhood, project_status, project_type, soil_type,
       latitude, longitude, terrain_type, site_location_nature, wind_exposure,
       start_date, end_date, work_days, work_days_list, work_hours_start, work_hours_end,
       project_manager, contact_number, site_area_m2, daily_truck_movements,
       has_onsite_crusher, has_onsite_batching_plant, dmp_approval_status,
       baseline_monitoring_days, monitoring_logging_interval_minutes, anemometer_height_m,
       entry_exit_cameras_installed, camera_retention_days, sensitivity_map_prepared,
       data_accuracy_confirmed, data_accuracy_confirmed_at) =
      (select
         coalesce(u.name, p.name),
         case when p_updates ? 'client_name' then u.client_name else p.client_name end,
         case when p_updates ? 'city' then u.city else p.city end,
         case when p_updates ? 'neighborhood' then u.neighborhood else p.neighborhood end,
         coalesce(u.project_status, p.project_status),
         case when p_updates ? 'project_type' then u.project_type else p.project_type end,
         case when p_updates ? 'soil_type' then u.soil_type else p.soil_type end,
         coalesce(u.latitude, p.latitude),
         coalesce(u.longitude, p.longitude),
         coalesce(u.terrain_type, p.terrain_type),
         case when p_updates ? 'site_location_nature' then u.site_location_nature else p.site_location_nature end,
         coalesce(u.wind_exposure, p.wind_exposure),
         case when p_updates ? 'start_date' then u.start_date else p.start_date end,
         case when p_updates ? 'end_date' then u.end_date else p.end_date end,
         case when p_updates ? 'work_days' then u.work_days else p.work_days end,
         coalesce(u.work_days_list, p.work_days_list),
         case when p_updates ? 'work_hours_start' then u.work_hours_start else p.work_hours_start end,
         case when p_updates ? 'work_hours_end' then u.work_hours_end else p.work_hours_end end,
         case when p_updates ? 'project_manager' then u.project_manager else p.project_manager end,
         case when p_updates ? 'contact_number' then u.contact_number else p.contact_number end,
         case when p_updates ? 'site_area_m2' then u.site_area_m2 else p.site_area_m2 end,
         case when p_updates ? 'daily_truck_movements' then u.daily_truck_movements else p.daily_truck_movements end,
         coalesce(u.has_onsite_crusher, p.has_onsite_crusher),
         coalesce(u.has_onsite_batching_plant, p.has_onsite_batching_plant),
         coalesce(u.dmp_approval_status, p.dmp_approval_status),
         case when p_updates ? 'baseline_monitoring_days' then u.baseline_monitoring_days else p.baseline_monitoring_days end,
         case when p_updates ? 'monitoring_logging_interval_minutes' then u.monitoring_logging_interval_minutes else p.monitoring_logging_interval_minutes end,
         case when p_updates ? 'anemometer_height_m' then u.anemometer_height_m else p.anemometer_height_m end,
         coalesce(u.entry_exit_cameras_installed, p.entry_exit_cameras_installed),
         case when p_updates ? 'camera_retention_days' then u.camera_retention_days else p.camera_retention_days end,
         coalesce(u.sensitivity_map_prepared, p.sensitivity_map_prepared),
         coalesce(u.data_accuracy_confirmed, p.data_accuracy_confirmed),
         case when p_updates ? 'data_accuracy_confirmed_at' then u.data_accuracy_confirmed_at else p.data_accuracy_confirmed_at end
       from jsonb_populate_record(null::public.projects, p_updates) u)
  where p.id = p_project_id;

  if not found then
    raise exception using errcode = '23503', message = format('project not found: %s', p_project_id);
  end if;

  if p_shifts_provided then
    delete from public.project_shifts where project_id = p_project_id;

    if p_shifts is not null and jsonb_typeof(p_shifts) = 'array' and jsonb_array_length(p_shifts) > 0 then
      for v_shift in select * from jsonb_array_elements(p_shifts)
      loop
        insert into public.project_shifts (project_id, name, start_time, end_time, sort_order)
        values (
          p_project_id,
          v_shift->>'name',
          (v_shift->>'start_time')::time,
          (v_shift->>'end_time')::time,
          v_sort_order
        );
        v_sort_order := v_sort_order + 1;
      end loop;
    end if;
  end if;
end;
$$;

revoke all on function public.update_project_with_shifts(uuid, jsonb, boolean, jsonb)
  from public, anon, authenticated;
grant execute on function public.update_project_with_shifts(uuid, jsonb, boolean, jsonb)
  to service_role;
