-- =====================================================================
-- DCR — 202607290004_append_only_audit.sql
-- =====================================================================
-- ⚠ مسودة غير مُختبرة على بيئة Supabase فعلية — راجع تحذير
-- 202607290001_baseline_final.sql. يُشغَّل بعد 202607290003 مباشرة (آخر
-- ملف في هذا المسار).
--
-- خطأ أمني مكتشَف ومُصلَح (مراجعة كود خبير خارجي — "سجل القرارات
-- والتنبيهات قابل للتعديل والحذف"): decision_records/alerts كانا قابلين
-- للـUPDATE/DELETE من مالك المشروع (RLS for all)، وDELETE على المشروع كان
-- يحذف صراحة alerts/decision_records/dust_evaluations/dust_compliance_
-- evaluations قبل حذف المشروع نفسه — فمالك يواجه مخالفة تنظيمية موثَّقة
-- يقدر يمحو دليلها بالكامل بضغطة واحدة، بلا أي أثر تدقيق.
--
-- هذا الملف يدمج 3 هجرات فردية بحالتها النهائية الصحيحة مباشرة (لا
-- تدريجياً كما وقع تاريخياً — راجع الترتيب الفعلي بجذر المشروع:
-- supabase-append-only-evidence-and-alert-events-migration.sql ثم
-- supabase-fix-evidence-cascade-delete-migration.sql ثم
-- supabase-fix-forbid-evidence-mutation-allow-fk-setnull-migration.sql):
--   1) جداول الأدلة (decision_records/dust_evaluations/dust_compliance_
--      evaluations/pm10_readings_history) تصبح append-only فعلياً على
--      مستوى قاعدة البيانات — trigger يمنع UPDATE/DELETE حتى لو نفَّذه
--      service_role (RLS لا تُطبَّق على service_role إطلاقاً، فهي وحدها
--      غير كافية). الدالة هنا مكتوبة مباشرة بصيغتها **النهائية المصحَّحة**
--      (تسمح فقط بحالة واحدة استثنائية: UPDATE ينُلّ dust_profile_id فقط
--      على dust_evaluations/dust_compliance_evaluations — الاستثناء الذي
--      يحتاجه ON DELETE SET NULL في الباسلاين، راجع الشرح أدناه) — لا حاجة
--      لكتابة نسخة أولى تمنع كل شيء بلا استثناء ثم تصحيحها لاحقاً، لأن
--      الباسلاين (202607290001) يبني dust_profile_id كـnullable+SET NULL
--      منذ البداية أصلاً، فيصطدم بنفس المشكلة فوراً لو كتبنا الدالة بلا
--      الاستثناء من الأساس.
--   2) alerts.state يصبح عموداً مشتقاً من alert_state_events (جدول أحداث
--      append-only جديد) عبر trigger — لا كتابة مباشرة لأي كود تطبيق بعد
--      الآن.
--   3) المشروع لا يُحذف فعلياً — يُؤرشف (archived_at/archived_by).
-- =====================================================================


-- ------------------------------------------------------------------
-- 1) دالة عامة تمنع UPDATE/DELETE على جداول الأدلة — بصيغتها النهائية
--    المصحَّحة من البداية (تسمح حصراً بـUPDATE الناتج عن ON DELETE SET NULL
--    على dust_profile_id، ترفض أي شيء آخر بلا استثناء)
-- ------------------------------------------------------------------
create or replace function public.forbid_evidence_mutation()
returns trigger
language plpgsql
as $$
begin
  if TG_OP = 'UPDATE'
     and TG_TABLE_NAME in ('dust_evaluations', 'dust_compliance_evaluations')
     and NEW.dust_profile_id is null
     and OLD.dust_profile_id is distinct from NEW.dust_profile_id
     and to_jsonb(NEW) - 'dust_profile_id' = to_jsonb(OLD) - 'dust_profile_id'
  then
    return NEW;
  end if;

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

-- pm10_readings_history: سجل قراءات PM10 الميداني (device/manual فقط بعد
-- فصل توقعات Open-Meteo إلى weather_forecasts في الباسلاين) — نفس درجة
-- حساسية الأدلة أعلاه. لا يملك عمود dust_profile_id، فيبقى ممنوعاً 100%
-- بلا أي استثناء (الشرط أعلاه لا يشمل اسم هذا الجدول أصلاً).
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
  -- nullable عمداً: null = تغيير آلي (نظام/Cron، مثال autoCloseResolvedAlerts
  -- أو إنشاء التنبيه الأولي)، غير null = مستخدم بشري فعلي عبر PATCH.
  actor_user_id uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index if not exists idx_alert_state_events_alert_id
  on public.alert_state_events (alert_id, created_at desc);

alter table public.alert_state_events enable row level security;

drop trigger if exists alert_state_events_immutable on public.alert_state_events;
create trigger alert_state_events_immutable
  before update or delete on public.alert_state_events
  for each row execute function public.forbid_evidence_mutation();

-- لا سياسات SELECT/INSERT لـanon/authenticated — الكتابة تمر حصراً عبر
-- service_role بعد تحقق ملكية/هوية صريح في الكود.
revoke all on public.alert_state_events from anon, authenticated;


-- ------------------------------------------------------------------
-- 3) alerts.state يصبح عموداً مشتقاً — trigger على alert_state_events
--    يحدّثه تلقائياً، لا كتابة مباشرة من أي API route بعد الآن
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

-- alerts.state يبقى عموداً عادياً (لا generated column — INSERT الأولي
-- لصف alert جديد يضبط state='NEW' مباشرة قبل أي حدث). المنع الفعلي
-- لتعديله مباشرة يأتي من REVOKE على العمود تحديداً — لا مسار تطبيق واحد
-- يبقى قادراً على UPDATE alerts SET state=... مباشرة، فقط عبر INSERT في
-- alert_state_events الذي يشغّل الـtrigger أعلاه (يعمل دائماً عبر
-- service_role، فلا يتأثر بهذا الـREVOKE).
revoke update (state) on public.alerts from authenticated;


-- ------------------------------------------------------------------
-- 4) أرشفة المشاريع بدل الحذف الفعلي
-- ------------------------------------------------------------------
alter table public.projects
  add column if not exists archived_at timestamptz,
  add column if not exists archived_by uuid references auth.users(id);

create index if not exists idx_projects_archived_at
  on public.projects (archived_at)
  where archived_at is not null;

-- ⚠ يتطلب تغييراً مرافقاً في الكود (خارج نطاق SQL): DELETE
-- /api/projects/[projectId] يجب أن يتوقف عن حذف alerts/decision_records/
-- dust_evaluations/dust_compliance_evaluations/project_dust_profiles/
-- المشروع نفسه فعلياً، ويكتفي بضبط projects.archived_at/archived_by بدلاً
-- من ذلك. راجع حالة هذا الكود الفعلية في app/api/projects/[projectId]/route.ts
-- قبل الاعتماد على هذه الهجرة وحدها لإغلاق الثغرة بالكامل.


-- =====================================================================
-- اختبارات مطلوبة قبل الاعتماد على هذا المسار (202607290001..0004) —
-- طلب صريح من المستخدم، لم تُنفَّذ فعلياً من هذه الجلسة (لا وصول لبيئة
-- Supabase حقيقية من هنا):
--
-- 1) قاعدة فارغة تقبل كل الملفات الأربعة بالترتيب دون خطأ:
--      supabase db reset   -- أو مشروع Supabase جديد فارغ تماماً
--      ثم تنفيذ 202607290001 → 0002 → 0003 → 0004 بالترتيب، top-to-bottom.
--
-- 2) نسخة من قاعدة الإنتاج الحالية (built من الـ21 ملف القديم) تقبل ترقية
--    مستقلة: يعني تشغيل ما تبقى من الملفات الأربعة (أي جزء لم يُطبَّق بعد
--    على تلك القاعدة تحديداً) بأمان فوق حالتها الحالية بلا تعارض. يتطلب
--    فحص يدوي لكل عمود/جدول قبل التشغيل (كل هذه الملفات تستخدم IF NOT
--    EXISTS/IF EXISTS بقدر الإمكان، لكن قوائم CHECK/DROP POLICY تُعاد
--    كتابتها بلا شرط في بعض المواضع — راجع كل ALTER/CREATE POLICY أعلاه
--    يدوياً مقابل الحالة الفعلية لتلك القاعدة تحديداً أولاً).
--
-- 3) Schema diff بين المسارين (قاعدة جديدة عبر الملفات الأربعة، مقابل
--    قاعدة الإنتاج المرقّاة عبر المسار القديم) يساوي صفراً:
--      supabase db diff --linked   -- أو pg_dump --schema-only لكل قاعدة
--      ومقارنة الناتجين نصياً (diff).
--
-- 4) يقلع التطبيق (npm run dev / npm run build ثم تشغيل فعلي) بعد كل
--    مسار، مع تنفيذ يدوي لمسار كامل واحد على الأقل (تسجيل دخول → إنشاء
--    مشروع → إضافة نشاط غبار → ربط جهاز رصد → توليد تنبيه) للتأكد أن كل
--    RLS/GRANT/trigger الجديدة لا تكسر أي عملية كتابة فعلية من الكود.
--
-- 5) الهجرات التدميرية (حذف عمود/تضييق قيد) لا تُشغَّل على قاعدة إنتاج
--    فعلية قبل backfill + خطة استعادة موثَّقة — هذا الملف نفسه لا يحذف أي
--    عمود إنتاجي فعلي (كل شيء هنا CREATE/ALTER ADD/REVOKE)، لكن أي تطبيق
--    مستقبلي لهذا المسار على قاعدة إنتاج قائمة فعلاً (بدل قاعدة فارغة)
--    سيحتاج خطة انتقال منفصلة تماماً عن هذه الملفات الأربعة (خارج نطاق هذه
--    المهمة — هذه الملفات مصمَّمة لقاعدة فارغة جديدة فقط، راجع تعليق
--    "الاستخدام" في 202607290001).
-- =====================================================================
