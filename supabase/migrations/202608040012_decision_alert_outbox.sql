-- =====================================================================
-- DCR — 202608040012_decision_alert_outbox.sql
-- =====================================================================
-- خطأ معماري مكتشَف (القسم 11 من "دليل الإصلاح الجذري لمنظومة مرقاب" —
-- "القرار والتنبيه ليسا لقطة ذرية واحدة"): evaluateProject يحفظ القرار
-- (persist_activity_decision_atomic) ثم يستدعي checkDustActivities في
-- عملية منفصلة تماماً — تلك الدالة تعيد جلب الجهاز وتشغّل DVI/الامتثال من
-- جديد بمعزل عن القرار المحفوظ للتو، فقد ينتج نص/شدة مختلفَين طفيفاً. فشل
-- التنبيه يُبتلع، ولا unique/idempotency يمنع تكرار نفس التنبيه من نفس
-- القرار عند إعادة محاولة.
--
-- الإصلاح (القسم 11.3): decision_alert_outbox جدول نوايا تنبيه — يُدرَج
-- ضمن نفس معاملة persist_activity_decision_atomic (لا استدعاء منفصل بعدها)
-- فور نجاح حفظ final_decisions، بدلالة الحقول التي حسبها القرار نفسه فقط
-- (mandatoryStop/operationalDecision) — بلا أي DVI/Compliance جديد. عامل
-- منفصل (outbox worker) يعالج الصفوف لاحقاً عبر create_alert_atomic.
-- =====================================================================

create table if not exists public.decision_alert_outbox (
  id uuid primary key default gen_random_uuid(),
  final_decision_id uuid not null references public.final_decisions(id) on delete restrict,
  project_id uuid not null references public.projects(id) on delete restrict,
  activity_group_id text not null,
  activity_id uuid not null references public.project_dust_profiles(id) on delete restrict,
  kind text not null check (kind in ('SAFETY_BREACH', 'COMPLIANCE_VIOLATION', 'COMPLIANCE_RESTRICTION')),
  action text not null default 'OPEN' check (action in ('OPEN', 'CLOSE')),
  payload jsonb not null,
  status text not null default 'PENDING' check (status in ('PENDING', 'RUNNING', 'PROCESSED', 'DEAD')),
  attempts integer not null default 0,
  available_at timestamptz not null default clock_timestamp(),
  locked_until timestamptz,
  processed_at timestamptz,
  last_error text,
  created_at timestamptz not null default clock_timestamp(),
  unique (final_decision_id, kind, action)
);

create index if not exists idx_decision_alert_outbox_claim
  on public.decision_alert_outbox (status, available_at, created_at);

create index if not exists idx_decision_alert_outbox_project
  on public.decision_alert_outbox (project_id, created_at desc);

alter table public.decision_alert_outbox enable row level security;
revoke all on public.decision_alert_outbox from anon, authenticated;
grant select, insert, update on public.decision_alert_outbox to service_role;

-- Append-only على alerts نفسه — persist لا يزال يستهلك alert_state_events
-- (موجودة مسبقاً من 202607290004) لسجل الانتقالات؛ الجدول الجديد هنا هو
-- "نية" التنبيه فقط، لا التنبيه نفسه.

-- =====================================================================
-- create_alert_atomic — القسم 11.5: "إنشاء التنبيه وانتقال حالته ذريان
-- أيضاً". يستبدل نمط alertExists ثم insertAlert المنفصلين (سباق فعلي) —
-- RPC واحدة تُدرج alerts وتكتب أول حدث NEW في المعاملة نفسها. إعادة نفس
-- dedupe_key (final_decision_id, kind, action من الـOutbox) تُعيد alert_id
-- الموجود بدل إنشاء نسخة ثانية (idempotent عبر unique index أعلاه على
-- الـOutbox نفسه، لا حاجة لقيد إضافي هنا لأن كل صف Outbox يُعالَج مرة واحدة).
-- =====================================================================
create or replace function public.create_alert_atomic(
  p_project_id uuid,
  p_activity_id text,
  p_timing text,
  p_kind text,
  p_message text,
  p_viewer_message text,
  p_metric_label text,
  p_metric_actual text,
  p_metric_threshold text,
  p_recommended_action text,
  p_opened_by_final_decision_id uuid
)
returns uuid
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_alert_id uuid;
  v_existing_id uuid;
begin
  -- يقفل أي صف تنبيه مفتوح موجود بنفس (project_id, activity_id, kind) —
  -- يمنع طلبين متزامنين من إنشاء نسختين معاً لنفس الشرط بنفس اللحظة.
  select id into v_existing_id
  from public.alerts
  where project_id = p_project_id
    and activity_id = p_activity_id
    and kind = p_kind
    and state <> 'CLOSED'
  order by created_at desc
  limit 1
  for update;

  if v_existing_id is not null then
    return v_existing_id;
  end if;

  insert into public.alerts (
    project_id, activity_source, activity_id, timing, kind, state, message,
    viewer_message, metric_label, metric_actual, metric_threshold, recommended_action
  ) values (
    p_project_id, 'dust', p_activity_id, p_timing, p_kind, 'NEW', p_message,
    p_viewer_message, p_metric_label, p_metric_actual, p_metric_threshold, p_recommended_action
  )
  returning id into v_alert_id;

  insert into public.alert_state_events (alert_id, previous_state, new_state, actor_user_id)
  values (v_alert_id, null, 'NEW', null);

  return v_alert_id;
end;
$$;

revoke all on function public.create_alert_atomic(
  uuid, text, text, text, text, text, text, text, text, text, uuid
) from public, anon, authenticated;
grant execute on function public.create_alert_atomic(
  uuid, text, text, text, text, text, text, text, text, text, uuid
) to service_role;
