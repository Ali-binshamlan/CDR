-- =====================================================================
-- DCR — 202608120001_manual_pm10_reading_endpoint.sql
-- =====================================================================
-- خطأ حرج مكتشَف ومُصلَح (مراجعة كود خارجي — "المسار القديم للتنبيهات
-- ينافس Outbox ويصنع قراءات PM10 وهمية"): كانت هناك نقطتا إدراج مستقلتان
-- (alerts/generate/route.ts، وcomputeDustComplianceResults في
-- dustEvaluation.ts عبر persistPm10Reading=true) تعيدان نسخ project_dust_
-- profiles.onsite_pm10 — حقل ثابت لا قراءة جديدة — إلى pm10_readings_history
-- بوقت recorded_at جديد في كل استدعاء (Cron، تبويب متصفح مفتوح، أو أي دورة
-- evaluateProject حية: ingest جهاز، إعادة محاولة مزوّد، تكة مجدول). النتيجة:
-- قياس يدوي حقيقي واحد يتحوّل إلى سلسلة زمنية تبدو مستمرة زوراً — بالضبط ما
-- يبني عليه pm10ThresholdRule "مخالفة مستمرة" (RCRC-PM10-340-VIOLATION-011)
-- خطأً. كلا الموقعين حُذفا بالكامل (راجع الملفين مباشرة).
--
-- الإصلاح هنا: القياس اليدوي الآن يدخل حصراً عبر فعل مستخدم صريح واحد —
-- endpoint مستقل (POST /api/pm10-readings/manual) يحمل observed_at (وقت
-- الرصد الميداني الفعلي، لا وقت الإدخال)، operator_id (مُشتَق من الجلسة على
-- الخادم — لا حقل عميل، نفس مبدأ device_id في dust-profiles/route.ts)،
-- وidempotency_key (يمنع تكرار نفس القياس عند إعادة إرسال الطلب من الواجهة
-- — نفس دور external_event_id لقراءات الأجهزة، لكن مصدره العميل هنا بدل
-- الجهاز، فيلزم تحقق نطاق أضيق: فريد فقط ضمن نفس (project_id,
-- activity_group_id)، لا عالمياً، حتى لا يمنع مستخدمَين مختلفَين بمشروعين
-- مختلفين من استخدام نفس القيمة البسيطة صدفة، دون أي حماية حقيقية إضافية).
-- =====================================================================

alter table public.pm10_readings_history
  add column if not exists operator_id uuid references auth.users(id) on delete set null,
  add column if not exists idempotency_key text;

comment on column public.pm10_readings_history.operator_id is
  'المستخدم الذي أدخل القراءة يدوياً (source=''manual'' فقط) — مُشتَق من الجلسة على الخادم، لا من حقل يرسله العميل. null لكل الصفوف الأخرى (device/تاريخية).';
comment on column public.pm10_readings_history.idempotency_key is
  'مفتاح idempotency من العميل لقراءات source=''manual'' فقط — يمنع إدراج نفس القياس مرتين عند إعادة إرسال الطلب (فشل شبكة/نقر مزدوج). فريد ضمن (project_id, activity_group_id) عبر الفهرس أدناه، لا عالمياً.';

-- الفهرس الجزئي الحالي idx_pm10_readings_history_device_event_unique
-- (device_id, external_event_id) لا يحمي القراءات اليدوية إطلاقاً — device_id
-- دائماً null لها، فقيمتان مختلفتان لـexternal_event_id (أو حتى نفس القيمة،
-- بما أن الفهرس نفسه لا يُطبَّق إلا حين device_id غير null ضمنياً عبر تطابق
-- المفتاح المركّب) لا تتصادمان أبداً بين صفَّين يدويَّين. فهرس مستقل هنا،
-- مقيَّد بـsource='manual' صراحة (لا يتقاطع مع قراءات device التي تُدار عبر
-- فهرسها الخاص بالفعل) ومقيَّد بـ(project_id, activity_group_id) بدل
-- device_id (لا معنى لجهاز هنا).
create unique index if not exists idx_pm10_readings_history_manual_idempotency
  on public.pm10_readings_history (project_id, activity_group_id, idempotency_key)
  where source = 'manual' and idempotency_key is not null;

-- إدراج ذرّي واحد — نفس نمط ingest_device_reading_atomic (202608040025)
-- لكن بمفتاح idempotency من العميل بدل external_event_id الجهاز، وبتحقق
-- ملكية المشروع صراحة هنا (لا اعتماد على RLS، نفس مبدأ verifyProjectOwnership
-- في apiAuth.ts — لكن كطبقة دفاع ثانية داخل الدالة الذرية نفسها، لأن الاستدعاء
-- من route.ts سيتحقق أيضاً قبل النداء؛ ازدواجية متعمَّدة لا فائض بلا داعٍ:
-- الدالة قد تُستدعى مستقبلاً من مسار آخر لا يمر بنفس تحقق الملكية).
create or replace function public.insert_manual_pm10_reading_atomic(
  p_project_id uuid,
  p_activity_group_id text,
  p_operator_id uuid,
  p_pm10_ug_m3 numeric,
  p_observed_at timestamptz,
  p_idempotency_key text
)
returns table (is_duplicate boolean, reading_id uuid)
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_reading_id uuid;
  v_key text;
begin
  if p_project_id is null or p_activity_group_id is null or btrim(p_activity_group_id) = '' then
    raise exception using errcode = '22023', message = 'project_id and activity_group_id are required';
  end if;

  if p_operator_id is null then
    raise exception using errcode = '22023', message = 'operator_id is required';
  end if;

  if p_pm10_ug_m3 is null or p_pm10_ug_m3 < 0 then
    raise exception using errcode = '22023', message = 'pm10_ug_m3 must be a non-negative number';
  end if;

  if p_observed_at is null then
    raise exception using errcode = '22023', message = 'observed_at is required';
  end if;

  v_key := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  if v_key is null then
    raise exception using errcode = '22023', message = 'idempotency_key is required';
  end if;

  -- التحقق من انتماء activity_group_id فعلياً لهذا المشروع (لا مجموعة
  -- عشوائية أو تخص مشروعاً آخر) — نفس القيد المركّب في activity_groups
  -- (project_id, id)، راجع migration 202608040006.
  if not exists (
    select 1 from public.activity_groups g
    where g.project_id = p_project_id and g.id = p_activity_group_id
  ) then
    raise exception using errcode = '23503', message = 'activity_group_id not found for this project';
  end if;

  insert into public.pm10_readings_history (
    project_id, activity_group_id, device_id, pm10_ug_m3, source,
    recorded_at, observed_at, received_at, operator_id, idempotency_key
  ) values (
    p_project_id, p_activity_group_id, null, p_pm10_ug_m3, 'manual',
    p_observed_at, p_observed_at, now(), p_operator_id, v_key
  )
  on conflict (project_id, activity_group_id, idempotency_key)
    where source = 'manual' and idempotency_key is not null
  do nothing
  returning id into v_reading_id;

  if v_reading_id is null then
    -- تعارض idempotency فعلي — نفس المفتاح لنفس المجموعة، إعادة إرسال لا
    -- خطأً حقيقياً (نفس منطق ingest_device_reading_atomic تماماً).
    select h.id into v_reading_id
    from public.pm10_readings_history h
    where h.project_id = p_project_id
      and h.activity_group_id = p_activity_group_id
      and h.source = 'manual'
      and h.idempotency_key = v_key;

    return query select true, v_reading_id;
    return;
  end if;

  return query select false, v_reading_id;
end;
$$;

revoke all on function public.insert_manual_pm10_reading_atomic(
  uuid, text, uuid, numeric, timestamptz, text
) from public, anon, authenticated;

grant execute on function public.insert_manual_pm10_reading_atomic(
  uuid, text, uuid, numeric, timestamptz, text
) to service_role;
