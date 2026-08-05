-- =====================================================================
-- DCR — 202608040013_persist_decision_outbox_intents.sql
-- =====================================================================
-- القسم 11.2-11.3 — يُضيف إدراج "نوايا التنبيه" (decision_alert_outbox)
-- داخل نفس معاملة persist_activity_decision_atomic، فور نجاح إدراج
-- final_decisions، مباشرة قبل COMMIT. deriveAlertIntent هنا SQL بسيط
-- مشتق حصراً من p_final_decision نفسه (operationalDecision/mandatoryStop)
-- — لا استعلام DVI/Compliance جديد، ولا fetch، بما يطابق دالة
-- deriveAlertIntents النقية الموصوفة في القسم 11.4 من التقرير.
--
-- kind المُشتق:
--   MANDATORY_STOP/PROTECTIVE_STOP → SAFETY_BREACH (خطر فيزيائي/تنظيمي
--     ملزم فوري).
--   RESTRICT                       → COMPLIANCE_RESTRICTION.
--   غير ذلك (ALLOW/MONITOR/HOLD_FOR_VERIFICATION) → لا نية تنبيه جديدة؛
--     العامل (Outbox worker) يتولى إصدار CLOSE لاحقاً بمقارنة القرار
--     السابق، لا هذه الدالة (لا تقرأ القرار السابق هنا لتبقى نقية بلا I/O
--     إضافي داخل نفس القفل).
--
-- mode='PLANNING' لا يُنتج أي نية تنبيه إطلاقاً (نفس قاعدة decideFinal:
-- توقّع مستقبلي لا يستحق تنبيهاً حياً).
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
  p_final_evaluated_at timestamptz
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
    insert into public.final_decisions (
      project_id, activity_group_id, dust_profile_id, mode, operational_decision, regulatory_finding,
      mandatory_stop, overridable, short_reason_ar, decision_label_ar, level, pending_confirmation,
      reason_codes, evidence_quality, rule_bundle_version, evaluated_at
    )
    values (
      p_project_id, p_activity_group_id, p_activity_id::uuid,
      p_final_decision->>'mode', p_final_decision->>'operationalDecision', p_final_decision->>'regulatoryFinding',
      (p_final_decision->>'mandatoryStop')::boolean, (p_final_decision->>'overridable')::boolean,
      p_final_decision->>'shortReasonAr', p_final_decision->>'decisionLabelAr', p_final_decision->>'level',
      (p_final_decision->>'pendingConfirmation')::boolean,
      array(select jsonb_array_elements_text(coalesce(p_final_decision->'reasonCodes', '[]'::jsonb))),
      p_final_decision->>'evidenceQuality', p_final_decision->>'ruleBundleVersion', p_final_evaluated_at
    )
    returning id into v_final_decision_id;

    v_final_persisted := true;

    -- =================================================================
    -- 4) decision_alert_outbox — نية تنبيه واحدة على الأكثر لكل قرار،
    --    بدلالة operationalDecision/mode المحفوظَين للتو فقط (لا DVI/
    --    Compliance جديد). mode=PLANNING لا يُنتج نية إطلاقاً.
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
          final_decision_id, project_id, activity_group_id, activity_id, kind, action, payload
        )
        values (
          v_final_decision_id, p_project_id, p_activity_group_id, p_activity_id::uuid, v_outbox_kind, 'OPEN',
          jsonb_build_object(
            'shortReasonAr', p_final_decision->>'shortReasonAr',
            'decisionLabelAr', p_final_decision->>'decisionLabelAr',
            'mandatoryStop', p_final_decision->>'mandatoryStop',
            'level', p_final_decision->>'level'
          )
        )
        on conflict (final_decision_id, kind, action) do nothing;
      end if;
    end if;
  end if;

  return query select v_dvi_persisted, v_compliance_persisted, v_final_persisted;
end;
$$;
