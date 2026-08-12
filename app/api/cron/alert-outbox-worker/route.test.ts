import { describe, it, expect, vi, beforeEach } from 'vitest';

// نموّه supabaseAdmin.rpc — يغطي مسار claim_alert_outbox_batch/renew_alert_
// outbox_lease/create_alert_atomic/close_alert_atomic/complete_alert_outbox_
// row/fail_alert_outbox_row (القسم 6 من مراجعة خبير خارجي — Outbox: alert_id
// يُحفَظ فعلياً، نوايا CLOSE تُعالَج، فشل complete لا يُهمَل بصمت. ومراجعة
// كود خارجي لاحقة — "ملكية Lease غير آمنة في العمال": renew قبل كل صف،
// fail_alert_outbox_row يشترط الآن worker_id ويُرجع boolean، وفشل complete
// بعد نجاح create/close الفعلي لا يستدعي fail بعد الآن — راجع route.ts).
let claimedRows: Array<Record<string, unknown>> = [];
const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
let renewResult: { data: boolean | null; error: { message: string } | null } = { data: true, error: null };
let createAlertResult: { data: string | null; error: { message: string } | null } = { data: 'alert-1', error: null };
let closeAlertResult: { data: string | null; error: { message: string } | null } = { data: 'alert-1', error: null };
let completeResult: { data: boolean | null; error: { message: string } | null } = { data: true, error: null };
let failResult: { data: boolean | null; error: { message: string } | null } = { data: true, error: null };

vi.mock('@/app/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      if (fn === 'claim_alert_outbox_batch') return { data: claimedRows, error: null };
      if (fn === 'renew_alert_outbox_lease') return renewResult;
      if (fn === 'create_alert_atomic') return createAlertResult;
      if (fn === 'close_alert_atomic') return closeAlertResult;
      if (fn === 'complete_alert_outbox_row') return completeResult;
      if (fn === 'fail_alert_outbox_row') return failResult;
      return { data: null, error: null };
    },
  },
}));

vi.mock('@/app/lib/timingSafe', () => ({
  timingSafeStringEqual: (a: string, b: string) => a === b,
}));

const SECRET = 'test-alert-outbox-secret';

function makeRequest(): Request {
  return new Request('http://localhost/api/cron/alert-outbox-worker', {
    headers: { authorization: `Bearer ${SECRET}` },
  });
}

function baseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'row-1',
    final_decision_id: 'fd-1',
    project_id: 'p1',
    activity_group_id: 'group-1',
    activity_id: 'activity-1',
    kind: 'SAFETY_BREACH',
    action: 'OPEN',
    payload: { shortReasonAr: 'سبب' },
    attempts: 0,
    ...overrides,
  };
}

describe('GET /api/cron/alert-outbox-worker', () => {
  beforeEach(() => {
    process.env.ALERT_OUTBOX_CRON_SECRET = SECRET;
    claimedRows = [];
    rpcCalls.length = 0;
    renewResult = { data: true, error: null };
    createAlertResult = { data: 'alert-1', error: null };
    closeAlertResult = { data: 'alert-1', error: null };
    completeResult = { data: true, error: null };
    failResult = { data: true, error: null };
  });

  it('يرفض بلا سر مُعرَّف بالخادم', async () => {
    delete process.env.ALERT_OUTBOX_CRON_SECRET;
    const { GET } = await import('./route');
    const res = await GET(makeRequest());
    expect(res.status).toBe(503);
  });

  it('يرفض ترويسة Authorization غير مطابقة', async () => {
    const { GET } = await import('./route');
    const res = await GET(new Request('http://localhost', { headers: { authorization: 'Bearer wrong' } }));
    expect(res.status).toBe(401);
  });

  it('action=OPEN: يستدعي create_alert_atomic ثم يحفظ alert_id عبر complete_alert_outbox_row', async () => {
    claimedRows = [baseRow()];
    const { GET } = await import('./route');
    const res = await GET(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.results[0]).toEqual({ id: 'row-1', ok: true, alertId: 'alert-1' });

    const createCall = rpcCalls.find((c) => c.fn === 'create_alert_atomic');
    expect(createCall).toBeDefined();
    const completeCall = rpcCalls.find((c) => c.fn === 'complete_alert_outbox_row');
    expect(completeCall!.args.p_alert_id).toBe('alert-1');
  });

  it('action=CLOSE: يستدعي close_alert_atomic بدل create_alert_atomic', async () => {
    claimedRows = [baseRow({ action: 'CLOSE' })];
    const { GET } = await import('./route');
    await GET(makeRequest());

    expect(rpcCalls.some((c) => c.fn === 'close_alert_atomic')).toBe(true);
    expect(rpcCalls.some((c) => c.fn === 'create_alert_atomic')).toBe(false);
  });

  it('close_alert_atomic يرجع null (لا تنبيه مفتوح أصلاً) → لا يُعتبر فشلاً', async () => {
    closeAlertResult = { data: null, error: null };
    claimedRows = [baseRow({ action: 'CLOSE' })];
    const { GET } = await import('./route');
    const res = await GET(makeRequest());
    const body = await res.json();

    expect(body.ok).toBe(true);
    expect(body.results[0]).toEqual({ id: 'row-1', ok: true, alertId: null });
  });

  // خطأ مكتشَف ومُصلَح (مراجعة كود خارجي — "ملكية Lease غير آمنة في
  // العمال"): complete_alert_outbox_row يرجع false يعني عامل آخر استرجع
  // الصف بعد انتهاء lease هذا العامل — لكن create_alert_atomic نجح فعلياً
  // قبل ذلك (التنبيه أُنشئ في قاعدة البيانات). النتيجة يجب أن تُعامَل كفشل
  // في results، لكن fail_alert_outbox_row يجب ألا يُستدعى إطلاقاً (استدعاؤه
  // كان سيُعيد صفاً بات مسؤولية عامل آخر إلى RETRY/DEAD زوراً رغم نجاح
  // العملية الفعلية) — هذا هو الإصلاح الجوهري المطلوب صراحة في التقرير.
  it('complete_alert_outbox_row يرجع false (بعد نجاح create فعلي) → فشل في النتيجة، لكن fail_alert_outbox_row لا يُستدعى إطلاقاً', async () => {
    completeResult = { data: false, error: null };
    claimedRows = [baseRow()];
    const { GET } = await import('./route');
    const res = await GET(makeRequest());
    const body = await res.json();

    expect(body.ok).toBe(false);
    expect(body.results[0].ok).toBe(false);
    expect(body.results[0].alertId).toBe('alert-1');
    expect(rpcCalls.some((c) => c.fn === 'fail_alert_outbox_row')).toBe(false);
  });

  it('create_alert_atomic يفشل (فشل معالجة حقيقي، لا مشكلة ملكية) → fail_alert_outbox_row يُستدعى بـp_worker_id، لا complete', async () => {
    createAlertResult = { data: null, error: { message: 'boom' } };
    claimedRows = [baseRow()];
    const { GET } = await import('./route');
    const res = await GET(makeRequest());
    const body = await res.json();

    expect(body.ok).toBe(false);
    const failCall = rpcCalls.find((c) => c.fn === 'fail_alert_outbox_row');
    expect(failCall).toBeDefined();
    expect(failCall!.args.p_worker_id).toBe(body.workerId);
    expect(rpcCalls.some((c) => c.fn === 'complete_alert_outbox_row')).toBe(false);
  });

  it('لا صفوف مُطالَب بها → ok=true بلا أي استدعاء آخر', async () => {
    claimedRows = [];
    const { GET } = await import('./route');
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.claimed).toBe(0);
  });

  // اختبارات قبول صريحة (طلب المستخدم — تقرير المراجعة الخارجي: "ملكية
  // Lease غير آمنة في العمال"): renew_alert_outbox_lease يُستدعى قبل معالجة
  // كل صف، وfalse منه يعني توقّف فوري بلا أي معالجة وبلا استدعاء fail.
  describe('renew_alert_outbox_lease قبل كل صف (اختبار قبول صريح)', () => {
    it('renew ناجح → يُستدعى بـp_worker_id/p_lease_seconds الصحيحين قبل create_alert_atomic', async () => {
      claimedRows = [baseRow()];
      const { GET } = await import('./route');
      await GET(makeRequest());

      const renewIndex = rpcCalls.findIndex((c) => c.fn === 'renew_alert_outbox_lease');
      const createIndex = rpcCalls.findIndex((c) => c.fn === 'create_alert_atomic');
      expect(renewIndex).toBeGreaterThanOrEqual(0);
      expect(renewIndex).toBeLessThan(createIndex);
      expect(rpcCalls[renewIndex].args.p_row_id).toBe('row-1');
      expect(rpcCalls[renewIndex].args.p_lease_seconds).toBe(60);
    });

    it('renew يرجع false (عامل آخر استرجع الصف) → لا معالجة إطلاقاً، لا create/close/complete/fail', async () => {
      renewResult = { data: false, error: null };
      claimedRows = [baseRow()];
      const { GET } = await import('./route');
      const res = await GET(makeRequest());
      const body = await res.json();

      expect(body.results[0].ok).toBe(false);
      expect(rpcCalls.some((c) => c.fn === 'create_alert_atomic')).toBe(false);
      expect(rpcCalls.some((c) => c.fn === 'close_alert_atomic')).toBe(false);
      expect(rpcCalls.some((c) => c.fn === 'complete_alert_outbox_row')).toBe(false);
      expect(rpcCalls.some((c) => c.fn === 'fail_alert_outbox_row')).toBe(false);
    });

    it('renew يرجع خطأ DB → نفس معاملة false (توقّف فوري بلا معالجة)', async () => {
      renewResult = { data: null, error: { message: 'connection lost' } };
      claimedRows = [baseRow()];
      const { GET } = await import('./route');
      const res = await GET(makeRequest());
      const body = await res.json();

      expect(body.results[0].ok).toBe(false);
      expect(rpcCalls.some((c) => c.fn === 'create_alert_atomic')).toBe(false);
    });
  });

  // اختبارات قبول صريحة (طلب المستخدم — تقرير المراجعة الخارجي: "Outbox
  // يخلط الإيقاف الإلزامي والاحترازي"): PROTECTIVE_STOP يجب أن يُنتج نصاً
  // منفصلاً تماماً عن "إيقاف إلزامي" (SAFETY_BREACH) — لا يُعامَل بنفس
  // deriveAlertMessage القديمة التي كانت تُسمّي كليهما "إيقافاً إلزامياً".
  describe('PROTECTIVE_STOP يُعامَل بنص منفصل عن SAFETY_BREACH (اختبار قبول صريح)', () => {
    it("kind='PROTECTIVE_STOP' → نص التنبيه يذكر 'احترازي معلَّق'، لا 'إيقاف إلزامي'", async () => {
      claimedRows = [baseRow({ kind: 'PROTECTIVE_STOP', payload: { shortReasonAr: 'قيد التأكيد' } })];
      const { GET } = await import('./route');
      await GET(makeRequest());

      const createCall = rpcCalls.find((c) => c.fn === 'create_alert_atomic');
      expect(createCall).toBeDefined();
      const message = createCall!.args.p_message as string;
      expect(message).toContain('احترازي معلَّق');
      expect(message).not.toContain('إيقاف إلزامي');
      expect(createCall!.args.p_kind).toBe('PROTECTIVE_STOP');
    });

    it("kind='SAFETY_BREACH' → نص التنبيه يبقى 'إيقاف إلزامي' كالسابق (لا تراجع في السلوك القديم لهذا النوع تحديداً)", async () => {
      claimedRows = [baseRow({ kind: 'SAFETY_BREACH', payload: { shortReasonAr: 'تجاوز' } })];
      const { GET } = await import('./route');
      await GET(makeRequest());

      const createCall = rpcCalls.find((c) => c.fn === 'create_alert_atomic');
      const message = createCall!.args.p_message as string;
      expect(message).toContain('إيقاف إلزامي');
    });

    it("kind='PROTECTIVE_STOP' → p_viewer_message يبقى null (نفس معاملة SAFETY_BREACH/COMPLIANCE_RESTRICTION، ليس COMPLIANCE_VIOLATION)", async () => {
      claimedRows = [baseRow({ kind: 'PROTECTIVE_STOP' })];
      const { GET } = await import('./route');
      await GET(makeRequest());

      const createCall = rpcCalls.find((c) => c.fn === 'create_alert_atomic');
      expect(createCall!.args.p_viewer_message).toBeNull();
    });

    it("payload.mandatoryStop كـboolean حقيقي (لا نص) لا يكسر deriveAlertMessage — القيمة غير مقروءة فعلياً هناك، فقط النوع يجب أن يقبل boolean", async () => {
      claimedRows = [
        baseRow({ kind: 'SAFETY_BREACH', payload: { shortReasonAr: 'سبب', mandatoryStop: true } }),
      ];
      const { GET } = await import('./route');
      const res = await GET(makeRequest());
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.results[0].ok).toBe(true);
    });
  });

  // اختبار قبول صريح (طلب المستخدم — تقرير المراجعة الخارجي: "الانتقال بين
  // أنواع التنبيه لا يغلق النوع السابق"): العامل تسلسلي (for loop على مصفوفة
  // rows بالترتيب المُرجَع من claim_alert_outbox_batch حرفياً، بلا إعادة
  // ترتيب داخل route.ts نفسه) — يتحقق هذا الاختبار أن صف CLOSE (لو وصل أولاً
  // في المصفوفة، كما يضمنه sequence_no في migration 202608110022) يُعالَج
  // فعلياً قبل صف OPEN التالي له لنفس final_decision، لا العكس، بصرف النظر
  // عن id عشوائي لكل صف.
  describe('CLOSE يُعالَج قبل OPEN عند الانتقال بين نوعين (اختبار قبول صريح)', () => {
    it('دفعة تحوي CLOSE(SAFETY_BREACH) ثم OPEN(COMPLIANCE_RESTRICTION) لنفس القرار → close_alert_atomic يُستدعى قبل create_alert_atomic، وكلاهما يُعالَج بنجاح', async () => {
      claimedRows = [
        baseRow({
          id: 'row-close',
          kind: 'SAFETY_BREACH',
          action: 'CLOSE',
          payload: { shortReasonAr: 'تحسّن القرار' },
        }),
        baseRow({
          id: 'row-open',
          kind: 'COMPLIANCE_RESTRICTION',
          action: 'OPEN',
          payload: { shortReasonAr: 'تقييد متبقٍّ' },
        }),
      ];
      const { GET } = await import('./route');
      const res = await GET(makeRequest());
      const body = await res.json();

      expect(body.ok).toBe(true);
      expect(body.results).toHaveLength(2);
      expect(body.results[0]).toEqual({ id: 'row-close', ok: true, alertId: 'alert-1' });
      expect(body.results[1]).toEqual({ id: 'row-open', ok: true, alertId: 'alert-1' });

      const closeIndex = rpcCalls.findIndex((c) => c.fn === 'close_alert_atomic');
      const createIndex = rpcCalls.findIndex((c) => c.fn === 'create_alert_atomic');
      expect(closeIndex).toBeGreaterThanOrEqual(0);
      expect(createIndex).toBeGreaterThanOrEqual(0);
      expect(closeIndex).toBeLessThan(createIndex);
      expect(rpcCalls[closeIndex].args.p_kind).toBe('SAFETY_BREACH');
      expect(rpcCalls[createIndex].args.p_kind).toBe('COMPLIANCE_RESTRICTION');
    });
  });
});
