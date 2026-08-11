-- =====================================================================
-- DCR — 202608110013_dust_profile_atomic_insert.sql
-- =====================================================================
-- خطأ معماري مكتشَف ومُصلَح (مراجعة كود خارجي — "إنشاء نشاط الغبار ليس
-- معاملة واحدة"): app/api/dust-profiles/route.ts كان يُدرج activity_groups
-- (upsert) قبل استكمال باقي التحققات (تاريخ ماضٍ، أوقات الدوام، فحص موقع
-- الكسارة/محطة الخلط عبر validateDustUnitPlacement) وقبل إدراج صف
-- project_dust_profiles نفسه. لو فشل أي تحقق لاحق (مثال: PLACEMENT_BLOCKED
-- 422)، الدالة تُرجع خطأً للمستخدم — لكن صف activity_groups يبقى مُدرَجاً
-- فعلياً في القاعدة بلا أي نشاط ينتمي إليه أبداً (يتيم دائماً، لا محاولة
-- لاحقة تُنظّفه). كذلك فشل شبكي/خادمي عابر بين نجاح upsert وبدء insert
-- (نافذة زمنية حقيقية بين استدعاءين منفصلين) يترك نفس النتيجة.
--
-- الإصلاح: كل التحققات (الموقع/الفئة/المسافات/الوقت) تُنفَّذ في route.ts
-- أولاً كما هي (بلا أي كتابة قبلها) — هذه الدالة تُستدعى فقط بعد نجاحها
-- جميعاً، وتُنشئ صف activity_groups (إن لم يكن موجوداً) وصف
-- project_dust_profiles معاً داخل معاملة واحدة ذرية: كلاهما يُكتَب أو لا
-- شيء يُكتَب إطلاقاً — لا مجال لصف مجموعة يتيم بعد الآن.
-- =====================================================================

-- p_insert: حمولة project_dust_profiles الكاملة بعد التحقق الكامل من
-- Zod في route.ts (DustProfileInsertSchema، نحو 150 عمود اختياري متغيّر
-- حسب regulatory_activity — لا جدوى من تعداد كل عمود كمعامل RPC منفصل هنا،
-- خاصة أن هذا النموذج يتوسع باستمرار). jsonb_populate_record يُطابق كل
-- مفتاح في p_insert بعمود مطابق الاسم في project_dust_profiles تلقائياً،
-- ويتجاهل أي مفتاح إضافي لا عمود مطابقاً له بصمت (لا خطر — p_insert جاهزة
-- من مصدر موثوق وحيد: route.ts بعد التحقق، لا مدخل مستخدم خام مباشر لهذه
-- الدالة).
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
  select * from jsonb_populate_record(null::public.project_dust_profiles, p_insert)
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.insert_dust_profile_atomic(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.insert_dust_profile_atomic(uuid, text, jsonb) to service_role;
