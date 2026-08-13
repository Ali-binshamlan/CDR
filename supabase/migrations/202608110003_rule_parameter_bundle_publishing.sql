-- =====================================================================
-- DCR — 202608110003_rule_parameter_bundle_publishing.sql
-- =====================================================================
-- خطأ مكتشَف (مراجعة تدقيق — "توجد معاملات قابلة للنشر والتراجع، لكن ليست
-- حزمة ذرية موحدة"): publish_rule_parameter_version (202608060003) تنشر
-- معاملاً واحداً فقط لكل استدعاء. تغيير عدة معاملات مترابطة معاً (مثال:
-- كل عتبات بوابة الرياح لملف تشغيلي جديد) يتطلب عدة استدعاءات منفصلة —
-- كل واحد بمعاملته الخاصة، بلا رابط مشترك يوثّق "هذه كانت تُفترَض أن تُنشَر
-- معاً". فشل استدعاء وسط بين عدة استدعاءات يترك النظام بحالة نصف-مُطبَّقة
-- بلا آلية تراجع جماعية.
--
-- الإصلاح: rule_parameter_publication_bundles سجل رأس واحد لكل عملية نشر/
-- تراجع جماعية؛ rule_parameter_versions.bundle_id (عمود جديد، nullable)
-- يربط كل نسخة نُشرت ضمن هذه العملية بالسجل نفسه. publish_rule_parameter_
-- bundle تنشر مصفوفة معاملات كاملة داخل معاملة واحدة (لا N استدعاءات
-- منفصلة لـpublish_rule_parameter_version — نفس منطق التحقق/القفل/
-- الاستبدال/الإدراج مُضمَّن هنا مباشرة في حلقة واحدة). النشر المفرد الحالي
-- (publish_rule_parameter_version) يبقى بلا أي تغيير — bundle_id يبقى null
-- له دائماً (توافقي تام، لا إعادة هيكلة لمسار يعمل).
-- =====================================================================

create table if not exists public.rule_parameter_publication_bundles (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'PUBLISHED' check (status in ('PUBLISHED', 'ROLLED_BACK')),
  change_reason_ar text not null,
  published_by uuid references auth.users(id) on delete set null,
  published_at timestamptz not null default clock_timestamp(),
  is_rollback boolean not null default false,
  rolled_back_from_bundle_id uuid references public.rule_parameter_publication_bundles(id) on delete set null,
  created_at timestamptz not null default clock_timestamp()
);

alter table public.rule_parameter_publication_bundles enable row level security;
revoke all on public.rule_parameter_publication_bundles from anon, authenticated;
grant select, insert, update on public.rule_parameter_publication_bundles to service_role;

alter table public.rule_parameter_versions
  add column if not exists bundle_id uuid references public.rule_parameter_publication_bundles(id) on delete set null;

create index if not exists idx_rule_parameter_versions_bundle
  on public.rule_parameter_versions (bundle_id);

-- =====================================================================
-- publish_rule_parameter_bundle — ذرّي بالكامل: يقفل صفوف كل معامل مطلوب
-- (for update، بترتيب code ثابت لمنع Deadlock بين نشرين متزامنين لحزمتين
-- متقاطعتين)، يتحقق من المدى الآمن لكل معامل، ثم يُنهي (SUPERSEDED) كل
-- نسخة PUBLISHED حالية وينشئ نسخة PUBLISHED جديدة لكل معامل — كل ذلك ضمن
-- معاملة واحدة. فشل أي معامل (قيمة خارج المدى، كود غير معروف، تكرار نفس
-- الكود مرتين في نفس الطلب) يُلغي كامل الطلب (raise exception يُرجع كل شيء
-- لحالته قبل الاستدعاء — دلالة معاملة Postgres القياسية، بلا تعويض يدوي).
-- =====================================================================
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

  -- فحص أولي: تحقق من التكرار وصحة الشكل قبل أي قفل/كتابة — يمنع قفل صفوف
  -- ثم اكتشاف خطأ شكلي لاحقاً بلا داعٍ.
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

  -- ترتيب أبجدي ثابت لقفل/كتابة كل معامل — يمنع Deadlock بين استدعاءين
  -- متزامنين لهذه الدالة يتقاطعان في مجموعة المعاملات (نفس مبدأ: قفل
  -- الموارد بترتيب ثابت دائماً بصرف النظر عن ترتيب إدخال المستخدم).
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

  return;
end;
$$;

revoke all on function public.publish_rule_parameter_bundle(jsonb, uuid, text)
  from public, anon, authenticated;
grant execute on function public.publish_rule_parameter_bundle(jsonb, uuid, text) to service_role;

-- =====================================================================
-- rollback_rule_parameter_bundle — يعيد نشر كل معامل في البندلة الأصلية
-- بقيمته *قبل* تلك البندلة تحديداً (supersedes_version_id الخاص بنسخة كل
-- معامل ضمن البندلة، لا "آخر نسخة الآن") كنسخة PUBLISHED جديدة تماماً —
-- نفس فلسفة rollback_rule_parameter_version ("انشر القديم من جديد"، لا
-- حذف). ينشئ بندلة جديدة (is_rollback=true) تربط كل نسخ التراجع معاً.
-- =====================================================================
create or replace function public.rollback_rule_parameter_bundle(
  p_bundle_id uuid,
  p_published_by uuid,
  p_change_reason_ar text
)
returns setof public.rule_parameter_versions
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_original_bundle public.rule_parameter_publication_bundles;
  v_new_bundle_id uuid;
  v_member record;
  v_target public.rule_parameter_versions;
  v_min numeric;
  v_max numeric;
  v_previous_id uuid;
  v_new_row public.rule_parameter_versions;
begin
  set local lock_timeout = '3s';
  set local statement_timeout = '10s';

  if p_change_reason_ar is null or btrim(p_change_reason_ar) = '' then
    raise exception using errcode = '22023', message = 'change_reason_ar إلزامي عند التراجع';
  end if;

  select * into v_original_bundle
  from public.rule_parameter_publication_bundles
  where id = p_bundle_id
  for update;

  if not found then
    raise exception using errcode = '23503', message = format('بندلة غير موجودة: %s', p_bundle_id);
  end if;

  if v_original_bundle.status = 'ROLLED_BACK' then
    raise exception using errcode = '22023', message = 'هذه البندلة تراجع عنها بالفعل';
  end if;

  insert into public.rule_parameter_publication_bundles (
    change_reason_ar, published_by, is_rollback, rolled_back_from_bundle_id
  )
  values (p_change_reason_ar, p_published_by, true, p_bundle_id)
  returning id into v_new_bundle_id;

  for v_member in
    select rpv.parameter_code, rpv.supersedes_version_id
    from public.rule_parameter_versions rpv
    where rpv.bundle_id = p_bundle_id
    order by rpv.parameter_code
  loop
    if v_member.supersedes_version_id is null then
      raise exception using errcode = '22023',
        message = format('المعامل %s لم يكن له نسخة سابقة قبل هذه البندلة — لا يوجد ما يُتراجع إليه', v_member.parameter_code);
    end if;

    select * into v_target from public.rule_parameter_versions where id = v_member.supersedes_version_id;
    if not found then
      raise exception using errcode = '23503', message = format('النسخة السابقة للمعامل %s غير موجودة', v_member.parameter_code);
    end if;

    select min_value, max_value into v_min, v_max
    from public.rule_parameter_definitions
    where code = v_target.parameter_code
    for update;

    if v_min is not null and v_target.value < v_min then
      raise exception using errcode = '22023', message = format('المعامل %s: القيمة السابقة %s أصبحت خارج المدى الآمن الحالي (أدنى %s)', v_target.parameter_code, v_target.value, v_min);
    end if;
    if v_max is not null and v_target.value > v_max then
      raise exception using errcode = '22023', message = format('المعامل %s: القيمة السابقة %s أصبحت خارج المدى الآمن الحالي (أقصى %s)', v_target.parameter_code, v_target.value, v_max);
    end if;

    select id into v_previous_id
    from public.rule_parameter_versions
    where parameter_code = v_target.parameter_code and status = 'PUBLISHED';

    if v_previous_id is not null then
      update public.rule_parameter_versions set status = 'SUPERSEDED' where id = v_previous_id;
    end if;

    insert into public.rule_parameter_versions (
      parameter_code, value, status, effective_from, published_by, published_at,
      change_reason_ar, is_rollback, supersedes_version_id, created_by, bundle_id
    ) values (
      v_target.parameter_code, v_target.value, 'PUBLISHED', clock_timestamp(), p_published_by, clock_timestamp(),
      p_change_reason_ar, true, v_previous_id, p_published_by, v_new_bundle_id
    )
    returning * into v_new_row;

    return next v_new_row;
  end loop;

  update public.rule_parameter_publication_bundles
  set status = 'ROLLED_BACK'
  where id = p_bundle_id;

  return;
end;
$$;

revoke all on function public.rollback_rule_parameter_bundle(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.rollback_rule_parameter_bundle(uuid, uuid, text) to service_role;

-- =====================================================================
-- إصلاح ثغرة جانبية: forbid_published_rule_parameter_mutation (202608060003)
-- لا تتحقق من bundle_id ضمن شرط الانتقال PUBLISHED→SUPERSEDED المسموح —
-- إضافة العمود الجديد بلا تحديث هذا الشرط تفتح ثغرة صغيرة (تعديل bundle_id
-- أثناء الانتقال المسموح كان سيمر بصمت). إعادة تعريف الجسم كاملاً (حسب
-- عرف المشروع لكل تعديل على triggers الحماية) بإضافة شرط تطابق bundle_id.
-- =====================================================================
create or replace function public.forbid_published_rule_parameter_mutation()
returns trigger
language plpgsql
as $$
begin
  if old.status = 'DRAFT' then
    return new;
  end if;

  if old.status = 'PUBLISHED' and new.status = 'SUPERSEDED'
     and new.value = old.value and new.parameter_code = old.parameter_code
     and new.published_at = old.published_at and new.published_by is not distinct from old.published_by
     and new.change_reason_ar = old.change_reason_ar and new.is_rollback = old.is_rollback
     and new.supersedes_version_id is not distinct from old.supersedes_version_id
     and new.bundle_id is not distinct from old.bundle_id then
    return new;
  end if;

  raise exception using errcode = '0A000',
    message = 'rule_parameter_versions: لا يجوز تعديل نسخة منشورة/مُستبدَلة/مؤرشَفة إلا انتقال PUBLISHED→SUPERSEDED — append-only بعد النشر';
end;
$$;
