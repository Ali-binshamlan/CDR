-- =====================================================================
-- DCR — 202608040027_merge_device_ingest_atomic.sql
-- =====================================================================
-- خطأ حرج مكتشَف ومُصلَح (مراجعة خبير خارجي — "ما زال يعيد تأريخ PM10
-- القديم كقراءة حديثة: توجد كتابتان منفصلتان في deviceReadingWriter.ts —
-- RPC قديمة تستخدم أحدث timestamp عام، وRPC V2 تستخدم timestamps مستقلة
-- صحيحة. الكتابتان ليستا عملية واحدة ذرية، ويجب إلغاء الكتابة القديمة أو
-- جعل سجلها Projection مشتقة من V2 باستخدام وقت PM10 نفسه"):
--
-- deviceReadingWriter.ts (writeDeviceReading) كان يستدعي ingest_device_
-- reading_atomic ثم ingest_device_event_v2 كاستدعاءين شبكة منفصلين تماماً،
-- كل منهما بمعاملة SQL خاصة به. فشل الاستدعاء الثاني (V2) لم يكن يُسقِط
-- الاستدعاء الأول (V1) — بل يُسجَّل فقط بـconsole.error، بلا rollback وبلا
-- إعادة محاولة وبلا أي إشارة فشل تصل للمستدعي (نجاح Response كامل رغم فشل
-- جزئي فعلي). النتيجة: V1 (pm10_readings_history، مُصلَحة مسبقاً بـp_pm10_
-- observed_at في 202608040025) قد تنجح بينما V2 (device_metric_latest،
-- مصدر resolveFreshProjectDevice للقرار الحي) تفشل أو العكس — فيتباعد
-- مصدرا "آخر قراءة PM10" (استمرار المخالفة مقابل القرار الحي الفوري) بصمت،
-- حتى لو كانت منطق كل RPC على حدة صحيحاً.
--
-- الإصلاح: دمج كامل منطق V1+V2 داخل RPC ذرّي واحد (معاملة SQL واحدة، كل
-- الكتابات تنجح معاً أو تفشل معاً) — لا استدعاءين شبكة منفصلين بعد الآن.
-- ingest_device_reading_atomic وingest_device_event_v2 تبقيان معرَّفتين
-- (توافقاً مع أي استدعاء تاريخي/اختباري مباشر لهما) لكن deviceReadingWriter.ts
-- يستدعي هذه الدالة الموحَّدة فقط من الآن فصاعداً.
-- =====================================================================

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
  -- في ingest_device_event_v2 بالضبط. NULL/غائب يعني "لا مصدر توقيت مستقل
  -- لأي حقل" — تُستخدَم p_observed_at المشتركة كـfallback لكل حقل (توافق
  -- مصادر push قديمة لا ترسل fields مستقلة أصلاً).
  p_measurements_v2 jsonb default null
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

  -- قفل المشروع أولاً (نفس مفتاح archive_project_atomic بالضبط) — يمنع
  -- سباق أرشفة متزامنة مع هذا الإدخال لنفس المشروع.
  perform pg_advisory_xact_lock(
    hashtextextended('project:' || p_project_id::text, 0)
  );

  select archived_at into v_project_archived_at
  from public.projects
  where id = p_project_id;

  if v_project_archived_at is not null then
    raise exception using errcode = 'P0001', message = 'PROJECT_ARCHIVED';
  end if;

  -- قفل الصف — يمنع تحديثين متزامنين لنفس الجهاز من قراءة قيمة last_*_at
  -- قديمة معاً ثم كتابة كلاهما بلا رؤية تحديث الآخر.
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
    -- تعارض idempotency فعلي — نفس eventId وُجد مسبقاً لهذا الجهاز، إعادة
    -- إرسال (retry شبكة/جهاز يعيد آخر حمولة محفوظة) لا خطأً حقيقياً. لا شيء
    -- آخر يُكتَب في هذه الحالة (كل الجداول أدناه ترتبط بنفس eventId أصلاً).
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

  -- كل حقل last_*/_at يُحدَّث فقط إن كانت هذه القراءة (observed_at) أحدث من
  -- أو تساوي القيمة الحالية المخزَّنة لنفس الحقل تحديداً.
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

    -- last_pm10/last_pm10_at (project_devices) بقيتا بالوقت العام
    -- p_observed_at عمداً — للعرض فقط (سجل عام)، لا مصدر حساب استمرار
    -- المخالفة الفعلي (ذاك pm10_readings_history أعلاه بـv_pm10_observed_at)
    -- ولا مصدر القرار الحي (ذاك device_metric_latest أدناه، V2).
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
  -- نفس معاملة SQL الحالية بالضبط (بلا BEGIN/COMMIT منفصل، ولا استدعاء شبكة
  -- ثانٍ) — فشل أي إدراج هنا يُسقِط كل الكتابات أعلاه تلقائياً (rollback
  -- كامل للدالة)، بعكس الاستدعاءين المنفصلين السابقين حيث نجاح V1 كان يبقى
  -- قائماً حتى لو فشلت V2 بالكامل.
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
    -- نفس eventId موجود مسبقاً في device_events أيضاً — retry متكرر، لا شيء
    -- إضافي يُكتَب (device_readings_history أعلاه اكتشف نفس الحالة بالفعل
    -- وأعاد مبكراً، فهذا الفرع نظرياً لا يصل إلا لو تباعد eventId بين
    -- الجدولين تاريخياً — فشل آمن: لا خطأ، فقط لا كتابة إضافية هنا).
    null;
  else
    -- p_measurements_v2 غائب (مصدر push قديم بلا fields مستقلة) يعني: ابنِ
    -- envelope مكافئ من p_measurements + p_observed_at المشتركة، بدل تخطي
    -- V2 كلياً — يبقي device_metric_latest محدَّثاً دائماً بصرف النظر عن
    -- مصدر البيانات.
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

    -- أي مفتاح في p_measurements غاب عن p_measurements_v2 (لا fields مستقلة
    -- له) يُستكمَل هنا بـp_observed_at المشتركة — نفس fallback الذي كان
    -- deviceReadingWriter.ts يبنيه سابقاً في JavaScript قبل هذا الدمج.
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

revoke all on function public.ingest_device_reading_and_event_atomic(
  uuid, uuid, text, bigint, timestamptz, timestamptz, jsonb, timestamptz, jsonb
) from public, anon, authenticated;

grant execute on function public.ingest_device_reading_and_event_atomic(
  uuid, uuid, text, bigint, timestamptz, timestamptz, jsonb, timestamptz, jsonb
) to service_role;
