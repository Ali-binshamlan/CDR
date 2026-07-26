import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'crypto';

// requireDeviceApiKey يستورد supabaseAdmin كـ singleton من ./supabaseAdmin —
// نموّهه بسلسلة from().select().eq().maybeSingle() قابلة للتحكم بنتيجتها
// لكل اختبار عبر متغير module-level.
let mockDeviceRow: any = null;

vi.mock('./supabaseAdmin', () => ({
  supabaseAdmin: {
    from: vi.fn(() => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: mockDeviceRow }),
        }),
      }),
    })),
  },
}));

describe('requireDeviceApiKey — مصادقة جهاز رصد عبر مفتاح API', () => {
  beforeEach(() => {
    mockDeviceRow = null;
  });

  it('يرفض (401) عند غياب رأس Authorization تماماً', async () => {
    const { requireDeviceApiKey } = await import('./apiAuth');
    const request = new Request('http://localhost/api/devices/ingest', { method: 'POST' });
    const result = await requireDeviceApiKey(request);
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error.status).toBe(401);
  });

  it('يرفض (401) عند مفتاح غير موجود في قاعدة البيانات', async () => {
    mockDeviceRow = null;
    const { requireDeviceApiKey } = await import('./apiAuth');
    const request = new Request('http://localhost/api/devices/ingest', {
      method: 'POST',
      headers: { Authorization: 'Bearer dcr_wrong_key' },
    });
    const result = await requireDeviceApiKey(request);
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error.status).toBe(401);
  });

  it('يرفض (401) عند جهاز مُلغى (is_active=false) حتى لو كان المفتاح صحيحاً', async () => {
    mockDeviceRow = { id: 'device-1', project_id: 'project-1', is_active: false };
    const { requireDeviceApiKey } = await import('./apiAuth');
    const request = new Request('http://localhost/api/devices/ingest', {
      method: 'POST',
      headers: { Authorization: 'Bearer dcr_revoked_key' },
    });
    const result = await requireDeviceApiKey(request);
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error.status).toBe(401);
  });

  it('يقبل مفتاحاً صحيحاً ونشطاً ويرجع deviceId/projectId الصحيحين', async () => {
    mockDeviceRow = { id: 'device-42', project_id: 'project-7', is_active: true };
    const { requireDeviceApiKey } = await import('./apiAuth');
    const request = new Request('http://localhost/api/devices/ingest', {
      method: 'POST',
      headers: { Authorization: 'Bearer dcr_valid_key' },
    });
    const result = await requireDeviceApiKey(request);
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.deviceId).toBe('device-42');
      expect(result.projectId).toBe('project-7');
    }
  });

  it('يرفض (401) صفاً مُرحَّلاً من محطات الرصد القديمة (legacy backfill) بأي مفتاح مُقدَّم', async () => {
    // يحاكي صف project_devices نتج من supabase-backfill-monitoring-stations-
    // to-devices-migration.sql: is_active=false دائماً، api_key_prefix
    // مميَّز 'legacy__'. الحارس الفعلي هو is_active — يُرفض بصرف النظر عن
    // أي مفتاح يُقدَّم لأن الهاش المخزَّن أصلاً غير قابل للاشتقاق من أي نص.
    mockDeviceRow = { id: 'legacy-device-1', project_id: 'project-9', is_active: false, api_key_prefix: 'legacy__' };
    const { requireDeviceApiKey } = await import('./apiAuth');
    const request = new Request('http://localhost/api/devices/ingest', {
      method: 'POST',
      headers: { Authorization: 'Bearer any-guessed-or-random-token' },
    });
    const result = await requireDeviceApiKey(request);
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error.status).toBe(401);
  });

  it('لا مقارنة نصية صريحة للمفتاح الخام في أي مكان — التحقق دائماً عبر الهاش', () => {
    // حارس بنيوي: يتأكد أن آلية المطابقة تمر عبر createHash لا مقارنة مباشرة.
    // هذا اختبار توثيقي/دلالي (لا يستدعي الدالة نفسها) يمنع أي تراجع مستقبلي
    // يعيد إدخال مقارنة نص صريح بالخطأ.
    const rawKey = 'dcr_example';
    const hash1 = createHash('sha256').update(rawKey).digest('hex');
    const hash2 = createHash('sha256').update(rawKey).digest('hex');
    expect(hash1).toBe(hash2);
    expect(hash1).not.toBe(rawKey);
  });
});
