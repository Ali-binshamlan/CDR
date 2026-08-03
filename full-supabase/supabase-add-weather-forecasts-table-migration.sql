-- =====================================================================
-- هجرة: فصل توقعات Open-Meteo عن سجل أدلة PM10 الميداني
--
-- الثغرة المكتشفة (مراجعة كود خبير خارجي): supabase-add-openmeteo-pm10-
-- history-source-migration.sql وسّعت قيد source في pm10_readings_history
-- ليقبل 'open-meteo' — فأصبح توقّع طقس شبكي (نموذج عالمي، دقة ساعية، بلا
-- محطة معتمدة ولا معايرة) يُخزَّن حرفياً في نفس الجدول المسمّى "سجل أدلة
-- ميداني" جنباً إلى جنب مع قراءات device/manual الحقيقية. الحماية الوحيدة
-- ضد تصعيد هذا لقرار إلزامي كانت شرطاً برمجياً واحداً (isCurrentSourceDevice
-- في computeSustainedPm10Status، app/lib/dustEvaluation.ts) — فصل منطقي لا
-- بنيوي، عرضة لكسر مستقبلي (تعديل ناسٍ، استعلام جديد يتجاهل الفحص)، وأي
-- مراجعة/تدقيق لاحق للسجل التاريخي يجد "قراءات PM10" لم تُقَس ميدانياً قط.
--
-- الإصلاح: جدول weather_forecasts منفصل تماماً لتوقعات Open-Meteo —
-- evidence_eligible=false دائماً (توقّع للتخطيط/التحذير فقط، لا يجوز أن
-- يُستخدم دليلاً لإثبات استمرار مخالفة). pm10_readings_history يعود لقيده
-- الأصلي (device/manual فقط) — سجل أدلة ميداني نقي.
-- =====================================================================

create table if not exists public.weather_forecasts (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  activity_group_id text,
  provider text not null default 'open-meteo',
  fetched_at timestamptz not null default now(),
  forecast_valid_at timestamptz not null,
  pm10_ug_m3 numeric,
  -- دائماً false — لا مسار برمجي يجوز أن يقرأ هذا العمود ليقرر MANDATORY_STOP
  -- أو أي إيقاف إلزامي؛ التوقّع للتخطيط/التحذير الاستباقي فقط.
  evidence_eligible boolean not null default false
);

create index if not exists idx_weather_forecasts_group_time
  on public.weather_forecasts (activity_group_id, forecast_valid_at desc);

create index if not exists idx_weather_forecasts_project_time
  on public.weather_forecasts (project_id, forecast_valid_at desc);

alter table public.weather_forecasts enable row level security;

-- ترحيل الصفوف القديمة (إن وُجدت) من pm10_readings_history إلى الجدول
-- الجديد قبل حذفها — لا فقدان بيانات، فقط إعادة تصنيف تخزينها الصحيح.
insert into public.weather_forecasts (project_id, activity_group_id, provider, fetched_at, forecast_valid_at, pm10_ug_m3, evidence_eligible)
select project_id, activity_group_id, 'open-meteo', recorded_at, recorded_at, pm10_ug_m3, false
from public.pm10_readings_history
where source = 'open-meteo';

delete from public.pm10_readings_history where source = 'open-meteo';

alter table public.pm10_readings_history
  drop constraint if exists pm10_readings_history_source_check;

alter table public.pm10_readings_history
  add constraint pm10_readings_history_source_check
  check (source in ('device', 'manual'));
