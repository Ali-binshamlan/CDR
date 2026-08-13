import { describe, it, expect, vi, beforeEach } from 'vitest';

// خطأ حرج مكتشَف ومُصلَح (مراجعة كود خارجي — "صفوف Telemetry الميتة تُحذف
// بعد سبعة أيام"): هذا endpoint هو المسار الوحيد لإخراج صف من
// telemetry_dead_letter (لا حذف مباشر أبداً — راجع migration 202608120002):
// إما replay (إعادة محاولة عبر telemetry-worker) أو acknowledge (اعتماد
// بشري موثَّق بسبب إلزامي). يختبر منطق التحقق/التمرير TypeScript-level؛
// منطق RPC الذري نفسه SQL بحت.

const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
let rpcResult: { data: unknown; error: { message: string } | null } = { data: null, error: null };

vi.mock('@/app/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from: () => {
      const chain: Record<string, unknown> = {
        select: () => chain,
        order: () => chain,
        limit: () => chain,
        is: () => chain,
        or: () => chain,
        then: (resolve: (v: { data: unknown[]; error: null }) => void) => resolve({ data: [], error: null }),
      };
      return chain;
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      return rpcResult;
    },
  },
}));

vi.mock('@/app/lib/apiAuth', () => ({
  requireSuperAdmin: async () => ({ userId: 'admin-1', role: 'admin' as const }),
}));

function makeRequest(body: unknown) {
  return new Request('http://localhost', { method: 'POST', body: JSON.stringify(body) }) as never;
}

describe('POST /api/admin/telemetry-dead-letter', () => {
  beforeEach(() => {
    rpcCalls.length = 0;
    rpcResult = { data: null, error: null };
  });

  it('يرفض بلا id بـ400', async () => {
    const { POST } = await import('./route');
    const res = await POST(makeRequest({ action: 'replay' }));
    expect(res.status).toBe(400);
    expect(rpcCalls).toHaveLength(0);
  });

  it("يرفض action غير 'replay'/'acknowledge' بـ400", async () => {
    const { POST } = await import('./route');
    const res = await POST(makeRequest({ id: 'row-1', action: 'delete' }));
    expect(res.status).toBe(400);
    expect(rpcCalls).toHaveLength(0);
  });

  it('replay يستدعي replay_dead_telemetry_letter بالمعاملات الصحيحة (replayed_by من الجلسة، لا من body)', async () => {
    rpcResult = { data: 'new-queue-row-id', error: null };
    const { POST } = await import('./route');
    const res = await POST(makeRequest({ id: 'row-1', action: 'replay', replayedBy: 'attacker-supplied-id' }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.queueId).toBe('new-queue-row-id');
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].fn).toBe('replay_dead_telemetry_letter');
    expect(rpcCalls[0].args.p_dead_letter_id).toBe('row-1');
    // مُشتَق من الجلسة (auth.userId)، لا من أي حقل في body — نفس مبدأ
    // operator_id في POST /api/pm10-readings/manual.
    expect(rpcCalls[0].args.p_replayed_by).toBe('admin-1');
  });

  it('acknowledge يرفض بلا reason بـ400 (سبب إلزامي، لا اعتماد صامت)', async () => {
    const { POST } = await import('./route');
    const res = await POST(makeRequest({ id: 'row-1', action: 'acknowledge' }));
    expect(res.status).toBe(400);
    expect(rpcCalls).toHaveLength(0);
  });

  it('acknowledge يرفض reason فارغ/مسافات فقط بـ400', async () => {
    const { POST } = await import('./route');
    const res = await POST(makeRequest({ id: 'row-1', action: 'acknowledge', reason: '   ' }));
    expect(res.status).toBe(400);
    expect(rpcCalls).toHaveLength(0);
  });

  it('acknowledge بسبب صالح يستدعي acknowledge_dead_telemetry_letter بالمعاملات الصحيحة', async () => {
    rpcResult = { data: true, error: null };
    const { POST } = await import('./route');
    const res = await POST(makeRequest({ id: 'row-1', action: 'acknowledge', reason: 'تحقّقنا يدوياً — القراءة غير قابلة للاسترجاع، الجهاز استُبدل' }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(rpcCalls[0].fn).toBe('acknowledge_dead_telemetry_letter');
    expect(rpcCalls[0].args.p_dead_letter_id).toBe('row-1');
    expect(rpcCalls[0].args.p_acknowledged_by).toBe('admin-1');
    expect(rpcCalls[0].args.p_reason).toContain('الجهاز استُبدل');
  });

  it('acknowledge على صف مُعتمَد/مُعاد محاولته مسبقاً (RPC يُرجع false) → 409', async () => {
    rpcResult = { data: false, error: null };
    const { POST } = await import('./route');
    const res = await POST(makeRequest({ id: 'row-1', action: 'acknowledge', reason: 'سبب' }));
    expect(res.status).toBe(409);
  });
});
