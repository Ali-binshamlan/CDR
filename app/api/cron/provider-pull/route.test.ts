import { describe, it, expect, vi, beforeEach } from 'vitest';

// خطأ مكتشَف ومُصلَح (مراجعة خبير خارجي — التقرير النهائي: "العينة كل
// دقيقتين لا تكفي؛ يمكن النقل كل دقيقتين فقط إذا احتوت الإرسالية على جميع
// عينات الدقيقة بطوابعها المستقلة"): هذا الملف يختبر أن provider-pull
// يستخدم fetchReadingsSince (كل العينات منذ آخر سحب) بدل fetchLatestReading
// (نقطة واحدة فقط) حين يدعمها الـConnector، ويكتب كل قراءة على حدة.

const rpcResponses: Record<string, unknown> = {};
const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
const updateCalls: Array<{ table: string; values: Record<string, unknown> }> = [];

// نموّه supabaseAdmin بمنشئ استعلام سلسلي عام — provider-pull يستدعي
// .from('projects').select(...).in(...) و.from('provider_instances').
// select(...).in(...) (كلاهما استعلامات مسطَّحة بلا joins، راجع تعليق
// "خطأ تشغيلي إضافي مكتشَف ومُصلَح" في route.ts)، بالإضافة لـ
// .from('provider_connections').update(...).eq(...) لتسجيل نتيجة كل سحب.
function makeSelectChain(data: unknown[]) {
  const chain: Record<string, unknown> = {
    in: () => chain,
    then: (resolve: (value: { data: unknown[]; error: null }) => void) => resolve({ data, error: null }),
  };
  return chain;
}

vi.mock('@/app/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      return rpcResponses[fn] ?? { data: null, error: null };
    },
    from: (table: string) => ({
      select: () => makeSelectChain([]),
      update: (values: Record<string, unknown>) => ({
        eq: async () => {
          updateCalls.push({ table, values });
          return { data: null, error: null };
        },
      }),
    }),
  },
}));

vi.mock('@/app/lib/timingSafe', () => ({
  timingSafeStringEqual: (a: string, b: string) => a === b,
}));

vi.mock('@/app/lib/evaluateProject', () => ({
  evaluateProject: vi.fn(async (projectId: string) => ({ success: true, persisted: 1, projectId })),
}));

vi.mock('@/app/lib/credentialsEncryption', () => ({
  decryptCredentialsV2: vi.fn(() => ({ username: 'u', password: 'p' })),
}));

const fetchLatestReadingMock = vi.fn();
const fetchReadingsSinceMock = vi.fn();

vi.mock('@/app/lib/providers/registry', () => ({
  getConnector: vi.fn(() => ({
    id: 'thingsboard',
    requiresProviderInstance: false,
    fetchLatestReading: fetchLatestReadingMock,
    fetchReadingsSince: fetchReadingsSinceMock,
  })),
}));

const writeDeviceReadingMock = vi.fn();
vi.mock('@/app/lib/deviceReadingWriter', () => ({
  writeDeviceReading: (...args: unknown[]) => writeDeviceReadingMock(...args),
}));

const SECRET = 'test-provider-pull-secret';

function makeRequest(): Request {
  return new Request('http://localhost/api/cron/provider-pull', {
    headers: { authorization: `Bearer ${SECRET}` },
  });
}

function connectionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'conn-1',
    device_id: 'device-1',
    project_id: 'project-1',
    provider: 'thingsboard',
    credentials_ciphertext: 'enc:v2:xxx',
    credentials_key_version: 1,
    vendor_station_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    provider_instance_id: null,
    last_pull_at: null,
    ...overrides,
  };
}

describe('GET /api/cron/provider-pull', () => {
  beforeEach(() => {
    process.env.PROVIDER_PULL_CRON_SECRET = SECRET;
    rpcCalls.length = 0;
    updateCalls.length = 0;
    writeDeviceReadingMock.mockReset();
    writeDeviceReadingMock.mockResolvedValue({ success: true });
    fetchLatestReadingMock.mockReset();
    fetchReadingsSinceMock.mockReset();
    delete rpcResponses['list_active_provider_connections'];
  });

  it('يرفض بلا سر مُعرَّف بالخادم', async () => {
    delete process.env.PROVIDER_PULL_CRON_SECRET;
    const { GET } = await import('./route');
    const res = await GET(makeRequest());
    expect(res.status).toBe(503);
  });

  it('يرفض ترويسة Authorization غير مطابقة', async () => {
    const { GET } = await import('./route');
    const res = await GET(new Request('http://localhost', { headers: { authorization: 'Bearer wrong' } }));
    expect(res.status).toBe(401);
  });

  it('Connector يدعم fetchReadingsSince: 3 قراءات مُرجَعة → 3 استدعاءات writeDeviceReading منفصلة، لا استدعاء واحد فقط', async () => {
    rpcResponses['list_active_provider_connections'] = { data: [connectionRow()], error: null };
    fetchReadingsSinceMock.mockResolvedValue([
      { observedAtIso: '2026-01-01T00:00:00.000Z', pm10: 340 },
      { observedAtIso: '2026-01-01T00:00:45.000Z', pm10: 345 },
      { observedAtIso: '2026-01-01T00:01:30.000Z', pm10: 350 },
    ]);

    const { GET } = await import('./route');
    const res = await GET(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(fetchLatestReadingMock).not.toHaveBeenCalled();
    expect(writeDeviceReadingMock).toHaveBeenCalledTimes(3);
  });

  it('Connector لا يدعم fetchReadingsSince (undefined) → يسقط إلى fetchLatestReading (قراءة واحدة فقط، سلوك سابق بلا كسر)', async () => {
    rpcResponses['list_active_provider_connections'] = { data: [connectionRow()], error: null };
    fetchReadingsSinceMock.mockReset();
    // محاكاة Connector بلا الدالة إطلاقاً (مثل mockConnector الحالي) — نعيد
    // تسجيل getConnector بلا fetchReadingsSince لهذا الاختبار تحديداً.
    const { getConnector } = await import('@/app/lib/providers/registry');
    vi.mocked(getConnector).mockReturnValueOnce({
      id: 'thingsboard',
      requiresProviderInstance: false,
      fetchLatestReading: fetchLatestReadingMock,
    } as never);
    fetchLatestReadingMock.mockResolvedValue({ observedAtIso: '2026-01-01T00:00:00.000Z', pm10: 340 });

    const { GET } = await import('./route');
    await GET(makeRequest());

    expect(fetchLatestReadingMock).toHaveBeenCalledTimes(1);
    expect(writeDeviceReadingMock).toHaveBeenCalledTimes(1);
  });

  it('fetchReadingsSince يُرجع مصفوفة فارغة → لا استدعاء writeDeviceReading، last_pull_success=true (لا خطأ، فقط لا شيء جديد)', async () => {
    rpcResponses['list_active_provider_connections'] = { data: [connectionRow()], error: null };
    fetchReadingsSinceMock.mockResolvedValue([]);

    const { GET } = await import('./route');
    await GET(makeRequest());

    expect(writeDeviceReadingMock).not.toHaveBeenCalled();
    const lastUpdate = updateCalls[updateCalls.length - 1];
    expect(lastUpdate.values.last_pull_success).toBe(true);
  });

  it('sinceMs يُحسَب من last_pull_at الفعلي للاتصال (لا وقت ثابت)، مُمرَّراً لـfetchReadingsSince', async () => {
    const lastPullIso = new Date(Date.now() - 3 * 60_000).toISOString(); // قبل 3 دقائق
    rpcResponses['list_active_provider_connections'] = { data: [connectionRow({ last_pull_at: lastPullIso })], error: null };
    fetchReadingsSinceMock.mockResolvedValue([]);

    const { GET } = await import('./route');
    await GET(makeRequest());

    expect(fetchReadingsSinceMock).toHaveBeenCalledTimes(1);
    const sinceMsArg = fetchReadingsSinceMock.mock.calls[0][3] as number;
    // محدود بحد أقصى 10 دقائق نظرياً، لكن last_pull_at (قبل 3 دقائق) أحدث من
    // الحد الأقصى، فيجب استخدامه كما هو تقريباً (فرق بضع مللي ثوانٍ تنفيذ فقط).
    expect(Math.abs(sinceMsArg - new Date(lastPullIso).getTime())).toBeLessThan(5000);
  });

  it('كتابة واحدة تفشل من أصل ثلاث → last_pull_success=false، لكن الكتابات الناجحة لا تُفقَد', async () => {
    rpcResponses['list_active_provider_connections'] = { data: [connectionRow()], error: null };
    fetchReadingsSinceMock.mockResolvedValue([
      { observedAtIso: '2026-01-01T00:00:00.000Z', pm10: 340 },
      { observedAtIso: '2026-01-01T00:00:45.000Z', pm10: 345 },
      { observedAtIso: '2026-01-01T00:01:30.000Z', pm10: 350 },
    ]);
    writeDeviceReadingMock
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false, error: 'boom' })
      .mockResolvedValueOnce({ success: true });

    const { GET } = await import('./route');
    await GET(makeRequest());

    expect(writeDeviceReadingMock).toHaveBeenCalledTimes(3);
    const lastUpdate = updateCalls[updateCalls.length - 1];
    expect(lastUpdate.values.last_pull_success).toBe(false);
    expect(lastUpdate.values.last_pull_error).toBe('boom');
  });
});
