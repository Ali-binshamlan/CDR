-- =====================================================================
-- DCR — 202608040016_provider_credentials_v2_columns.sql
-- =====================================================================
-- المرحلة 1 من ترقية تشفير provider_connections.credentials إلى enc:v2
-- (القسم 15.2 من "دليل الإصلاح الجذري لمنظومة مرقاب") — أعمدة جديدة فقط،
-- بلا NOT NULL بعد (سيُطبَّق بعد الـbackfill في migration منفصل)، وقيد شكل
-- NOT VALID (يُحقَّق لاحقاً بـVALIDATE CONSTRAINT منفصل لتفادي قفل طويل على
-- الجدول كاملاً في نفس الخطوة).
-- =====================================================================

alter table public.provider_connections
  add column credentials_ciphertext text,
  add column credentials_key_version integer,
  add column credentials_migrated_at timestamptz;

alter table public.provider_connections
  add constraint provider_credentials_v2_shape
  check (
    credentials_ciphertext is null or (
      credentials_ciphertext like 'enc:v2:%'
      and credentials_key_version is not null
    )
  ) not valid;
