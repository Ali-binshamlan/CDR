-- =====================================================================
-- DCR — 202608120003_fix_dust_profile_atomic_id_default.sql
-- =====================================================================
-- خطأ حرج مكتشَف ومُصلَح (المستخدم واجه فشل POST /api/dust-profiles بالكامل
-- على الإنتاج — لا يقدر يضيف أي نشاط غبار جديد إطلاقاً — الرسالة الحقيقية
-- من Vercel logs بعد إصلاح safeErrorResponse: "null value in column id of
-- relation project_dust_profiles violates not-null constraint"):
-- insert_dust_profile_atomic (migration 202608110013) تستخدم
-- jsonb_populate_record(null::public.project_dust_profiles, p_insert) —
-- هذه الدالة تبني صفاً كاملاً بكل أعمدة الجدول، وأي عمود *غائب* من مفاتيح
-- p_insert (وليس فقط أي عمود بقيمة JSON null صريحة) يُملأ بـNULL في الصف
-- الناتج، لا بالـdefault الخاص بالعمود. route.ts (FORBIDDEN_DUST_PROFILE_
-- FIELDS) يحذف id/created_at من الحمولة عمداً قبل الوصول لهذه الدالة — وهما
-- NOT NULL مع default حقيقي (id=gen_random_uuid()، created_at=now()). لأن
-- INSERT الفعلي هو `insert into project_dust_profiles select * from
-- <صف كامل بكل الأعمدة>`، فهو يذكر id/created_at بقيمة NULL صريحة ضمن
-- قائمة الأعمدة/القيم المُدرَجة — والفرق الجوهري في PostgreSQL: عمود *غير
-- مذكور إطلاقاً* في INSERT يُفعِّل الـdefault تلقائياً، بينما عمود *مذكور*
-- بقيمة NULL صريحة يخالف قيد NOT NULL مباشرة (لا يوجد "قيمة تعني: استخدم
-- الـdefault" ضمن SQL قياسي، إلا DEFAULT keyword الحرفية غير المتاحة هنا).
--
-- لماذا لم يُكتشَف هذا وقت كتابة migration 202608110013 الأصلية: لم يُختبَر
-- فعلياً ضد قاعدة بيانات حقيقية وقتها (لا بيئة Supabase متصلة من تلك الجلسة)
-- — فحص منطقي للكود فقط، فات عليه هذا الفارق السلوكي الدقيق لـ
-- jsonb_populate_record تحديداً.
--
-- الإصلاح: حذف صريح لمفتاحَي id/created_at من p_insert (عبر عامل الطرح -
-- على jsonb، يعمل حتى لو المفتاح غير موجود أصلاً — لا خطأ) قبل تمريره لـ
-- jsonb_populate_record — فلا يُذكَران إطلاقاً في عمود/قيمة INSERT الناتج،
-- فتُفعَّل الـdefault الحقيقية لكل منهما. أثر أمني إضافي مقصود: حتى لو
-- تسرّب مستقبلاً id/created_at ضمن p_insert من أي تعديل لاحق على route.ts
-- (خطأً)، هذه الدالة الذرية نفسها تضمن تجاهلهما دائماً — id لا يجوز أبداً
-- أن يُملى من عميل (انتحال/تصادم هوية صف)، وcreated_at يجب أن يبقى دائماً
-- وقت الخادم الفعلي وقت الكتابة، لا وقت عميل قابل للتلاعب.
-- =====================================================================

create or replace function public.insert_dust_profile_atomic(
  p_project_id uuid,
  p_activity_group_id text,
  p_insert jsonb
)
returns public.project_dust_profiles
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_row public.project_dust_profiles;
begin
  if p_activity_group_id is null or btrim(p_activity_group_id) = '' then
    raise exception using errcode = '22023', message = 'activity_group_id إلزامي';
  end if;

  insert into public.activity_groups (project_id, id)
  values (p_project_id, p_activity_group_id)
  on conflict (project_id, id) do nothing;

  insert into public.project_dust_profiles
  select * from jsonb_populate_record(null::public.project_dust_profiles, p_insert - 'id' - 'created_at')
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.insert_dust_profile_atomic(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.insert_dust_profile_atomic(uuid, text, jsonb) to service_role;
