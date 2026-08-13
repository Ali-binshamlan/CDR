-- =====================================================================
-- DCR — 202608040024_ingest_device_event_v2_require_sequence.sql
-- =====================================================================
-- القسم 5.10 — بعد فرض NOT NULL على device_events.sequence_no
-- (202608040023)، تُحدَّث ingest_device_event_v2 لترفض p_sequence_no=null
-- برسالة خطأ واضحة قبل محاولة الإدراج (بدل الاعتماد فقط على رفض العمود
-- نفسه، الذي كان سيُظهر رسالة PostgreSQL عامة "null value in column
-- sequence_no violates not-null constraint" أقل وضوحاً للمستدعي).
--
-- خطأ حرج مكتشَف ومُصلَح (مراجعة خبير خارجي — "أحدث تعريف لـ
-- ingest_device_event_v2 أسقط قفل المشروع وفحص archived_at؛ أثبت اختبار
-- قاعدة بيانات أن مشروعاً مؤرشفاً يقبل Event بعد إعادة تفعيل جهازه"):
-- النسخة الأصلية من هذا التعديل (قبل هذا الإصلاح) بُنيت بالخطأ فوق نسخة
-- الدالة القديمة (202608040002)، لا الأحدث (202608040010 التي أضافت
-- pg_advisory_xact_lock + فحص archived_at) — فحذفت الحماية ضد الأرشفة
-- دون قصد. أُعيد الفحص هنا صراحةً، بنفس ترتيب القفل قبل الفحص قبل قفل
-- صف الجهاز (نفس نمط ingest_device_reading_atomic تماماً).
-- =====================================================================

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

  -- قفل استشاري على المشروع — يمنع سباق أرشفة/إدخال حدث متزامنَين (نفس
  -- مبدأ ingest_device_reading_atomic في 202608040010).
  perform pg_advisory_xact_lock(
    hashtextextended('project:' || p_project_id::text, 0)
  );

  select archived_at into v_project_archived_at
  from public.projects
  where id = p_project_id;

  if v_project_archived_at is not null then
    raise exception using errcode = 'P0001', message = 'PROJECT_ARCHIVED';
  end if;

  -- قفل الصف — يمنع تحديثين متزامنين لنفس الجهاز من كتابة device_metric_latest
  -- بترتيب غير متوقَّع لبعضهما (نفس مبدأ ingest_device_reading_atomic).
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
    -- تعارض idempotency فعلي — نفس eventId وُجد مسبقاً لهذا الجهاز.
    select e.id into v_event_row_id
    from public.device_events e
    where e.device_id = p_device_id
      and e.external_event_id = btrim(p_external_event_id);

    return query select true, v_event_row_id;
    return;
  end if;

  -- كل مفتاح في p_measurements هو {value, observedAtIso} مستقل — قياس واحد
  -- بوقت رصد خاص به، لا وقت مشترك للحمولة كلها.
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

    -- device_metric_latest: يُستبدَل فقط إذا كان هذا القياس (observed_at)
    -- أحدث من أو يساوي القيمة الحالية المخزَّنة لنفس (device_id, metric) —
    -- حدث متأخر الوصول يُحفَظ في device_measurements لكن لا يستبدل لقطة أحدث.
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

revoke all on function public.ingest_device_event_v2(
  uuid, uuid, text, bigint, timestamptz, jsonb
) from public, anon, authenticated;

grant execute on function public.ingest_device_event_v2(
  uuid, uuid, text, bigint, timestamptz, jsonb
) to service_role;
