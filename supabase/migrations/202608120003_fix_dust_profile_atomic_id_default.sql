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
-- محاولة إصلاح أولى فاشلة (لا تزال هنا كتوثيق — راجع اختبار القبول أدناه):
-- ظننت أن حذف مفتاحَي id/created_at من p_insert (عبر عامل الطرح - على
-- jsonb) قبل jsonb_populate_record كافٍ لتفعيل الـdefault الخاص بكل عمود
-- (id=gen_random_uuid()، created_at=now()) — لكن ثبت بالاختبار المباشر
-- (SELECT insert_dust_profile_atomic(...) في SQL Editor، الخطأ استمر
-- بالضبط: null value in column "id") أن هذا الافتراض خاطئ جوهرياً:
-- jsonb_populate_record لا تعرف أصلاً مفهوم "عمود له default على الجدول" —
-- هي تبني *قيمة صف مركّب (composite row value)* بمعزل تام عن أي جدول أو
-- قيد، وتملأ كل حقل غائب بـNULL دائماً بصرف النظر عمّا يحمله تعريف الجدول
-- الفعلي من defaults. الـdefault هو مفهوم خاص بعبارة INSERT نفسها (عمود
-- *غير مذكور في قائمة الأعمدة* يُفعِّل الـdefault) — لكن `insert ... select
-- *` هنا لا يذكر أي قائمة أعمدة صريحة، فيرث ترتيب/عدد أعمدة الصف المركّب
-- كاملاً بما فيها id/created_at كقيم NULL فعلية ضمن VALUES الضمنية، لا
-- كأعمدة "غائبة" بالمعنى الذي يُفعِّل الـdefault.
--
-- الإصلاح الصحيح: توليد id عبر gen_random_uuid() صراحة داخل PL/pgSQL نفسه
-- وحقنه داخل جسم p_insert نفسه (دمج jsonb عبر ||، يستبدل أي مفتاح موجود
-- مسبقاً بنفس الاسم) قبل jsonb_populate_record — بهذا id يصل كقيمة UUID
-- فعلية دائماً، لا NULL، بصرف النظر عن سلوك
-- jsonb_populate_record مع الأعمدة الغائبة. created_at لا يحتاج نفس
-- المعالجة: created_at ليس NOT NULL بلا default حقيقي على مستوى استخدام
-- INSERT العادي فقط — لكن بما أن نفس آلية jsonb_populate_record تنطبق
-- عليه أيضاً (تملأه NULL لا now())، يُحقَن هو الآخر بنفس الطريقة صراحة
-- (clock_timestamp()) بدل الاعتماد على default الجدول الذي لا يُفعَّل هنا
-- إطلاقاً عبر هذا المسار.
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

  -- id/created_at يُحقَنان صراحة كقيم فعلية (لا يُترَكان لـjsonb_populate_
  -- record — راجع التعليق الكامل أعلى الملف لسبب فشل النهج السابق). jsonb_set
  -- بأي مفتاح موجود مسبقاً في p_insert (لن يحدث فعلياً — route.ts يحذفهما،
  -- لكن كطبقة دفاع ثانية) يستبدله، لا يكرره.
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
