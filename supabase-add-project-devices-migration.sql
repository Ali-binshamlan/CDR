-- =====================================================================
-- هجرة: project_devices — أجهزة رصد فعلية مرتبطة بمشروع، ترسل قراءات
-- لحظية (سرعة/اتجاه الرياح، PM10، PM2.5، الرؤية) عبر مفتاح API خاص بكل
-- جهاز. القراءة الأخيرة تُخزَّن كأعمدة قابلة للتحديث مباشرة على نفس الصف
-- (last_*) — لا جدول تاريخ منفصل، يطابق الاستخدام الحالي "قراءة لحظية
-- تحل محل الطقس الحي" بلا حاجة لعرض تاريخي.
--
-- الأولوية عند التقييم (راجع app/utils/dust-engine/engine.ts
-- computeDviResult): قراءة الجهاز الحديثة > onsite_* اليدوي > Open-Meteo.
-- =====================================================================

create table if not exists public.project_devices (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,

  name text not null,
  lat numeric,
  lng numeric,

  -- الاعتماد: يُخزَّن هاش SHA-256 فقط، لا المفتاح الخام أبداً. api_key_prefix
  -- نص صريح (أول ~8 حروف) لعرض قائمة الأجهزة في الواجهة بلا كشف المفتاح كاملاً.
  api_key_hash text not null,
  api_key_prefix text not null,
  is_active boolean not null default true,

  -- القراءة الأخيرة (تُستبدل بالكامل أو جزئياً عند كل push من الجهاز)
  last_reading_at timestamptz,
  last_wind_speed_kmh numeric,
  last_wind_gust_kmh numeric,
  last_wind_direction_deg numeric,
  last_pm10 numeric,
  last_pm25 numeric,
  last_visibility_m numeric,

  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create index if not exists idx_project_devices_project_id on public.project_devices (project_id);
create unique index if not exists idx_project_devices_api_key_hash on public.project_devices (api_key_hash);

alter table public.project_devices enable row level security;

-- نفس نمط الملكية المستخدم لـ project_shifts/project_dust_profiles — دفاع
-- إضافي فقط؛ الكتابة الفعلية من مسارات API تمر عبر supabaseAdmin
-- (service_role يتجاوز RLS)، والتحقق الحقيقي من الملكية في كود التطبيق
-- (verifyProjectOwnership لمسارات إدارة الأجهزة، ومطابقة api_key_hash
-- لمسار الاستقبال ingest الذي لا يملك auth.uid() أصلاً).
drop policy if exists "project_devices_owner_all" on public.project_devices;
create policy "project_devices_owner_all"
  on public.project_devices for all
  to authenticated
  using (
    exists (
      select 1 from public.projects
      where projects.id = project_devices.project_id
        and projects.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.projects
      where projects.id = project_devices.project_id
        and projects.user_id = auth.uid()
    )
  );

-- تحقق سريع بعد التنفيذ:
--   select column_name, data_type from information_schema.columns
--   where table_schema = 'public' and table_name = 'project_devices'
--   order by ordinal_position;
