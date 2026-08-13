-- =====================================================================
-- DCR — 202608040004_evaluation_jobs_and_runs.sql
-- =====================================================================
-- خطأ تشغيلي مكتشَف (القسم 10.1 من "دليل الإصلاح الجذري لمنظومة مرقاب" —
-- "لماذا الجدول الحالي غير كافٍ؟"): scheduler_locks(project_id,time_bucket)
-- يمنع تكراراً داخل نافذة زمنية فقط، لكنه:
--   - لا يمنع تداخل Scheduler مع Push/طلب المستخدم (كل مسار يُقيَّم بمعزل).
--   - يعالج كل المشاريع في طلب واحد تسلسلياً (لا عمال متعددون).
--   - يتضخم بلا تنظيف (صف واحد لكل مشروع لكل نافذة دقيقتين، للأبد).
--   - لا يملك Lease (فشل عامل منتصف التنفيذ لا يُسترجَع أبداً).
--   - لا يعيد المحاولة بعد فشل التقييم (فشل واحد = صمت حتى الدورة التالية).
--
-- الإصلاح (القسم 10.2): طابور مهام حقيقي (project_evaluation_jobs) بحالات
-- صريحة (PENDING/RUNNING/RETRY/SUCCEEDED/DEAD)، Lease زمني قابل للاسترداد
-- (FOR UPDATE SKIP LOCKED)، وBackoff بين المحاولات. scheduler_locks
-- (202608030008) لا تُحذف هنا — تبقى تاريخياً، لكن scheduler-tick/route.ts
-- (الكود، لا هذه الهجرة) يتحول لإنشاء صفوف هنا بدل الاعتماد عليها وحدها.
-- =====================================================================

create table if not exists public.project_evaluation_jobs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  dedupe_key text not null,
  trigger_type text not null check (trigger_type in (
    'SCHEDULED', 'DEVICE_EVENT', 'PROVIDER_PULL', 'USER_REQUEST'
  )),
  status text not null default 'PENDING' check (status in (
    'PENDING', 'RUNNING', 'RETRY', 'SUCCEEDED', 'DEAD'
  )),
  run_after timestamptz not null default clock_timestamp(),
  attempts integer not null default 0,
  worker_id uuid,
  lease_until timestamptz,
  last_error text,
  created_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  unique (project_id, dedupe_key)
);

create index if not exists idx_project_evaluation_jobs_claim
  on public.project_evaluation_jobs (status, run_after, created_at);

create index if not exists idx_project_evaluation_jobs_project
  on public.project_evaluation_jobs (project_id, created_at desc);

alter table public.project_evaluation_jobs enable row level security;
revoke all on public.project_evaluation_jobs from anon, authenticated;
grant select, insert, update on public.project_evaluation_jobs to service_role;

-- القسم 11.2 — Evaluation Run: يربط كل دورة تقييم فعلية (DVI + Compliance +
-- FinalDecision لكل الأنشطة المتأثرة) بمعرّف واحد، بصرف النظر عن مصدر
-- التحفيز (Scheduled/Device Event/Provider Pull/User Request). final_decisions
-- لا تُعدَّل هنا (عمود evaluation_run_id يبقى لمرحلة Outbox اللاحقة، القسم
-- 11.3) — هذه الهجرة تقتصر على إنشاء الجدول وربطه بـproject_evaluation_jobs
-- فقط، تجنباً لتغيير جدول أدلة مقفل (append-only) في نفس الهجرة.
create table if not exists public.evaluation_runs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  evaluation_job_id uuid references public.project_evaluation_jobs(id) on delete set null,
  trigger_type text not null check (trigger_type in (
    'SCHEDULED', 'DEVICE_EVENT', 'PROVIDER_PULL', 'USER_REQUEST'
  )),
  as_of timestamptz not null,
  status text not null check (status in ('RUNNING', 'SUCCEEDED', 'FAILED')),
  activities_evaluated integer not null default 0,
  activities_failed integer not null default 0,
  error text,
  started_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz
);

create index if not exists idx_evaluation_runs_project_time
  on public.evaluation_runs (project_id, started_at desc);

alter table public.evaluation_runs enable row level security;
revoke all on public.evaluation_runs from anon, authenticated;
grant select, insert, update on public.evaluation_runs to service_role;

-- القسم 10.3 — الإثبات التشغيلي: Heartbeat ومقاييس (scheduler_last_
-- heartbeat_at, jobs_due, jobs_running, jobs_dead, evaluation_lag_seconds,
-- last_successful_project_evaluation_at) — جدول صف واحد يُحدَّثه scheduler-
-- tick في كل استدعاء ناجح؛ endpoint منفصل (app/api/cron/scheduler-heartbeat)
-- يقرأه ويحسب المقاييس المشتقة (jobs_due/jobs_running/jobs_dead من
-- project_evaluation_jobs مباشرة، evaluation_lag_seconds من الفارق بين
-- الآن ووقت آخر heartbeat).
create table if not exists public.scheduler_heartbeat (
  id boolean primary key default true check (id),
  last_heartbeat_at timestamptz not null default clock_timestamp(),
  last_successful_project_evaluation_at timestamptz
);

insert into public.scheduler_heartbeat (id) values (true) on conflict (id) do nothing;

alter table public.scheduler_heartbeat enable row level security;
revoke all on public.scheduler_heartbeat from anon, authenticated;
grant select, insert, update on public.scheduler_heartbeat to service_role;
