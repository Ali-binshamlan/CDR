import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { encryptCredentialsV2, decryptCredentialsV2 } from './credentialsEncryption';

describe('credentialsEncryption (v2)', () => {
  const ORIGINAL_KEY = process.env.PROVIDER_CREDENTIALS_ENCRYPTION_KEY;
  const ORIGINAL_KEY_V2 = process.env.PROVIDER_CREDENTIALS_ENCRYPTION_KEY_V2;

  const ctx = {
    connectionId: 'conn-1',
    projectId: 'project-1',
    deviceId: 'device-1',
    provider: 'thingsboard',
  };

  beforeEach(() => {
    process.env.PROVIDER_CREDENTIALS_ENCRYPTION_KEY = 'test-secret-key-not-for-production-use';
    delete process.env.PROVIDER_CREDENTIALS_ENCRYPTION_KEY_V2;
  });

  afterEach(() => {
    process.env.PROVIDER_CREDENTIALS_ENCRYPTION_KEY = ORIGINAL_KEY;
    process.env.PROVIDER_CREDENTIALS_ENCRYPTION_KEY_V2 = ORIGINAL_KEY_V2;
  });

  it('يشفّر الكائن كاملاً ثم يفك تشفيره بنفس المحتوى الأصلي', () => {
    const original = { username: 'ops@example.com', password: 'hunter2' };
    const { ciphertext, keyVersion } = encryptCredentialsV2(original, ctx);
    expect(ciphertext.startsWith('enc:v2:')).toBe(true);
    expect(keyVersion).toBe(1);

    const decrypted = decryptCredentialsV2(ciphertext, keyVersion, ctx);
    expect(decrypted).toEqual(original);
  });

  it('لا يُخزِّن القيمة الأصلية كنص صريح ضمن الـciphertext', () => {
    const { ciphertext } = encryptCredentialsV2({ password: 'hunter2' }, ctx);
    expect(ciphertext).not.toContain('hunter2');
    expect(ciphertext).not.toContain('password');
  });

  it('ينتج تشفيراً مختلفاً في كل مرة لنفس القيمة (IV عشوائي)', () => {
    const a = encryptCredentialsV2({ password: 'hunter2' }, ctx);
    const b = encryptCredentialsV2({ password: 'hunter2' }, ctx);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(decryptCredentialsV2(a.ciphertext, a.keyVersion, ctx).password).toBe('hunter2');
    expect(decryptCredentialsV2(b.ciphertext, b.keyVersion, ctx).password).toBe('hunter2');
  });

  it('يفشل فك التشفير عند AAD مختلف (نسخ ciphertext لصف آخر)', () => {
    const { ciphertext, keyVersion } = encryptCredentialsV2({ password: 'hunter2' }, ctx);
    const otherRowCtx = { ...ctx, connectionId: 'conn-2' };
    expect(() => decryptCredentialsV2(ciphertext, keyVersion, otherRowCtx)).toThrow();
  });

  it('يفشل فك التشفير عند تعديل الـciphertext (auth tag غير صالح)', () => {
    const { ciphertext, keyVersion } = encryptCredentialsV2({ password: 'hunter2' }, ctx);
    const tampered = ciphertext.slice(0, -4) + 'AAAA';
    expect(() => decryptCredentialsV2(tampered, keyVersion, ctx)).toThrow();
  });

  it('يدعم تدوير المفتاح: يفك تشفير صف قديم بالمفتاح v1 حتى بعد إضافة مفتاح v2', () => {
    const { ciphertext, keyVersion } = encryptCredentialsV2({ password: 'hunter2' }, ctx);
    expect(keyVersion).toBe(1);

    process.env.PROVIDER_CREDENTIALS_ENCRYPTION_KEY_V2 = 'rotated-secret-key-not-for-production';
    const rotated = encryptCredentialsV2({ password: 'new-password' }, ctx);
    expect(rotated.keyVersion).toBe(2);

    // الصف القديم (key_version=1) يبقى قابلاً لفك التشفير أثناء نافذة التدوير.
    expect(decryptCredentialsV2(ciphertext, keyVersion, ctx).password).toBe('hunter2');
    expect(decryptCredentialsV2(rotated.ciphertext, rotated.keyVersion, ctx).password).toBe('new-password');
  });

  // القسم 18.7 من "دليل الإصلاح الجذري لمنظومة مرقاب" — "Rotation: يعمل
  // الإصداران المصرح بهما، ثم يفشل المفتاح القديم بعد الإلغاء". الاختبار
  // أعلاه (61) يثبت أن الإصدارين يعملان معاً *أثناء* نافذة التدوير؛ هذا
  // يثبت الخطوة الثانية: إزالة PROVIDER_CREDENTIALS_ENCRYPTION_KEY (v1)
  // تماماً من البيئة (إلغاء فعلي، لا مجرد إضافة v2 بجانبه) يجعل فك تشفير
  // أي صف v1 قديم يفشل صراحة، لا يسقط بصمت لمفتاح آخر.
  it('بعد إلغاء المفتاح القديم (v1) من البيئة تماماً → فك تشفير صف v1 قديم يفشل صراحة، بينما v2 يبقى يعمل', () => {
    const { ciphertext: oldCiphertext, keyVersion: oldKeyVersion } = encryptCredentialsV2({ password: 'hunter2' }, ctx);
    expect(oldKeyVersion).toBe(1);

    process.env.PROVIDER_CREDENTIALS_ENCRYPTION_KEY_V2 = 'rotated-secret-key-not-for-production';
    const { ciphertext: newCiphertext, keyVersion: newKeyVersion } = encryptCredentialsV2({ password: 'new-password' }, ctx);
    expect(newKeyVersion).toBe(2);

    // إلغاء المفتاح القديم فعلياً — لا مجرد تدوير، بل حذفه من البيئة تماماً.
    delete process.env.PROVIDER_CREDENTIALS_ENCRYPTION_KEY;

    expect(() => decryptCredentialsV2(oldCiphertext, oldKeyVersion, ctx)).toThrow();
    expect(decryptCredentialsV2(newCiphertext, newKeyVersion, ctx).password).toBe('new-password');
  });

  it('يرمي خطأً واضحاً عند غياب مفتاح التشفير', () => {
    delete process.env.PROVIDER_CREDENTIALS_ENCRYPTION_KEY;
    expect(() => encryptCredentialsV2({ password: 'x' }, ctx)).toThrow();
  });

  it('يتعامل مع كائن credentials فارغ بلا أخطاء', () => {
    const { ciphertext, keyVersion } = encryptCredentialsV2({}, ctx);
    expect(decryptCredentialsV2(ciphertext, keyVersion, ctx)).toEqual({});
  });

  it('يرفض ciphertext بصيغة غير enc:v2', () => {
    expect(() => decryptCredentialsV2('enc:v1:abc', 1, ctx)).toThrow();
  });
});
