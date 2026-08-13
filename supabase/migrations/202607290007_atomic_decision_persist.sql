-- =====================================================================
-- DCR — 202607290007_atomic_decision_persist.sql
-- =====================================================================
-- خطأ معماري مكتشَف ومُصلَح (مراجعة كود خبير خارجي — C-04: "حفظ القرار
-- غير ذري... يمكن أن ينجح الطلب رغم فشل حفظ القرار النهائي"): كانت
-- persistDustEvaluations/persistDustComplianceEvaluations/persistFinalDecisions
-- (app/lib/dustEvaluation.ts) تنفّذ 3 مراحل كتابة منفصلة تماماً بلا معاملة
-- SQL واحدة تجمعها — فشل حقيقي بين المرحلة الثانية والثالثة (انقطاع اتصال،
-- timeout) كان يترك dust_evaluations/dust_compliance_evaluations محفوظين
-- بلا final_decisions مقابل. الإصلاح السابق (C-04 الجزئي، راجع تعليق
-- persistFinalDecisions) جعل الفشل مرئياً صراحة في استجابة API بدل ابتلاعه
-- بصمت، لكن لم يحقق الذرية الفعلية.
--
-- الإصلاح الكامل هنا: دالة PL/pgSQL واحدة تستقبل كل الصفوف الجاهزة
-- للإدراج (محسوبة مسبقاً بالكامل في TypeScript — decideFinal/
-- computeSustainedPm10Status/shouldSkipPersist/computeStoppedSince/
-- computePendingResumeSince تبقى كلها كما هي بلا أي تغيير أو نقل منطق
-- لـ SQL، وهذا مقصود: نقل محرك القرار نفسه لـ PL/pgSQL كان سيضاعف نقاط
-- الفشل ويصعّب الاختبار والصيانة بلا فائدة إضافية للذرية) وتكتبها جميعاً
-- (dust_evaluations + current_dust_decisions + dust_compliance_evaluations
-- + current_dust_compliance_decisions + final_decisions) ضمن معاملة واحدة
-- (كل دالة PL/pgSQL تُنفَّذ ضمنياً كمعاملة واحدة atomic بالكامل في
-- PostgreSQL) — إما تكتمل كل الكتابات الخمس لنشاط واحد معاً، أو لا يُكتب
-- شيء منها إطلاقاً (RAISE EXCEPTION يُرجع كل شيء لحالته قبل الاستدعاء).
--
-- ملاحظة على compare-and-swap: التحقق من existing.updated_at (يمنع كتابة
-- متأخرة من طلب أقدم فوق طلب أحدث) يبقى داخل الدالة نفسها (WHERE
-- updated_at = p_expected_updated_at)، بنفس المبدأ الذي كان في TypeScript،
-- لكن الآن ضمن نفس المعاملة الذرية التي تكتب باقي الجداول — يزيل نافذة
-- التزامن التي كانت موجودة بين قراءة existing وكتابة current_dust_decisions
-- في الكود القديم (فحص وكتابة منفصلين عبر 2 استدعاء شبكة، لا استدعاء واحد).
--
-- خطأ مكتشَف ومُصلَح (مراجعة كود خبير خارجي — "فرع 'لا صف سابق' لا يطبّق
-- أي حماية تزامن"): عندما لا يوجد صف current_dust_decisions/
-- current_dust_compliance_decisions سابق وقت القراءة في TypeScript
-- (p_*_expected_updated_at IS NULL)، كان الفرع القديم يستخدم مباشرة
-- "insert ... on conflict (activity_group_id) do update" بلا أي شرط زمني
-- — فإذا وصل طلبان متزامنان لأول تقييم لنفس النشاط (كلاهما رأى "لا صف
-- سابق")، الطلب الذي يصل متأخراً للخادم يستبدل قرار الطلب الذي وصل أولاً
-- بلا أي فحص "هل تغيّر شيء منذ قراءتي؟" — بالضبط نفس علة "upsert أعمى"
-- الموثَّقة في التعليقات القديمة (persistDustEvaluations)، لكن في هذا
-- الفرع تحديداً لم تُغلق. الإصلاح: "on conflict do nothing" أولاً (لا
-- استبدال أعمى)؛ إذا لم يُدرَج شيء فعلاً (GET DIAGNOSTICS ROW_COUNT = 0،
-- يعني صف سبقنا لإدراجه بالتزامن)، يُعاد المحاولة كـUPDATE عادي بنفس شرط
-- "WHERE updated_at = p_expected_updated_at" — لكن بما أن p_expected_updated_at
-- كان NULL أصلاً (لم نقرأ أي صف)، هذا التحديث يُطبَّق بشرط IS NULL بدلاً
-- من ذلك (فحص واحد فقط ضد قيمة updated_at الفعلية الحالية في الجدول لحظة
-- إعادة المحاولة، لا القيمة القديمة التي قرأناها) — يضمن أن الفائز الفعلي
-- هو أول من يُدرِج الصف، لا آخر من يصل للخادم.
-- =====================================================================

create or replace function public.persist_activity_decision_atomic(
  p_project_id uuid,
  p_activity_group_id text,
  p_activity_id text,

  -- dust_evaluations + current_dust_decisions (null = لا يوجد DVI لهذا النشاط)
  p_dvi_result jsonb,
  p_dvi_triggered_by text,
  p_dvi_expected_updated_at timestamptz,

  -- dust_compliance_evaluations + current_dust_compliance_decisions
  -- (null = لا يوجد امتثال لهذا النشاط، مثال: نشاط بلا وحدة تنظيمية بعد)
  p_compliance_result jsonb,
  p_compliance_rulebook_version text,
  p_compliance_triggered_by text,
  p_compliance_expected_updated_at timestamptz,
  p_compliance_dust_profile_id uuid,
  p_compliance_stopped_since timestamptz,
  p_compliance_pending_resume_since timestamptz,

  -- final_decisions (null = تخطّي هذه المرحلة، مثال: skipActivityIds من
  -- فشل مرحلة سابقة — راجع تعليق evaluate/route.ts)
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
  -- تسلسل تنفيذي واحد فقط لكل (project_id, activity_group_id) في نفس
  -- اللحظة: يمنع تسابقاً فعلياً بين قراءة existing.updated_at في
  -- TypeScript وكتابة current_dust_decisions/current_dust_compliance_decisions
  -- هنا (القفل الاستشاري يُحرَّر تلقائياً عند نهاية المعاملة).
  perform pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_project_id::text || ':' || p_activity_group_id, 0)
  );

  -- يمنع كتابة قرار لنشاط لا ينتمي فعلياً لـ p_project_id/p_activity_group_id
  -- المرسَلين (طلب مزوَّر أو activity_id من مشروع آخر بالخطأ).
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
      where activity_group_id = p_activity_group_id
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
      on conflict (activity_group_id) do nothing;

      if not found then
        -- طلب آخر متزامن سبقنا لإدراج الصف (نفس السيناريو الموثَّق أعلاه) —
        -- لا نستبدله أعمى؛ نحاول تحديثه فقط إن كان لا يزال بلا أي تحديث
        -- لاحق منذ إدراجه الأول (updated_at is null مستحيل عملياً هنا لأن
        -- كل مسارات الإدراج تضبطها فوراً، فهذا الشرط لن يتحقق أبداً إن كان
        -- الصف قد أُدرج فعلاً بمنافس — وهذا مقصود: نترك قرار المنافس الذي
        -- سبقنا فعلياً كما هو، لا نستبدله بقرار قد يكون محسوباً من نفس
        -- اللحظة تقريباً على أي حال).
        update public.current_dust_decisions
        set latest_evaluation_id = v_dvi_evaluation_id,
            decision = p_dvi_result->>'decisionCategory',
            triggered_rules = coalesce(p_dvi_result->'triggeredRules', '[]'::jsonb),
            short_reason = p_dvi_result->>'shortReason',
            updated_at = now()
        where activity_group_id = p_activity_group_id
          and updated_at is null;
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
      where activity_group_id = p_activity_group_id
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
      on conflict (activity_group_id) do nothing;

      if not found then
        -- نفس منطق current_dust_decisions أعلاه — لا نستبدل قرار منافس سبقنا.
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
        where activity_group_id = p_activity_group_id
          and updated_at is null;
      end if;
    end if;

    v_compliance_persisted := true;
  end if;

  -- ===================================================================
  -- 3) final_decisions — append-only، يعتمد على نجاح المرحلتين أعلاه
  --    (p_final_decision يصل null من التطبيق أصلاً إذا فشلت مرحلة سابقة
  --    لنفس النشاط — راجع skipActivityIds في persistFinalDecisions)
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

-- current_dust_decisions/current_dust_compliance_decisions تفتقران لقيد
-- unique صريح على activity_group_id في الباسلاين الأصلي رغم أنه PRIMARY KEY
-- فعلياً هناك (راجع 202607290001) — on conflict أعلاه يعتمد على نفس الـPK،
-- لا حاجة لإضافة قيد جديد.

-- الدالة تُستدعى حصراً عبر service_role (supabaseAdmin) من
-- app/api/projects/[projectId]/evaluate/route.ts، بعد تحقق ملكية المشروع
-- الكامل في طبقة التطبيق — نفس نمط الوصول لكل الجداول الثلاثة المكتوبة هنا.
--
-- "revoke all ... from anon, authenticated" وحده لا يكفي: PostgreSQL يمنح
-- EXECUTE على الدوال الجديدة لدور PUBLIC افتراضياً عند الإنشاء، وanon/
-- authenticated يرثانها عبر عضويتهما الضمنية في PUBLIC — سحب الامتياز
-- منهما مباشرة لا يلغي المنح الأصلي من PUBLIC نفسه. لذلك: سحب صريح عن
-- PUBLIC أولاً، ثم منح صريح لـservice_role وحده.
revoke execute on function public.persist_activity_decision_atomic(
  uuid, text, text, jsonb, text, timestamptz, jsonb, text,
  text, timestamptz, uuid, timestamptz, timestamptz, jsonb, timestamptz
) from public, anon, authenticated;

grant execute on function public.persist_activity_decision_atomic(
  uuid, text, text, jsonb, text, timestamptz, jsonb, text,
  text, timestamptz, uuid, timestamptz, timestamptz, jsonb, timestamptz
) to service_role;
