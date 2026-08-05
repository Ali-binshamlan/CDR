-- =====================================================================
-- DCR — 202608040026_outbox_close_intents_and_alert_id.sql
-- =====================================================================
-- خطأ مكتشَف ومُصلَح (مراجعة خبير خارجي — القسم 6: "Outbox: رغم أن نية
-- التنبيه أصبحت ذرية مع القرار، بقيت المشكلات التالية: صف RUNNING لا يملك
-- Lease Recovery فعّال، لا توجد نوايا CLOSE، لا Unique جزئي يمنع تنبيهين
-- مفتوحين للحالة نفسها، alert_id لا يُحفظ فعلياً على التنبيه الناتج في
-- الـOutbox، العامل يهمل بعض أخطاء تحديث PROCESSED"):
--
-- 1) alert_id: عمود جديد على decision_alert_outbox — العامل (alert-outbox-
--    worker/route.ts) يحفظ فيه معرّف التنبيه الفعلي الذي أنشأه/أعاد استخدامه
--    create_alert_atomic، بدل أن يبقى فقط في استجابة HTTP المؤقتة.
-- 2) locked_until: عمود Lease — يُضبَط RUNNING مع مهلة زمنية (نفس نمط
--    project_evaluation_jobs.lease_until)، ودالة claim جديدة تسترد الصفوف
--    المنتهية مهلتها تلقائياً بدل تركها RUNNING للأبد إن تعطّل العامل.
-- 3) نوايا CLOSE: persist_activity_decision_atomic يقارن القرار الجديد
--    بآخر قرار محفوظ لنفس النشاط (قبل إدراج الصف الجديد) — تحسّن حقيقي
--    (SAFETY_BREACH/COMPLIANCE_RESTRICTION سابق ← ALLOW/MONITOR الآن) ينتج
--    نية CLOSE، لا يُترَك للعامل "يقارن لاحقاً" كما كان موصوفاً (بلا تنفيذ
--    فعلي) في 202608040013.
-- 4) unique جزئي إضافي: يمنع أكثر من نية OPEN غير معالَجة واحدة لكل
--    (project_id, activity_id, kind) في آن واحد.
-- =====================================================================

alter table public.decision_alert_outbox
  add column if not exists alert_id uuid references public.alerts(id) on delete set null;

alter table public.decision_alert_outbox
  add column if not exists locked_by uuid;

-- عمود locked_until موجود مسبقاً من 202608040012 (بلا استخدام فعلي بعد) —
-- يُعاد استخدامه هنا كـLease حقيقي بدل مجرد عمود معرَّف.

create index if not exists idx_decision_alert_outbox_claim_lease
  on public.decision_alert_outbox (status, locked_until)
  where status = 'RUNNING';

-- يمنع أكثر من نية OPEN واحدة غير معالَجة (PENDING/RUNNING) لنفس
-- (project_id, activity_id, kind) في آن واحد — القسم 18.5 "Unique جزئي
-- يمنع تنبيهين مفتوحين للحالة نفسها".
create unique index if not exists idx_decision_alert_outbox_open_unprocessed
  on public.decision_alert_outbox (project_id, activity_id, kind)
  where action = 'OPEN' and status in ('PENDING', 'RUNNING');

-- =====================================================================
-- claim_alert_outbox_batch — نفس نمط claim_evaluation_jobs (202608040005):
-- FOR UPDATE SKIP LOCKED + Lease زمني، يسترد صفوف RUNNING منتهية المهلة
-- تلقائياً (عامل تعطّل منتصف المعالجة بلا استدعاء complete/fail).
-- =====================================================================
create or replace function public.claim_alert_outbox_batch(
  p_worker_id uuid,
  p_batch_size integer default 50,
  p_lease_seconds integer default 60
)
returns setof public.decision_alert_outbox
language sql
security invoker
set search_path = pg_catalog, public
as $$
  with candidates as (
    select id
    from public.decision_alert_outbox
    where status in ('PENDING', 'RETRY')
      and available_at <= clock_timestamp()
    union all
    select id
    from public.decision_alert_outbox
    where status = 'RUNNING'
      and locked_until is not null
      and locked_until < clock_timestamp()
    order by id
    for update skip locked
    limit greatest(1, p_batch_size)
  )
  update public.decision_alert_outbox o
  set status = 'RUNNING',
      locked_by = p_worker_id,
      locked_until = clock_timestamp() + make_interval(secs => greatest(1, p_lease_seconds))
  from candidates c
  where o.id = c.id
  returning o.*;
$$;

revoke all on function public.claim_alert_outbox_batch(uuid, integer, integer)
  from public, anon, authenticated;
grant execute on function public.claim_alert_outbox_batch(uuid, integer, integer) to service_role;

-- =====================================================================
-- complete_alert_outbox_row — إنهاء ناجح، يسجّل alert_id، يتحقق أن
-- locked_by ما زال يطابق (لا تُنهي مهمة استرجعها عامل آخر بعد انتهاء
-- Lease هذا العامل).
-- =====================================================================
create or replace function public.complete_alert_outbox_row(
  p_row_id uuid,
  p_worker_id uuid,
  p_alert_id uuid
)
returns boolean
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_updated boolean;
begin
  update public.decision_alert_outbox
  set status = 'PROCESSED',
      alert_id = p_alert_id,
      processed_at = clock_timestamp(),
      locked_until = null,
      locked_by = null,
      last_error = null
  where id = p_row_id and locked_by = p_worker_id
  returning true into v_updated;

  return coalesce(v_updated, false);
end;
$$;

revoke all on function public.complete_alert_outbox_row(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.complete_alert_outbox_row(uuid, uuid, uuid) to service_role;

-- =====================================================================
-- close_alert_atomic — يغلق أحدث تنبيه مفتوح (state <> 'CLOSED') لنفس
-- (project_id, activity_id, kind) عبر alert_state_events (نفس آلية PATCH
-- /api/alerts/[alertId] — trigger alert_state_events_sync يحدّث alerts.state
-- تلقائياً بعد الإدراج، لا UPDATE مباشر على alerts.state هنا). actor_user_id
-- يبقى null (نظامي — العامل، لا مستخدم بشري). لا خطأ إن لم يوجد تنبيه مفتوح
-- أصلاً (فشل آمن: قد يكون أُغلِق يدوياً من مستخدم قبل هذا الاستدعاء).
-- =====================================================================
create or replace function public.close_alert_atomic(
  p_project_id uuid,
  p_activity_id text,
  p_kind text
)
returns uuid
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_alert_id uuid;
  v_current_state text;
begin
  select id, state into v_alert_id, v_current_state
  from public.alerts
  where project_id = p_project_id
    and activity_id = p_activity_id
    and kind = p_kind
    and state <> 'CLOSED'
  order by created_at desc
  limit 1
  for update;

  if v_alert_id is null then
    return null;
  end if;

  insert into public.alert_state_events (alert_id, previous_state, new_state, actor_user_id)
  values (v_alert_id, v_current_state, 'CLOSED', null);

  return v_alert_id;
end;
$$;

revoke all on function public.close_alert_atomic(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.close_alert_atomic(uuid, text, text) to service_role;

-- =====================================================================
-- fail_alert_outbox_row — فشل، RETRY مع Backoff أسّي (حد أقصى 10 دقائق)
-- حتى p_max_attempts، ثم DEAD نهائياً. لا يشترط locked_by (فشل قد يُسجَّل
-- بعد انتهاء Lease العامل فعلياً — لا يزال يجب تسجيل الخطأ ودفع الجدولة
-- قدماً بأمان، نفس مبدأ fail_evaluation_job).
-- =====================================================================
create or replace function public.fail_alert_outbox_row(
  p_row_id uuid,
  p_error text,
  p_max_attempts integer default 5
)
returns void
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_attempts integer;
begin
  select attempts into v_attempts from public.decision_alert_outbox where id = p_row_id;
  if not found then
    return;
  end if;

  if v_attempts >= p_max_attempts then
    update public.decision_alert_outbox
    set status = 'DEAD',
        last_error = p_error,
        locked_until = null,
        locked_by = null
    where id = p_row_id;
  else
    update public.decision_alert_outbox
    set status = 'RETRY',
        attempts = attempts + 1,
        last_error = p_error,
        locked_until = null,
        locked_by = null,
        available_at = clock_timestamp() + make_interval(secs => least(600, power(2, v_attempts) * 5))
    where id = p_row_id;
  end if;
end;
$$;

revoke all on function public.fail_alert_outbox_row(uuid, text, integer)
  from public, anon, authenticated;
grant execute on function public.fail_alert_outbox_row(uuid, text, integer) to service_role;

-- =====================================================================
-- persist_activity_decision_atomic — إضافة نوايا CLOSE: يقارن القرار
-- الجديد المحفوظ للتو بآخر قرار محفوظ سابقاً لنفس النشاط (قبل هذا الإدراج)
-- — تحسّن حقيقي من حالة تنبيه مفتوحة (SAFETY_BREACH/COMPLIANCE_RESTRICTION)
-- إلى حالة لا تستوجب تنبيهاً (ALLOW/MONITOR/HOLD_FOR_VERIFICATION) ينتج
-- نية CLOSE لكل kind كان مفتوحاً فعلياً، بدل الاعتماد على "العامل يقارن
-- لاحقاً" (لم يكن منفَّذاً فعلياً في 202608040013). مبنية فوق أحدث تعريف
-- فعلي (202608040022 — p_evaluation_run_id/p_input_snapshot_hash)، لا نسخة
-- أقدم (202608040013) — نفس خطأ overload المذكور في القسم 7 من مراجعة
-- الخبير، الذي وقعنا فيه فعلياً مرة سابقة اليوم مع ingest_device_event_v2
-- قبل تصحيحه في migration 202608040024.
-- =====================================================================
create or replace function public.persist_activity_decision_atomic(
  p_project_id uuid,
  p_activity_group_id text,
  p_activity_id text,

  p_dvi_result jsonb,
  p_dvi_triggered_by text,
  p_dvi_expected_updated_at timestamptz,

  p_compliance_result jsonb,
  p_compliance_rulebook_version text,
  p_compliance_triggered_by text,
  p_compliance_expected_updated_at timestamptz,
  p_compliance_dust_profile_id uuid,
  p_compliance_stopped_since timestamptz,
  p_compliance_pending_resume_since timestamptz,

  p_final_decision jsonb,
  p_final_evaluated_at timestamptz,

  p_evaluation_run_id uuid default null,
  p_input_snapshot_hash text default null
)
returns table (
  dvi_persisted boolean,
  compliance_persisted boolean,
  final_decision_persisted boolean
)
language plpgsql
as $$
declare
  v_dvi_evaluation_id uuid;
  v_compliance_evaluation_id uuid;
  v_dvi_persisted boolean := false;
  v_compliance_persisted boolean := false;
  v_final_persisted boolean := false;
  v_affected_rows integer := 0;
  v_project_archived_at timestamptz;
  v_final_decision_id uuid;
  v_operational_decision text;
  v_mode text;
  v_outbox_kind text;
  v_previous_operational_decision text;
  v_previous_kind text;
begin
  perform pg_advisory_xact_lock(
    hashtextextended('project:' || p_project_id::text, 0)
  );

  select archived_at into v_project_archived_at
  from public.projects
  where id = p_project_id;

  if v_project_archived_at is not null then
    raise exception using errcode = 'P0001', message = 'PROJECT_ARCHIVED';
  end if;

  perform pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_project_id::text || ':' || p_activity_group_id, 0)
  );

  perform 1
  from public.project_dust_profiles p
  where p.id = p_activity_id::uuid
    and p.project_id = p_project_id
    and coalesce(p.activity_group_id, 'dust-' || p.id::text) = p_activity_group_id;

  if not found then
    raise exception using errcode = '23503',
      message = format('activity/project/activity_group mismatch for activity_id=%s', p_activity_id);
  end if;

  -- ===================================================================
  -- 1) dust_evaluations + current_dust_decisions
  -- ===================================================================
  if p_dvi_result is not null then
    insert into public.dust_evaluations (project_id, dust_profile_id, activity_group_id, result, triggered_by)
    values (p_project_id, p_activity_id::uuid, p_activity_group_id, p_dvi_result, p_dvi_triggered_by)
    returning id into v_dvi_evaluation_id;

    if v_dvi_evaluation_id is null then
      raise exception 'فشل إدراج dust_evaluations للنشاط %', p_activity_id;
    end if;

    if p_dvi_expected_updated_at is not null then
      update public.current_dust_decisions
      set latest_evaluation_id = v_dvi_evaluation_id,
          decision = p_dvi_result->>'decisionCategory',
          triggered_rules = coalesce(p_dvi_result->'triggeredRules', '[]'::jsonb),
          short_reason = p_dvi_result->>'shortReason',
          updated_at = now()
      where project_id = p_project_id
        and activity_group_id = p_activity_group_id
        and updated_at = p_dvi_expected_updated_at;

      get diagnostics v_affected_rows = row_count;
      if v_affected_rows <> 1 then
        raise exception using errcode = '40001',
          message = format('CAS conflict on current_dust_decisions for activity_group_id=%s', p_activity_group_id);
      end if;
    else
      insert into public.current_dust_decisions (
        activity_group_id, project_id, latest_evaluation_id, decision, triggered_rules, short_reason, updated_at
      )
      values (
        p_activity_group_id, p_project_id, v_dvi_evaluation_id, p_dvi_result->>'decisionCategory',
        coalesce(p_dvi_result->'triggeredRules', '[]'::jsonb), p_dvi_result->>'shortReason', now()
      )
      on conflict (project_id, activity_group_id) do nothing;

      get diagnostics v_affected_rows = row_count;
      if v_affected_rows <> 1 then
        raise exception using errcode = '40001',
          message = format('CAS conflict (first-insert race) on current_dust_decisions for activity_group_id=%s', p_activity_group_id);
      end if;
    end if;

    v_dvi_persisted := true;
  end if;

  -- ===================================================================
  -- 2) dust_compliance_evaluations + current_dust_compliance_decisions
  -- ===================================================================
  if p_compliance_result is not null then
    insert into public.dust_compliance_evaluations (
      project_id, dust_profile_id, activity_group_id, result, rulebook_version, triggered_by
    )
    values (
      p_project_id, p_compliance_dust_profile_id, p_activity_group_id, p_compliance_result,
      p_compliance_rulebook_version, p_compliance_triggered_by
    )
    returning id into v_compliance_evaluation_id;

    if v_compliance_evaluation_id is null then
      raise exception 'فشل إدراج dust_compliance_evaluations للنشاط %', p_activity_id;
    end if;

    if p_compliance_expected_updated_at is not null then
      update public.current_dust_compliance_decisions
      set latest_evaluation_id = v_compliance_evaluation_id,
          decision = p_compliance_result->>'decisionCategory',
          triggered_rules = coalesce(p_compliance_result->'triggeredRules', '[]'::jsonb),
          short_reason = p_compliance_result->>'shortReasonAr',
          updated_at = now(),
          stopped_since = p_compliance_stopped_since,
          pending_resume_since = p_compliance_pending_resume_since,
          deciding_rule_code = p_compliance_result->>'decidingRuleCode',
          stop_cause = p_compliance_result->>'decidingRuleMessageAr'
      where project_id = p_project_id
        and activity_group_id = p_activity_group_id
        and updated_at = p_compliance_expected_updated_at;

      get diagnostics v_affected_rows = row_count;
      if v_affected_rows <> 1 then
        raise exception using errcode = '40001',
          message = format('CAS conflict on current_dust_compliance_decisions for activity_group_id=%s', p_activity_group_id);
      end if;
    else
      insert into public.current_dust_compliance_decisions (
        activity_group_id, project_id, latest_evaluation_id, decision, triggered_rules, short_reason,
        updated_at, stopped_since, pending_resume_since, deciding_rule_code, stop_cause
      )
      values (
        p_activity_group_id, p_project_id, v_compliance_evaluation_id, p_compliance_result->>'decisionCategory',
        coalesce(p_compliance_result->'triggeredRules', '[]'::jsonb), p_compliance_result->>'shortReasonAr',
        now(), p_compliance_stopped_since, p_compliance_pending_resume_since,
        p_compliance_result->>'decidingRuleCode', p_compliance_result->>'decidingRuleMessageAr'
      )
      on conflict (project_id, activity_group_id) do nothing;

      get diagnostics v_affected_rows = row_count;
      if v_affected_rows <> 1 then
        raise exception using errcode = '40001',
          message = format('CAS conflict (first-insert race) on current_dust_compliance_decisions for activity_group_id=%s', p_activity_group_id);
      end if;
    end if;

    v_compliance_persisted := true;
  end if;

  -- ===================================================================
  -- 3) final_decisions — append-only، يعتمد على نجاح المرحلتين أعلاه
  -- ===================================================================
  if p_final_decision is not null then
    -- آخر قرار مُشغَّل (LIVE_OPERATIONAL) محفوظ سابقاً لنفس النشاط، *قبل*
    -- إدراج الصف الجديد أدناه — أساس مقارنة "هل تحسّن القرار؟" لبناء نوايا
    -- CLOSE. PLANNING مستبعد من المقارنة (لا تنبيهات حية لتوقّعات مستقبلية
    -- أصلاً، راجع الشرط v_mode='LIVE_OPERATIONAL' أدناه).
    select operational_decision into v_previous_operational_decision
    from public.final_decisions
    where project_id = p_project_id
      and activity_group_id = p_activity_group_id
      and mode = 'LIVE_OPERATIONAL'
    order by created_at desc
    limit 1;

    insert into public.final_decisions (
      project_id, activity_group_id, dust_profile_id, mode, operational_decision, regulatory_finding,
      mandatory_stop, overridable, short_reason_ar, decision_label_ar, level, pending_confirmation,
      reason_codes, evidence_quality, rule_bundle_version, evaluated_at,
      evaluation_run_id, input_snapshot_hash
    )
    values (
      p_project_id, p_activity_group_id, p_activity_id::uuid,
      p_final_decision->>'mode', p_final_decision->>'operationalDecision', p_final_decision->>'regulatoryFinding',
      (p_final_decision->>'mandatoryStop')::boolean, (p_final_decision->>'overridable')::boolean,
      p_final_decision->>'shortReasonAr', p_final_decision->>'decisionLabelAr', p_final_decision->>'level',
      (p_final_decision->>'pendingConfirmation')::boolean,
      array(select jsonb_array_elements_text(coalesce(p_final_decision->'reasonCodes', '[]'::jsonb))),
      p_final_decision->>'evidenceQuality', p_final_decision->>'ruleBundleVersion', p_final_evaluated_at,
      p_evaluation_run_id, p_input_snapshot_hash
    )
    returning id into v_final_decision_id;

    v_final_persisted := true;

    -- =================================================================
    -- 4) decision_alert_outbox — نية تنبيه واحدة على الأكثر لكل قرار،
    --    بدلالة operationalDecision/mode المحفوظَين للتو فقط (لا DVI/
    --    Compliance جديد). mode=PLANNING لا يُنتج نية إطلاقاً.
    --    evaluation_run_id يُنسَخ من نفس القيمة المحفوظة على final_decisions
    --    للتو — القرار والتنبيه المرتبط به يحملان نفس evaluation_run_id.
    -- =================================================================
    v_mode := p_final_decision->>'mode';
    v_operational_decision := p_final_decision->>'operationalDecision';

    if v_mode = 'LIVE_OPERATIONAL' then
      v_outbox_kind := case
        when v_operational_decision in ('MANDATORY_STOP', 'PROTECTIVE_STOP') then 'SAFETY_BREACH'
        when v_operational_decision = 'RESTRICT' then 'COMPLIANCE_RESTRICTION'
        else null
      end;

      if v_outbox_kind is not null then
        insert into public.decision_alert_outbox (
          final_decision_id, project_id, activity_group_id, activity_id, kind, action, payload, evaluation_run_id
        )
        values (
          v_final_decision_id, p_project_id, p_activity_group_id, p_activity_id::uuid, v_outbox_kind, 'OPEN',
          jsonb_build_object(
            'shortReasonAr', p_final_decision->>'shortReasonAr',
            'decisionLabelAr', p_final_decision->>'decisionLabelAr',
            'mandatoryStop', p_final_decision->>'mandatoryStop',
            'level', p_final_decision->>'level'
          ),
          p_evaluation_run_id
        )
        on conflict (final_decision_id, kind, action) do nothing;
      else
        -- القرار الجديد لا يستوجب تنبيهاً (ALLOW/MONITOR/HOLD_FOR_VERIFICATION)
        -- — إن كان القرار السابق يستوجب واحداً (SAFETY_BREACH/
        -- COMPLIANCE_RESTRICTION)، هذا تحسّن حقيقي يستحق نية CLOSE لنفس
        -- الـkind الذي كان مفتوحاً، حتى تُغلَق التنبيهات المفتوحة فعلياً
        -- (لا تبقى مفتوحة للأبد بعد زوال سببها).
        v_previous_kind := case
          when v_previous_operational_decision in ('MANDATORY_STOP', 'PROTECTIVE_STOP') then 'SAFETY_BREACH'
          when v_previous_operational_decision = 'RESTRICT' then 'COMPLIANCE_RESTRICTION'
          else null
        end;

        if v_previous_kind is not null then
          insert into public.decision_alert_outbox (
            final_decision_id, project_id, activity_group_id, activity_id, kind, action, payload, evaluation_run_id
          )
          values (
            v_final_decision_id, p_project_id, p_activity_group_id, p_activity_id::uuid, v_previous_kind, 'CLOSE',
            jsonb_build_object(
              'shortReasonAr', p_final_decision->>'shortReasonAr',
              'decisionLabelAr', p_final_decision->>'decisionLabelAr',
              'level', p_final_decision->>'level'
            ),
            p_evaluation_run_id
          )
          on conflict (final_decision_id, kind, action) do nothing;
        end if;
      end if;
    end if;
  end if;

  return query select v_dvi_persisted, v_compliance_persisted, v_final_persisted;
end;
$$;
