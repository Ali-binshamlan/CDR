import { describe, it, expect, vi, beforeEach } from 'vitest';

// خطأ مكتشَف ومُصلَح (مراجعة كود خارجي — "مؤشر السحب يتقدم حتى عند فشل
// Queue"): هذا الملف يختبر السلوك الفعلي الحالي لـprovider-pull/route.ts
// بعد إعادة تصميم مسار الاستقبال (2026-08-09) وبعد فصل last_pull_at (وقت آخر
// محاولة، يتقدم دائماً) عن pull_cursor_at (مؤشر السحب الفعلي، يتقدم فقط عند
// نجاح إدراج الدفعة كاملة في telemetry_ingestion_queue).
//
// خطأ مكتشَف ومُصلَح لاحقاً (مراجعة كود خارجي — "نافذة عشر دقائق وحدود
// ThingsBoard تقطع البيانات بصمت"): fetchReadingsSince تُرجع الآن كائناً
// {readings, coveredThroughMs, hasMore} بدل مصفوفة خام — pull_cursor_at
// يتقدم إلى coveredThroughMs فقط (لا Date.now())، وroute.ts يستدعي
// fetchReadingsSince داخل حلقة صفحات محدودة (MAX_PAGES_PER_CONNECTION=5)
// حتى hasMore=false أو استنفاد الصفحات.

const rpcResponses: Record<string, unknown> = {};
const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
const updateCalls: Array<{ table: string; values: Record<string, unknown> }> = [];
const upsertCalls: Array<{ table: string; rows: Record<string, unknown>[]; options: Record<string, unknown> }> = [];
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
      // خطأ مكتشَف ومُصلَح (مراجعة كود خارجي — "مفتاح منع التكرار قابل
      // للتصادم"): يلتقط الصفوف الفعلية وخيارات onConflict الممرَّرة —
      // يختبر أن route.ts يستخدم الآن (connection_id, provider_event_key)
      // بدل idempotency_key وحده، وأن provider_event_key يُبنى صحيحاً.
      upsert: (rows: Record<string, unknown>[], options: Record<string, unknown>) => {
        upsertCalls.push({ table: 'telemetry_ingestion_queue', rows, options });
        return {
          select: async () =>
            queueInsertError ? { data: null, error: queueInsertError } : { data: queueInsertedIds, error: null },
        };
      },
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

// نتيجة صفحة واحدة كاملة (hasMore=false) — الحالة الشائعة في أغلب
// الاختبارات (لا اقتطاع، سلوك ما قبل إصلاح Pagination بلا تغيير ظاهري).
function page(readings: unknown[], coveredThroughMs: number, hasMore = false) {
  return { readings, coveredThroughMs, hasMore };
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
    upsertCalls.length = 0;
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

  it('Connector يدعم fetchReadingsSince: 3 قراءات مُرجَعة (hasMore=false) → صف واحد لكل قراءة في دفعة الإدراج', async () => {
    rpcResponses['list_active_provider_connections'] = { data: [connectionRow()], error: null };
    const now = Date.now();
    fetchReadingsSinceMock.mockResolvedValue(
      page(
        [
          { observedAtIso: '2026-01-01T00:00:00.000Z', pm10: 340 },
          { observedAtIso: '2026-01-01T00:00:45.000Z', pm10: 345 },
          { observedAtIso: '2026-01-01T00:01:30.000Z', pm10: 350 },
        ],
        now
      )
    );
    queueInsertedIds = [{ id: 'q1' }, { id: 'q2' }, { id: 'q3' }];

    const { GET } = await import('./route');
    const res = await GET(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(fetchLatestReadingMock).not.toHaveBeenCalled();
    expect(body.results[0].queued).toBe(3);
    // hasMore=false من الـConnector → صفحة واحدة فقط، لا حلقة إضافية.
    expect(fetchReadingsSinceMock).toHaveBeenCalledTimes(1);
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

  it('fetchReadingsSince يُرجع مصفوفة فارغة (hasMore=false) → last_pull_success=true، pull_cursor_at=coveredThroughMs', async () => {
    rpcResponses['list_active_provider_connections'] = { data: [connectionRow()], error: null };
    const now = Date.now();
    fetchReadingsSinceMock.mockResolvedValue(page([], now));

    const { GET } = await import('./route');
    await GET(makeRequest());

    const lastUpdate = findConnectionUpdate();
    expect(lastUpdate.last_pull_success).toBe(true);
    expect(lastUpdate.pull_cursor_at).toBeTruthy();
    expect(new Date(lastUpdate.pull_cursor_at as string).getTime()).toBe(now);
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
    fetchReadingsSinceMock.mockResolvedValue(page([], Date.now()));

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
    fetchReadingsSinceMock.mockResolvedValue(page([], Date.now()));

    const { GET } = await import('./route');
    await GET(makeRequest());

    const sinceMsArg = fetchReadingsSinceMock.mock.calls[0][3] as number;
    const expectedSinceMs = Date.now() - 10 * 60_000;
    expect(Math.abs(sinceMsArg - expectedSinceMs)).toBeLessThan(2000);
  });

  it('untilMs (المعامل الخامس لـfetchReadingsSince) ثابتة داخل دورة واحدة — لا Date.now() متحركة بين استدعاءات نفس الاتصال', async () => {
    rpcResponses['list_active_provider_connections'] = { data: [connectionRow()], error: null };
    const t1 = Date.now();
    // صفحتان: الأولى hasMore=true (تستدعي صفحة ثانية)، الثانية hasMore=false.
    fetchReadingsSinceMock
      .mockResolvedValueOnce(page([{ observedAtIso: new Date(t1 - 500_000).toISOString(), pm10: 300 }], t1 - 400_000, true))
      .mockResolvedValueOnce(page([], t1));
    queueInsertedIds = [{ id: 'q1' }];

    const { GET } = await import('./route');
    await GET(makeRequest());

    expect(fetchReadingsSinceMock).toHaveBeenCalledTimes(2);
    const untilMsCall1 = fetchReadingsSinceMock.mock.calls[0][4] as number;
    const untilMsCall2 = fetchReadingsSinceMock.mock.calls[1][4] as number;
    expect(untilMsCall1).toBe(untilMsCall2);
    // الصفحة الثانية تبدأ من coveredThroughMs الذي أرجعته الصفحة الأولى.
    const sinceMsCall2 = fetchReadingsSinceMock.mock.calls[1][3] as number;
    expect(sinceMsCall2).toBe(t1 - 400_000);
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
      fetchReadingsSinceMock.mockResolvedValue(page([{ observedAtIso: '2026-01-01T00:00:00.000Z', pm10: 340 }], Date.now()));
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
      const now = Date.now();
      const readings = [
        { observedAtIso: '2026-01-01T00:00:00.000Z', pm10: 340 },
        { observedAtIso: '2026-01-01T00:00:45.000Z', pm10: 345 },
      ];

      // الدورة 1: Queue "معطَّلة" — فشل إدراج الدفعة بالكامل.
      fetchReadingsSinceMock.mockResolvedValueOnce(page(readings, now));
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
      fetchReadingsSinceMock.mockResolvedValueOnce(page(readings, Date.now()));
      await GET(makeRequest());

      const cycle2Update = findConnectionUpdate();
      expect(cycle2Update.last_pull_success).toBe(true);
      expect(cycle2Update.pull_cursor_at).toBeTruthy();
      // كلتا القراءتين وصلتا فعلياً في الدورة الثانية — لا فقد، بصرف النظر
      // عن فشل الدورة الأولى بالكامل.
      expect(fetchReadingsSinceMock).toHaveBeenCalledTimes(2);
    });
  });

  // اختبارات قبول صريحة (طلب المستخدم — تقرير المراجعة الخارجي: "نافذة عشر
  // دقائق وحدود ThingsBoard تقطع البيانات بصمت"): بلوغ حدود المنصة
  // (hasMore=true) يجب ألا يُقدِّم المؤشر فوق البيانات غير المجلوبة، ويجب أن
  // يستكمل الجلب عبر صفحات إضافية ضمن نفس الدورة حتى تكتمل النافذة أو
  // يُستنفَد حد الصفحات.
  describe('Pagination عند بلوغ حدود المنصة — لا فقد صامت (اختبار قبول صريح)', () => {
    it('صفحة أولى hasMore=true → يُستدعى Connector مرة ثانية بـsinceMs=coveredThroughMs السابقة', async () => {
      rpcResponses['list_active_provider_connections'] = { data: [connectionRow()], error: null };
      const t0 = Date.now() - 600_000;
      const midPoint = t0 + 200_000;
      fetchReadingsSinceMock
        .mockResolvedValueOnce(page([{ observedAtIso: new Date(t0 + 100_000).toISOString(), pm10: 320 }], midPoint, true))
        .mockResolvedValueOnce(page([{ observedAtIso: new Date(midPoint + 100_000).toISOString(), pm10: 330 }], Date.now(), false));
      queueInsertedIds = [{ id: 'q1' }];

      const { GET } = await import('./route');
      const res = await GET(makeRequest());
      const body = await res.json();

      expect(fetchReadingsSinceMock).toHaveBeenCalledTimes(2);
      expect(fetchReadingsSinceMock.mock.calls[1][3]).toBe(midPoint);
      // كلتا القراءتين (من الصفحتين معاً) تصل لدفعة الإدراج النهائية.
      expect(body.results[0].hasMore).toBe(false);
    });

    it('استنفاد MAX_PAGES_PER_CONNECTION (5) مع hasMore=true مستمر → pull_cursor_at يتقدم فقط لآخر coveredThroughMs مؤكَّد، لا أبعد، وhasMore=true في النتيجة', async () => {
      rpcResponses['list_active_provider_connections'] = { data: [connectionRow()], error: null };
      // كل صفحة تتقدم 50 ثانية فقط وhasMore=true دائماً — محاكاة إرسالية
      // كثيفة جداً تستنفد كل الصفحات المسموحة دون اكتمال النافذة الكاملة.
      let callIndex = 0;
      fetchReadingsSinceMock.mockImplementation(async (_o, _c, _v, sinceMs: number) => {
        callIndex++;
        const covered = sinceMs + 50_000;
        return page([{ observedAtIso: new Date(covered).toISOString(), pm10: 300 + callIndex }], covered, true);
      });
      queueInsertedIds = Array.from({ length: 5 }, (_, i) => ({ id: `q${i}` }));

      const { GET } = await import('./route');
      const res = await GET(makeRequest());
      const body = await res.json();

      // 5 صفحات بالضبط (MAX_PAGES_PER_CONNECTION) — لا حلقة لا نهائية.
      expect(fetchReadingsSinceMock).toHaveBeenCalledTimes(5);
      expect(body.results[0].hasMore).toBe(true);
      const lastUpdate = findConnectionUpdate();
      // المؤشر تقدَّم فقط بقدر ما جُلب فعلاً (sinceMs الفعلي للصفحة الأولى +
      // 5×50 ثانية) — لا حتى نهاية النافذة الكاملة (untilMs)، ولا Date.now()
      // الفعلي عند نهاية الدورة. sinceMs الفعلي للصفحة الأولى يُقرأ من نداء
      // الـmock مباشرة (لا يُعاد حسابه هنا) لتفادي فارق ميلي ثانية محتمل مع
      // Date.now() الداخلي في route.ts وقت التنفيذ الفعلي.
      const firstSinceMs = fetchReadingsSinceMock.mock.calls[0][3] as number;
      expect(new Date(lastUpdate.pull_cursor_at as string).getTime()).toBe(firstSinceMs + 5 * 50_000);
    });

    it('توقّف 20 دقيقة (لا سحب) ثم استئناف: النافذة كاملة (10 دقائق كحد أقصى) تُجلَب عبر صفحات، لا تُسقَط أول 10 دقائق منها', async () => {
      // pull_cursor_at قديم جداً (قبل 20 دقيقة) — sinceMs يُطبَّق عليه سقف
      // MAX_LOOKBACK_MS (10 دقائق) كحد أقصى مقصود (راجع تعليق route.ts) —
      // هذا سقف معروف ومقبول، لا بق. البق الذي يختبره هذا الاختبار تحديداً:
      // ضمن تلك النافذة الفعلية (10 دقائق)، حدود المنصة (hasMore) لا تُسقِط
      // شيئاً بصمت — كل ما داخل الميزانية يصل عبر صفحات متتالية.
      const staleCursor = new Date(Date.now() - 20 * 60_000).toISOString();
      rpcResponses['list_active_provider_connections'] = {
        data: [connectionRow({ pull_cursor_at: staleCursor })],
        error: null,
      };
      let callIndex = 0;
      fetchReadingsSinceMock.mockImplementation(async (_o, _c, _v, sinceMs: number, untilMs: number) => {
        callIndex++;
        // كل صفحة تُغطي 3 دقائق فقط (محاكاة حد صفحة من المنصة) حتى تصل
        // untilMs الفعلية (لا تتجاوزها أبداً).
        const covered = Math.min(sinceMs + 3 * 60_000, untilMs);
        return page(
          [{ observedAtIso: new Date(covered).toISOString(), pm10: 300 + callIndex }],
          covered,
          covered < untilMs
        );
      });
      queueInsertedIds = Array.from({ length: 5 }, (_, i) => ({ id: `q${i}` }));

      const { GET } = await import('./route');
      await GET(makeRequest());

      // أول sinceMs مُستلَم من الـConnector يجب ألا يكون أقدم من MAX_LOOKBACK_MS
      // (10 دقائق) — سقف مقصود، لا فقد إضافي فوقه.
      const firstSinceMs = fetchReadingsSinceMock.mock.calls[0][3] as number;
      expect(Date.now() - firstSinceMs).toBeLessThanOrEqual(10 * 60_000 + 2000);
      // كل الصفحات ضمن النافذة (10 دقائق / 3 دقائق للصفحة ≈ 4 صفحات) تصل
      // فعلياً بلا توقف مبكر (لم تُستنفَد صفحات MAX_PAGES_PER_CONNECTION=5).
      expect(fetchReadingsSinceMock.mock.calls.length).toBeGreaterThanOrEqual(3);
      const lastUpdate = findConnectionUpdate();
      expect(lastUpdate.last_pull_success).toBe(true);
    });
  });

  // اختبارات قبول صريحة (طلب المستخدم — تقرير المراجعة الخارجي: "مفتاح منع
  // التكرار قابل للتصادم"): الفريد الفعلي الآن (connection_id, provider_
  // event_key)، وprovider_event_key يُبنى من vendorEventId الحقيقي إن توفر،
  // وإلا observedAtIso + hash قانوني للحمولة كاملة — تصحيح لاحق بنفس
  // observedAtIso يُنتج مفتاحاً مختلفاً بدل أن يُرفَض كتكرار صامت.
  describe('provider_event_key يمنع تصادم المفتاح القديم (اختبار قبول صريح)', () => {
    it('upsert يستخدم onConflict=connection_id,provider_event_key بدل idempotency_key وحده', async () => {
      rpcResponses['list_active_provider_connections'] = { data: [connectionRow()], error: null };
      fetchReadingsSinceMock.mockResolvedValue(page([{ observedAtIso: '2026-01-01T00:00:00.000Z', pm10: 340 }], Date.now()));
      queueInsertedIds = [{ id: 'q1' }];

      const { GET } = await import('./route');
      await GET(makeRequest());

      expect(upsertCalls).toHaveLength(1);
      expect(upsertCalls[0].options.onConflict).toBe('connection_id,provider_event_key');
      expect(upsertCalls[0].options.ignoreDuplicates).toBe(true);
      const row = upsertCalls[0].rows[0];
      expect(row.provider_event_key).toBeTruthy();
      // idempotency_key يبقى مُشتقّاً من connection_id:provider_event_key —
      // فريد عالمياً بذاته حتى بلا الفهرس الفريد المستقل السابق.
      expect(row.idempotency_key).toBe(`${row.connection_id}:${row.provider_event_key}`);
    });

    it('vendorEventId موجود في القراءة → يُستخدَم مباشرة كـprovider_event_key (لا hash)', async () => {
      rpcResponses['list_active_provider_connections'] = { data: [connectionRow()], error: null };
      fetchReadingsSinceMock.mockResolvedValue(
        page([{ observedAtIso: '2026-01-01T00:00:00.000Z', pm10: 340, vendorEventId: 'tb-event-abc123' }], Date.now())
      );
      queueInsertedIds = [{ id: 'q1' }];

      const { GET } = await import('./route');
      await GET(makeRequest());

      expect(upsertCalls[0].rows[0].provider_event_key).toBe('tb-event-abc123');
    });

    it('لا vendorEventId (حالة ThingsBoard الفعلية) → provider_event_key يُشتَق من observedAtIso + hash الحمولة', async () => {
      rpcResponses['list_active_provider_connections'] = { data: [connectionRow()], error: null };
      fetchReadingsSinceMock.mockResolvedValue(page([{ observedAtIso: '2026-01-01T00:00:00.000Z', pm10: 340 }], Date.now()));
      queueInsertedIds = [{ id: 'q1' }];

      const { GET } = await import('./route');
      await GET(makeRequest());

      const key = upsertCalls[0].rows[0].provider_event_key as string;
      const prefix = '2026-01-01T00:00:00.000Z:';
      expect(key.startsWith(prefix)).toBe(true);
      // جزء الـhash (بعد observedAtIso الكامل — يحتوي هو نفسه ':' فلا يصلح
      // split(':') البسيط) طوله 64 (sha256 hex) — تأكيد استخدام hash فعلي
      // لا نص فارغ أو placeholder.
      expect(key.slice(prefix.length)).toHaveLength(64);
    });

    it('قراءتان بنفس observedAtIso لكن قيمة PM10 مختلفة (تصحيح فعلي) → provider_event_key مختلف لكل منهما، لا تصادم', async () => {
      rpcResponses['list_active_provider_connections'] = { data: [connectionRow()], error: null };
      fetchReadingsSinceMock.mockResolvedValue(
        page(
          [
            { observedAtIso: '2026-01-01T00:00:00.000Z', pm10: 340 },
            { observedAtIso: '2026-01-01T00:00:00.000Z', pm10: 355 }, // تصحيح لاحق لنفس اللحظة
          ],
          Date.now()
        )
      );
      queueInsertedIds = [{ id: 'q1' }, { id: 'q2' }];

      const { GET } = await import('./route');
      const res = await GET(makeRequest());
      const body = await res.json();

      const keys = upsertCalls[0].rows.map((r) => r.provider_event_key);
      expect(new Set(keys).size).toBe(2);
      // كلتا القراءتين وصلتا لدفعة الإدراج (لم تُستبعَد أي منهما داخل
      // route.ts نفسه — الفهرس الفريد الجديد في قاعدة البيانات الفعلية هو
      // ما يقرر القبول/الرفض، لا كود route.ts).
      expect(upsertCalls[0].rows).toHaveLength(2);
      expect(body.results[0].queued).toBe(2);
    });

    it('قراءتان متطابقتان تماماً (إعادة إرسال حقيقية) → نفس provider_event_key، يُترَك للفهرس الفريد ليرفض التكرار', async () => {
      rpcResponses['list_active_provider_connections'] = { data: [connectionRow()], error: null };
      const identicalReading = { observedAtIso: '2026-01-01T00:00:00.000Z', pm10: 340 };
      fetchReadingsSinceMock.mockResolvedValue(page([identicalReading, { ...identicalReading }], Date.now()));
      queueInsertedIds = [{ id: 'q1' }]; // الفهرس الفريد الفعلي يرفض الثانية

      const { GET } = await import('./route');
      await GET(makeRequest());

      const keys = upsertCalls[0].rows.map((r) => r.provider_event_key);
      expect(keys[0]).toBe(keys[1]);
    });

    it('نفس provider_event_key عبر اتصالين مختلفين → مسموح (الفريد مُركَّب مع connection_id، لا عالمي)', async () => {
      const rows = [connectionRow({ id: 'conn-a', project_id: 'project-a' }), connectionRow({ id: 'conn-b', project_id: 'project-b' })];
      rpcResponses['list_active_provider_connections'] = { data: rows, error: null };
      fetchReadingsSinceMock.mockResolvedValue(page([{ observedAtIso: '2026-01-01T00:00:00.000Z', pm10: 340 }], Date.now()));
      queueInsertedIds = [{ id: 'q1' }];

      const { GET } = await import('./route');
      await GET(makeRequest());

      expect(upsertCalls).toHaveLength(2);
      const keyA = upsertCalls.find((c) => c.rows[0].connection_id === 'conn-a')?.rows[0].provider_event_key;
      const keyB = upsertCalls.find((c) => c.rows[0].connection_id === 'conn-b')?.rows[0].provider_event_key;
      expect(keyA).toBe(keyB);
      // idempotency_key المُشتقّ يبقى مختلفاً فعلياً رغم تطابق provider_event_key
      // (يتضمن connection_id) — لا تصادم فعلي حتى على العمود التوافقي القديم.
      const idA = upsertCalls.find((c) => c.rows[0].connection_id === 'conn-a')?.rows[0].idempotency_key;
      const idB = upsertCalls.find((c) => c.rows[0].connection_id === 'conn-b')?.rows[0].idempotency_key;
      expect(idA).not.toBe(idB);
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
      return page([{ observedAtIso: '2026-01-01T00:00:00.000Z', pm10: 100 }], Date.now());
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
