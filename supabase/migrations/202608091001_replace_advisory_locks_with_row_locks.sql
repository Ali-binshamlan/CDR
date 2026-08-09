-- =====================================================================
-- DCR — 202608091001_replace_advisory_locks_with_row_locks.sql
-- =====================================================================
-- حادثة إنتاج فعلية (2026-08-09، على مشروع Supabase جديد تماماً فارغ من
-- أي بيانات سابقة — يستبعد نظرية "تراكم بيانات قديم" كسبب): تشغيل سيناريو
-- اختبار بسيط (قراءة جهاز واحد كل دقيقة + دورة provider-pull كل دقيقة من
-- cron-job.org) أدى خلال دقائق إلى PGRST003 ("Timed out acquiring
-- connection from connection pool") على كامل القاعدة. pg_stat_activity
-- أظهر عدة اتصالات authenticator عالقة بحالة wait_event_type=Lock/
-- wait_event=advisory، كلها تستدعي persist_activity_decision_atomic لنفس
-- (project_id, activity_group_id) في نفس اللحظة تقريباً.
--
-- lock_timeout='5s' على مستوى الـrole (202608081001) لم يمنع الاستنزاف:
-- كل اتصال ينتظر يحجز اتصاله الكامل من connection pool طوال مدة الانتظار
-- (حتى لو فشل لاحقاً بعد 5 ثوانٍ)، وتحت تزامن كافٍ (عدة تقييمات لنفس
-- النشاط في نفس الثانية تقريباً — نمط متوقَّع تماماً من قراءات جهاز حقيقي
-- + provider-pull يعملان بمعدل متقارب) يكفي ذلك لاستهلاك الـpool بأكمله
-- خلال ثوانٍ، قبل أن تتاح الفرصة لأي اتصال آخر (حتى لا علاقة له بالقفل).
--
-- السبب الجذري الفعلي: pg_advisory_xact_lock هو قفل عمومي (global) لا صف
-- له في pg_locks بمعنى تقليدي — لا طابور FIFO عادل، ولا يرتبط ببنية
-- الجدول، ولا يمكن ملاحظته/تشخيصه بسهولة عبر pg_locks.granted كصف محدَّد.
-- الإصلاح البنيوي: استبدال كل قفل استشاري بقفل صف حقيقي (SELECT ... FOR
-- UPDATE / INSERT ... ON CONFLICT DO UPDATE) على الجدول الذي يحميه فعلياً:
--   * قفل المشروع (hashtextextended('project:'||project_id)) → يُستبدَل
--     بـ SELECT id FROM public.projects WHERE id = p_project_id FOR UPDATE
--     (الصف موجود دائماً؛ archive_project_atomic يعمل UPDATE على نفس
--     الصف، فيتشارك القفل الطبيعي معه دون أي تغيير إضافي).
--   * قفل النشاط (hashtextextended(project_id||':'||activity_group_id))
--     → يُستبدَل بـ INSERT ... ON CONFLICT (activity_group_id) DO UPDATE
--     مباشرة بالقيمة النهائية الحقيقية على current_dust_decisions/
--     current_dust_compliance_decisions — خطوة ذرية واحدة تنشئ الصف وتقفله
--     وتكتب القيمة الصحيحة معاً، سواء كان هذا أول تقييم لهذا النشاط أو
--     المائة (لا حاجة لخطوة "قفل" منفصلة عن خطوة "كتابة" كما في التصميم
--     القديم القائم على قفل استشاري عام ثم UPDATE منفصل).
--
-- الفرق العملي: قفل صف حقيقي يدخل طابور انتظار FIFO عادل مرئي في pg_locks
-- (granted=false تُظهر مَن ينتظر ماذا بوضوح)، ويُحرَّر تلقائياً بنفس آلية
-- أي قفل صف عادي (نهاية المعاملة) — لا فرق فعلي هناك عن القفل الاستشاري
-- من ناحية التحرر، لكن الفرق الجوهري هو أن ازدحام قفل صف كامل مرتبط
-- ببنية بيانات حقيقية يمكن تشخيصه فوراً عبر pg_locks/pg_blocking_pids()،
-- بخلاف القفل الاستشاري الذي لا يترك أثراً بنيوياً واضحاً لولا فحص
-- wait_event=advisory يدوياً في pg_stat_activity كما حدث هنا.
--
-- تحديث lock_timeout الحالي (5s) يبقى كخط دفاع ثانٍ كما هو — لا إزالة.
-- =====================================================================

-- ===================================================================
-- 1) archive_project_atomic — قفل المشروع فقط، مُستبدَل بقفل صف مباشر
--    (الدالة أصلاً تعمل UPDATE على نفس صف projects بعد القفل، فدمج
--    القفل داخل نفس الاستعلام آمن ومباشر هنا).
-- ===================================================================
create or replace function public.archive_project_atomic(
  p_project_id uuid,
  p_actor_id uuid
)
returns void
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
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

-- ===================================================================
-- 2) ingest_device_reading_atomic — قفل المشروع الاستشاري يُستبدَل بـ
--    SELECT ... FOR UPDATE على صف projects. قفل الجهاز (project_devices)
--    كان أصلاً FOR UPDATE — بلا تغيير.
-- ===================================================================
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

  select archived_at into v_project_archived_at
  from public.projects
  where id = p_project_id
  for update;

  if not found then
    raise exception using errcode = '42501', message = 'project not found';
  end if;

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

-- ===================================================================
-- 3) ingest_device_event_v2 — نفس الاستبدال (قفل مشروع → FOR UPDATE).
-- ===================================================================
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

  select archived_at into v_project_archived_at
  from public.projects
  where id = p_project_id
  for update;

  if not found then
    raise exception using errcode = '42501', message = 'project not found';
  end if;

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

-- ===================================================================
-- 4) ingest_device_reading_and_event_atomic — نفس الاستبدال. هذه الدالة
--    هي الأعلى تكراراً فعلياً (تُستدعى من deviceReadingWriter.ts في كل
--    قراءة جهاز حية)، وبالتالي أكبر مصدر تزامن على قفل المشروع أصلاً.
-- ===================================================================
create or replace function public.ingest_device_reading_and_event_atomic(
  p_project_id uuid,
  p_device_id uuid,
  p_external_event_id text,
  p_sequence_no bigint,
  p_observed_at timestamptz,
  p_received_at timestamptz,
  p_measurements jsonb,
  p_pm10_observed_at timestamptz default null,
  p_measurements_v2 jsonb default null,
  p_is_late boolean default false
)
returns table (is_duplicate boolean, event_row_id uuid)
language plpgsql
security invoker
set search_path = pg_catalog, public
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

  select archived_at into v_project_archived_at
  from public.projects
  where id = p_project_id
  for update;

  if not found then
    raise exception using errcode = '42501', message = 'project not found';
  end if;

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

-- ===================================================================
-- 5) persist_activity_decision_atomic — قفلان استشاريان (مشروع + نشاط).
--    قفل المشروع → SELECT ... FOR UPDATE على projects (صف موجود دائماً).
--    قفل النشاط → INSERT ... ON CONFLICT (activity_group_id) DO UPDATE
--    مباشرة على current_dust_decisions/current_dust_compliance_decisions
--    بالقيمة النهائية الحقيقية في خطوة ذرية واحدة (ينشئ الصف إن لم يوجد،
--    أو يقفله ويكتب فوق قيمته إن وُجد) — لا حاجة لخطوة قفل منفصلة قبلها.
-- ===================================================================
create or replace function public.persist_activity_decision_atomic(
  p_project_id uuid,
  p_activity_group_id text,
  p_activity_id text,

  p_dvi_result jsonb,
  p_dvi_triggered_by text,
  p_dvi_expected_updated_at timestamptz,

  p_compliance_result jsonb,
  p_compliance_rulebook_version text,
  p_compliance_triggered_by text,
  p_compliance_expected_updated_at timestamptz,
  p_compliance_dust_profile_id uuid,
  p_compliance_stopped_since timestamptz,
  p_compliance_pending_resume_since timestamptz,

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
  select archived_at into v_project_archived_at
  from public.projects
  where id = p_project_id
  for update;

  if not found then
    raise exception using errcode = '42501', message = 'project not found';
  end if;

  if v_project_archived_at is not null then
    raise exception using errcode = 'P0001', message = 'PROJECT_ARCHIVED';
  end if;

  perform 1
  from public.project_dust_profiles p
  where p.id = p_activity_id::uuid
    and p.project_id = p_project_id
    and coalesce(p.activity_group_id, 'dust-' || p.id::text) = p_activity_group_id;

  if not found then
    raise exception using errcode = '23503',
      message = format('activity/project/activity_group mismatch for activity_id=%s', p_activity_id);
  end if;

  -- ملاحظة تزامن: لا حاجة لقفل صف current_dust_decisions/
  -- current_dust_compliance_decisions بشكل منفصل قبل الأقسام (1)/(2)
  -- أدناه — INSERT ... ON CONFLICT (activity_group_id) DO UPDATE هناك هو
  -- نفسه عملية ذرية واحدة تقفل الصف (يُنشئه إن لم يوجد، أو يقفله فوراً إن
  -- وُجد) وتكتب القيمة النهائية في نفس الخطوة، فلا نافذة زمنية بين "قفل"
  -- و"كتابة" يمكن لاتصال آخر أن يتسلل خلالها أصلاً. هذا يستبدل القفل
  -- الاستشاري القديم (project lock → activity lock) بضمان مكافئ: قفل صف
  -- projects أعلاه يحمي من سباق الأرشفة، وupsert الصف هنا يحمي من كتابتين
  -- متزامنتين على نفس (project_id, activity_group_id) بنفس الطريقة تماماً
  -- التي كان يوفرها pg_advisory_xact_lock — عبر تسلسل PostgreSQL الطبيعي
  -- لعمليات INSERT/UPDATE المتنافسة على نفس المفتاح الفريد.

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
      on conflict (activity_group_id) do update
      set latest_evaluation_id = excluded.latest_evaluation_id,
          decision = excluded.decision,
          triggered_rules = excluded.triggered_rules,
          short_reason = excluded.short_reason,
          updated_at = excluded.updated_at;

      v_affected_rows := 1;
    end if;

    v_dvi_persisted := true;
  end if;

  -- ===================================================================
  -- 2) dust_compliance_evaluations + current_dust_compliance_decisions
  --    نفس نمط قفل الصف أعلاه، على current_dust_compliance_decisions.
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
      on conflict (activity_group_id) do update
      set latest_evaluation_id = excluded.latest_evaluation_id,
          decision = excluded.decision,
          triggered_rules = excluded.triggered_rules,
          short_reason = excluded.short_reason,
          updated_at = excluded.updated_at,
          stopped_since = excluded.stopped_since,
          pending_resume_since = excluded.pending_resume_since,
          deciding_rule_code = excluded.deciding_rule_code,
          stop_cause = excluded.stop_cause;
    end if;

    v_compliance_persisted := true;
  end if;

  -- ===================================================================
  -- 3) final_decisions — append-only، يعتمد على نجاح المرحلتين أعلاه
  -- ===================================================================
  if p_final_decision is not null then
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
