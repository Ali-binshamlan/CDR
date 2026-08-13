-- =====================================================================
-- DCR — 202608040025_pm10_history_independent_timestamp.sql
-- =====================================================================
-- خطأ مكتشَف ومُصلَح (مراجعة خبير خارجي — "ThingsBoard ما زال يعيد تأريخ
-- PM10 القديم كقراءة حديثة"): ingest_device_reading_atomic (202608020004)
-- تكتب pm10_readings_history.observed_at/recorded_at بـp_observed_at
-- المشترك للحمولة كلها — وهذا الوقت (المُشتَق في thingsboardConnector.ts
-- fetchLatestReading كأحدث timestamp بين كل الحقول، لا وقت PM10 تحديداً)
-- قد يكون أحدث بكثير من وقت رصد PM10 الفعلي (مثال: حرارة تُحدَّث الساعة
-- 10:00 بينما آخر قراءة PM10 فعلية كانت الساعة 08:00 بلا تغيّر). النتيجة:
-- computeSustainedPm10Status (dustEvaluation.ts) — التي تقرأ حصراً من
-- pm10_readings_history.recorded_at لحساب "استمرار المخالفة المؤكَّد" —
-- كانت ترى قراءة PM10 قديمة فعلياً وكأنها وصلت للتو، فتُحوّل دليلاً قديماً
-- إلى دليل حديث زائف يُبنى عليه قرار حي.
--
-- p_pm10_observed_at (اختياري — NULL يعني "استخدم p_observed_at كما كان،
-- توافقاً مع أي مستدعٍ قديم لا يمرره") هو وقت رصد PM10 المستقل الحقيقي —
-- deviceReadingWriter.ts يمرره من reading.fields.pm10.observedAtIso (نفس
-- المصدر الذي تستهلكه ingest_device_event_v2 أصلاً لهذا الحقل بالضبط، لا
-- قيمة جديدة تُخترَع هنا). device_readings_history وproject_devices.last_
-- pm10_at يبقيان بمنطقهما الحالي بلا تغيير (سجل عام/لقطة عامة، لا مصدر
-- حساب الاستمرار الفعلي) — التعديل الوحيد على pm10_readings_history تحديداً.
--
-- خطأ حرج إضافي مُصحَّح هنا (اكتُشف أثناء كتابة هذه الهجرة نفسها، بمراجعة
-- ذاتية بعد وقوع نفس الخطأ مرتين سابقاً اليوم مع ingest_device_event_v2):
-- النسخة الأولى من هذه الهجرة بُنيت بالخطأ فوق 202608020004 (التعريف
-- الأصلي)، لا 202608040010 (الأحدث فعلياً، التي أضافت pg_advisory_xact_lock
-- + فحص archived_at) — فحذفت حماية الأرشفة دون قصد. أُعيد الفحص هنا صراحةً.
-- =====================================================================

-- خطأ مكتشَف ومُصلَح (مراجعة خبير خارجي — القسم 7: "migration أضافت overload
-- جديداً بـ8 وسائط وتركت نسخة 7 وسائط دون سحب واضح، مع مشكلة محتملة في
-- صلاحية EXECUTE"): CREATE OR REPLACE FUNCTION بعدد وسائط مختلف عن التعريف
-- الحالي (7 → 8 هنا) لا يستبدل الدالة القديمة في PostgreSQL — ينشئ overload
-- ثانياً منفصلاً كلياً، فيبقى التوقيع القديم (7 وسائط، بمنطقه الخاطئ) قابلاً
-- للاستدعاء فعلياً لو ناداه أي كود قديم أو نسخة مخبَّأة (cached) من مخطط
-- PostgREST. يجب إسقاط التوقيع القديم صراحةً أولاً — لا الاعتماد على
-- REPLACE وحده ليحل محله ضمنياً.
drop function if exists public.ingest_device_reading_atomic(
  uuid, uuid, text, bigint, timestamptz, timestamptz, jsonb
);

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

  -- قفل المشروع أولاً (نفس مفتاح archive_project_atomic بالضبط) — يمنع
  -- سباق أرشفة متزامنة مع هذا الإدخال لنفس المشروع (202608040010).
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
  -- قديمة معاً ثم كتابة كلاهما بلا رؤية تحديث الآخر (فحص/كتابة منفصلين
  -- كانا الثغرة الأصلية في deviceReadingWriter.ts قبل هذا الإصلاح).
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
    -- تعارض idempotency فعلي — نفس eventId وُجد مسبقاً لهذا الجهاز، إعادة
    -- إرسال (retry شبكة/جهاز يعيد آخر حمولة محفوظة) لا خطأً حقيقياً.
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
  -- أو تساوي القيمة الحالية المخزَّنة لنفس الحقل تحديداً — لا last_reading_at
  -- العام. حدث متأخر الوصول (observed_at أقدم من last_*_at الحالي) يبقى
  -- محفوظاً في device_readings_history أعلاه لكن لا يستبدل اللقطة الحية.
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

    -- last_pm10/last_pm10_at (project_devices) بقيتا كما هي عمداً بالوقت
    -- العام p_observed_at — للعرض فقط (راجع devicePm10LastReadingAt في
    -- dust-engine/types.ts)، لا مصدر حساب استمرار المخالفة الفعلي (ذاك حصراً
    -- pm10_readings_history المصحَّحة أعلاه بـv_pm10_observed_at).
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

revoke all on function public.ingest_device_reading_atomic(
  uuid, uuid, text, bigint, timestamptz, timestamptz, jsonb, timestamptz
) from public, anon, authenticated;

grant execute on function public.ingest_device_reading_atomic(
  uuid, uuid, text, bigint, timestamptz, timestamptz, jsonb, timestamptz
) to service_role;
