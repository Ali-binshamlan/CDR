-- =====================================================================
-- DCR — 202608040020_device_shift_composite_fks_validate.sql
-- =====================================================================
-- المرحلة 2 من 202608040019 — VALIDATE CONSTRAINT الفعلي (فحص كامل لكل
-- صف قائم بمعاملة منفصلة قصيرة، بدل قفل طويل ضمن نفس هجرة الإضافة). لو
-- فشل أي VALIDATE هنا فهذا يعني وجود صف حقيقي حالي يخالف العزل بين
-- المشاريع (device_id/shift_id ينتمي فعلياً لمشروع مختلف عن project_id في
-- نفس الصف) — يتطلب تنظيف بيانات يدوي قبل إعادة تشغيل هذه الهجرة، لا تجاوز
-- الفحص.
-- =====================================================================

alter table public.project_dust_profiles
  validate constraint project_dust_profiles_device_project_fk;

alter table public.project_dust_profiles
  validate constraint project_dust_profiles_shift_project_fk;

alter table public.pm10_readings_history
  validate constraint pm10_readings_history_device_project_fk;

alter table public.provider_connections
  validate constraint provider_connections_device_project_fk;

alter table public.device_events
  validate constraint device_events_device_project_fk;

alter table public.device_measurements
  validate constraint device_measurements_device_project_fk;

alter table public.device_metric_latest
  validate constraint device_metric_latest_device_project_fk;
