import { describe, it, expect, vi, beforeEach } from 'vitest';

// خطأ مكتشَف ومُصلَح (مراجعة كود خارجي — "مؤشر السحب يتقدم حتى عند فشل
// Queue"): هذا الملف يختبر السلوك الفعلي الحالي لـprovider-pull/route.ts
// بعد إعادة تصميم مسار الاستقبال (2026-08-09 — الملف السابق كان يختبر بنية
// قديمة تستدعي writeDeviceReading/evaluateProject مباشرة، وهما غير
// مستوردين إطلاقاً في route.ts الحالي؛ كل الاختبارات القديمة كانت فاشلة
// فعلياً قبل هذا التصحيح) وبعد فصل last_pull_at (وقت آخر محاولة، يتقدم
// دائماً) عن pull_cursor_at (مؤشر السحب الفعلي المستخدَم في sinceMs، يتقدم
// فقط عند نجاح إدراج الدفعة كاملة في telemetry_ingestion_queue).

const rpcResponses: Record<string, unknown> = {};
const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
const updateCalls: Array<{ table: string; values: Record<string, unknown> }> = [];
let runLockShouldFail = false;
let queueInsertError: { message: string } | null = null;
let queueInsertedIds: { id: string }[] = [];

// نموّه supabaseAdmin بمنشئ استعلام سلسلي عام — provider-pull يستدعي
// .from('projects').select(...).in(...) و.from('provider_instances').
// select(...).in(...) (كلاهما استعلامات مسطَّحة بلا joins)، .from(
// 'provider_connections').update(...).eq(...) لتسجيل نتيجة كل سحب، و
// .from('telemetry_ingestion_queue').upsert(...).select(...) للإدراج
// الدفعي الفعلي (المسار الوحيد للكتابة الفعلية بعد إعادة التصميم).
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
      insert: async () =>
        runLockShouldFail
          ? { data: null, error: { message: 'duplicate key value violates unique constraint', code: '23505' } }
          : { data: null, error: null },
      upsert: () => ({
        select: async () =>
          queueInsertError ? { data: null, error: queueInsertError } : { data: queueInsertedIds, error: null },
      }),
    }),
  },
}));

vi.mock('@/app/lib/timingSafe', () => ({
  timingSafeStringEqual: (a: string, b: string) => a === b,
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
    pull_cursor_at: null,
    ...overrides,
  };
}

function findConnectionUpdate(index = 0): Record<string, unknown> {
  const calls = updateCalls.filter((c) => c.table === 'provider_connections');
  return calls[index]?.values ?? {};
}

describe('GET /api/cron/provider-pull', () => {
  beforeEach(() => {
    process.env.PROVIDER_PULL_CRON_SECRET = SECRET;
    rpcCalls.length = 0;
    updateCalls.length = 0;
    fetchLatestReadingMock.mockReset();
    fetchReadingsSinceMock.mockReset();
    delete rpcResponses['list_active_provider_connections'];
    runLockShouldFail = false;
    queueInsertError = null;
    queueInsertedIds = [];
  });

  it('دورة سابقة لا تزال قيد التنفيذ (قفل النافذة الزمنية يفشل) → يتخطى فوراً بلا أي عمل، 200', async () => {
    runLockShouldFail = true;
    rpcResponses['list_active_provider_connections'] = { data: [connectionRow()], error: null };

    const { GET } = await import('./route');
    const res = await GET(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.skipped).toBe(true);
    expect(rpcCalls.length).toBe(0);
    expect(fetchReadingsSinceMock).not.toHaveBeenCalled();
    expect(fetchLatestReadingMock).not.toHaveBeenCalled();
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

  it('Connector يدعم fetchReadingsSince: 3 قراءات مُرجَعة → صف واحد لكل قراءة في دفعة الإدراج', async () => {
    rpcResponses['list_active_provider_connections'] = { data: [connectionRow()], error: null };
    fetchReadingsSinceMock.mockResolvedValue([
      { observedAtIso: '2026-01-01T00:00:00.000Z', pm10: 340 },
      { observedAtIso: '2026-01-01T00:00:45.000Z', pm10: 345 },
      { observedAtIso: '2026-01-01T00:01:30.000Z', pm10: 350 },
    ]);
    queueInsertedIds = [{ id: 'q1' }, { id: 'q2' }, { id: 'q3' }];

    const { GET } = await import('./route');
    const res = await GET(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(fetchLatestReadingMock).not.toHaveBeenCalled();
    expect(body.results[0].queued).toBe(3);
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
    queueInsertedIds = [{ id: 'q1' }];

    const { GET } = await import('./route');
    const res = await GET(makeRequest());
    const body = await res.json();

    expect(fetchLatestReadingMock).toHaveBeenCalledTimes(1);
    expect(body.results[0].queued).toBe(1);
  });

  it('fetchReadingsSince يُرجع مصفوفة فارغة → last_pull_success=true، pull_cursor_at وlast_pull_at يتقدمان معاً', async () => {
    rpcResponses['list_active_provider_connections'] = { data: [connectionRow()], error: null };
    fetchReadingsSinceMock.mockResolvedValue([]);

    const { GET } = await import('./route');
    await GET(makeRequest());

    const lastUpdate = findConnectionUpdate();
    expect(lastUpdate.last_pull_success).toBe(true);
    expect(lastUpdate.pull_cursor_at).toBeTruthy();
    expect(lastUpdate.last_pull_at).toBeTruthy();
  });

  it('sinceMs يُحسَب من pull_cursor_at الفعلي للاتصال (لا last_pull_at)، مُمرَّراً لـfetchReadingsSince مع هامش تداخل صغير', async () => {
    const cursorIso = new Date(Date.now() - 3 * 60_000).toISOString(); // قبل 3 دقائق
    // last_pull_at أقدم بكثير (محاولة سابقة فاشلة لم تُقدِّم المؤشر) —
    // يجب ألا يؤثر على sinceMs إطلاقاً، فقط pull_cursor_at.
    const staleLastPullAt = new Date(Date.now() - 30 * 60_000).toISOString();
    rpcResponses['list_active_provider_connections'] = {
      data: [connectionRow({ pull_cursor_at: cursorIso, last_pull_at: staleLastPullAt })],
      error: null,
    };
    fetchReadingsSinceMock.mockResolvedValue([]);

    const { GET } = await import('./route');
    await GET(makeRequest());

    expect(fetchReadingsSinceMock).toHaveBeenCalledTimes(1);
    const sinceMsArg = fetchReadingsSinceMock.mock.calls[0][3] as number;
    // هامش تداخل 5 ثوانٍ للخلف عن pull_cursor_at نفسه — الفرق المتوقَّع هو
    // هذا الهامش تحديداً (± وقت تنفيذ ضئيل)، لا صفر.
    const expectedSinceMs = new Date(cursorIso).getTime() - 5_000;
    expect(Math.abs(sinceMsArg - expectedSinceMs)).toBeLessThan(2000);
  });

  it('لا pull_cursor_at ولا last_pull_at إطلاقاً (اتصال جديد) → sinceMs يعتمد حد النظر للخلف الأقصى (10 دقائق)', async () => {
    rpcResponses['list_active_provider_connections'] = { data: [connectionRow()], error: null };
    fetchReadingsSinceMock.mockResolvedValue([]);

    const { GET } = await import('./route');
    await GET(makeRequest());

    const sinceMsArg = fetchReadingsSinceMock.mock.calls[0][3] as number;
    const expectedSinceMs = Date.now() - 10 * 60_000;
    expect(Math.abs(sinceMsArg - expectedSinceMs)).toBeLessThan(2000);
  });

  // اختبارا قبول صريحان (طلب المستخدم — تقرير المراجعة الخارجي: "مؤشر
  // السحب يتقدم حتى عند فشل Queue"): فشل إدراج الدفعة أو استثناء غير
  // متوقَّع يجب ألا يُقدِّم pull_cursor_at إطلاقاً — الدورة التالية تُعيد
  // نفس النافذة الزمنية بالضبط بدل تخطّيها. last_pull_at (وقت المحاولة)
  // يبقى يتقدم في كلتا الحالتين (صحيح لغرضه: كشف توقّف الدورة بالكامل في
  // scheduler-heartbeat).
  describe('فشل الإدراج/استثناء لا يُقدِّم pull_cursor_at (اختبار قبول صريح)', () => {
    it('فشل إدراج دفعة القراءات في telemetry_ingestion_queue → last_pull_success=false، pull_cursor_at لا يُقدَّم إطلاقاً', async () => {
      rpcResponses['list_active_provider_connections'] = { data: [connectionRow()], error: null };
      fetchReadingsSinceMock.mockResolvedValue([{ observedAtIso: '2026-01-01T00:00:00.000Z', pm10: 340 }]);
      queueInsertError = { message: 'connection pool exhausted' };

      const { GET } = await import('./route');
      await GET(makeRequest());

      const lastUpdate = findConnectionUpdate();
      expect(lastUpdate.last_pull_success).toBe(false);
      expect(lastUpdate.last_pull_error).toBe('connection pool exhausted');
      // pull_cursor_at/last_pull_success_at غائبان تماماً عن حمولة التحديث
      // (لا مجرد null) — أي مفتاح موجود صراحةً كان سيُطبَّق فوق القيمة
      // القديمة في قاعدة بيانات حقيقية؛ الغياب الكامل هو الضمانة الصحيحة.
      expect('pull_cursor_at' in lastUpdate).toBe(false);
      expect('last_pull_success_at' in lastUpdate).toBe(false);
      // last_pull_at (وقت المحاولة) يبقى يتقدم — صحيح لغرضه المستقل.
      expect(lastUpdate.last_pull_at).toBeTruthy();
    });

    it('استثناء غير متوقَّع أثناء fetchReadingsSince → pull_cursor_at لا يُقدَّم إطلاقاً', async () => {
      rpcResponses['list_active_provider_connections'] = { data: [connectionRow()], error: null };
      fetchReadingsSinceMock.mockRejectedValue(new Error('network timeout'));

      const { GET } = await import('./route');
      await GET(makeRequest());

      const lastUpdate = findConnectionUpdate();
      expect(lastUpdate.last_pull_success).toBe(false);
      expect('pull_cursor_at' in lastUpdate).toBe(false);
      expect(lastUpdate.last_pull_at).toBeTruthy();
    });

    it('عطّل Queue ثم أعِدها: دورة فاشلة لا تُقدِّم المؤشر، الدورة التالية تعيد طلب نفس النافذة وتستلم كل القراءات (لا فقد)', async () => {
      rpcResponses['list_active_provider_connections'] = { data: [connectionRow()], error: null };
      const readings = [
        { observedAtIso: '2026-01-01T00:00:00.000Z', pm10: 340 },
        { observedAtIso: '2026-01-01T00:00:45.000Z', pm10: 345 },
      ];

      // الدورة 1: Queue "معطَّلة" — فشل إدراج الدفعة بالكامل.
      fetchReadingsSinceMock.mockResolvedValueOnce(readings);
      queueInsertError = { message: 'queue unavailable' };
      const { GET } = await import('./route');
      await GET(makeRequest());

      const cycle1Update = findConnectionUpdate();
      expect(cycle1Update.last_pull_success).toBe(false);
      expect('pull_cursor_at' in cycle1Update).toBe(false);

      // الدورة 2: Queue "أُعيدت" — نفس pull_cursor_at (null، لم يتغيّر)
      // يُمرَّر لهذه الدورة (محاكاة قراءة صف provider_connections غير
      // مُعدَّل بين الدورتين)، ونفس القراءتين تُرجَعان من المزوّد (لم
      // تُستهلَكا فعلياً من مصدرهما الحقيقي بعد).
      updateCalls.length = 0;
      queueInsertError = null;
      queueInsertedIds = [{ id: 'q1' }, { id: 'q2' }];
      fetchReadingsSinceMock.mockResolvedValueOnce(readings);
      await GET(makeRequest());

      const cycle2Update = findConnectionUpdate();
      expect(cycle2Update.last_pull_success).toBe(true);
      expect(cycle2Update.pull_cursor_at).toBeTruthy();
      // كلتا القراءتين وصلتا فعلياً في الدورة الثانية — لا فقد، بصرف النظر
      // عن فشل الدورة الأولى بالكامل.
      expect(fetchReadingsSinceMock).toHaveBeenCalledTimes(2);
    });
  });

  it('10 اتصالات (أكثر من دفعة توازي واحدة، CONCURRENCY=8) → كلها تُعالَج رغم فشل واحد منها في المنتصف', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => connectionRow({ id: `conn-${i}`, project_id: `project-${i}` }));
    rpcResponses['list_active_provider_connections'] = { data: rows, error: null };
    // الاستدعاء الرابع (ترتيب وصول، لا بالضرورة conn-3 بسبب التوازي) يفشل
    // بخطأ مرمي (لا مرفوض فقط) — يجب ألا يوقف بقية الدفعة أو الدفعات التالية.
    let callIndex = 0;
    queueInsertedIds = [{ id: 'q1' }];
    fetchReadingsSinceMock.mockImplementation(async () => {
      const current = callIndex++;
      if (current === 3) throw new Error('محطة معطوبة');
      return [{ observedAtIso: '2026-01-01T00:00:00.000Z', pm10: 100 }];
    });

    const { GET } = await import('./route');
    const res = await GET(makeRequest());
    const body = await res.json();

    expect(fetchReadingsSinceMock).toHaveBeenCalledTimes(10);
    expect(body.total).toBe(10);
    expect(body.failed).toBe(1);
    expect(body.results.filter((r: { ok: boolean }) => r.ok)).toHaveLength(9);
  });
});
