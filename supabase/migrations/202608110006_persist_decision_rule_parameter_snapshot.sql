-- =====================================================================
-- DCR — 202608110006_persist_decision_rule_parameter_snapshot.sql
-- =====================================================================
-- يضيف p_rule_parameter_version_snapshot jsonb default null إلى
-- persist_activity_decision_atomic — يُخزَّن في final_decisions.
-- rule_parameter_version_snapshot (202608110005). معامل اختياري جديد
-- (nullable، default null) في آخر القائمة — توافقي تماماً، أي استدعاء قديم
-- لا يمرره يستمر يعمل بلا تغيير.
--
-- إسقاط صريح للتوقيع الحالي (17 معاملاً) قبل create or replace بتوقيع 18
-- معاملاً — إلزامي: 202608110002b أثبت أن CREATE OR REPLACE FUNCTION بعدد
-- معاملات مختلف لا يستبدل التوقيع القديم في PostgreSQL، بل يضيف Overload
-- منفصلاً. عدم إسقاط التوقيع القديم صراحةً هنا كان سيكرر نفس الخطأ الذي
-- اكتُشف وأُصلح للتو (persist_activity_decision_atomic ذاتها، توقيعان
-- منفصلان موجودان معاً في القاعدة الحية قبل هذه الدفعة).
-- =====================================================================

drop function if exists public.persist_activity_decision_atomic(
  uuid, text, text, jsonb, text, timestamptz, jsonb, text, text, timestamptz, uuid, timestamptz, timestamptz,
  jsonb, timestamptz, uuid, text
);

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
  p_input_snapshot_hash text default null,
  p_rule_parameter_version_snapshot jsonb default null
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
  v_previous_level text;
  v_previous_pending_confirmation boolean;
  v_previous_created_at timestamptz;
  v_current_pending_resume_since timestamptz;
  v_skip_final boolean := false;
begin
  set local lock_timeout = '3s';
  set local statement_timeout = '10s';

  select archived_at into v_project_archived_at
  from public.projects
  where id = p_project_id
  for update;

  if not found then
    raise exception using errcode = '42501', message = 'project not found';
  end if;

  if v_project_archived_at is not null then
    raise exception using errcode = 'P0001', message = 'PROJECT_ARCHIVED';
  end if;

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
      on conflict (project_id, activity_group_id) do update
      set latest_evaluation_id = excluded.latest_evaluation_id,
          decision = excluded.decision,
          triggered_rules = excluded.triggered_rules,
          short_reason = excluded.short_reason,
          updated_at = excluded.updated_at;

      v_affected_rows := 1;
    end if;

    v_dvi_persisted := true;
  end if;

  -- ===================================================================
  -- 2) dust_compliance_evaluations + current_dust_compliance_decisions
  -- ===================================================================
  if p_compliance_result is not null then
    select pending_resume_since into v_current_pending_resume_since
    from public.current_dust_compliance_decisions
    where project_id = p_project_id and activity_group_id = p_activity_group_id;

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
      on conflict (project_id, activity_group_id) do update
      set latest_evaluation_id = excluded.latest_evaluation_id,
          decision = excluded.decision,
          triggered_rules = excluded.triggered_rules,
          short_reason = excluded.short_reason,
          updated_at = excluded.updated_at,
          stopped_since = excluded.stopped_since,
          pending_resume_since = excluded.pending_resume_since,
          deciding_rule_code = excluded.deciding_rule_code,
          stop_cause = excluded.stop_cause;

      v_affected_rows := 1;
    end if;

    v_compliance_persisted := true;
  end if;

  -- ===================================================================
  -- 3) final_decisions — append-only. حارس State-Change (202608100001) +
  --    بصمة نسخ المعاملات الجديدة (rule_parameter_version_snapshot).
  -- ===================================================================
  if p_final_decision is not null then
    select operational_decision, level, pending_confirmation, created_at
    into v_previous_operational_decision, v_previous_level, v_previous_pending_confirmation, v_previous_created_at
    from public.final_decisions
    where project_id = p_project_id
      and activity_group_id = p_activity_group_id
      and mode = 'LIVE_OPERATIONAL'
    order by created_at desc
    limit 1;

    v_mode := p_final_decision->>'mode';
    v_operational_decision := p_final_decision->>'operationalDecision';

    if v_mode = 'LIVE_OPERATIONAL'
      and v_previous_operational_decision is not null
      and v_previous_operational_decision = v_operational_decision
      and v_previous_level = (p_final_decision->>'level')
      and v_previous_pending_confirmation = (p_final_decision->>'pendingConfirmation')::boolean
      and v_previous_created_at is not null
      and now() - v_previous_created_at < interval '5 minutes'
      and coalesce(v_current_pending_resume_since, 'epoch'::timestamptz)
        = coalesce(p_compliance_pending_resume_since, 'epoch'::timestamptz)
    then
      v_skip_final := true;
    end if;

    if not v_skip_final then
      insert into public.final_decisions (
        project_id, activity_group_id, dust_profile_id, mode, operational_decision, regulatory_finding,
        mandatory_stop, overridable, short_reason_ar, decision_label_ar, level, pending_confirmation,
        reason_codes, evidence_quality, rule_bundle_version, evaluated_at,
        evaluation_run_id, input_snapshot_hash, rule_parameter_version_snapshot
      )
      values (
        p_project_id, p_activity_group_id, p_activity_id::uuid,
        v_mode, v_operational_decision, p_final_decision->>'regulatoryFinding',
        (p_final_decision->>'mandatoryStop')::boolean, (p_final_decision->>'overridable')::boolean,
        p_final_decision->>'shortReasonAr', p_final_decision->>'decisionLabelAr', p_final_decision->>'level',
        (p_final_decision->>'pendingConfirmation')::boolean,
        array(select jsonb_array_elements_text(coalesce(p_final_decision->'reasonCodes', '[]'::jsonb))),
        p_final_decision->>'evidenceQuality', p_final_decision->>'ruleBundleVersion', p_final_evaluated_at,
        p_evaluation_run_id, p_input_snapshot_hash, p_rule_parameter_version_snapshot
      )
      returning id into v_final_decision_id;

      v_final_persisted := true;

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
          on conflict (project_id, activity_id, kind) where action = 'OPEN' and status in ('PENDING', 'RUNNING')
          do nothing;
        else
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
  end if;

  return query select v_dvi_persisted, v_compliance_persisted, v_final_persisted;
end;
$$;

revoke all on function public.persist_activity_decision_atomic(
  uuid, text, text, jsonb, text, timestamptz, jsonb, text, text, timestamptz, uuid, timestamptz, timestamptz,
  jsonb, timestamptz, uuid, text, jsonb
) from public, anon, authenticated;

grant execute on function public.persist_activity_decision_atomic(
  uuid, text, text, jsonb, text, timestamptz, jsonb, text, text, timestamptz, uuid, timestamptz, timestamptz,
  jsonb, timestamptz, uuid, text, jsonb
) to service_role;
