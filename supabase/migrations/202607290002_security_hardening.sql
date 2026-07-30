-- =====================================================================
-- DCR — 202607290002_security_hardening.sql
-- =====================================================================
-- ⚠ مسودة غير مُختبرة على بيئة Supabase فعلية — راجع تحذير
-- 202607290001_baseline_final.sql. يجب أن يُشغَّل بعد ذلك الملف مباشرة.
--
-- يجمع الحالة النهائية لتصحيحات أمنية اكتُشفت عبر مراجعات كود خارجية
-- متتالية (مصادرها الأصلية بجذر المشروع):
--   • supabase-add-user-authorizations-table-migration.sql: يغلق ثغرة
--     ترقية صلاحيات ذاتية (مستخدم يقدر يرفع نفسه Super Admin/viewer عبر
--     تعديل صف profiles الخاص به مباشرة من المتصفح).
--   • supabase-lock-project-devices-rls-migration.sql: يغلق ثغرة تزوير
--     قراءة جهاز رصد من مالك المشروع نفسه عبر عميل anon الجانبي.
--
-- ملاحظة: هذا الملف لا "يُصلح" حالة قديمة موجودة فعلياً في الباسلاين (مثل
-- supabase-add-viewer-role-migration.sql الأصلية التي أضافت account_role
-- لـprofiles قبل نقله لاحقاً) — الباسلاين (202607290001) لم يُنشئ تلك
-- الحالة الوسيطة أصلاً، فينشئ هذا الملف مباشرة الحالة الأمنية النهائية
-- الصحيحة (user_authorizations منذ البداية، project_devices بلا أي سياسة
-- RLS منذ البداية).
-- =====================================================================


-- =====================================================================
-- 1) user_authorizations — صلاحيات is_super_admin/account_role منفصلة
--    تماماً عن profiles، بلا أي منح افتراضي لـanon/authenticated
-- =====================================================================
create table if not exists public.user_authorizations (
  user_id uuid primary key references auth.users(id) on delete cascade,
  is_super_admin boolean not null default false,
  account_role text not null default 'user'
    check (account_role in ('user', 'viewer')),
  updated_at timestamptz not null default now()
);

alter table public.user_authorizations enable row level security;

-- لا سياسات RLS عمداً — القراءة/الكتابة تمران حصراً عبر service_role
-- (supabaseAdmin) من الخادم فقط.
revoke all on public.user_authorizations from anon, authenticated;

-- صف واحد بالقيم الافتراضية الآمنة لكل مستخدم موجود حالياً — حتى لا تفشل
-- قراءات apiAuth.ts بصمت (maybeSingle() يرجع null) لحسابات موجودة مسبقاً.
-- طلب صريح من المستخدم (الميجريشن الأصلية): لا نسخ تلقائي لأي صلاحية
-- قديمة — تُمنح يدوياً عبر SQL Editor للحسابات الموثوقة فقط بعد هذا.
insert into public.user_authorizations (user_id)
select id from auth.users
on conflict (user_id) do nothing;


-- =====================================================================
-- 2) profiles — سياسات مقيَّدة بعمود بدل "for all" شاملة
-- =====================================================================
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

drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own"
  on public.profiles for insert
  to authenticated
  with check (auth.uid() = id);

-- يمنع UPDATE عام على الجدول، ثم يمنح فقط الأعمدة غير الحسّاسة — أي عمود
-- صلاحيات يُضاف مستقبلاً لـprofiles بالخطأ لن يكون قابلاً للتعديل الذاتي
-- افتراضياً (GRANT صريح مطلوب لكل عمود جديد).
revoke update on public.profiles from authenticated;

grant update (
  company_name,
  username,
  phone_number,
  role
) on public.profiles to authenticated;


-- =====================================================================
-- 3) project_devices — إغلاق كامل أمام anon/authenticated
-- =====================================================================
-- لا سياسة "for all" هنا (الباسلاين لم ينشئها أصلاً) — فقط REVOKE صريح
-- للتوثيق والوضوح، حتى لو كانت GRANT الافتراضية لا تشمل الجدول أصلاً.
-- كل مسارات إدارة الأجهزة الفعلية تمر عبر supabaseAdmin (service_role).
revoke all on public.project_devices from anon, authenticated;
