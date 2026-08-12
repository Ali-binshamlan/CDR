-- =====================================================================
-- DCR — 202608120004_fix_dust_profile_atomic_id_default_v2.sql
-- =====================================================================
-- تصحيح لمحاولة سابقة فاشلة (migration 202608120003) — بقيت هنا موثَّقة
-- كاملة لأنها كُشفت واختُبرت فعلياً على الإنتاج، والدرس مهم لأي دالة
-- مستقبلية تستخدم jsonb_populate_record بنفس النمط.
--
-- المشكلة الأصلية: POST /api/dust-profiles يفشل 500 دائماً —
-- "null value in column id of relation project_dust_profiles violates
-- not-null constraint".
--
-- محاولة 202608120003 افترضت أن حذف مفتاحَي id/created_at من p_insert
-- (عبر عامل الطرح - على jsonb) قبل jsonb_populate_record كافٍ لتفعيل
-- الـdefault الخاص بكل عمود (id=gen_random_uuid()، created_at=now()) —
-- نفس المنطق الصحيح لعبارة INSERT عادية (عمود غير مذكور في قائمة
-- الأعمدة يُفعِّل الـdefault). ثبت بالاختبار المباشر على الإنتاج
-- (استدعاء select insert_dust_profile_atomic(...) مباشرة في SQL Editor،
-- نفس الخطأ استمر حرفياً) أن هذا الافتراض خاطئ جوهرياً:
--
-- jsonb_populate_record لا تعرف أصلاً مفهوم "عمود له default على
-- الجدول الهدف" — هي تبني *قيمة صف مركّب (composite row value)* بمعزل
-- تام عن أي جدول أو قيد فعلي، وتملأ كل حقل غائب من مفاتيح الـjsonb
-- بـNULL دائماً، بصرف النظر عمّا يحمله تعريف عمود الجدول الفعلي من
-- defaults. مفهوم "الـdefault يُفعَّل لعمود غير مذكور" خاص بعبارة INSERT
-- نفسها حين تحمل قائمة أعمدة صريحة (insert into t (a, b) values (...))
-- — لكن `insert into t select * from jsonb_populate_record(...)` لا
-- يذكر أي قائمة أعمدة صريحة على الإطلاق؛ هو يُدرِج *كل* حقول الصف
-- المركّب كقيم فعلية بالترتيب، بما فيها id/created_at كـNULL حقيقي ضمن
-- تلك القيم — لا كأعمدة "غائبة" بالمعنى الذي كان يُفعِّل الـdefault.
--
-- الإصلاح الصحيح هنا: توليد id عبر gen_random_uuid() وcreated_at عبر
-- clock_timestamp() صراحةً داخل PL/pgSQL نفسه، وحقنهما داخل جسم p_insert
-- (دمج jsonb عبر ||، يستبدل أي مفتاح موجود مسبقاً بنفس الاسم) قبل
-- jsonb_populate_record — بهذا كلاهما يصل كقيمة فعلية حقيقية دائماً،
-- بصرف النظر التام عن سلوك jsonb_populate_record مع الحقول الغائبة، لا
-- اعتماداً على أي default جدول لا يُفعَّل عبر هذا المسار إطلاقاً.
--
-- اختبار القبول الذي أثبت الإصلاح (نفَّذه المستخدم مباشرة على الإنتاج):
--   select public.insert_dust_profile_atomic(
--     '<project_id حقيقي>'::uuid, '<activity_group_id فريد>',
--     '{"project_id": "...", "activity_group_id": "...",
--       "activity_type": "GENERAL_OUTDOOR_WORK", "regulatory_activity": "OTHER",
--       "planned_date": "2026-08-13", "planned_time": "10:00",
--       "duration_hours": 4, "is_dust_generating": true}'::jsonb
--   );
-- يجب أن يُرجع صف project_dust_profiles كاملاً بـid/created_at فعليين،
-- بلا أي خطأ NOT NULL.
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
  v_final_insert jsonb;
begin
  if p_activity_group_id is null or btrim(p_activity_group_id) = '' then
    raise exception using errcode = '22023', message = 'activity_group_id إلزامي';
  end if;

  insert into public.activity_groups (project_id, id)
  values (p_project_id, p_activity_group_id)
  on conflict (project_id, id) do nothing;

  -- id/created_at يُحقَنان صراحة كقيم فعلية — لا يُترَكان لـjsonb_populate_
  -- record (راجع الشرح الكامل أعلى الملف لسبب فشل النهج السابق تحديداً).
  v_final_insert := (p_insert - 'id' - 'created_at')
    || jsonb_build_object('id', gen_random_uuid(), 'created_at', clock_timestamp());

  insert into public.project_dust_profiles
  select * from jsonb_populate_record(null::public.project_dust_profiles, v_final_insert)
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.insert_dust_profile_atomic(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.insert_dust_profile_atomic(uuid, text, jsonb) to service_role;
