import { describe, it, expect, afterEach } from 'vitest';
import { getConnector, listAvailableProviders } from './registry';

// process.env.NODE_ENV نوعه readonly في تعريفات Node القياسية — vi.stubEnv
// هو الطريق الموصى به من Vitest للتعديل المؤقت الآمن نوعياً داخل الاختبارات
// (بدل (process.env as any).NODE_ENV = ... المباشر).
import { vi } from 'vitest';

describe('registry — حجب mockConnector في الإنتاج', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('يمنع getConnector("mock") في بيئة الإنتاج', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(getConnector('mock')).toBeNull();
  });

  it('يسمح بـgetConnector("mock") خارج بيئة الإنتاج', () => {
    vi.stubEnv('NODE_ENV', 'test');
    expect(getConnector('mock')).not.toBeNull();
    expect(getConnector('mock')?.id).toBe('mock');
  });

  it('لا يؤثر على thingsboard في أي بيئة', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(getConnector('thingsboard')).not.toBeNull();
    vi.stubEnv('NODE_ENV', 'test');
    expect(getConnector('thingsboard')).not.toBeNull();
  });

  it('يستبعد mock من listAvailableProviders في الإنتاج', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const ids = listAvailableProviders().map((p) => p.id);
    expect(ids).not.toContain('mock');
    expect(ids).toContain('thingsboard');
  });

  it('يُدرج mock ضمن listAvailableProviders خارج الإنتاج', () => {
    vi.stubEnv('NODE_ENV', 'test');
    const ids = listAvailableProviders().map((p) => p.id);
    expect(ids).toContain('mock');
  });
});
