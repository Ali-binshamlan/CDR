-- =====================================================================
-- DCR — 202608190003_technical_fault_events.sql
-- =====================================================================
-- طلب مستخدم صريح ("سجل الأعطال والتدقيق"): عند فشل استعلام سلسلة PM10
-- التاريخية (pm10HistoryQueryFailed=true، راجع Pm10SustainedFetchResult في
-- dustEvaluation.ts) يجب تسجيل حدث تقني في مسار Telemetry حقيقي، لا
-- الاكتفاء بـconsole.error كما كان الحال سابقاً. لا يوجد جدول عام لهذا
-- الغرض في المخطط الحالي (alert_state_events خاص بتغييرات حالة تنبيه
-- موجود بالفعل، device_events خاص بأحداث الأجهزة) — هذه الهجرة تنشئ جدولاً
-- مخصصاً للأعطال التقنية العامة في مسار التقييم، يبدأ بنوع الحدث الوحيد
-- المطلوب حالياً (PM10_HISTORY_QUERY_FAILED) لكن بعمود eventType عاماً كي
-- يُعاد استخدامه لأعطال تقنية مشابهة لاحقاً بلا هجرة جديدة لكل نوع.
--
-- تصميم متعمد (مبدأ عدم تسريب تفاصيل داخلية، طلب المستخدم صراحة):
--   - لا عمود لنص PostgreSQL الداخلي، ولا Stack trace، ولا بيانات اتصال
--     قاعدة البيانات. الحقل الوحيد شبه الحر هو retry_count (رقم) — لا نص
--     خطأ خام يُخزَّن هنا إطلاقاً. أي تفصيل تشخيصي أعمق يبقى في سجلات
--     الخادم (console.error) فقط، لا في جدول تُقرأ منه الواجهة.
--   - append-only (نفس نمط alert_state_events/forbid_evidence_mutation)
--     لأنه سجل تدقيق: لا تعديل ولا حذف بعد الإدراج.
--   - idempotency: عمود dedupe_key فريد لكل (project_id, activity_group_id)
--     ضمن دقيقة واحدة (نفس مبدأ project_evaluation_jobs.dedupe_key الموثَّق
--     في evaluateProject.ts:enqueueEvaluationRetryJob) — يمنع تكرار نفس
--     العطل غير المتغيّر كل دقيقة في هذا الجدول، لا في التنبيه المعروض
--     للمستخدم فقط.
create table if not exists public.technical_fault_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null check (event_type in ('PM10_HISTORY_QUERY_FAILED')),
  project_id uuid not null references public.projects(id) on delete cascade,
  activity_group_id uuid,
  device_id uuid,
  evaluation_id uuid,
  retry_count integer not null default 0,
  evaluated_at timestamptz not null,
  dedupe_key text not null,
  created_at timestamptz not null default clock_timestamp(),
  unique (project_id, dedupe_key)
);

create index if not exists idx_technical_fault_events_project
  on public.technical_fault_events (project_id, created_at desc);

alter table public.technical_fault_events enable row level security;

drop trigger if exists technical_fault_events_immutable on public.technical_fault_events;
create trigger technical_fault_events_immutable
  before update or delete on public.technical_fault_events
  for each row execute function public.forbid_evidence_mutation();

-- لا سياسات SELECT/INSERT لـanon/authenticated — نفس فلسفة alert_state_events:
-- الكتابة والقراءة التشخيصية تمران حصراً عبر service_role (لوحات تدقيق
-- داخلية مستقبلية، لا واجهة المستخدم العادية).
revoke all on public.technical_fault_events from anon, authenticated;
grant select, insert on public.technical_fault_events to service_role;
