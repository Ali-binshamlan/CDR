// Backfill لمرة واحدة: يقرأ provider_connections.credentials (JSONB القديم —
// مشفَّر حقلاً حقلاً enc:v1: أو نص صريح من قبل تفعيل أي تشفير)، ويكتب
// credentials_ciphertext (enc:v2:، JSON كامل + AAD) + credentials_key_version
// + credentials_migrated_at لكل صف. راجع app/lib/credentialsEncryption.ts
// للتفاصيل الكاملة عن سبب الترقية (القسم 15.2 من "دليل الإصلاح الجذري
// لمنظومة مرقاب").
//
// آمن لإعادة التشغيل: صف يملك credentials_ciphertext مسبقاً يُتخطّى (لا
// إعادة تشفير). لا يحذف العمود القديم credentials — ذاك يتم في migration
// cutover منفصل بعد التأكد الكامل من نجاح الترحيل (تقرير صفر سجل Plaintext
// + فك تشفير عينة تجريبية آمن، القسم 15.2 بند 5).
//
// يتطلب NEXT_PUBLIC_SUPABASE_URL، SUPABASE_SERVICE_ROLE_KEY،
// وPROVIDER_CREDENTIALS_ENCRYPTION_KEY (نفس القيمة المستخدَمة فعلياً بالتطبيق
// للتشفير v1 القديم — تُستخدَم هنا فقط لفك تشفير v1 القديم قبل إعادة
// التشفير بصيغة v2).
//
// الاستخدام:
//   node -r dotenv/config scripts/migrate-provider-credentials-v2.mjs dotenv_config_path=.env.local
//   node -r dotenv/config scripts/migrate-provider-credentials-v2.mjs dotenv_config_path=.env.local -- --dry-run

import { createClient } from '@supabase/supabase-js';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const encryptionSecret = process.env.PROVIDER_CREDENTIALS_ENCRYPTION_KEY;
const dryRun = process.argv.includes('--dry-run');

if (!supabaseUrl || !serviceRoleKey) {
  console.error('يتطلب NEXT_PUBLIC_SUPABASE_URL وSUPABASE_SERVICE_ROLE_KEY في البيئة.');
  process.exit(1);
}
if (!encryptionSecret) {
  console.error('يتطلب PROVIDER_CREDENTIALS_ENCRYPTION_KEY في البيئة (نفس القيمة المستخدَمة بالتطبيق للتشفير v1 القديم).');
  process.exit(1);
}

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH_BYTES = 12;
const AUTH_TAG_LENGTH_BYTES = 16;
const SALT = 'dcr-provider-credentials-v1';
const V1_PREFIX = 'enc:v1:';
const V2_PREFIX = 'enc:v2:';
const CURRENT_KEY_VERSION = 1; // أول تفعيل لـv2 — لا مفاتيح مُدوَّرة بعد

function getKey() {
  return scryptSync(encryptionSecret, SALT, 32);
}

// فك تشفير v1 القديم (حقل حقل، بلا AAD) — لاستخراج القيمة الأصلية فقط قبل
// إعادة التشفير بصيغة v2 الجديدة.
function decryptV1String(stored) {
  const key = getKey();
  const raw = Buffer.from(stored.slice(V1_PREFIX.length), 'base64');
  const iv = raw.subarray(0, IV_LENGTH_BYTES);
  const authTag = raw.subarray(IV_LENGTH_BYTES, IV_LENGTH_BYTES + AUTH_TAG_LENGTH_BYTES);
  const encrypted = raw.subarray(IV_LENGTH_BYTES + AUTH_TAG_LENGTH_BYTES);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

function decryptLegacyCredentials(credentials) {
  const result = {};
  for (const [key, value] of Object.entries(credentials || {})) {
    result[key] = typeof value === 'string' && value.startsWith(V1_PREFIX) ? decryptV1String(value) : value;
  }
  return result;
}

function buildAad(ctx) {
  return Buffer.from(`${ctx.connectionId}:${ctx.projectId}:${ctx.deviceId}:${ctx.provider}`, 'utf8');
}

function encryptCredentialsV2(credentials, ctx) {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(buildAad(ctx));
  const plaintext = Buffer.from(JSON.stringify(credentials), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return V2_PREFIX + Buffer.concat([iv, authTag, encrypted]).toString('base64');
}

// فك تشفير عينة عشوائية بعد الترحيل — يثبت أن AAD والمفتاح صحيحان فعلاً
// قبل الاعتماد على الترحيل كاملاً (القسم 15.2 بند 5: "تجربة فك عينة آمنة").
function decryptV2ForVerification(ciphertext, ctx) {
  const key = getKey();
  const raw = Buffer.from(ciphertext.slice(V2_PREFIX.length), 'base64');
  const iv = raw.subarray(0, IV_LENGTH_BYTES);
  const authTag = raw.subarray(IV_LENGTH_BYTES, IV_LENGTH_BYTES + AUTH_TAG_LENGTH_BYTES);
  const encrypted = raw.subarray(IV_LENGTH_BYTES + AUTH_TAG_LENGTH_BYTES);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAAD(buildAad(ctx));
  decipher.setAuthTag(authTag);
  return JSON.parse(Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8'));
}

const supabase = createClient(supabaseUrl, serviceRoleKey);

(async () => {
  const { data: rows, error } = await supabase
    .from('provider_connections')
    .select('id, project_id, device_id, provider, credentials, credentials_ciphertext');
  if (error) {
    console.error('فشل جلب provider_connections:', error.message);
    process.exit(1);
  }

  let migrated = 0;
  let skipped = 0;
  let failed = 0;
  let plaintextRowsFound = 0;
  const migratedIds = [];

  for (const row of rows || []) {
    if (row.credentials_ciphertext) {
      skipped++;
      continue;
    }

    const ctx = { connectionId: row.id, projectId: row.project_id, deviceId: row.device_id, provider: row.provider };

    let legacy;
    try {
      legacy = decryptLegacyCredentials(row.credentials || {});
    } catch (err) {
      console.error(`فشل فك تشفير v1 للصف ${row.id}:`, err.message);
      failed++;
      continue;
    }

    const hadPlaintext = Object.values(row.credentials || {}).some(
      (v) => typeof v === 'string' && !v.startsWith(V1_PREFIX)
    );
    if (hadPlaintext) plaintextRowsFound++;

    const ciphertext = encryptCredentialsV2(legacy, ctx);

    if (dryRun) {
      migrated++;
      continue;
    }

    const { error: updateError } = await supabase
      .from('provider_connections')
      .update({
        credentials_ciphertext: ciphertext,
        credentials_key_version: CURRENT_KEY_VERSION,
        credentials_migrated_at: new Date().toISOString(),
      })
      .eq('id', row.id);

    if (updateError) {
      console.error(`فشل تحديث الصف ${row.id}:`, updateError.message);
      failed++;
      continue;
    }
    migrated++;
    migratedIds.push(row.id);
  }

  console.log(
    `${dryRun ? '[dry-run] ' : ''}تم: ${migrated} صف مُرحَّل، ${skipped} صف كان مُرحَّلاً مسبقاً، ${failed} صف فشل.`
  );
  console.log(`صفوف كانت تحمل قيمة نص صريح (غير مشفَّرة v1) قبل الترحيل: ${plaintextRowsFound}.`);

  // تحقق عينة عشوائية بعد الترحيل الفعلي — يثبت أن ما كُتب قابل لفك تشفير
  // صحيح فعلياً، لا مجرد "لم يفشل الاستدعاء".
  if (!dryRun && migratedIds.length > 0) {
    const sampleId = migratedIds[Math.floor(Math.random() * migratedIds.length)];
    const { data: sampleRow, error: sampleError } = await supabase
      .from('provider_connections')
      .select('id, project_id, device_id, provider, credentials_ciphertext')
      .eq('id', sampleId)
      .single();
    if (sampleError || !sampleRow) {
      console.error('تعذّر جلب عينة للتحقق بعد الترحيل.');
      process.exit(1);
    }
    try {
      decryptV2ForVerification(sampleRow.credentials_ciphertext, {
        connectionId: sampleRow.id,
        projectId: sampleRow.project_id,
        deviceId: sampleRow.device_id,
        provider: sampleRow.provider,
      });
      console.log(`تحقق عينة فك التشفير (صف ${sampleId}): نجح.`);
    } catch (err) {
      console.error(`تحقق عينة فك التشفير (صف ${sampleId}) فشل:`, err.message);
      process.exit(1);
    }
  }
})();
