-- =====================================================================
-- DCR — 202607290005_device_event_contract.sql
-- =====================================================================
-- خطأ معماري مكتشَف ومُصلَح (مراجعة كود خبير خارجي — C-03: "عقد أحداث
-- الجهاز غير منفذ"): /api/devices/ingest لم يكن يستقبل أي معرّف حدث
-- (eventId)، ولا تسلسلاً (sequence)، ولا وقت رصد مستقل عن وقت وصول الخادم
-- (observedAt) — فاستخدم دائماً new Date() (وقت استلام الخادم) كوقت القراءة
-- الفعلي. بلا قيد uniqueness على (device_id, external_event_id)، إعادة
-- إرسال نفس الحدث (فشل شبكة يعيد المحاولة، أو إعادة تشغيل الجهاز فيعيد آخر
-- حمولة محفوظة محلياً) تُنشئ صفاً جديداً في pm10_readings_history/
-- device_readings_history في كل مرة — قد يصنع مدة استمرار PM10 وهمية
-- (computeSustainedPm10Status في dustEvaluation.ts تعتمد على عدد/تباعد
-- العينات الزمني لإثبات "مخالفة مؤكَّدة").
--
-- الإصلاح:
--   1. عمود external_event_id (نصي، هوية الحدث من الجهاز نفسه — nullable:
--      أجهزة/سكربتات لا ترسله بعد تستمر بالعمل بلا كسر توافقي، فقط بلا
--      حماية تكرار).
--   2. عمود sequence_no (تسلسل رقمي من الجهاز، للعرض/التدقيق — يساعد على
--      اكتشاف فجوات إرسال لاحقاً، لا يُستخدم حالياً لأي قرار حسابي).
--   3. عمود observed_at (وقت رصد القراءة الفعلي من الجهاز نفسه، مستقل عن
--      recorded_at/created_at اللذين يبقيان وقت وصول الخادم دائماً — راجع
--      تعليق observedAt في route.ts للتحقق المطبَّق عليه).
--   4. فهرس uniqueness جزئي على (device_id, external_event_id) — يمنع إدراج
--      نفس الحدث مرتين لنفس الجهاز فعلياً على مستوى قاعدة البيانات (لا مجرد
--      فحص تطبيقي قابل لتزامن سباق race condition)، فقط عندما يُرسَل
--      external_event_id فعلاً (partial index، where not null) — صفوف
--      manual/قديمة بلا معرّف حدث لا تخضع لهذا القيد إطلاقاً.
-- =====================================================================

alter table public.pm10_readings_history
  add column if not exists external_event_id text,
  add column if not exists sequence_no bigint,
  add column if not exists observed_at timestamptz;

-- device_readings_history يُنشأ هنا (لا في 202607290006 كما كان سابقاً)
-- لأن ALTER TABLE أدناه يعتمد عليه فوراً — إنشاؤه لاحقاً في 006 كان يكسر
-- `supabase db reset` على قاعدة فارغة (ALTER على جدول غير موجود بعد).
-- التعريف الكامل (فهارس/RLS/trigger append-only) يبقى في 006 كما هو —
-- هنا فقط create table أساسي كافٍ ليصح ALTER عليه، و006 يستكمل الباقي
-- بأوامر idempotent (create index if not exists، إلخ) فلا تكرار ضار.
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

alter table public.device_readings_history
  add column if not exists external_event_id text,
  add column if not exists sequence_no bigint,
  add column if not exists observed_at timestamptz;

create unique index if not exists idx_pm10_readings_history_device_event_unique
  on public.pm10_readings_history (device_id, external_event_id)
  where external_event_id is not null;

create unique index if not exists idx_device_readings_history_device_event_unique
  on public.device_readings_history (device_id, external_event_id)
  where external_event_id is not null;
