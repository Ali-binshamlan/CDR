import { describe, it, expect, vi, beforeEach } from 'vitest';

const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
let rpcResult: { data: unknown; error: { code?: string; message: string } | null } = { data: { id: 'v2' }, error: null };

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

describe('POST /api/admin/rule-parameters/[code]/rollback', () => {
  beforeEach(() => {
    rpcCalls.length = 0;
    rpcResult = { data: { id: 'v2' }, error: null };
  });

  it('يرفض versionId غائباً بـ400', async () => {
    const { POST } = await import('./route');
    const res = await POST(makeRequest({ changeReasonAr: 'سبب' }), { params: Promise.resolve({ code: 'STONE_CUTTING_WIND_STOP_KMH' }) });
    expect(res.status).toBe(400);
    expect(rpcCalls).toHaveLength(0);
  });

  it('يرفض changeReasonAr فارغاً بـ400', async () => {
    const { POST } = await import('./route');
    const res = await POST(makeRequest({ versionId: 'v1', changeReasonAr: '' }), { params: Promise.resolve({ code: 'STONE_CUTTING_WIND_STOP_KMH' }) });
    expect(res.status).toBe(400);
    expect(rpcCalls).toHaveLength(0);
  });

  it('طلب صالح يستدعي rollback_rule_parameter_version بالمعاملات الصحيحة', async () => {
    const { POST } = await import('./route');
    const res = await POST(makeRequest({ versionId: 'v1', changeReasonAr: 'عودة لقيمة سابقة أصح' }), { params: Promise.resolve({ code: 'STONE_CUTTING_WIND_STOP_KMH' }) });
    expect(res.status).toBe(200);
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].fn).toBe('rollback_rule_parameter_version');
    expect(rpcCalls[0].args.p_version_id).toBe('v1');
    expect(rpcCalls[0].args.p_published_by).toBe('admin-1');
    expect(rpcCalls[0].args.p_change_reason_ar).toBe('عودة لقيمة سابقة أصح');
  });

  it('خطأ تحقق من RPC (23503، نسخة غير موجودة) يُعرَض كما هو', async () => {
    rpcResult = { data: null, error: { code: '23503', message: 'نسخة غير موجودة: v-missing' } };
    const { POST } = await import('./route');
    const res = await POST(makeRequest({ versionId: 'v-missing', changeReasonAr: 'اختبار' }), { params: Promise.resolve({ code: 'STONE_CUTTING_WIND_STOP_KMH' }) });
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toBe('نسخة غير موجودة: v-missing');
  });
});
