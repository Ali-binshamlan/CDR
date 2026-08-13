-- =====================================================================
-- DCR — 202608120005_wind_gate_parameter_relational_check.sql
-- =====================================================================
-- خطأ مكتشَف ومُصلَح (مراجعة كود خارجي — "يمكن نشر معاملات رياح متناقضة"):
-- publish_rule_parameter_version وpublish_rule_parameter_bundle (202608060003/
-- 202608110003) كانتا تتحققان فقط من المدى الآمن (min_value/max_value) لكل
-- معامل بمفرده — WIND_GATE_ENHANCED_MIN_KMH وWIND_GATE_STOP_KMH كلاهما
-- 0-100 كمدى آمن مستقل، فنشر ENHANCED=30 مع STOP=25 (أو نشر ENHANCED=30
-- وحدها بينما STOP الحالية 25) كان ينجح فعلياً رغم تناقضهما المنطقي.
-- classifyWind (rulebook.ts) تعتمد على الترتيب ENHANCED < STOP: رياح 27
-- كم/س (تتجاوز فعلياً حد الإيقاف 25) كانت ستُصنَّف خطأً BELOW_15 بدل
-- ABOVE_25 لأن 27 < 30 (ENHANCED المُفسَد) صحيحة — بوابة إيقاف الرياح
-- التنظيمية (GATE-WIND-ABOVE-25-004) لا تُفعَّل إطلاقاً لتلك القراءة.
--
-- الإصلاح: دالة تحقق علائقي واحدة (assert_wind_gate_parameters_coherent)
-- تُستدعى من نهاية كل من publish_rule_parameter_version وpublish_rule_
-- parameter_bundle — بعد إدراج/تحديث القيمة الجديدة داخل نفس المعاملة، قبل
-- إرجاع النتيجة. تقرأ القيمة الفعلية PUBLISHED الحالية لكلا المعاملين (بعد
-- أي تغيير حدث للتو ضمن هذا الاستدعاء) فتغطي كل السيناريوهات: نشر كلا
-- المعاملين معاً بتناقض، أو نشر أحدهما وحده بما يُفسِد التوافق مع الآخر
-- المنشور مسبقاً. فشل التحقق يُلغي المعاملة بأكملها (raise exception عادية
-- — دلالة Postgres القياسية، بلا تعويض يدوي)، بما في ذلك كل عناصر بندلة
-- publish_rule_parameter_bundle حتى لو التناقض جاء من عنصر واحد فيها.
--
-- لا حاجة لتعديل rollback_rule_parameter_version/rollback_rule_parameter_bundle
-- بشكل منفصل: كلاهما يفوّض فعلياً لـpublish_rule_parameter_version/
-- publish_rule_parameter_bundle (راجع تعليقيهما في 202608060003/
-- 202608110003) فيرث هذا التحقق تلقائياً.
-- =====================================================================

-- دالة مساعدة عامة — تقرأ القيمة الفعلية الحالية لمعامل (PUBLISHED إن وُجد،
-- وإلا null صراحة؛ المستدعي يتعامل مع null كـ"لا نسخة، القيمة الافتراضية
-- الثابتة تتحكم" بنفس مبدأ resolveActiveRuleParameters في dustEvaluation.ts).
create or replace function public._current_published_rule_parameter_value(p_code text)
returns numeric
language sql
stable
as $$
  select value from public.rule_parameter_versions
  where parameter_code = p_code and status = 'PUBLISHED';
$$;

-- يتحقق من زوجين علائقيين معروفين حالياً (الأصغر يجب أن يبقى أصغر من
-- الأكبر): بوابة الرياح (تعزيز/إيقاف) وعتبتا الرؤية (تقييد شديد/إيقاف
-- إلزامي). غياب أي نسخة PUBLISHED لأحد طرفي زوج يعني الاعتماد على
-- DEFAULT_RULE_PARAMETERS (ruleParameters.ts) لذلك الطرف تحديداً — متماسك
-- دائماً بحكم القيم الافتراضية الثابتة المتحقق من ترتيبها عند الكتابة، فلا
-- حاجة لفحص ذلك الزوج حينها.
create or replace function public.assert_wind_gate_parameters_coherent()
returns void
language plpgsql
as $$
declare
  v_wind_enhanced numeric := public._current_published_rule_parameter_value('WIND_GATE_ENHANCED_MIN_KMH');
  v_wind_stop numeric := public._current_published_rule_parameter_value('WIND_GATE_STOP_KMH');
  v_vis_restrict numeric := public._current_published_rule_parameter_value('VISIBILITY_RESTRICT_SEVERE_KM');
  v_vis_stop numeric := public._current_published_rule_parameter_value('VISIBILITY_MANDATORY_STOP_KM');
begin
  if v_wind_enhanced is not null and v_wind_stop is not null and v_wind_enhanced >= v_wind_stop then
    raise exception using errcode = '22023', message = format(
      'تناقض بين معاملات بوابة الرياح: حد التعزيز (WIND_GATE_ENHANCED_MIN_KMH=%s) يجب أن يكون أقل من حد الإيقاف (WIND_GATE_STOP_KMH=%s)',
      v_wind_enhanced, v_wind_stop
    );
  end if;

  if v_vis_stop is not null and v_vis_restrict is not null and v_vis_stop >= v_vis_restrict then
    raise exception using errcode = '22023', message = format(
      'تناقض بين معاملات الرؤية: حد الإيقاف الإلزامي (VISIBILITY_MANDATORY_STOP_KM=%s) يجب أن يكون أقل من حد التقييد الشديد (VISIBILITY_RESTRICT_SEVERE_KM=%s)',
      v_vis_stop, v_vis_restrict
    );
  end if;
end;
$$;

create or replace function public.publish_rule_parameter_version(
  p_parameter_code text,
  p_value numeric,
  p_published_by uuid,
  p_change_reason_ar text,
  p_is_rollback boolean default false,
  p_rollback_to_version_id uuid default null
)
returns public.rule_parameter_versions
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_min numeric;
  v_max numeric;
  v_previous_id uuid;
  v_new_row public.rule_parameter_versions;
begin
  if p_change_reason_ar is null or btrim(p_change_reason_ar) = '' then
    raise exception using errcode = '22023', message = 'change_reason_ar إلزامي عند النشر';
  end if;

  select min_value, max_value into v_min, v_max
  from public.rule_parameter_definitions
  where code = p_parameter_code
  for update;

  if not found then
    raise exception using errcode = '23503', message = format('معامل غير معروف: %s', p_parameter_code);
  end if;

  if v_min is not null and p_value < v_min then
    raise exception using errcode = '22023', message = format('القيمة %s أقل من الحد الأدنى الآمن %s', p_value, v_min);
  end if;
  if v_max is not null and p_value > v_max then
    raise exception using errcode = '22023', message = format('القيمة %s أعلى من الحد الأقصى الآمن %s', p_value, v_max);
  end if;

  select id into v_previous_id
  from public.rule_parameter_versions
  where parameter_code = p_parameter_code and status = 'PUBLISHED';

  if v_previous_id is not null then
    update public.rule_parameter_versions
    set status = 'SUPERSEDED'
    where id = v_previous_id;
  end if;

  insert into public.rule_parameter_versions (
    parameter_code, value, status, effective_from, published_by, published_at,
    change_reason_ar, is_rollback, supersedes_version_id, created_by
  ) values (
    p_parameter_code, p_value, 'PUBLISHED', clock_timestamp(), p_published_by, clock_timestamp(),
    p_change_reason_ar, coalesce(p_is_rollback, false),
    coalesce(p_rollback_to_version_id, v_previous_id), p_published_by
  )
  returning * into v_new_row;

  -- تحقق علائقي بعد الكتابة، قبل إرجاع النتيجة — راجع تعليق
  -- assert_wind_gate_parameters_coherent الكامل أعلاه.
  perform public.assert_wind_gate_parameters_coherent();

  return v_new_row;
end;
$$;

create or replace function public.publish_rule_parameter_bundle(
  p_changes jsonb, -- [{code: text, value: numeric}, ...]
  p_published_by uuid,
  p_change_reason_ar text
)
returns setof public.rule_parameter_versions
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_bundle_id uuid;
  v_item jsonb;
  v_code text;
  v_value numeric;
  v_min numeric;
  v_max numeric;
  v_previous_id uuid;
  v_new_row public.rule_parameter_versions;
  v_seen_codes text[] := '{}';
  v_count integer := 0;
begin
  set local lock_timeout = '3s';
  set local statement_timeout = '10s';

  if p_change_reason_ar is null or btrim(p_change_reason_ar) = '' then
    raise exception using errcode = '22023', message = 'change_reason_ar إلزامي عند نشر المجموعة';
  end if;

  if p_changes is null or jsonb_typeof(p_changes) <> 'array' or jsonb_array_length(p_changes) = 0 then
    raise exception using errcode = '22023', message = 'يجب تمرير معامل واحد على الأقل في المجموعة';
  end if;

  for v_item in select value from jsonb_array_elements(p_changes) order by value->>'code' loop
    v_count := v_count + 1;
    v_code := v_item->>'code';
    v_value := (v_item->>'value')::numeric;

    if v_code is null or btrim(v_code) = '' then
      raise exception using errcode = '22023', message = format('عنصر %s: code إلزامي', v_count);
    end if;
    if v_value is null then
      raise exception using errcode = '22023', message = format('عنصر %s (%s): value إلزامي ويجب أن يكون رقماً', v_count, v_code);
    end if;
    if v_code = any(v_seen_codes) then
      raise exception using errcode = '22023', message = format('المعامل %s مكرر أكثر من مرة في نفس الطلب', v_code);
    end if;
    v_seen_codes := array_append(v_seen_codes, v_code);
  end loop;

  insert into public.rule_parameter_publication_bundles (change_reason_ar, published_by)
  values (p_change_reason_ar, p_published_by)
  returning id into v_bundle_id;

  for v_item in select value from jsonb_array_elements(p_changes) order by value->>'code' loop
    v_code := v_item->>'code';
    v_value := (v_item->>'value')::numeric;

    select min_value, max_value into v_min, v_max
    from public.rule_parameter_definitions
    where code = v_code
    for update;

    if not found then
      raise exception using errcode = '23503', message = format('معامل غير معروف: %s', v_code);
    end if;

    if v_min is not null and v_value < v_min then
      raise exception using errcode = '22023', message = format('المعامل %s: القيمة %s أقل من الحد الأدنى الآمن %s', v_code, v_value, v_min);
    end if;
    if v_max is not null and v_value > v_max then
      raise exception using errcode = '22023', message = format('المعامل %s: القيمة %s أعلى من الحد الأقصى الآمن %s', v_code, v_value, v_max);
    end if;

    select id into v_previous_id
    from public.rule_parameter_versions
    where parameter_code = v_code and status = 'PUBLISHED';

    if v_previous_id is not null then
      update public.rule_parameter_versions
      set status = 'SUPERSEDED'
      where id = v_previous_id;
    end if;

    insert into public.rule_parameter_versions (
      parameter_code, value, status, effective_from, published_by, published_at,
      change_reason_ar, is_rollback, supersedes_version_id, created_by, bundle_id
    ) values (
      v_code, v_value, 'PUBLISHED', clock_timestamp(), p_published_by, clock_timestamp(),
      p_change_reason_ar, false, v_previous_id, p_published_by, v_bundle_id
    )
    returning * into v_new_row;

    return next v_new_row;
  end loop;

  -- تحقق علائقي بعد كتابة كل عناصر البندلة، قبل الإرجاع — يغطي حالة نشر
  -- كلا معاملي بوابة الرياح معاً بتناقض بينهما ضمن نفس البندلة.
  perform public.assert_wind_gate_parameters_coherent();

  return;
end;
$$;

-- =====================================================================
-- البند الثالث من نفس ملاحظة المراجعة — "انقل حدود الرؤية 500/1000 إلى حزمة
-- القواعد حتى تدخل في replay": VISIBILITY_MANDATORY_STOP_KM (0.5 كم، كانت
-- ثابتاً خاماً `< 0.5` في applyMandatoryGates بـdust-engine/engine.ts)
-- وVISIBILITY_RESTRICT_SEVERE_KM (1 كم، كانت `< 1`) — نفس آلية كل معامل آخر
-- في هذا الكتالوج (code_default_value مطابقة تماماً للثابت القديم، fallback
-- آمن بلا نسخة PUBLISHED بعد). راجع تعليق الحقلين الكامل في ruleParameters.ts.
-- =====================================================================
insert into public.rule_parameter_definitions (code, label_ar, description_ar, unit, value_type, min_value, max_value, code_default_value) values
  ('VISIBILITY_MANDATORY_STOP_KM', 'حد الإيقاف الإلزامي للرؤية', 'الرؤية الأفقية الميدانية التي دونها يُوقَف إلزامياً أي نشاط يعتمد على الرؤية.', 'كم', 'NUMBER', 0, 10, 0.5),
  ('VISIBILITY_RESTRICT_SEVERE_KM', 'حد التقييد الشديد للرؤية', 'الرؤية الأفقية الميدانية التي دونها يُطبَّق تقييد شديد على الأنشطة المعتمدة على الرؤية.', 'كم', 'NUMBER', 0, 10, 1)
on conflict (code) do nothing;
