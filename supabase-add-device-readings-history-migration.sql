-- =====================================================================
-- هجرة: device_readings_history — سجل تاريخي append-only لكل قراءات
-- الجهاز (لا PM10 فقط، بخلاف pm10_readings_history الموجود)
--
-- السبب: project_devices يخزّن آخر قراءة فقط (last_wind_speed_kmh،
-- last_visibility_m، last_relative_humidity_percent، last_temperature_c،
-- last_pm25...) بلا أي سجل زمني — فلا يمكن رسم بياني تاريخي لأي عنصر غير
-- PM10 (الذي له جدول تاريخي منفصل بالفعل: pm10_readings_history). طلب
-- المستخدم: "مؤشر للقراءات حق النشاط، رسم بياني منفصل لكل عنصر" — يتطلب
-- سجلاً زمنياً كاملاً لكل الحقول الثمانية المُرسَلة من /api/devices/ingest.
--
-- نفس بنية/فلسفة pm10_readings_history تماماً: append-only فعلياً (trigger
-- forbid_evidence_mutation يمنع UPDATE/DELETE، راجع supabase-append-only-
-- evidence-and-alert-events-migration.sql)، project_id + device_id لكل صف
-- (الجهاز مرتبط بالمشروع ككل لا بنشاط محدد — نفس مبدأ pm10_readings_history،
-- والتجميع حسب نشاط يتم عند القراءة عبر device_id المرتبط بالنشاط، لا عمود
-- activity_group_id هنا لتفادي التكرار).
--
-- كل حقل قياس nullable مستقل تماماً — نفس MEASUREMENT_FIELDS في
-- devices/ingest/route.ts: الكتابة جزئية (جهاز برياح فقط لا يرسل PM)، فصف
-- واحد قد يحمل بعض الحقول فقط بقيمة والبقية null.
-- =====================================================================

create table if not exists public.device_readings_history (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  device_id uuid not null references public.project_devices(id) on delete cascade,
  wind_speed_kmh numeric,
  wind_gust_kmh numeric,
  wind_direction_deg numeric,
  pm10_ug_m3 numeric,
  pm25_ug_m3 numeric,
  visibility_m numeric,
  relative_humidity_percent numeric,
  temperature_c numeric,
  recorded_at timestamptz not null default now()
);

create index if not exists idx_device_readings_history_device_time
  on public.device_readings_history (device_id, recorded_at desc);

create index if not exists idx_device_readings_history_project_time
  on public.device_readings_history (project_id, recorded_at desc);

alter table public.device_readings_history enable row level security;

-- append-only فعلياً — نفس forbid_evidence_mutation المستخدمة لجداول
-- الأدلة الأخرى (dust_evaluations، pm10_readings_history...). الدالة نفسها
-- معرَّفة مسبقاً في supabase-append-only-evidence-and-alert-events-migration.sql.
drop trigger if exists device_readings_history_immutable on public.device_readings_history;
create trigger device_readings_history_immutable
  before update or delete on public.device_readings_history
  for each row execute function public.forbid_evidence_mutation();

-- لا سياسات SELECT/INSERT لـ anon/authenticated — الكتابة تمر حصراً عبر
-- supabaseAdmin (service_role) من app/api/devices/ingest/route.ts بعد تحقق
-- هوية الجهاز عبر مفتاحه (requireDeviceApiKey)، والقراءة عبر supabaseAdmin
-- أيضاً من app/api/projects/[projectId]/device-readings-history/route.ts
-- (بعد تحقق ملكية المشروع عبر requireUserId/verifyProjectOwnership).
revoke all on public.device_readings_history from anon, authenticated;
