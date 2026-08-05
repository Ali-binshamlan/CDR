-- =====================================================================
-- DCR — 202608030006_composite_key_activity_group_id.sql
-- =====================================================================
-- خطأ معماري مكتشَف — مراجعة كود خبير خارجي: "activity_group_id غير معزول
-- بمفتاح مركب مع project_id". current_dust_decisions وcurrent_dust_
-- compliance_decisions (راجع 202607290001_baseline_final.sql) كانا يعتمدان
-- على activity_group_id (نص، مُولَّد بـcrypto.randomUUID() من العميل —
-- راجع AddActivityModal/index.tsx) بمفرده كـPRIMARY KEY، بلا project_id
-- ضمن المفتاح. عملياً هذا يعني: لا شيء في قاعدة البيانات نفسها يمنع صفاً
-- بـactivity_group_id معيَّناً خطأً (تصادم UUID نظرياً ضئيل، لكن أيضاً أي bug
-- برمجي مستقبلي أو عبث مباشر بالبيانات) من الانتماء لمشروع مختلف عمّا
-- يُفترض — والأخطر: عدة استعلامات بالتطبيق (dustEvaluation.ts، activities/
-- route.ts، alerts/generate/route.ts) كانت تفلتر بـ.eq('activity_group_id', ...)
-- فقط بلا project_id في نفس شرط WHERE، فلو حدث تصادم فعلي، هذه الاستعلامات
-- كانت ستقرأ/تُحدِّث/تحذف بيانات مشروع خاطئ تماماً بلا أي حماية من القاعدة.
--
-- الإصلاح: تحويل المفتاح الأساسي الفعلي لكلا الجدولين إلى مفتاح مركب
-- (project_id, activity_group_id) — التطبيق يُحدَّث بالتوازي (نفس الكوميت)
-- ليمرر project_id في كل استعلام .eq/.delete/ON CONFLICT على هذين الجدولين.
-- =====================================================================

-- current_dust_decisions: إسقاط PK القديم (activity_group_id وحده)، إضافة
-- PK مركب جديد. بلا تغيير على أي عمود آخر أو أي بيانات موجودة.
alter table public.current_dust_decisions
  drop constraint if exists current_dust_decisions_pkey;

alter table public.current_dust_decisions
  add constraint current_dust_decisions_pkey primary key (project_id, activity_group_id);

-- current_dust_compliance_decisions: نفس التغيير بالضبط.
alter table public.current_dust_compliance_decisions
  drop constraint if exists current_dust_compliance_decisions_pkey;

alter table public.current_dust_compliance_decisions
  add constraint current_dust_compliance_decisions_pkey primary key (project_id, activity_group_id);

-- idx_current_dust_decisions_project_id / idx_current_dust_compliance_decisions_project_id
-- (فهرس منفصل على project_id وحده) يبقيان كما هما — لا يزالان مفيدين
-- لاستعلامات project_id بمفرده (مثال: عد قرارات مشروع)، بخلاف PK الجديد
-- (project_id, activity_group_id) الذي يخدم البحث المركب تحديداً.

-- =====================================================================
-- تحديث persist_activity_decision_atomic: ON CONFLICT (activity_group_id)
-- يعتمد على القيد القديم بالاسم؛ يجب أن يطابق العمودين الجديدين للمفتاح
-- الأساسي الآن (project_id, activity_group_id) بدل activity_group_id وحده.
-- بقية منطق الدالة كما هو تماماً بلا أي تغيير آخر (نفس نسخة
-- 202608030005_fix_first_insert_cas_race.sql).
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
begin
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
    );

    v_final_persisted := true;
  end if;

  return query select v_dvi_persisted, v_compliance_persisted, v_final_persisted;
end;
$$;
