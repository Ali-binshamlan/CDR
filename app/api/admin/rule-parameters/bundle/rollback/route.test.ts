import { describe, it, expect, vi, beforeEach } from 'vitest';

const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
let rpcResult: { data: unknown; error: { code?: string; message: string } | null } = { data: [{ id: 'v2' }], error: null };

vi.mock('@/app/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
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

describe('POST /api/admin/rule-parameters/bundle/rollback', () => {
  beforeEach(() => {
    rpcCalls.length = 0;
    rpcResult = { data: [{ id: 'v2' }], error: null };
  });

  it('يرفض bundleId فارغاً بـ400', async () => {
    const { POST } = await import('./route');
    const res = await POST(makeRequest({ changeReasonAr: 'سبب' }));
    expect(res.status).toBe(400);
    expect(rpcCalls).toHaveLength(0);
  });

  it('يرفض changeReasonAr فارغاً بـ400', async () => {
    const { POST } = await import('./route');
    const res = await POST(makeRequest({ bundleId: 'bundle-1', changeReasonAr: '  ' }));
    expect(res.status).toBe(400);
    expect(rpcCalls).toHaveLength(0);
  });

  it('طلب صالح يستدعي rollback_rule_parameter_bundle بالمعاملات الصحيحة', async () => {
    const { POST } = await import('./route');
    const res = await POST(makeRequest({ bundleId: 'bundle-1', changeReasonAr: 'تراجع عن الملف التشغيلي' }));
    expect(res.status).toBe(200);
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].fn).toBe('rollback_rule_parameter_bundle');
    expect(rpcCalls[0].args.p_bundle_id).toBe('bundle-1');
    expect(rpcCalls[0].args.p_published_by).toBe('admin-1');
    expect(rpcCalls[0].args.p_change_reason_ar).toBe('تراجع عن الملف التشغيلي');
  });

  it('خطأ تحقق من RPC (22023، بندلة تراجع عنها بالفعل) يُعرَض كما هو', async () => {
    rpcResult = { data: null, error: { code: '22023', message: 'هذه البندلة تراجع عنها بالفعل' } };
    const { POST } = await import('./route');
    const res = await POST(makeRequest({ bundleId: 'bundle-1', changeReasonAr: 'اختبار' }));
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toBe('هذه البندلة تراجع عنها بالفعل');
  });

  it('خطأ داخلي غير متوقع يُعرَض برسالة عامة', async () => {
    rpcResult = { data: null, error: { code: '08000', message: 'connection reset by peer at 10.0.0.5:5432' } };
    const { POST } = await import('./route');
    const res = await POST(makeRequest({ bundleId: 'bundle-1', changeReasonAr: 'اختبار' }));
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body.error).not.toContain('10.0.0.5');
  });
});
