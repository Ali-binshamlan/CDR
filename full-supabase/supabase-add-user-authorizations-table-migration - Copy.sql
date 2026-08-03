-- =====================================================================
-- هجرة: فصل صلاحيات is_super_admin/account_role عن profiles — إغلاق ثغرة
-- ترقية صلاحيات ذاتية (مراجعة كود خبير خارجي — "يمكن للمستخدم رفع نفسه
-- إلى Super Admin أو Viewer")
--
-- الثغرة المكتشفة: is_super_admin وaccount_role كانا عمودين عاديين في
-- public.profiles، وسياسة RLS الوحيدة عليه كانت:
--   for all using (auth.uid() = id) with check (auth.uid() = id)
-- هذه السياسة تتحقق فقط من ملكية الصف — لا تقيّد أي عمود. أي مستخدم مسجَّل
-- يقدر (عبر عميل anon الجانبي في app/lib/supabase.ts، بجلسته الخاصة، بلا
-- أي كود خلفي متورط) أن يستدعي مباشرة من المتصفح:
--   supabase.from('profiles').update({ is_super_admin: true }).eq('id', session.user.id)
-- ويمر عبر RLS بنجاح (auth.uid() = id صحيح)، فيرفع نفسه Super Admin (وصول
-- كتابة كامل لكل مشروع لكل مستخدم عبر verifyProjectOwnership في apiAuth.ts)
-- أو account_role='viewer' بلا أي تدخل خلفي. app/api/profile/route.ts
-- (PATCH) نفسه كان يُصفّي الأعمدة المقبولة بشكل صحيح فعلاً، لكن ذلك مسار
-- واحد فقط — RLS نفسها كانت الثغرة الفعلية القابلة للاستغلال مباشرة.
--
-- الإصلاح: فصل بنيوي كامل — جدول user_authorizations منفصل تماماً، بلا أي
-- منح افتراضي لـ anon/authenticated إطلاقاً (REVOKE ALL) — القراءة/الكتابة
-- تمران حصراً عبر supabaseAdmin (service_role، يتجاوز RLS/GRANT بالكامل)
-- من الخادم فقط. profiles تبقى قابلة للقراءة/التعديل الذاتي، لكن التعديل
-- يُقيَّد بعمود عبر GRANT UPDATE على أعمدة محددة فقط (company_name/
-- username/phone_number/role) — is_super_admin/account_role يُحذفان من
-- profiles نهائياً بعد نقل القيم.
-- =====================================================================

create table if not exists public.user_authorizations (
  user_id uuid primary key references auth.users(id) on delete cascade,
  is_super_admin boolean not null default false,
  account_role text not null default 'user'
    check (account_role in ('user', 'viewer')),
  updated_at timestamptz not null default now()
);

alter table public.user_authorizations enable row level security;

-- لا سياسات RLS مُنشأة عمداً — REVOKE ALL يمنع أي وصول عبر anon/authenticated
-- (المستخدم أو الجلسة الجانبية) بصرف النظر عن أي سياسة قد تُضاف لاحقاً
-- بالخطأ. القراءة/الكتابة تمران فقط عبر service_role (supabaseAdmin)، الذي
-- يتجاوز RLS وGRANT معاً بحكم دوره، فبقاء الجدول بلا سياسات SELECT/UPDATE
-- لا يمنع عمل الخادم إطلاقاً.
revoke all on public.user_authorizations from anon, authenticated;

-- طلب صريح من المستخدم: لا نسخ تلقائي لقيم is_super_admin/account_role
-- الحالية من profiles — تبدأ كل الحسابات من القيم الافتراضية الآمنة
-- (is_super_admin=false, account_role='user')، وتُمنح الصلاحيات يدوياً من
-- جديد عبر SQL Editor للحسابات الموثوقة فقط بعد هذه الهجرة. صف واحد لكل
-- مستخدم موجود حالياً بالقيم الافتراضية، حتى لا تفشل قراءات apiAuth.ts
-- بصمت (maybeSingle() يرجع null) لحسابات لم تُنشأ بعد هذه الهجرة.
insert into public.user_authorizations (user_id)
select id from auth.users
on conflict (user_id) do nothing;

-- profiles: إزالة is_super_admin/account_role نهائياً بعد نقل القراءة إلى
-- user_authorizations في الكود (apiAuth.ts وكل المسارات المرجعة).
alter table public.profiles drop column if exists is_super_admin;
alter table public.profiles drop column if exists account_role;

-- سياسة "for all" الواحدة كانت تسمح بتعديل أي عمود — نستبدلها بسياستين
-- منفصلتين (select/update) + قيد GRANT على مستوى العمود، حتى لو أُعيد
-- إضافة عمود صلاحيات لـ profiles بالخطأ مستقبلاً فلن يكون قابلاً للتعديل
-- الذاتي افتراضياً (GRANT UPDATE صريح مطلوب لكل عمود جديد).
drop policy if exists "profiles_owner_all" on public.profiles;

create policy "profiles_owner_select"
  on public.profiles for select
  to authenticated
  using (auth.uid() = id);

create policy "profiles_owner_update"
  on public.profiles for update
  to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- INSERT يبقى مطلوباً لتسجيل حساب جديد (app/api/auth/register/route.ts
-- يستخدم عميل service_role مخصص هناك أصلاً — راجع تعليق ذلك الملف — لكن
-- نُبقي سياسة الإدراج الذاتي القديمة لأي مسار آخر يعتمد عليها).
drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own"
  on public.profiles for insert
  to authenticated
  with check (auth.uid() = id);

revoke update on public.profiles from authenticated;

grant update (
  company_name,
  username,
  phone_number,
  role
) on public.profiles to authenticated;
