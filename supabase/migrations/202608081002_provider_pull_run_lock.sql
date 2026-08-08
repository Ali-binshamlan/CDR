-- =====================================================================
-- DCR — 202608081002_provider_pull_run_lock.sql
-- =====================================================================
-- حادثة إنتاج فعلية (2026-08-08، راجع 202608081001 لتفاصيل الأعراض):
-- cron-job.org يستدعي /api/cron/provider-pull كل دقيقة، لكن دورة واحدة
-- (حلقة تسلسلية بالكامل عبر كل الاتصالات النشطة: فك تشفير + fetchReadingsSince
-- لكل محطة خارجية + كتابة كل قراءة + إعادة تقييم كل مشروع متأثر) قد تأخذ
-- أكثر من دقيقة تحت حمل حقيقي. الاستدعاء التالي يبدأ فوق السابق قبل
-- اكتماله، فتتراكم دورات متزامنة تتنافس على نفس الاتصالات/الأقفال
-- الاستشارية (persist_activity_decision_atomic وغيرها) وتستنزف connection
-- pool بالكامل — حتى طلبات لا علاقة لها بـprovider-pull (لوحة التحكم) تفشل.
--
-- الإصلاح: نفس نمط scheduler_locks (202608030008) — قيد PRIMARY KEY على
-- نافذة زمنية، لا pg_advisory_lock. أي محاولة INSERT ثانية لنفس run_bucket
-- (نافذة 60 ثانية ثابتة) ترتطم بالقيد وتفشل فوراً (23505) بدل الانتظار —
-- الكود (route.ts) يترجم هذا الفشل إلى "دورة سابقة لا تزال قيد التنفيذ،
-- تخطَّ هذه الدورة" ويرجع 200 فوراً بلا أي عمل، بدل إضافة حمل فوق حمل.
create table if not exists public.provider_pull_run_lock (
  run_bucket bigint primary key,
  started_at timestamptz not null default now()
);

create index if not exists idx_provider_pull_run_lock_started_at
  on public.provider_pull_run_lock (started_at);

alter table public.provider_pull_run_lock enable row level security;
-- عمداً بلا أي سياسة RLS — service_role فقط (نفس نمط scheduler_locks).

revoke all on public.provider_pull_run_lock from anon, authenticated;
