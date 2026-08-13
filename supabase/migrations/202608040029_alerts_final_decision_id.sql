-- =====================================================================
-- DCR — 202608040029_alerts_final_decision_id.sql
-- =====================================================================
-- خطأ حرج مكتشَف ومُصلَح (مراجعة خبير خارجي — القسم 6 (متابعة): "alert_id
-- يُحفَظ فعلياً على الـOutbox [مُصلَح سابقاً في 202608040026]، لكن
-- final_decision_id لا يُحفظ فعلياً على التنبيه نفسه"):
--
-- create_alert_atomic (202608040012) كانت تستقبل معامل
-- p_opened_by_final_decision_id uuid منذ البداية، لكن جدول alerts (المُعرَّف
-- في 202607290001_baseline_final.sql) لا يملك عموداً بهذا الاسم إطلاقاً —
-- فالمعامل كان يُمرَّر من alert-outbox-worker/route.ts (row.final_decision_id)
-- ثم يُهمَل صامتاً داخل الدالة (لا استخدام له في عبارة INSERT). النتيجة: لا
-- رابطة فعلية على مستوى قاعدة البيانات بين alerts.id والقرار (final_decisions)
-- الذي سبَّب فتح التنبيه — يمنع أي استعلام/تدقيق مستقبلي يحتاج تتبّع "أي
-- قرار بالضبط فتح هذا التنبيه" دون العودة لمطابقة نصية هشة (message/kind/
-- توقيت تقريبي).
--
-- الإصلاح: عمود final_decision_id على alerts (اختياري — نفس اتفاقية
-- alert_id على decision_alert_outbox في 202608040026، on delete set null:
-- حذف final_decisions القديمة تاريخياً لا يجوز أن يحذف/يمنع التنبيه المرتبط
-- به تاريخياً)، وcreate_alert_atomic تُعاد كتابتها لتُدرِجه فعلياً.
-- =====================================================================

alter table public.alerts
  add column if not exists final_decision_id uuid references public.final_decisions(id) on delete set null;

create index if not exists idx_alerts_final_decision_id on public.alerts (final_decision_id);

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
    -- تنبيه مفتوح موجود مسبقاً (idempotency/إعادة محاولة) — يُحدَّث
    -- final_decision_id ليعكس آخر قرار حي فعلياً تسبَّب في إعادة تفعيل نفس
    -- نية الإنشاء، بدل تركه معلَّقاً بقرار قديم قد يكون تاريخياً بحتاً.
    update public.alerts
    set final_decision_id = coalesce(p_opened_by_final_decision_id, final_decision_id)
    where id = v_existing_id;
    return v_existing_id;
  end if;

  insert into public.alerts (
    project_id, activity_source, activity_id, timing, kind, state, message,
    viewer_message, metric_label, metric_actual, metric_threshold, recommended_action,
    final_decision_id
  ) values (
    p_project_id, 'dust', p_activity_id, p_timing, p_kind, 'NEW', p_message,
    p_viewer_message, p_metric_label, p_metric_actual, p_metric_threshold, p_recommended_action,
    p_opened_by_final_decision_id
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
