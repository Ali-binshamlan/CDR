-- =====================================================================
-- DCR — 202608020006_add_missing_received_at_columns.sql
-- =====================================================================
-- خطأ مكتشَف عند أول تشغيل فعلي لـingest_device_reading_atomic (راجع
-- 202608020004_atomic_device_ingest.sql): الدالة تكتب received_at إلى
-- device_readings_history وpm10_readings_history (نفس تمييز observedAt/
-- receivedAt المقصود — راجع تعليق الدالة)، لكن 202608020004 أضافت
-- last_received_at على project_devices فقط ونسيت إضافة العمود المقابل
-- received_at على الجدولين التاريخيين أنفسهما — فشل فعلي عند أول استدعاء:
-- "column received_at of relation device_readings_history does not exist".
-- =====================================================================

alter table public.device_readings_history
  add column if not exists received_at timestamptz;

alter table public.pm10_readings_history
  add column if not exists received_at timestamptz;
