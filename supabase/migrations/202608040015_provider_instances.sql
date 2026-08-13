-- =====================================================================
-- DCR — 202608040015_provider_instances.sql
-- =====================================================================
-- خطأ أمني مكتشَف (القسم 15.1 من "دليل الإصلاح الجذري لمنظومة مرقاب" —
-- "ThingsBoard: SSRF غير مكتملة"): كان provider_connections.credentials.
-- base_url نصاً حراً يكتبه أي مستخدم مسجَّل دخول مباشرة — safeUrl.ts يفحص
-- عنوان IP وقت الاستدعاء، لكن الحل الأقوى (الموصى به صراحة) هو ألا تكون
-- Credentials جزءاً من base_url يكتبه المستخدم إطلاقاً. الإصلاح: سجل
-- منصات معتمدة (provider_instances) يديره مسؤول النظام (super admin) —
-- المستخدم يختار من قائمة معتمدة بدل كتابة رابط حر.
--
-- origin مقيَّد بـhttps:// فقط (check أدناه)، port=443 فقط — أي دعم
-- لـThingsBoard مستضاف ذاتياً على منفذ/بروتوكول مختلف يتطلب موافقة صريحة
-- من مسؤول النظام يدوياً (إدراج صف جديد)، لا قبولاً تلقائياً من أي مستخدم.
-- =====================================================================

create table if not exists public.provider_instances (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  origin text not null unique,
  hostname text not null,
  port integer not null default 443 check (port = 443),
  is_approved boolean not null default false,
  approved_by uuid references auth.users(id),
  approved_at timestamptz,
  is_active boolean not null default true,
  created_at timestamptz not null default clock_timestamp(),
  check (origin like 'https://%')
);

create index if not exists idx_provider_instances_provider on public.provider_instances (provider) where is_active and is_approved;

alter table public.provider_instances enable row level security;
revoke all on public.provider_instances from anon, authenticated;
grant select, insert, update on public.provider_instances to service_role;

-- provider_connections يختار من provider_instances المعتمدة بدل base_url
-- حر داخل credentials — on delete restrict: لا يجوز حذف instance طالما
-- توجد اتصالات نشطة تستخدمه (يجب إلغاء تفعيل الاتصالات أولاً).
alter table public.provider_connections
  add column if not exists provider_instance_id uuid references public.provider_instances(id) on delete restrict;
