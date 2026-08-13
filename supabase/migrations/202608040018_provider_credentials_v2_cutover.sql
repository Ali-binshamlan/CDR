-- =====================================================================
-- DCR — 202608040018_provider_credentials_v2_cutover.sql
-- =====================================================================
-- المرحلة 3 (الأخيرة) من ترقية تشفير provider_connections.credentials —
-- القسم 15.2 بند 6: "احذف عمود JSONB القديم وأزل Fallback الذي يقبل
-- Plaintext نهائياً". لا تُطبَّق هذه المرحلة إلا بعد:
--   1. تشغيل scripts/migrate-provider-credentials-v2.mjs بنجاح كامل (صفر
--      صف فشل، تقرير "صفوف كانت تحمل نص صريح" مراجَع).
--   2. تطبيق 202608040017_provider_credentials_v2_validate.sql (القيد
--      NOT VALID السابق صار validated).
--   3. نشر إصدار من التطبيق يقرأ/يكتب credentials_ciphertext حصراً (لا
--      fallback للعمود القديم credentials) — راجع app/lib/
--      credentialsEncryption.ts وapp/api/projects/[projectId]/devices/
--      [deviceId]/provider-connection/route.ts وapp/api/cron/
--      provider-pull/route.ts.
-- تطبيقها قبل ذلك يفقد أي صف لم يُرحَّل بعد بلا رجعة.
-- =====================================================================

alter table public.provider_connections
  alter column credentials_ciphertext set not null,
  alter column credentials_key_version set not null;

alter table public.provider_connections
  drop column credentials;
