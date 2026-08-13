-- =====================================================================
-- DCR — 202608120014_register_profile_atomic.sql
-- =====================================================================
-- خطأ مكتشَف ومُصلَح (طلب صريح من المستخدم — مراجعة كود خارجي: "محدد
-- المعدل غير موزع ومسار التسجيل يحتاج إعادة ضبط"، بند: "أنشئ profile
-- وauthorization عبر Trigger/RPC ذرية"):
--
-- auth/register/route.ts كان يُنفِّذ profiles.insert ثم user_authorizations.
-- insert كاستدعاءين منفصلين تماماً من جانب التطبيق، مع تعويض يدوي (silent
-- rollback عبر profiles.delete + auth.admin.deleteUser) عند فشل الثاني —
-- لا ذرّية حقيقية على مستوى قاعدة البيانات: فشل الخادم أو انقطاع الاتصال
-- تحديداً بين نجاح الإدراج الأول وبدء الثاني يترك مستخدم auth.users +
-- profiles بلا user_authorizations مقابل (والتعويض اليدوي نفسه معرَّض لنفس
-- الفشل الجزئي لو انقطع الاتصال أثناءه).
--
-- الإصلاح: RPC ذرّية واحدة تُنشئ الصفّين معاً داخل معاملة SQL واحدة —
-- ينجحان معاً أو يفشلان معاً (Rollback كامل تلقائي عند أي استثناء). لا يمس
-- auth.users نفسه (يبقى من مسؤولية auth.signUp في الكود — لا صلاحية SQL
-- عادية لإدراج auth.users مباشرة بأمان خارج مسار Supabase Auth الرسمي).
-- =====================================================================

create or replace function public.create_profile_and_authorization_atomic(
  p_user_id uuid,
  p_company_name text,
  p_username text,
  p_phone_number text,
  p_role text
)
returns void
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  if p_user_id is null then
    raise exception using errcode = '22023', message = 'user_id إلزامي';
  end if;
  if p_username is null or btrim(p_username) = '' then
    raise exception using errcode = '22023', message = 'username إلزامي';
  end if;

  insert into public.profiles (id, company_name, username, phone_number, role)
  values (p_user_id, p_company_name, p_username, p_phone_number, p_role);

  insert into public.user_authorizations (user_id)
  values (p_user_id);
end;
$$;

-- لا GRANT لـanon/authenticated — نفس نمط user_authorizations (تعليق
-- 202607290002): الكتابة تمر حصراً عبر service_role من الخادم.
revoke all on function public.create_profile_and_authorization_atomic(uuid, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.create_profile_and_authorization_atomic(uuid, text, text, text, text)
  to service_role;
