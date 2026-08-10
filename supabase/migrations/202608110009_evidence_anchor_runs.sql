-- =====================================================================
-- DCR — 202608110009_evidence_anchor_runs.sql
-- =====================================================================
-- التثبيت الخارجي على GitHub (لا مشروع Supabase ثانٍ — تحت نفس نموذج
-- التهديد؛ ولا HMAC — أي سر يعيش داخل نفس Postgres يقدر مالك القاعدة نفسه
-- قراءته). سجل كل محاولة تثبيت، حتى الفاشلة (بلا github_commit_sha، مع
-- error) — يميّز "لم تعمل الدورة" عن "عملت وفشل الاتصال بـGitHub".
--
-- جدول أدلة أيضاً (يوثّق تاريخ التثبيت الخارجي نفسه) — نفس حماية
-- append-only.
-- =====================================================================

create table if not exists public.evidence_anchor_runs (
  id uuid primary key default gen_random_uuid(),
  ledger_seq bigint references public.evidence_hash_ledger(seq),
  chain_hash text not null,
  github_commit_sha text,
  github_path text,
  anchored_at timestamptz not null default clock_timestamp(),
  error text
);

create index if not exists idx_evidence_anchor_runs_anchored_at
  on public.evidence_anchor_runs (anchored_at desc);

alter table public.evidence_anchor_runs enable row level security;
revoke all on public.evidence_anchor_runs from anon, authenticated;
grant select, insert on public.evidence_anchor_runs to service_role;

drop trigger if exists evidence_anchor_runs_immutable on public.evidence_anchor_runs;
create trigger evidence_anchor_runs_immutable
  before update or delete on public.evidence_anchor_runs
  for each row execute function public.forbid_evidence_mutation();

drop trigger if exists evidence_anchor_runs_no_truncate on public.evidence_anchor_runs;
create trigger evidence_anchor_runs_no_truncate
  before truncate on public.evidence_anchor_runs
  for each statement execute function public.forbid_evidence_truncate();

revoke truncate on public.evidence_anchor_runs from anon, authenticated, service_role;
