-- =====================================================================
-- هجرة مؤجَّلة: حذف عمودي projects.monitoring_station_count و
-- monitoring_station_locations نهائياً — استُبدلا بالكامل بصفوف
-- project_devices الحقيقية.
--
-- ⚠ لا تُشغِّل هذا الملف إلا بعد استيفاء الشرطين التاليين معاً:
--   1) تشغيل supabase-backfill-monitoring-stations-to-devices-migration.sql
--      والتحقق يدوياً من نتائجه (عدد الصفوف المُرحَّلة يطابق التوقع).
--   2) نشر تغييرات الكود التي تتوقف عن قراءة/كتابة هذين العمودين
--      (create/page.tsx، settings/page.tsx،
--      app/api/projects/[projectId]/route.ts) ومرور دورة نشر كاملة بلا
--      أخطاء متعلقة بهما.
--
-- هذا الفصل المتعمد بين الترحيل والحذف (ملفان منفصلان لا يُدمَجان أبداً)
-- يبقي نافذة أمان للتراجع — دمجهما في عملية واحدة يزيل أي فرصة استرجاع لو
-- ظهرت مشكلة في منطق الترحيل بعد فوات الأوان.
-- =====================================================================

alter table public.projects drop column if exists monitoring_station_count;
alter table public.projects drop column if exists monitoring_station_locations;
