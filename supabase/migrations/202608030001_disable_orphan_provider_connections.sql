-- =====================================================================
-- DCR — 202608030001_disable_orphan_provider_connections.sql
-- =====================================================================
-- تصحيح بيانات لمرة واحدة: provider_connections.is_active=true لأجهزة
-- أُلغيت فعلياً (project_devices.is_active=false) قبل إضافة التعطيل
-- التلقائي في app/api/projects/[projectId]/devices/[deviceId]/route.ts
-- (PATCH/DELETE) — كانت هذه الاتصالات تسبب محاولات سحب فاشلة مستمرة كل
-- دورة cron بخطأ RPC "device not found, revoked, or project mismatch".
update public.provider_connections pc
set is_active = false, updated_at = now()
from public.project_devices d
where pc.device_id = d.id
  and d.is_active = false
  and pc.is_active = true;
