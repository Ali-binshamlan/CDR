-- =====================================================================
-- إضافة دور "جهة مراقبة" (viewer) — حساب قراءة فقط يرى كل المشاريع عبر
-- كل المستخدمين (خريطة + تنبيهات + تقارير)، بلا أي صلاحية تعديل. عمود
-- مستقل تماماً عن is_super_admin (لا يُمس، يبقى المصدر الوحيد لصلاحية
-- الأدمن) — إضافي بحت، بلا أي تعديل على apiAuth.ts القديم (requireViewer
-- دالة جديدة منفصلة، راجع app/lib/apiAuth.ts).
-- =====================================================================
alter table public.profiles
  add column if not exists account_role text not null default 'user';

alter table public.profiles
  drop constraint if exists profiles_account_role_check;

alter table public.profiles
  add constraint profiles_account_role_check
  check (account_role in ('user', 'viewer'));

create index if not exists idx_profiles_account_role
  on public.profiles (account_role)
  where account_role <> 'user';

-- منح دور المراقب لحساب viewer@dcr.com (أُنشئ عبر supabaseAdmin.auth.admin.createUser)
update public.profiles
set account_role = 'viewer'
where id = (select id from auth.users where email = 'viewer@dcr.com');
