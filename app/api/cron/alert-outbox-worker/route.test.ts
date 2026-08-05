import { describe, it, expect, vi, beforeEach } from 'vitest';

// نموّه supabaseAdmin.rpc — يغطي مسار claim_alert_outbox_batch/create_alert_
// atomic/close_alert_atomic/complete_alert_outbox_row/fail_alert_outbox_row
// (القسم 6 من مراجعة خبير خارجي — Outbox: alert_id يُحفَظ فعلياً، نوايا
// CLOSE تُعالَج، فشل complete لا يُهمَل بصمت).
let claimedRows: Array<Record<string, unknown>> = [];
const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
let createAlertResult: { data: string | null; error: { message: string } | null } = { data: 'alert-1', error: null };
let closeAlertResult: { data: string | null; error: { message: string } | null } = { data: 'alert-1', error: null };
let completeResult: { data: boolean | null; error: { message: string } | null } = { data: true, error: null };

vi.mock('@/app/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      if (fn === 'claim_alert_outbox_batch') return { data: claimedRows, error: null };
      if (fn === 'create_alert_atomic') return createAlertResult;
      if (fn === 'close_alert_atomic') return closeAlertResult;
      if (fn === 'complete_alert_outbox_row') return completeResult;
      if (fn === 'fail_alert_outbox_row') return { data: null, error: null };
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
    createAlertResult = { data: 'alert-1', error: null };
    closeAlertResult = { data: 'alert-1', error: null };
    completeResult = { data: true, error: null };
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

  // خطأ مكتشَف ومُصلَح (مراجعة خبير خارجي — "العامل يهمل بعض أخطاء تحديث
  // PROCESSED"): complete_alert_outbox_row يرجع false (locked_by لم يعد
  // يطابق — عامل آخر استرجع المهمة) يجب أن يُعامَل كفشل صريح، لا نجاحاً صامتاً.
  it('complete_alert_outbox_row يرجع false → يُعامَل كفشل، يُستدعى fail_alert_outbox_row', async () => {
    completeResult = { data: false, error: null };
    claimedRows = [baseRow()];
    const { GET } = await import('./route');
    const res = await GET(makeRequest());
    const body = await res.json();

    expect(body.ok).toBe(false);
    expect(body.results[0].ok).toBe(false);
    expect(rpcCalls.some((c) => c.fn === 'fail_alert_outbox_row')).toBe(true);
  });

  it('create_alert_atomic يفشل → fail_alert_outbox_row يُستدعى، لا complete', async () => {
    createAlertResult = { data: null, error: { message: 'boom' } };
    claimedRows = [baseRow()];
    const { GET } = await import('./route');
    const res = await GET(makeRequest());
    const body = await res.json();

    expect(body.ok).toBe(false);
    expect(rpcCalls.some((c) => c.fn === 'fail_alert_outbox_row')).toBe(true);
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
});
