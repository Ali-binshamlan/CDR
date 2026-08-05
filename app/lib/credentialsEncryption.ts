import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import type { ProviderCredentials } from '@/app/lib/providers/types';

// تشفير provider_connections.credentials عند الراحة (خطأ أمني مكتشَف —
// مراجعة كود خبير خارجي: "اسم المستخدم وكلمة المرور محفوظان بصيغة JSONB
// غير مشفرة") — بيانات اعتماد طرف ثالث حقيقية (username/password/api_key
// لمنصات مثل ThingsBoard) كانت تُخزَّن نصاً صريحاً بالكامل في القاعدة، فأي
// وصول لها (تسريب DB، نسخة احتياطية، وصول مباشر بصلاحيات service_role)
// يكشف بيانات اعتماد المستخدم الحقيقية لدى مزوّده الخارجي مباشرة.
//
// AES-256-GCM على مستوى التطبيق (لا يعتمد على تشفير Supabase عند الراحة —
// ذاك يحمي من سرقة القرص فقط، لا من استعلام SQL مباشر بصلاحيات service_role
// أو تسريب pg_dump). المفتاح من PROVIDER_CREDENTIALS_ENCRYPTION_KEY (متغيّر
// بيئة، لا يُخزَّن بالقاعدة أبداً) — بلا هذا المتغيّر، الكتابة/القراءة تفشل
// صراحة بدل الرجوع الصامت لنص صريح.
//
// v2 (القسم 15.2 من "دليل الإصلاح الجذري لمنظومة مرقاب" — يحل محل v1
// الذي كان يشفّر كل حقل نصي على حدة، تاركاً بنية الكائن نفسها (أسماء
// المفاتيح) مكشوفة، وبلا أي ربط بسياق الصف الذي يخزّن فيه):
//   1. يشفّر كائن credentials كاملاً كـJSON واحد (لا حقلاً حقلاً) — بنية
//      الكائن نفسها (أي حقول موجودة) لم تعد ظاهرة من الـciphertext.
//   2. AAD (Additional Authenticated Data) يربط الـciphertext بسياقه:
//      connection_id + project_id + device_id + provider. نسخ Ciphertext
//      كامل من صف لآخر (حتى بنفس القاعدة، بصلاحيات SQL مباشرة) يفشل عند
//      فك التشفير لأن AAD المُدخل حينها يخص الصف الجديد لا الأصلي.
//   3. key_version مخزَّن صراحة لكل صف — يتيح تدوير المفتاح (نافذة زمنية
//      يعمل خلالها المفتاحان القديم والجديد معاً) بلا الاعتماد على محاولة
//      كل المفاتيح المعروفة عشوائياً.
const ENCRYPTION_PREFIX_V2 = 'enc:v2:';
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH_BYTES = 12; // الطول الموصى به لـGCM
const AUTH_TAG_LENGTH_BYTES = 16;
const SALT = 'dcr-provider-credentials-v1'; // ثابت — التنويع الفعلي من IV العشوائي لكل قيمة، لا من الملح

// مفاتيح مرقّمة — القيمة الحالية (للتشفير الجديد) من
// PROVIDER_CREDENTIALS_ENCRYPTION_KEY دائماً بـkey_version=1 ما لم يُعرَّف
// PROVIDER_CREDENTIALS_ENCRYPTION_KEY_V{n} أعلى. أثناء تدوير مفتاح، يُضاف
// متغيّر بيئة جديد (PROVIDER_CREDENTIALS_ENCRYPTION_KEY_V2 مثلاً) بينما
// يبقى القديم موجوداً لفك تشفير الصفوف غير المُرحَّلة بعد — الإصدار الأحدث
// المعرَّف فعلياً هو ما يُستخدَم للتشفير الجديد.
function resolveCurrentKeyVersion(): number {
  let version = 1;
  while (process.env[`PROVIDER_CREDENTIALS_ENCRYPTION_KEY_V${version + 1}`]) version++;
  return version;
}

function getEncryptionKeyForVersion(version: number): Buffer {
  const secret =
    version === 1
      ? process.env.PROVIDER_CREDENTIALS_ENCRYPTION_KEY
      : process.env[`PROVIDER_CREDENTIALS_ENCRYPTION_KEY_V${version}`];
  if (!secret || !secret.trim()) {
    throw new Error(`مفتاح تشفير بيانات اعتماد المزوّدين غير مُعرَّف للإصدار ${version}`);
  }
  return scryptSync(secret, SALT, 32);
}

export interface CredentialsAadContext {
  connectionId: string;
  projectId: string;
  deviceId: string;
  provider: string;
}

function buildAad(ctx: CredentialsAadContext): Buffer {
  return Buffer.from(`${ctx.connectionId}:${ctx.projectId}:${ctx.deviceId}:${ctx.provider}`, 'utf8');
}

// يشفّر كائن credentials كاملاً كوحدة واحدة، مربوطاً بسياق الصف عبر AAD.
// يُخزَّن الناتج في provider_connections.credentials_ciphertext مع
// credentials_key_version = رقم المفتاح المستخدَم.
export function encryptCredentialsV2(
  credentials: ProviderCredentials,
  ctx: CredentialsAadContext
): { ciphertext: string; keyVersion: number } {
  const keyVersion = resolveCurrentKeyVersion();
  const key = getEncryptionKeyForVersion(keyVersion);
  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(buildAad(ctx));
  const plaintext = Buffer.from(JSON.stringify(credentials), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const ciphertext = ENCRYPTION_PREFIX_V2 + Buffer.concat([iv, authTag, encrypted]).toString('base64');
  return { ciphertext, keyVersion };
}

// يفك تشفير credentials_ciphertext — يفشل صراحةً (يرمي) إن كان AAD المُمرَّر
// لا يطابق السياق الأصلي وقت التشفير (صف مختلف، أو أي حقل من الأربعة تغيّر)،
// أو إن كان authTag غير صالح (ciphertext مُعدَّل أو منقول من صف آخر)، أو إن
// كان key_version المطلوب غير معرَّف في البيئة الحالية.
export function decryptCredentialsV2(
  ciphertext: string,
  keyVersion: number,
  ctx: CredentialsAadContext
): ProviderCredentials {
  if (!ciphertext.startsWith(ENCRYPTION_PREFIX_V2)) {
    throw new Error('صيغة credentials_ciphertext غير معروفة — يجب أن تبدأ بـ enc:v2:');
  }
  const key = getEncryptionKeyForVersion(keyVersion);
  const raw = Buffer.from(ciphertext.slice(ENCRYPTION_PREFIX_V2.length), 'base64');
  const iv = raw.subarray(0, IV_LENGTH_BYTES);
  const authTag = raw.subarray(IV_LENGTH_BYTES, IV_LENGTH_BYTES + AUTH_TAG_LENGTH_BYTES);
  const encrypted = raw.subarray(IV_LENGTH_BYTES + AUTH_TAG_LENGTH_BYTES);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAAD(buildAad(ctx));
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  return JSON.parse(decrypted) as ProviderCredentials;
}
