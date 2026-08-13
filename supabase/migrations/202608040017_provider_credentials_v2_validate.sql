-- =====================================================================
-- DCR — 202608040017_provider_credentials_v2_validate.sql
-- =====================================================================
-- المرحلة 2 من ترقية تشفير provider_connections.credentials إلى enc:v2 —
-- تحقيق قيد الشكل المُضاف بالمرحلة 1 (NOT VALID سابقاً) بعد تشغيل سكربت
-- الـbackfill (scripts/migrate-provider-credentials-v2.mjs) وتأكد كل صف
-- قديم صار يحمل credentials_ciphertext صالحاً. migration منفصل عمداً (لا
-- بنفس ملف إضافة الأعمدة) — القسم 16 من التقرير: "استخدم NOT VALID ثم
-- VALIDATE CONSTRAINT عند الحاجة لتقليل القفل".
-- =====================================================================

alter table public.provider_connections
  validate constraint provider_credentials_v2_shape;
