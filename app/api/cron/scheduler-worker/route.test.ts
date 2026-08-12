import { describe, it, expect, vi, beforeEach } from 'vitest';

// خطأ مكتشَف ومُصلَح (مراجعة كود خارجي — "ملكية Lease غير آمنة في
// العمال"): أول ملف اختبار لـscheduler-worker/route.ts (لم يكن موجوداً
// قبل هذا التصحيح). يغطي مسار claim_evaluation_jobs/renew_evaluation_job_
// lease/evaluateProject/complete_evaluation_job/fail_evaluation_job — راجع
// تعليق route.ts الكامل: renew قبل كل مهمة، fail_evaluation_job يشترط الآن
// worker_id ويُرجع boolean، وفشل complete بعد نجاح التقييم الفعلي لا
// يستدعي fail بعد الآن.
let claimedJobs: Array<Record<string, unknown>> = [];
const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
let renewResult: { data: boolean | null; error: { message: string } | null } = { data: true, error: null };
let completeResult: { data: boolean | null; error: { message: string } | null } = { data: true, error: null };
let failResult: { data: boolean | null; error: { message: string } | null } = { data: true, error: null };

vi.mock('@/app/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      if (fn === 'claim_evaluation_jobs') return { data: claimedJobs, error: null };
      if (fn === 'renew_evaluation_job_lease') return renewResult;
      if (fn === 'complete_evaluation_job') return completeResult;
      if (fn === 'fail_evaluation_job') return failResult;
      return { data: null, error: null };
    },
  },
}));

vi.mock('@/app/lib/timingSafe', () => ({
  timingSafeStringEqual: (a: string, b: string) => a === b,
}));

const evaluateProjectMock = vi.fn();
vi.mock('@/app/lib/evaluateProject', () => ({
  evaluateProject: (...args: unknown[]) => evaluateProjectMock(...args),
}));

const SECRET = 'test-scheduler-secret';

function makeRequest(): Request {
  return new Request('http://localhost/api/cron/scheduler-worker', {
    headers: { authorization: `Bearer ${SECRET}` },
  });
}

function baseJob(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-1',
    project_id: 'project-1',
    ...overrides,
  };
}

describe('GET /api/cron/scheduler-worker', () => {
  beforeEach(() => {
    process.env.SCHEDULER_CRON_SECRET = SECRET;
    claimedJobs = [];
    rpcCalls.length = 0;
    renewResult = { data: true, error: null };
    completeResult = { data: true, error: null };
    failResult = { data: true, error: null };
    evaluateProjectMock.mockReset();
    evaluateProjectMock.mockResolvedValue({ success: true });
  });

  it('يرفض بلا سر مُعرَّف بالخادم', async () => {
    delete process.env.SCHEDULER_CRON_SECRET;
    const { GET } = await import('./route');
    const res = await GET(makeRequest());
    expect(res.status).toBe(503);
  });

  it('يرفض ترويسة Authorization غير مطابقة', async () => {
    const { GET } = await import('./route');
    const res = await GET(new Request('http://localhost', { headers: { authorization: 'Bearer wrong' } }));
    expect(res.status).toBe(401);
  });

  it('تقييم ناجح → complete_evaluation_job يُستدعى، النتيجة ok=true', async () => {
    claimedJobs = [baseJob()];
    const { GET } = await import('./route');
    const res = await GET(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.results[0]).toEqual({ jobId: 'job-1', projectId: 'project-1', ok: true });
    expect(rpcCalls.some((c) => c.fn === 'complete_evaluation_job')).toBe(true);
  });

  it('evaluateProject يرجع success=false → fail_evaluation_job يُستدعى بـp_worker_id', async () => {
    evaluateProjectMock.mockResolvedValue({ success: false, error: 'تعذّر جلب بيانات المشروع' });
    claimedJobs = [baseJob()];
    const { GET } = await import('./route');
    const res = await GET(makeRequest());
    const body = await res.json();

    expect(body.ok).toBe(false);
    const failCall = rpcCalls.find((c) => c.fn === 'fail_evaluation_job');
    expect(failCall).toBeDefined();
    expect(failCall!.args.p_worker_id).toBe(body.workerId);
    expect(failCall!.args.p_job_id).toBe('job-1');
    expect(rpcCalls.some((c) => c.fn === 'complete_evaluation_job')).toBe(false);
  });

  it('evaluateProject يرمي استثناء → يُعامَل كفشل، fail_evaluation_job يُستدعى', async () => {
    evaluateProjectMock.mockRejectedValue(new Error('DB timeout'));
    claimedJobs = [baseJob()];
    const { GET } = await import('./route');
    const res = await GET(makeRequest());
    const body = await res.json();

    expect(body.ok).toBe(false);
    expect(body.results[0].error).toContain('DB timeout');
    expect(rpcCalls.some((c) => c.fn === 'fail_evaluation_job')).toBe(true);
  });

  // اختبارات قبول صريحة (طلب المستخدم — تقرير المراجعة الخارجي: "ملكية
  // Lease غير آمنة في العمال").
  describe('renew_evaluation_job_lease قبل كل مهمة (اختبار قبول صريح)', () => {
    it('renew ناجح → يُستدعى بـp_worker_id/p_lease_seconds قبل evaluateProject', async () => {
      claimedJobs = [baseJob()];
      const { GET } = await import('./route');
      await GET(makeRequest());

      const renewCall = rpcCalls.find((c) => c.fn === 'renew_evaluation_job_lease');
      expect(renewCall).toBeDefined();
      expect(renewCall!.args.p_job_id).toBe('job-1');
      expect(renewCall!.args.p_lease_seconds).toBe(90);
      expect(evaluateProjectMock).toHaveBeenCalledTimes(1);
    });

    it('renew يرجع false (عامل آخر استرجع المهمة) → لا استدعاء evaluateProject إطلاقاً، لا complete/fail', async () => {
      renewResult = { data: false, error: null };
      claimedJobs = [baseJob()];
      const { GET } = await import('./route');
      const res = await GET(makeRequest());
      const body = await res.json();

      expect(body.results[0].ok).toBe(false);
      expect(evaluateProjectMock).not.toHaveBeenCalled();
      expect(rpcCalls.some((c) => c.fn === 'complete_evaluation_job')).toBe(false);
      expect(rpcCalls.some((c) => c.fn === 'fail_evaluation_job')).toBe(false);
    });
  });

  // اختبارات قبول صريحة (طلب المستخدم — تقرير المراجعة الخارجي: "التقييم
  // بحسب وقت المعالجة قد يفوّت مخالفة كاملة"): job.evaluation_at (يملؤها
  // telemetry-worker من observed_at الفعلي) يجب أن تصل كـnowMs (المعامل
  // الثالث) لـevaluateProject — لا تُهمَل، ولا تُستبدَل بـDate.now() ضمنياً.
  describe('evaluation_at → nowMs الممرَّرة لـevaluateProject (اختبار قبول صريح)', () => {
    it('job.evaluation_at موجودة → تُمرَّر كـMs رقمي (المعامل الثالث) لـevaluateProject', async () => {
      const evaluationAtIso = '2026-01-01T12:03:59.999Z';
      claimedJobs = [baseJob({ evaluation_at: evaluationAtIso })];
      const { GET } = await import('./route');
      await GET(makeRequest());

      expect(evaluateProjectMock).toHaveBeenCalledTimes(1);
      const callArgs = evaluateProjectMock.mock.calls[0];
      expect(callArgs[0]).toBe('project-1');
      expect(callArgs[1]).toBe('scheduler');
      expect(callArgs[2]).toBe(new Date(evaluationAtIso).getTime());
    });

    it('job.evaluation_at غائبة (null، مهمة scheduler-tick دورية عادية) → المعامل الثالث undefined، evaluateProject تسقط لـDate.now() داخلياً كما كانت دائماً', async () => {
      claimedJobs = [baseJob({ evaluation_at: null })];
      const { GET } = await import('./route');
      await GET(makeRequest());

      const callArgs = evaluateProjectMock.mock.calls[0];
      expect(callArgs[2]).toBeUndefined();
    });
  });

  // اختبار قبول صريح: complete_evaluation_job=false بعد تقييم ناجح فعلياً
  // يجب ألا يستدعي fail (القرار كُتب بالفعل — استدعاء fail كان سيُعيد مهمة
  // باتت مسؤولية عامل آخر إلى RETRY زوراً رغم نجاح التقييم).
  it('complete_evaluation_job يرجع false (بعد تقييم ناجح فعلياً) → فشل في النتيجة، لكن fail_evaluation_job لا يُستدعى إطلاقاً', async () => {
    completeResult = { data: false, error: null };
    claimedJobs = [baseJob()];
    const { GET } = await import('./route');
    const res = await GET(makeRequest());
    const body = await res.json();

    expect(body.results[0].ok).toBe(false);
    expect(rpcCalls.some((c) => c.fn === 'fail_evaluation_job')).toBe(false);
  });

  it('لا مهام مُطالَب بها → ok=true بلا أي استدعاء آخر', async () => {
    claimedJobs = [];
    const { GET } = await import('./route');
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.claimed).toBe(0);
  });
});
