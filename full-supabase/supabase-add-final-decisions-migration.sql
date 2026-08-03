-- =====================================================================
-- هجرة: final_decisions — لقطة واحدة موثوقة لكل قرار نهائي (decideFinal)
--
-- الثغرة المعمارية المكتشَفة (مراجعة كود مدير — "FinalDecisionEngine ليس
-- المصدر التشغيلي الوحيد فعلياً"): decideFinal (final-decision-engine)
-- موجود ويُستدعى من 4 مسارات مستقلة تماماً (البانر عبر computeUnifiedActivityDecision
-- في dustEvaluation.ts، dashboard/global/route.ts، viewer/dashboard/route.ts،
-- alerts/generate/route.ts) — كل مسار يُعيد بناء dvi/compliance/aei ويستدعي
-- decideFinal بنفسه، بمعرّف snapshotId مختلف (`unified`، `global:${id}`،
-- `viewer:${id}`، `alert-gen:${id}`)، بلا أي تخزين للنتيجة الفعلية ولا
-- decisionId واحد يربط البطاقة/الخريطة/التخزين/التنبيه معاً. أربع إعادات
-- حساب مستقلة لنفس المدخلات نظرياً = أربع نقاط يمكن أن تتناقض عملياً (فرق
-- توقيت جلب البيانات بين استعلامين متزامنين، أو تغيّر بيانات بينهما).
--
-- الإصلاح: نقطة كتابة واحدة (evaluate/route.ts، نفس المسار الذي يكتب
-- dust_evaluations/dust_compliance_evaluations بالفعل) تحسب decideFinal
-- مرة واحدة فقط لكل نشاط وتخزّنها هنا. بقية المسارات الأربعة تُحوَّل لاحقاً
-- لتقرأ آخر صف مخزَّن هنا (WHERE activity_group_id = ... ORDER BY created_at
-- DESC LIMIT 1) بدل إعادة الحساب محلياً — decisionId (id هذا الصف) يصبح
-- المعرّف الموحَّد الذي تربط به كل الواجهات نفس القرار بالضبط.
--
-- append-only (نفس فلسفة dust_evaluations/dust_compliance_evaluations —
-- كل تقييم جديد صف جديد، لا تحديث في مكانه) — سجل تاريخي كامل قابل للتدقيق
-- لكل قرار نهائي صدر فعلياً، لا فقط "آخر قرار" لحظي.
-- =====================================================================

create table if not exists public.final_decisions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  activity_group_id text not null,
  dust_profile_id uuid references public.project_dust_profiles(id) on delete set null,

  mode text not null check (mode in ('LIVE_OPERATIONAL', 'PLANNING')),
  operational_decision text not null check (operational_decision in (
    'ALLOW', 'MONITOR', 'RESTRICT', 'HOLD_FOR_VERIFICATION', 'PROTECTIVE_STOP', 'MANDATORY_STOP'
  )),
  regulatory_finding text not null check (regulatory_finding in (
    'COMPLIANT', 'PENDING_CONFIRMATION', 'NON_COMPLIANT', 'NOT_DETERMINABLE'
  )),
  mandatory_stop boolean not null,
  overridable boolean not null,
  short_reason_ar text not null,
  decision_label_ar text not null,
  level text not null check (level in ('GREEN', 'YELLOW', 'ORANGE', 'RED', 'DARK_RED', 'BLACK')),
  pending_confirmation boolean not null,
  reason_codes text[] not null default '{}',
  evidence_quality text not null check (evidence_quality in ('OK', 'PARTIAL', 'STALE', 'UNAVAILABLE')),
  rule_bundle_version text not null,

  evaluated_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_final_decisions_activity_group_time
  on public.final_decisions (activity_group_id, created_at desc);

create index if not exists idx_final_decisions_project_time
  on public.final_decisions (project_id, created_at desc);

alter table public.final_decisions enable row level security;

-- append-only فعلياً — نفس forbid_evidence_mutation المستخدمة لجداول
-- الأدلة الأخرى (القرار النهائي المحفوظ هو أعلى درجات "الدليل" في هذا
-- النظام: هو ما يُبنى عليه أي إجراء/تنبيه/تدقيق لاحق).
drop trigger if exists final_decisions_immutable on public.final_decisions;
create trigger final_decisions_immutable
  before update or delete on public.final_decisions
  for each row execute function public.forbid_evidence_mutation();

-- لا سياسات SELECT/INSERT لـ anon/authenticated — الكتابة تمر حصراً عبر
-- supabaseAdmin (service_role) من app/api/projects/[projectId]/evaluate/route.ts
-- (بعد تحقق ملكية عبر requireUserId/verifyProjectOwnership)، والقراءة عبر
-- supabaseAdmin أيضاً من كل مستهلك (البانر، dashboard/global، viewer/dashboard،
-- alerts/generate).
revoke all on public.final_decisions from anon, authenticated;
