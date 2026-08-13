-- =====================================================================
-- DCR — 202608040001_device_events_v2.sql
-- =====================================================================
-- خطأ معماري مكتشَف (دليل الإصلاح الجذري لمنظومة مرقاب، القسم 2.2/7/8):
-- النظام كان يخزّن حمولة كاملة (كل الحقول: رياح/PM10/رؤية/إلخ) بوقت رصد
-- واحد مشترك (observed_at في device_readings_history، وproject_devices.
-- last_*_at كانت تُحدَّث من نفس observed_at الوارد للحمولة كلها) — صحيح
-- فقط إذا أخذت كل الحساسات عينتها في نفس اللحظة، وهو غير صحيح لموصلات
-- pull مثل ThingsBoard (thingsboardConnector.ts) التي تجلب "آخر نقطة" لكل
-- حقل على حدة من الجهاز، وقد تختلف توقيتاتها الفعلية بثوانٍ أو دقائق.
--
-- الإصلاح: عقد حدث جديد (Event V2) بوقت رصد مستقل لكل قياس على حدة:
--   device_events: سجل الحدث الخام (event_id/sequence من المصدر)، دليل
--     تاريخي غير قابل للتعديل — لا يُعدَّل بعد الإدراج.
--   device_measurements: قياس واحد لكل حقل ضمن الحدث، بوقت رصد (observed_at)
--     ووقت وصول (received_at) مستقلَّين لكل قياس — الدليل التاريخي الفعلي.
--   device_metric_latest: Projection سريع قابل لإعادة البناء بالكامل من
--     device_measurements — "آخر قيمة معروفة" لكل (project_id, device_id,
--     metric) مع وقت رصدها، ليقرأه مسار القرار الحي مباشرة بلا حاجة لفحص
--     كامل device_measurements في كل تقييم.
--
-- project_devices.last_*/last_*_at (من 202608020004) تبقى كما هي بلا
-- تعديل أو حذف — أعمدة تاريخية لا تزال تُستهلَك في مسارات أخرى (الواجهة/
-- التنبيهات)؛ هذه الهجرة إضافية بحتة، لا تُبطل أي مسار قائم.
-- =====================================================================

create table if not exists public.device_events (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  device_id uuid not null references public.project_devices(id) on delete cascade,
  external_event_id text,
  sequence_no bigint check (sequence_no is null or sequence_no >= 0),
  source text not null default 'device',
  received_at timestamptz not null default clock_timestamp(),
  created_at timestamptz not null default clock_timestamp()
);

create unique index if not exists idx_device_events_device_event_unique
  on public.device_events (device_id, external_event_id)
  where external_event_id is not null;

create index if not exists idx_device_events_project_device
  on public.device_events (project_id, device_id, created_at desc);

-- metric: نفس أسماء NormalizedReading (windSpeedKmh/pm10/إلخ) — نص حر مقيَّد
-- بـcheck بدل enum منفصل، حتى تبقى الإضافة (لو لزم حقل قياس جديد لاحقاً)
-- تعديل قيد واحد بدل نوع Postgres.
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
  created_at timestamptz not null default clock_timestamp()
);

create index if not exists idx_device_measurements_event
  on public.device_measurements (event_id);

create index if not exists idx_device_measurements_latest_lookup
  on public.device_measurements (device_id, metric, observed_at desc);

-- device_metric_latest: Projection قابل لإعادة البناء الكامل من
-- device_measurements (select كل الحقول group by device_id, metric order by
-- observed_at desc limit 1) — لا يُعامَل كدليل تاريخي مستقل، فقط لقطة أحدث
-- قيمة لكل قياس لتسريع قراءة مسار القرار الحي.
create table if not exists public.device_metric_latest (
  project_id uuid not null references public.projects(id) on delete cascade,
  device_id uuid not null references public.project_devices(id) on delete cascade,
  metric text not null,
  value numeric not null,
  observed_at timestamptz not null,
  received_at timestamptz not null,
  source_measurement_id uuid not null references public.device_measurements(id) on delete restrict,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (project_id, device_id, metric)
);

create index if not exists idx_device_metric_latest_project_device
  on public.device_metric_latest (project_id, device_id);

-- Append-only على الدليل التاريخي — نفس مبدأ pm10_readings_history/
-- device_readings_history (202607290006/202608030007): لا UPDATE/DELETE من
-- أي دور تطبيقي، الإدراج فقط عبر RPC مسمّاة.
revoke update, delete on public.device_events from anon, authenticated, service_role;
revoke update, delete on public.device_measurements from anon, authenticated, service_role;
grant select, insert on public.device_events to service_role;
grant select, insert on public.device_measurements to service_role;
-- device_metric_latest يُحدَّث فعلياً (upsert) من الدالة الذرية أدناه —
-- يبقى select/insert/update لـservice_role فقط، لا delete.
grant select, insert, update on public.device_metric_latest to service_role;

alter table public.device_events enable row level security;
alter table public.device_measurements enable row level security;
alter table public.device_metric_latest enable row level security;
