-- =====================================================================
-- DCR — 202608030008_scheduler_lock.sql
-- =====================================================================
-- خطأ تشغيلي مكتشَف — مراجعة كود خبير خارجي: "لا يوجد Cron شامل لكل
-- المشاريع، ولا قفل زمني لكل دقيقتين". evaluateProject حالياً لا تُستدعى
-- إلا كأثر جانبي لحدث آخر (قراءة جهاز جديدة عبر push/pull، أو فتح المستخدم
-- للوحة يدوياً) — مشروع بلا جهاز نشط أو بلا قراءة حديثة لا يُعاد تقييمه
-- زمنياً أبداً (مثال: نشاط ينتقل لحالة "بدأ الآن" حسب الساعة لا يُكتشف
-- تلقائياً بلا حدث خارجي يُحفِّزه).
--
-- scheduler_locks: جدول قفل بسيط بمفتاح مركب (project_id, time_bucket) —
-- time_bucket نافذة دقيقتين ثابتة (epoch الدقائق مقسومة على 2)، لا timestamp
-- حر. أي محاولة INSERT ثانية لنفس (project_id, time_bucket) ترتطم بقيد
-- PRIMARY KEY فتفشل فوراً (تعارض 23505) — هذا هو القفل نفسه، لا حاجة
-- لـpg_advisory_lock هنا لأن النافذة الزمنية (لا المعاملة الحالية) هي وحدة
-- الحصرية المطلوبة: نفس المشروع في نفس نافذة الدقيقتين مرة واحدة فقط، بصرف
-- النظر عن عدد استدعاءات scheduler-tick المتزامنة أو المعاد محاولتها من
-- خدمة cron خارجية.
create table if not exists public.scheduler_locks (
  project_id uuid not null references public.projects(id) on delete cascade,
  time_bucket bigint not null,
  locked_at timestamptz not null default now(),
  primary key (project_id, time_bucket)
);

-- تنظيف دوري ضمني: لا نحتاج صفوفاً أقدم من بضع ساعات إطلاقاً (فقط
-- time_bucket الحالي/الأخير يُفحَص عملياً) — فهرس على locked_at يسهّل أي
-- DELETE دوري مستقبلي (خارج نطاق هذه الهجرة، لا trigger تلقائي هنا).
create index if not exists idx_scheduler_locks_locked_at on public.scheduler_locks (locked_at);

alter table public.scheduler_locks enable row level security;
-- عمداً بلا أي سياسة RLS — service_role فقط (نفس نمط admin_audit_log).

revoke all on public.scheduler_locks from anon, authenticated;
