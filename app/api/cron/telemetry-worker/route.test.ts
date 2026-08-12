import { describe, it, expect, vi, beforeEach } from 'vitest';

// خطأ مكتشَف ومُصلَح (مراجعة كود خارجي — "ملكية Lease غير آمنة في
// العمال"): أول ملف اختبار لـtelemetry-worker/route.ts (لم يكن موجوداً
// قبل هذا التصحيح). يغطي مسار claim_telemetry_queue/renew_telemetry_queue_
// lease/writeDeviceReading/complete_telemetry_queue_row/fail_telemetry_queue_
// row — راجع تعليق route.ts الكامل: renew قبل كل صف، fail_telemetry_queue_
// row يشترط الآن worker_id ويُرجع boolean، وفشل complete بعد نجاح الكتابة
// الفعلية لا يستدعي fail بعد الآن.
let claimedRows: Array<Record<string, unknown>> = [];
const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
let renewResult: { data: boolean | null; error: { message: string } | null } = { data: true, error: null };
let completeResult: { data: boolean | null; error: { message: string } | null } = { data: true, error: null };
let failResult: { data: boolean | null; error: { message: string } | null } = { data: true, error: null };
let insertError: { message: string } | null = null;

vi.mock('@/app/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      if (fn === 'claim_telemetry_queue') return { data: claimedRows, error: null };
      if (fn === 'renew_telemetry_queue_lease') return renewResult;
      if (fn === 'complete_telemetry_queue_row') return completeResult;
      if (fn === 'fail_telemetry_queue_row') return failResult;
      return { data: null, error: null };
    },
    from: (table: string) => ({
      insert: async (values: Record<string, unknown>) => {
        // خطأ مكتشَف ومُصلَح (مراجعة كود خارجي — "التقييم بحسب وقت المعالجة
        // قد يفوّت مخالفة كاملة"): args تُلتقَط الآن فعلياً (كانت args: {}
        // ثابتة سابقاً) — لازمة للتحقق من dedupe_key/evaluation_at الفعليين
        // المُرسَلين لكل مهمة تقييم.
        rpcCalls.push({ fn: `insert:${table}`, args: values });
        return { data: null, error: insertError };
      },
    }),
  },
}));

vi.mock('@/app/lib/timingSafe', () => ({
  timingSafeStringEqual: (a: string, b: string) => a === b,
}));

const writeDeviceReadingMock = vi.fn();
vi.mock('@/app/lib/deviceReadingWriter', () => ({
  writeDeviceReading: (...args: unknown[]) => writeDeviceReadingMock(...args),
}));

const SECRET = 'test-telemetry-worker-secret';

function makeRequest(): Request {
  return new Request('http://localhost/api/cron/telemetry-worker', {
    headers: { authorization: `Bearer ${SECRET}` },
  });
}

function baseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'row-1',
    idempotency_key: 'thingsboard:conn-1:evt-1',
    project_id: 'project-1',
    device_id: 'device-1',
    payload: { observedAtIso: '2026-01-01T00:00:00.000Z', pm10: 340 },
    ...overrides,
  };
}

describe('GET /api/cron/telemetry-worker', () => {
  beforeEach(() => {
    process.env.TELEMETRY_WORKER_CRON_SECRET = SECRET;
    claimedRows = [];
    rpcCalls.length = 0;
    renewResult = { data: true, error: null };
    completeResult = { data: true, error: null };
    failResult = { data: true, error: null };
    insertError = null;
    writeDeviceReadingMock.mockReset();
    writeDeviceReadingMock.mockResolvedValue({ success: true });
  });

  it('يرفض بلا سر مُعرَّف بالخادم', async () => {
    delete process.env.TELEMETRY_WORKER_CRON_SECRET;
    const { GET } = await import('./route');
    const res = await GET(makeRequest());
    expect(res.status).toBe(503);
  });

  it('يرفض ترويسة Authorization غير مطابقة', async () => {
    const { GET } = await import('./route');
    const res = await GET(new Request('http://localhost', { headers: { authorization: 'Bearer wrong' } }));
    expect(res.status).toBe(401);
  });

  it('كتابة ناجحة → complete_telemetry_queue_row يُستدعى، النتيجة ok=true', async () => {
    claimedRows = [baseRow()];
    const { GET } = await import('./route');
    const res = await GET(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.results[0]).toEqual({ rowId: 'row-1', projectId: 'project-1', ok: true });
    expect(rpcCalls.some((c) => c.fn === 'complete_telemetry_queue_row')).toBe(true);
  });

  it('writeDeviceReading يرجع success=false → fail_telemetry_queue_row يُستدعى بـp_worker_id', async () => {
    writeDeviceReadingMock.mockResolvedValue({ success: false, error: 'قيمة غير صالحة' });
    claimedRows = [baseRow()];
    const { GET } = await import('./route');
    const res = await GET(makeRequest());
    const body = await res.json();

    expect(body.ok).toBe(false);
    const failCall = rpcCalls.find((c) => c.fn === 'fail_telemetry_queue_row');
    expect(failCall).toBeDefined();
    expect(failCall!.args.p_worker_id).toBe(body.workerId);
    expect(failCall!.args.p_row_id).toBe('row-1');
    expect(rpcCalls.some((c) => c.fn === 'complete_telemetry_queue_row')).toBe(false);
  });

  it('writeDeviceReading يرمي استثناء → يُعامَل كفشل، fail_telemetry_queue_row يُستدعى', async () => {
    writeDeviceReadingMock.mockRejectedValue(new Error('انقطاع شبكة'));
    claimedRows = [baseRow()];
    const { GET } = await import('./route');
    const res = await GET(makeRequest());
    const body = await res.json();

    expect(body.ok).toBe(false);
    expect(body.results[0].error).toContain('انقطاع شبكة');
    expect(rpcCalls.some((c) => c.fn === 'fail_telemetry_queue_row')).toBe(true);
  });

  it('نجاح → مشروع الصف يدخل affectedProjects ويُنشئ project_evaluation_jobs (Evaluation Coalescing)', async () => {
    claimedRows = [baseRow()];
    const { GET } = await import('./route');
    const res = await GET(makeRequest());
    const body = await res.json();

    expect(body.affectedProjects).toBe(1);
    expect(rpcCalls.some((c) => c.fn === 'insert:project_evaluation_jobs')).toBe(true);
  });

  // اختبارات قبول صريحة (طلب المستخدم — تقرير المراجعة الخارجي: "التقييم
  // بحسب وقت المعالجة قد يفوّت مخالفة كاملة"): مهمة التقييم يجب أن تُبنى
  // لكل (مشروع، دقيقة رصد فعلية) لا دقيقة معالجة الدفعة، مع evaluation_at
  // يحمل نهاية دقيقة الرصد تلك تحديداً.
  describe('evaluation_at ودقيقة الرصد لا دقيقة المعالجة (اختبار قبول صريح)', () => {
    it('مهمة واحدة → dedupe_key وevaluation_at مبنيان من observedAtIso القراءة، لا Date.now() وقت تشغيل العامل', async () => {
      const observedAtIso = '2026-01-01T12:03:30.000Z'; // منتصف الدقيقة 12:03
      claimedRows = [baseRow({ payload: { observedAtIso, pm10: 340 } })];
      const { GET } = await import('./route');
      await GET(makeRequest());

      const insertCall = rpcCalls.find((c) => c.fn === 'insert:project_evaluation_jobs');
      expect(insertCall).toBeDefined();
      const observedMinuteBucket = Math.floor(new Date(observedAtIso).getTime() / 60_000);
      expect(insertCall!.args.dedupe_key).toBe(`ingest:${observedMinuteBucket}`);
      // evaluation_at = نهاية دقيقة 12:03 بالضبط (12:03:59.999)، لا وقت
      // معالجة الدفعة الفعلي (Date.now() قد يكون بعد ذلك بدقائق).
      expect(insertCall!.args.evaluation_at).toBe('2026-01-01T12:03:59.999Z');
    });

    it('دفعة تحوي قراءات من دقيقتَي رصد مختلفتين لنفس المشروع (سيناريو التقرير: 350←355←360 عند 12:03، ثم 100 عند 12:05) → مهمتا تقييم منفصلتان، لا مهمة واحدة', async () => {
      claimedRows = [
        baseRow({ id: 'row-1', payload: { observedAtIso: '2026-01-01T12:03:00.000Z', pm10: 350 } }),
        baseRow({ id: 'row-2', payload: { observedAtIso: '2026-01-01T12:03:30.000Z', pm10: 355 } }),
        baseRow({ id: 'row-3', payload: { observedAtIso: '2026-01-01T12:03:45.000Z', pm10: 360 } }),
        baseRow({ id: 'row-4', payload: { observedAtIso: '2026-01-01T12:05:10.000Z', pm10: 100 } }),
      ];
      const { GET } = await import('./route');
      const res = await GET(makeRequest());
      const body = await res.json();

      const insertCalls = rpcCalls.filter((c) => c.fn === 'insert:project_evaluation_jobs');
      expect(insertCalls).toHaveLength(2);
      const dedupeKeys = insertCalls.map((c) => c.args.dedupe_key).sort();
      const minute03 = Math.floor(new Date('2026-01-01T12:03:00.000Z').getTime() / 60_000);
      const minute05 = Math.floor(new Date('2026-01-01T12:05:00.000Z').getTime() / 60_000);
      expect(dedupeKeys).toEqual([`ingest:${minute03}`, `ingest:${minute05}`].sort());
      // مهمة دقيقة 12:03 تحمل evaluation_at نهاية تلك الدقيقة — إعادة
      // التقييم عندها لاحقاً تُعيد بناء الحالة وقت الذروة (350-355-360)،
      // لا وقت القراءة الآمنة (100) اللاحقة في دقيقة أخرى تماماً.
      const minute03Call = insertCalls.find((c) => c.args.dedupe_key === `ingest:${minute03}`);
      expect(minute03Call!.args.evaluation_at).toBe('2026-01-01T12:03:59.999Z');
      expect(body.affectedProjects).toBe(1); // مشروع واحد فقط (project-1)، لكن دقيقتا رصد
      expect(body.evaluationJobsEnqueued).toBe(1); // مشروع واحد "أُدرِجت له مهمة" (بصرف النظر عن عددها)
    });

    it('دفعة بمشروعين مختلفين، كل منهما بدقيقة رصد واحدة فقط → مهمة واحدة لكل مشروع (لا تغيير عن السلوك السابق لهذه الحالة)', async () => {
      claimedRows = [
        baseRow({ id: 'row-1', project_id: 'project-A', payload: { observedAtIso: '2026-01-01T12:03:00.000Z', pm10: 340 } }),
        baseRow({ id: 'row-2', project_id: 'project-B', payload: { observedAtIso: '2026-01-01T12:03:00.000Z', pm10: 340 } }),
      ];
      const { GET } = await import('./route');
      const res = await GET(makeRequest());
      const body = await res.json();

      const insertCalls = rpcCalls.filter((c) => c.fn === 'insert:project_evaluation_jobs');
      expect(insertCalls).toHaveLength(2);
      expect(body.affectedProjects).toBe(2);
    });
  });

  // اختبارات قبول صريحة (طلب المستخدم — تقرير المراجعة الخارجي: "ملكية
  // Lease غير آمنة في العمال").
  describe('renew_telemetry_queue_lease قبل كل صف (اختبار قبول صريح)', () => {
    it('renew ناجح → يُستدعى بـp_worker_id/p_lease_seconds قبل writeDeviceReading', async () => {
      claimedRows = [baseRow()];
      const { GET } = await import('./route');
      await GET(makeRequest());

      const renewCall = rpcCalls.find((c) => c.fn === 'renew_telemetry_queue_lease');
      expect(renewCall).toBeDefined();
      expect(renewCall!.args.p_row_id).toBe('row-1');
      expect(renewCall!.args.p_lease_seconds).toBe(60);
      expect(writeDeviceReadingMock).toHaveBeenCalledTimes(1);
    });

    it('renew يرجع false (عامل آخر استرجع الصف) → لا استدعاء writeDeviceReading إطلاقاً، لا complete/fail', async () => {
      renewResult = { data: false, error: null };
      claimedRows = [baseRow()];
      const { GET } = await import('./route');
      const res = await GET(makeRequest());
      const body = await res.json();

      expect(body.results[0].ok).toBe(false);
      expect(writeDeviceReadingMock).not.toHaveBeenCalled();
      expect(rpcCalls.some((c) => c.fn === 'complete_telemetry_queue_row')).toBe(false);
      expect(rpcCalls.some((c) => c.fn === 'fail_telemetry_queue_row')).toBe(false);
    });
  });

  // اختبار قبول صريح: complete_telemetry_queue_row=false بعد كتابة ناجحة
  // فعلياً يجب ألا يستدعي fail (القراءة كُتبت بالفعل في device_readings_
  // history — استدعاء fail كان سيُعيد صفاً بات مسؤولية عامل آخر إلى RETRY
  // زوراً رغم نجاح الكتابة).
  it('complete_telemetry_queue_row يرجع false (بعد كتابة ناجحة فعلياً) → فشل في النتيجة، لكن fail_telemetry_queue_row لا يُستدعى إطلاقاً', async () => {
    completeResult = { data: false, error: null };
    claimedRows = [baseRow()];
    const { GET } = await import('./route');
    const res = await GET(makeRequest());
    const body = await res.json();

    expect(body.results[0].ok).toBe(false);
    expect(rpcCalls.some((c) => c.fn === 'fail_telemetry_queue_row')).toBe(false);
    // نجاح الكتابة الفعلية يعني عدم إضافة المشروع لـaffectedProjects غير
    // مضمون هنا (complete فشل)، لكن الأهم: لا محاولة "تصحيح" عبر fail.
  });

  it('لا صفوف مُطالَب بها → ok=true بلا أي استدعاء آخر', async () => {
    claimedRows = [];
    const { GET } = await import('./route');
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.claimed).toBe(0);
  });
});
