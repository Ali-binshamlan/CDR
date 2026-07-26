-- =====================================================================
-- هجرة: ترحيل projects.monitoring_station_locations (jsonb قديم، وصفي
-- بحت — أسماء/إحداثيات بلا أي مفتاح API أو قراءات حية) إلى صفوف حقيقية في
-- project_devices، بعد أن أصبحت "أجهزة الرصد الحية" المصدر الوحيد لعدد
-- ومواقع أجهزة الرصد في التطبيق (راجع خطة توحيد "محطات رصد الغبار" مع
-- "أجهزة الرصد الحية").
--
-- هذه الصفوف "قديمة معطَّلة" عمداً — لا توجد طريقة لاختراع مفتاح API خام
-- صالح بأثر رجعي من SQL بحت (المفتاح الخام لا يُخزَّن أبداً، فقط هاشه):
--   • is_active = false — الحارس الفعلي: requireDeviceApiKey (apiAuth.ts)
--     يرفض أي جهاز غير نشط بصرف النظر عن الهاش، فهذه الصفوف غير قابلة
--     للاستخدام في الاستقبال (ingest) إطلاقاً منذ لحظة إنشائها.
--   • api_key_hash = هاش SHA-256 لِـ uuid عشوائي — غير قابل للاشتقاق من أي
--     نص حقيقي، فلا يمكن مطابقته بأي مفتاح يُقدَّم لاحقاً (دفاع إضافي فقط،
--     الحارس الحقيقي هو is_active أعلاه).
--   • api_key_prefix = 'legacy__' — يميّز هذه الصفوف بصرياً في قائمة
--     الأجهزة (صفحة الإعدادات) كـ"بيانات قديمة تحتاج تسجيل جهاز حقيقي".
--
-- شغّل هذه الهجرة أولاً، تحقق يدوياً من النتائج (الاستعلام أسفل الملف)،
-- ثم انشر تغييرات الكود (create/page.tsx، settings/page.tsx،
-- app/api/projects/[projectId]/route.ts) التي تتوقف عن قراءة/كتابة
-- monitoring_station_count/monitoring_station_locations. ملف حذف الأعمدة
-- القديمة (supabase-drop-monitoring-station-columns-migration.sql) منفصل
-- ومؤجَّل عمداً — لا يُشغَّل إلا بعد التحقق الكامل من هذه الخطوة.
-- =====================================================================

-- مطلوب لِـ gen_random_uuid() وdigest() أدناه — مفعَّل أصلاً في
-- supabase-dcr-full-schema.sql، لكن هذا الملف قد يُشغَّل مستقلاً.
create extension if not exists pgcrypto;

insert into public.project_devices (
  project_id, name, lat, lng,
  api_key_hash, api_key_prefix,
  is_active, created_at, revoked_at
)
select
  p.id,
  coalesce(nullif(trim(station->>'label'), ''), 'محطة مستوردة (بيانات قديمة)'),
  (station->>'lat')::numeric,
  (station->>'lng')::numeric,
  encode(digest('legacy-backfill:' || gen_random_uuid()::text, 'sha256'), 'hex'),
  'legacy__',
  false,
  now(),
  now()
from public.projects p,
     jsonb_array_elements(p.monitoring_station_locations) as station
where jsonb_typeof(p.monitoring_station_locations) = 'array'
  and jsonb_array_length(p.monitoring_station_locations) > 0
  and station->>'lat' is not null
  and station->>'lng' is not null;

-- تحقق يدوي بعد التنفيذ:
--   select project_id, count(*) from public.project_devices
--   where api_key_prefix = 'legacy__' group by project_id;
