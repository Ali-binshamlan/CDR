-- =====================================================================
-- هجرة: إغلاق ثغرة "سجل القرارات والتنبيهات قابل للتعديل والحذف"
-- (مراجعة كود خبير خارجي)
--
-- الثغرة المكتشفة: decision_records/alerts قابلان للـ UPDATE/DELETE من
-- طرف مالك المشروع (RLS for all)، وDELETE /api/projects/[projectId]
-- (route.ts) كان يحذف صراحةً alerts/decision_records/dust_evaluations/
-- dust_compliance_evaluations قبل حذف المشروع نفسه — فمالك يواجه مخالفة
-- تنظيمية موثَّقة يقدر يمحو دليلها بالكامل (تعديل حالة تنبيه، حذفه، أو
-- حذف المشروع كله) بضغطة واحدة، بلا أي أثر تدقيق.
--
-- الإصلاح (نطاقان):
-- 1) جداول الأدلة (decision_records/dust_evaluations/dust_compliance_
--    evaluations/pm10_readings_history) تصبح append-only فعلياً على
--    مستوى قاعدة البيانات — trigger يمنع UPDATE/DELETE حتى لو نفَّذه
--    supabaseAdmin (service_role)، لا فقط RLS (RLS لا تُطبَّق على
--    service_role إطلاقاً، فهي وحدها لم تكن كافية).
-- 2) alerts.state يصبح عموداً مشتقاً (derived) — لا يُكتب إليه مباشرة من
--    أي كود تطبيق بعد الآن، فقط عبر trigger يقرأ آخر صف في
--    alert_state_events (جدول أحداث append-only جديد). تغيير الحالة يصبح
--    حدثاً جديداً دائماً، لا استبدالاً للحالة القديمة. هذا يُبقي كل قراءات
--    alerts.state الحالية في التطبيق (9+ موقع) تعمل بلا أي تعديل — فقط
--    مسار الكتابة تغيّر جذرياً.
-- 3) المشروع لا يُحذف فعلياً بعد الآن — يُؤرشف (archived_at/archived_by).
--    DELETE /api/projects/[projectId] في الكود يتوقف عن حذف جداول الأدلة
--    نهائياً (تغيير كود منفصل مطلوب بجانب هذه الهجرة).
-- =====================================================================


-- ------------------------------------------------------------------
-- 1) دالة عامة تمنع UPDATE/DELETE — نفس الدالة لكل جداول الأدلة
-- ------------------------------------------------------------------
create or replace function public.forbid_evidence_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'audit/evidence rows are append-only — % on % is not permitted', TG_OP, TG_TABLE_NAME;
end;
$$;

drop trigger if exists decision_records_immutable on public.decision_records;
create trigger decision_records_immutable
  before update or delete on public.decision_records
  for each row execute function public.forbid_evidence_mutation();

drop trigger if exists dust_evaluations_immutable on public.dust_evaluations;
create trigger dust_evaluations_immutable
  before update or delete on public.dust_evaluations
  for each row execute function public.forbid_evidence_mutation();

drop trigger if exists compliance_evaluations_immutable on public.dust_compliance_evaluations;
create trigger compliance_evaluations_immutable
  before update or delete on public.dust_compliance_evaluations
  for each row execute function public.forbid_evidence_mutation();

-- pm10_readings_history هو المكافئ الفعلي لـ"sensor_pm10_events" في هذا
-- المشروع (لا يوجد جدول باسم sensor_pm10_events هنا) — سجل قراءات PM10
-- الميداني (device/manual فقط بعد فصل توقعات Open-Meteo إلى weather_
-- forecasts، راجع supabase-add-weather-forecasts-table-migration.sql)
-- الذي يُبنى عليه إثبات "استمرار مخالفة" — نفس درجة حساسية الأدلة أعلاه.
drop trigger if exists pm10_readings_history_immutable on public.pm10_readings_history;
create trigger pm10_readings_history_immutable
  before update or delete on public.pm10_readings_history
  for each row execute function public.forbid_evidence_mutation();


-- ------------------------------------------------------------------
-- 2) alert_state_events — سجل أحداث append-only لتغييرات حالة التنبيه
-- ------------------------------------------------------------------
create table if not exists public.alert_state_events (
  id uuid primary key default gen_random_uuid(),
  alert_id uuid not null references public.alerts(id) on delete restrict,
  previous_state text,
  new_state text not null check (
    new_state in ('NEW', 'REVIEWED', 'ACTION_TAKEN', 'CLOSED')
  ),
  -- nullable عمداً (بخلاف اقتراح المراجعة الأصلي not null): بعض التغييرات
  -- مصدرها نظامي بحت لا مستخدم بشري — إنشاء التنبيه الأولي (state='NEW')
  -- وautoCloseResolvedAlerts (إغلاق تلقائي عند زوال الشرط، عبر Cron/
  -- alerts/generate/route.ts، بلا جلسة Supabase أصلاً). فرض not null هنا
  -- كان سيتطلب اختلاق مستخدم "نظام" وهمي في auth.users — أقل صدقاً من
  -- ترك actor_user_id فارغاً بوضوح ليعني "تغيير آلي، لا فعل بشري". null
  -- = آلي (نظام/Cron)، غير null = مستخدم بشري فعلي عبر PATCH
  -- /api/alerts/[alertId].
  actor_user_id uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index if not exists idx_alert_state_events_alert_id
  on public.alert_state_events (alert_id, created_at desc);

alter table public.alert_state_events enable row level security;

-- append-only أيضاً — لا UPDATE/DELETE على سجل الأحداث نفسه.
drop trigger if exists alert_state_events_immutable on public.alert_state_events;
create trigger alert_state_events_immutable
  before update or delete on public.alert_state_events
  for each row execute function public.forbid_evidence_mutation();

-- لا سياسات SELECT/INSERT لـ anon/authenticated — الكتابة تمر حصراً عبر
-- supabaseAdmin (service_role) من app/api/alerts/[alertId]/route.ts
-- وapp/api/alerts/generate/route.ts بعد تحقق ملكية/هوية صريح في الكود.
revoke all on public.alert_state_events from anon, authenticated;


-- ------------------------------------------------------------------
-- 3) alerts.state يصبح عموداً مشتقاً — trigger على alert_state_events
--    يحدّثه تلقائياً، لا كتابة مباشرة من أي API route بعد الآن.
-- ------------------------------------------------------------------
create or replace function public.sync_alert_state_from_event()
returns trigger
language plpgsql
as $$
begin
  update public.alerts
  set state = new.new_state
  where id = new.alert_id;
  return new;
end;
$$;

drop trigger if exists alert_state_events_sync on public.alert_state_events;
create trigger alert_state_events_sync
  after insert on public.alert_state_events
  for each row execute function public.sync_alert_state_from_event();

-- alerts.state يبقى عموداً عادياً (لا نوع مولَّد generated column، لأن
-- INSERT الأولي لصف alert جديد يضبط state='NEW' مباشرة قبل أي حدث — راجع
-- insertAlert في app/api/alerts/generate/route.ts، لا تغيير هناك). المنع
-- الفعلي لتعديله مباشرة يأتي من REVOKE UPDATE أدناه على العمود تحديداً،
-- مطابقاً لنفس نمط profiles/project_devices في هجرات سابقة — لا مسار
-- تطبيق واحد يبقى قادراً على UPDATE alerts SET state=... مباشرة، فقط عبر
-- INSERT في alert_state_events الذي يشغّل الـ trigger أعلاه (يعمل عبر
-- supabaseAdmin دائماً، فلا يتأثر بـ REVOKE على anon/authenticated).
revoke update (state) on public.alerts from authenticated;


-- ------------------------------------------------------------------
-- 4) أرشفة المشاريع بدل الحذف الفعلي — يبقي كل الأدلة المرتبطة قابلة
--    للتدقيق حتى بعد "حذف" المشروع من منظور المستخدم.
-- ------------------------------------------------------------------
alter table public.projects
  add column if not exists archived_at timestamptz,
  add column if not exists archived_by uuid references auth.users(id);

create index if not exists idx_projects_archived_at
  on public.projects (archived_at)
  where archived_at is not null;
