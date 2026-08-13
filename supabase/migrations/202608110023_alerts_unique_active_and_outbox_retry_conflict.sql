-- =====================================================================
-- DCR — 202608110023_alerts_unique_active_and_outbox_retry_conflict.sql
-- =====================================================================
-- خطأ مكتشَف ومُصلَح (مراجعة كود خارجي — "يمكن إنشاء تنبيه نشط مكرر"):
--
-- 1) create_alert_atomic (202608040029) كانت تعتمد على:
--      select id ... where state <> 'CLOSED' order by created_at desc
--      limit 1 for update
--    لمنع إنشاء تنبيهين نشطين معاً لنفس (project_id, activity_id, kind).
--    SELECT ... FOR UPDATE يقفل صفاً موجوداً فعلياً — لكن حين لا يوجد أي
--    صف نشط بعد (الحالة الشائعة: أول تنبيه من نوعه لهذا النشاط)، لا يوجد
--    شيء ليُقفَل إطلاقاً. طلبان متزامنان لنفس (project_id, activity_id,
--    kind) كلاهما يجدان v_existing_id=null معاً (كلاهما يبدأ قبل أن يُدرِج
--    الآخر)، فيُدرِجان صفَّي alerts نشطين مكرَّرين لنفس الحالة تماماً —
--    السباق يقع تحديداً في الحالة التي صُمِّم القفل لمنعها.
--
-- 2) idx_decision_alert_outbox_open_unprocessed (202608040026) — الفهرس
--    الفريد الجزئي الذي يمنع أكثر من نية OPEN واحدة غير معالَجة لنفس
--    (project_id, activity_id, kind) — يقتصر على status in ('PENDING',
--    'RUNNING')، بلا 'RETRY'. صف OPEN فشلت معالجته مرة (fail_alert_outbox_row
--    يُعيده PENDING مع backoff فعلياً — لكن أثناء نافذة RETRY النظرية/أي
--    مسار مستقبلي يترك الصف بحالة RETRY فعلية) يخرج من نطاق الفهرس الفريد،
--    فنية OPEN جديدة لنفس الشرط تمر بلا اصطدام ON CONFLICT — تكرار نية
--    فتح، لا مجرد تكرار صف تنبيه.
--
-- الحل (مطلوب صراحةً):
--   - uq_alerts_one_active: فهرس فريد جزئي حقيقي على alerts (project_id,
--     activity_id, kind) where state <> 'CLOSED' — يمنع بنيوياً (لا منطقياً
--     فقط) وجود أكثر من صف نشط واحد لنفس الشرط، بصرف النظر عن أي تزامن.
--   - create_alert_atomic تُعاد كتابتها لتعتمد على INSERT ... ON CONFLICT
--     (على uq_alerts_one_active) بدل SELECT FOR UPDATE ثم INSERT منفصلين —
--     ذرّي حقيقي عبر قيد قاعدة البيانات نفسه، لا عبر قفل صف قد لا يوجد.
--   - idx_decision_alert_outbox_open_unprocessed يتسع لـ'RETRY' — ON
--     CONFLICT في persist_activity_decision_atomic يُحدَّث بنفس القائمة.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) alerts: فهرس فريد جزئي حقيقي — يحل محل الاعتماد على SELECT FOR UPDATE
--    وحدها كآلية منع تكرار.
-- ---------------------------------------------------------------------
create unique index if not exists uq_alerts_one_active
  on public.alerts (project_id, activity_id, kind)
  where state <> 'CLOSED';

comment on index public.uq_alerts_one_active is
  'يمنع بنيوياً أكثر من صف alerts نشط واحد (state <> CLOSED) لنفس (project_id, activity_id, kind) — create_alert_atomic تعتمد عليه عبر ON CONFLICT بدل SELECT FOR UPDATE (لا يحمي حالة عدم وجود صف بعد تحت التزامن).';

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
  v_inserted boolean;
begin
  -- خطأ مكتشَف ومُصلَح (مراجعة كود خارجي — "يمكن إنشاء تنبيه نشط مكرر"):
  -- INSERT ... ON CONFLICT (uq_alerts_one_active) بدل SELECT FOR UPDATE ثم
  -- INSERT منفصلين — الفهرس الفريد الجزئي نفسه هو آلية المنع الذرية
  -- الحقيقية الآن (يعمل بصرف النظر عن وجود صف سابق أصلاً، بخلاف القفل الذي
  -- يحتاج صفاً موجوداً ليقفله). طلبان متزامنان الآن: أحدهما يُدرِج بنجاح،
  -- والآخر يصطدم بالقيد فوراً (ON CONFLICT DO NOTHING) بلا أي نافذة سباق.
  insert into public.alerts (
    project_id, activity_source, activity_id, timing, kind, state, message,
    viewer_message, metric_label, metric_actual, metric_threshold, recommended_action,
    final_decision_id
  ) values (
    p_project_id, 'dust', p_activity_id, p_timing, p_kind, 'NEW', p_message,
    p_viewer_message, p_metric_label, p_metric_actual, p_metric_threshold, p_recommended_action,
    p_opened_by_final_decision_id
  )
  on conflict (project_id, activity_id, kind) where state <> 'CLOSED'
  do nothing
  returning id into v_alert_id;

  v_inserted := v_alert_id is not null;

  if v_inserted then
    insert into public.alert_state_events (alert_id, previous_state, new_state, actor_user_id)
    values (v_alert_id, null, 'NEW', null);

    return v_alert_id;
  end if;

  -- الإدراج اصطدم بالقيد — تنبيه نشط موجود مسبقاً بالفعل (idempotency/إعادة
  -- محاولة، أو الفائز الآخر من سباق تزامني حقيقي). نقرأه ونُحدِّث
  -- final_decision_id ليعكس آخر قرار حي فعلياً تسبَّب في إعادة تفعيل نفس
  -- نية الإنشاء، بدل تركه معلَّقاً بقرار قديم قد يكون تاريخياً بحتاً — نفس
  -- السلوك السابق تماماً لهذا المسار، فقط عبر UPDATE منفصل بدل قفل مسبق.
  select id into v_alert_id
  from public.alerts
  where project_id = p_project_id
    and activity_id = p_activity_id
    and kind = p_kind
    and state <> 'CLOSED'
  order by created_at desc
  limit 1;

  if v_alert_id is not null then
    update public.alerts
    set final_decision_id = coalesce(p_opened_by_final_decision_id, final_decision_id)
    where id = v_alert_id;
  end if;

  return v_alert_id;
end;
$$;

revoke all on function public.create_alert_atomic(
  uuid, text, text, text, text, text, text, text, text, text, uuid
) from public, anon, authenticated;
grant execute on function public.create_alert_atomic(
  uuid, text, text, text, text, text, text, text, text, text, uuid
) to service_role;

-- ---------------------------------------------------------------------
-- 2) decision_alert_outbox: توسيع الفهرس الفريد الجزئي ليشمل RETRY —
--    ON CONFLICT في persist_activity_decision_atomic يُحدَّث بنفس القائمة.
-- ---------------------------------------------------------------------
drop index if exists public.idx_decision_alert_outbox_open_unprocessed;

create unique index if not exists idx_decision_alert_outbox_open_unprocessed
  on public.decision_alert_outbox (project_id, activity_id, kind)
  where action = 'OPEN' and status in ('PENDING', 'RUNNING', 'RETRY');

comment on index public.idx_decision_alert_outbox_open_unprocessed is
  'يمنع أكثر من نية OPEN واحدة غير معالَجة (PENDING/RUNNING/RETRY) لنفس (project_id, activity_id, kind) — يشمل RETRY (كان مستبعَداً سابقاً، يسمح بتكرار نية فتح لصف فشلت محاولته الأولى وعاد للانتظار).';

drop function if exists public.persist_activity_decision_atomic(
  uuid, text, text, jsonb, text, timestamptz, jsonb, text, text, timestamptz, uuid, timestamptz, timestamptz,
  jsonb, timestamptz, uuid, text, jsonb
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
  v_regulatory_finding text;
  v_mandatory_stop boolean;
  v_required_alert_kind text;
  v_previous_operational_decision text;
  v_previous_regulatory_finding text;
  v_previous_mandatory_stop boolean;
  v_previous_required_alert_kind text;
  v_previous_level text;
  v_previous_pending_confirmation boolean;
  v_previous_created_at timestamptz;
  v_current_pending_resume_since timestamptz;
  v_skip_final boolean := false;
  v_mode text;
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
  -- 3) final_decisions — append-only. حارس State-Change (202608100001،
  --    وُسِّع في 202608110021) + بصمة نسخ المعاملات
  --    (rule_parameter_version_snapshot).
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

    if not v_skip_final then
      insert into public.final_decisions (
        project_id, activity_group_id, dust_profile_id, mode, operational_decision, regulatory_finding,
        mandatory_stop, overridable, short_reason_ar, decision_label_ar, level, pending_confirmation,
        reason_codes, evidence_quality, rule_bundle_version, evaluated_at,
        evaluation_run_id, input_snapshot_hash, rule_parameter_version_snapshot
      )
      values (
        p_project_id, p_activity_group_id, p_activity_id::uuid,
        v_mode, v_operational_decision, v_regulatory_finding,
        v_mandatory_stop, (p_final_decision->>'overridable')::boolean,
        p_final_decision->>'shortReasonAr', p_final_decision->>'decisionLabelAr', p_final_decision->>'level',
        (p_final_decision->>'pendingConfirmation')::boolean,
        array(select jsonb_array_elements_text(coalesce(p_final_decision->'reasonCodes', '[]'::jsonb))),
        p_final_decision->>'evidenceQuality', p_final_decision->>'ruleBundleVersion', p_final_evaluated_at,
        p_evaluation_run_id, p_input_snapshot_hash, p_rule_parameter_version_snapshot
      )
      returning id into v_final_decision_id;

      v_final_persisted := true;

      if v_mode = 'LIVE_OPERATIONAL' then
        if v_previous_required_alert_kind is not null
          and v_previous_required_alert_kind is distinct from v_required_alert_kind
        then
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

        if v_required_alert_kind is not null then
          -- خطأ مكتشَف ومُصلَح (مراجعة كود خارجي — "يمكن إنشاء تنبيه نشط
          -- مكرر"): هدف ON CONFLICT يطابق الآن idx_decision_alert_outbox_
          -- open_unprocessed المُوسَّع أعلاه (يشمل RETRY) — بلا هذا التحديث،
          -- نية OPEN لصف بحالة RETRY فعلية كانت ستمر ON CONFLICT بلا اصطدام
          -- (الفهرس القديم لا يراها أصلاً)، فتُدرَج نية فتح مكرَّرة.
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
          on conflict (project_id, activity_id, kind) where action = 'OPEN' and status in ('PENDING', 'RUNNING', 'RETRY')
          do nothing;
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
