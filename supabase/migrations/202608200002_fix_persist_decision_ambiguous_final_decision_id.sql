-- =====================================================================
-- DCR — 202608200002_fix_persist_decision_ambiguous_final_decision_id.sql
-- =====================================================================
-- خطأ حرج مكتشَف (Vercel Logs، PostgreSQL 42702 — "column reference
-- final_decision_id is ambiguous"): migration 202608160004 أضافت عمود
-- إخراج اسمه final_decision_id إلى returns table لـ
-- persist_activity_decision_atomic. PL/pgSQL يُنشئ متغيراً ضمنياً بنفس
-- اسم كل عمود إخراج، مرئياً في كامل جسم الدالة — فتعارض مباشرة مع عمود
-- الجدول public.decision_alert_outbox.final_decision_id المُستخدَم داخل
-- قوائم أعمدة insert/on conflict بنفس الدالة (بلا تأهيل ممكن أصلاً —
-- بنية SQL لا تسمح بـtable.column داخل قائمة أعمدة insert أو on conflict).
-- النتيجة: كل استدعاء لهذه الدالة منذ تطبيق 202608160004 على القاعدة
-- الحية كان يفشل بالكامل (لا حفظ DVI ولا امتثال ولا قرار نهائي) — هذا هو
-- السبب الجذري الفعلي وراء تجمّد current_dust_compliance_decisions.updated_at
-- الذي شُخِّص سابقاً هذه الجلسة (بدا حينها كأن evaluateProject يفشل صامتاً
-- لسبب مجهول؛ السبب الحقيقي كان دائماً هنا).
--
-- الإصلاح: إعادة تسمية عمود الإخراج نفسه إلى v_out_final_decision_id
-- (بادئة مختلفة تماماً عن أي عمود جدول حقيقي بالمشروع) — لا تغيير على
-- التوقيع الفعلي المرئي للمستدعي (نفس الترتيب/الأنواع)، فقط اسم العمود
-- الرابع في returns table يتغيّر. app/lib/dustEvaluation.ts يقرأ نتيجة
-- هذه الدالة عبر data[0].final_decision_id — يحتاج تحديثاً مرافقاً ليقرأ
-- الاسم الجديد (راجع التعديل المرافق في نفس commit).
-- =====================================================================

drop function if exists public.persist_activity_decision_atomic(
  uuid, text, text,
  jsonb, text, timestamptz,
  jsonb, text, text, timestamptz, uuid, timestamptz, timestamptz,
  jsonb, timestamptz,
  uuid, text, jsonb,
  jsonb, jsonb
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
  p_rule_parameter_version_snapshot jsonb default null,

  p_dvi_raw_result jsonb default null,
  p_compliance_raw_result jsonb default null
)
returns table (
  dvi_persisted boolean,
  compliance_persisted boolean,
  final_decision_persisted boolean,
  -- خطأ 42702 مُصلَح: كان اسم هذا العمود final_decision_id، متعارضاً مع
  -- عمود public.decision_alert_outbox.final_decision_id المُستخدَم داخل
  -- قوائم أعمدة insert/on conflict بجسم هذه الدالة (راجع تعليق الملف
  -- الكامل أعلاه). لا تغيير على الترتيب/النوع، فقط الاسم.
  v_out_final_decision_id uuid
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
  v_regulatory_finding text;
  v_mandatory_stop boolean;
  v_required_alert_kind text;
  v_previous_operational_decision text;
  v_previous_regulatory_finding text;
  v_previous_mandatory_stop boolean;
  v_previous_required_alert_kind text;
  v_previous_kind text;
  v_previous_level text;
  v_previous_pending_confirmation boolean;
  v_previous_created_at timestamptz;
  v_current_pending_resume_since timestamptz;
  v_skip_final boolean := false;
  v_mode text;
  v_final_dvi_evaluation_id uuid;
  v_final_compliance_evaluation_id uuid;
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

  select pending_resume_since into v_current_pending_resume_since
  from public.current_dust_compliance_decisions
  where project_id = p_project_id and activity_group_id = p_activity_group_id;

  -- ===================================================================
  -- 0) هل ستُكتَب final_decisions فعلياً هذه الدورة؟
  -- ===================================================================
  if p_final_decision is not null then
    select operational_decision, regulatory_finding, mandatory_stop, level, pending_confirmation, created_at
    into v_previous_operational_decision, v_previous_regulatory_finding, v_previous_mandatory_stop,
      v_previous_level, v_previous_pending_confirmation, v_previous_created_at
    from public.final_decisions
    where project_id = p_project_id
      and activity_group_id = p_activity_group_id
      and mode = 'LIVE_OPERATIONAL'
    order by created_at desc
    limit 1;

    v_mode := p_final_decision->>'mode';
    v_operational_decision := p_final_decision->>'operationalDecision';
    v_regulatory_finding := p_final_decision->>'regulatoryFinding';
    v_mandatory_stop := (p_final_decision->>'mandatoryStop')::boolean;

    v_required_alert_kind := case
      when v_regulatory_finding = 'NON_COMPLIANT' then 'COMPLIANCE_VIOLATION'
      when v_operational_decision = 'MANDATORY_STOP' then 'SAFETY_BREACH'
      when v_operational_decision = 'PROTECTIVE_STOP' then 'PROTECTIVE_STOP'
      when v_operational_decision = 'RESTRICT' then 'COMPLIANCE_RESTRICTION'
      else null
    end;

    v_previous_required_alert_kind := case
      when v_previous_regulatory_finding = 'NON_COMPLIANT' then 'COMPLIANCE_VIOLATION'
      when v_previous_operational_decision = 'MANDATORY_STOP' then 'SAFETY_BREACH'
      when v_previous_operational_decision = 'PROTECTIVE_STOP' then 'PROTECTIVE_STOP'
      when v_previous_operational_decision = 'RESTRICT' then 'COMPLIANCE_RESTRICTION'
      else null
    end;

    if v_mode = 'LIVE_OPERATIONAL'
      and v_previous_operational_decision is not null
      and v_previous_operational_decision = v_operational_decision
      and v_previous_regulatory_finding is not distinct from v_regulatory_finding
      and v_previous_mandatory_stop is not distinct from v_mandatory_stop
      and v_previous_required_alert_kind is not distinct from v_required_alert_kind
      and v_previous_level = (p_final_decision->>'level')
      and v_previous_pending_confirmation = (p_final_decision->>'pendingConfirmation')::boolean
      and v_previous_created_at is not null
      and now() - v_previous_created_at < interval '5 minutes'
      and coalesce(v_current_pending_resume_since, 'epoch'::timestamptz)
        = coalesce(p_compliance_pending_resume_since, 'epoch'::timestamptz)
    then
      v_skip_final := true;
    end if;
  end if;

  -- ===================================================================
  -- 1) dust_evaluations + current_dust_decisions
  -- ===================================================================
  if p_dvi_raw_result is not null and (p_final_decision is null or not v_skip_final) then
    insert into public.dust_evaluations (project_id, dust_profile_id, activity_group_id, result, triggered_by)
    values (p_project_id, p_activity_id::uuid, p_activity_group_id, p_dvi_raw_result, p_dvi_triggered_by)
    returning id into v_dvi_evaluation_id;

    if v_dvi_evaluation_id is null then
      raise exception 'فشل إدراج dust_evaluations للنشاط %', p_activity_id;
    end if;
  end if;

  if p_dvi_result is not null then
    if p_dvi_expected_updated_at is not null then
      update public.current_dust_decisions
      set latest_evaluation_id = coalesce(v_dvi_evaluation_id, latest_evaluation_id),
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
      set latest_evaluation_id = coalesce(excluded.latest_evaluation_id, public.current_dust_decisions.latest_evaluation_id),
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
  if p_compliance_raw_result is not null and (p_final_decision is null or not v_skip_final) then
    insert into public.dust_compliance_evaluations (
      project_id, dust_profile_id, activity_group_id, result, rulebook_version, triggered_by
    )
    values (
      p_project_id, p_compliance_dust_profile_id, p_activity_group_id, p_compliance_raw_result,
      p_compliance_rulebook_version, p_compliance_triggered_by
    )
    returning id into v_compliance_evaluation_id;

    if v_compliance_evaluation_id is null then
      raise exception 'فشل إدراج dust_compliance_evaluations للنشاط %', p_activity_id;
    end if;
  end if;

  if p_compliance_result is not null then
    if p_compliance_expected_updated_at is not null then
      update public.current_dust_compliance_decisions
      set latest_evaluation_id = coalesce(v_compliance_evaluation_id, latest_evaluation_id),
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
      set latest_evaluation_id = coalesce(excluded.latest_evaluation_id, public.current_dust_compliance_decisions.latest_evaluation_id),
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
  -- 3) final_decisions — append-only.
  -- ===================================================================
  if p_final_decision is not null and not v_skip_final then
    if v_dvi_evaluation_id is not null then
      v_final_dvi_evaluation_id := v_dvi_evaluation_id;
    else
      select latest_evaluation_id into v_final_dvi_evaluation_id
      from public.current_dust_decisions
      where project_id = p_project_id and activity_group_id = p_activity_group_id;
    end if;

    if v_compliance_evaluation_id is not null then
      v_final_compliance_evaluation_id := v_compliance_evaluation_id;
    else
      select latest_evaluation_id into v_final_compliance_evaluation_id
      from public.current_dust_compliance_decisions
      where project_id = p_project_id and activity_group_id = p_activity_group_id;
    end if;

    insert into public.final_decisions (
      project_id, activity_group_id, dust_profile_id, mode, operational_decision, regulatory_finding,
      mandatory_stop, overridable, short_reason_ar, decision_label_ar, level, pending_confirmation,
      reason_codes, evidence_quality, rule_bundle_version, evaluated_at,
      evaluation_run_id, input_snapshot_hash, rule_parameter_version_snapshot,
      dvi_evaluation_id, compliance_evaluation_id
    )
    values (
      p_project_id, p_activity_group_id, p_activity_id::uuid,
      v_mode, v_operational_decision, v_regulatory_finding,
      v_mandatory_stop, (p_final_decision->>'overridable')::boolean,
      p_final_decision->>'shortReasonAr', p_final_decision->>'decisionLabelAr', p_final_decision->>'level',
      (p_final_decision->>'pendingConfirmation')::boolean,
      array(select jsonb_array_elements_text(coalesce(p_final_decision->'reasonCodes', '[]'::jsonb))),
      p_final_decision->>'evidenceQuality', p_final_decision->>'ruleBundleVersion', p_final_evaluated_at,
      p_evaluation_run_id, p_input_snapshot_hash, p_rule_parameter_version_snapshot,
      v_final_dvi_evaluation_id, v_final_compliance_evaluation_id
    )
    returning id into v_final_decision_id;

    v_final_persisted := true;

    if v_mode = 'LIVE_OPERATIONAL' then
      if v_required_alert_kind is not null then
        insert into public.decision_alert_outbox (
          final_decision_id, project_id, activity_group_id, activity_id, kind, action, payload, evaluation_run_id
        )
        values (
          v_final_decision_id, p_project_id, p_activity_group_id, p_activity_id::uuid, v_required_alert_kind, 'OPEN',
          jsonb_build_object(
            'shortReasonAr', p_final_decision->>'shortReasonAr',
            'decisionLabelAr', p_final_decision->>'decisionLabelAr',
            'mandatoryStop', p_final_decision->'mandatoryStop',
            'level', p_final_decision->>'level'
          ),
          p_evaluation_run_id
        )
        on conflict (project_id, activity_id, kind) where action = 'OPEN' and status in ('PENDING', 'RUNNING')
        do nothing;
      else
        if v_previous_required_alert_kind is not null then
          insert into public.decision_alert_outbox (
            final_decision_id, project_id, activity_group_id, activity_id, kind, action, payload, evaluation_run_id
          )
          values (
            v_final_decision_id, p_project_id, p_activity_group_id, p_activity_id::uuid, v_previous_required_alert_kind, 'CLOSE',
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

  return query select v_dvi_persisted, v_compliance_persisted, v_final_persisted, v_final_decision_id;
end;
$$;

revoke all on function public.persist_activity_decision_atomic(
  uuid, text, text,
  jsonb, text, timestamptz,
  jsonb, text, text, timestamptz, uuid, timestamptz, timestamptz,
  jsonb, timestamptz,
  uuid, text, jsonb,
  jsonb, jsonb
) from public, anon, authenticated;
grant execute on function public.persist_activity_decision_atomic(
  uuid, text, text,
  jsonb, text, timestamptz,
  jsonb, text, text, timestamptz, uuid, timestamptz, timestamptz,
  jsonb, timestamptz,
  uuid, text, jsonb,
  jsonb, jsonb
) to service_role;
