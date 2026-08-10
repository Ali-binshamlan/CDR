import { describe, it, expect, vi, beforeEach } from 'vitest';

// نفس نمط [code]/publish/route.test.ts — يختبر منطق التحقق TypeScript-level
// فقط (changes مصفوفة غير فارغة، كل عنصر {code, value} صالح، changeReasonAr
// إلزامي). الذرية الفعلية لـpublish_rule_parameter_bundle نفسها SQL بحت،
// تُختبر عبر مراجعة الهجرة/تطبيق فعلي، لا vitest.

const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
let rpcResult: { data: unknown; error: { code?: string; message: string } | null } = { data: [{ id: 'v1' }], error: null };

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

describe('POST /api/admin/rule-parameters/bundle/publish', () => {
  beforeEach(() => {
    rpcCalls.length = 0;
    rpcResult = { data: [{ id: 'v1' }], error: null };
  });

  it('يرفض changes غير موجودة/غير مصفوفة بـ400', async () => {
    const { POST } = await import('./route');
    const res = await POST(makeRequest({ changeReasonAr: 'سبب' }));
    expect(res.status).toBe(400);
    expect(rpcCalls).toHaveLength(0);
  });

  it('يرفض مصفوفة changes فارغة بـ400', async () => {
    const { POST } = await import('./route');
    const res = await POST(makeRequest({ changes: [], changeReasonAr: 'سبب' }));
    expect(res.status).toBe(400);
    expect(rpcCalls).toHaveLength(0);
  });

  it('يرفض عنصراً بلا code أو بقيمة غير رقمية بـ400', async () => {
    const { POST } = await import('./route');
    const res = await POST(makeRequest({ changes: [{ code: 'WIND_GATE_STOP_KMH', value: 'abc' }], changeReasonAr: 'سبب' }));
    expect(res.status).toBe(400);
    expect(rpcCalls).toHaveLength(0);
  });

  it('يرفض changeReasonAr فارغاً بـ400', async () => {
    const { POST } = await import('./route');
    const res = await POST(makeRequest({ changes: [{ code: 'WIND_GATE_STOP_KMH', value: 25 }], changeReasonAr: '  ' }));
    expect(res.status).toBe(400);
    expect(rpcCalls).toHaveLength(0);
  });

  it('طلب صالح يستدعي publish_rule_parameter_bundle بمصفوفة المعاملات الصحيحة', async () => {
    const { POST } = await import('./route');
    const res = await POST(makeRequest({
      changes: [
        { code: 'WIND_GATE_ENHANCED_MIN_KMH', value: 16 },
        { code: 'WIND_GATE_STOP_KMH', value: 26 },
      ],
      changeReasonAr: 'ملف تشغيلي جديد',
    }));
    expect(res.status).toBe(200);
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].fn).toBe('publish_rule_parameter_bundle');
    expect(rpcCalls[0].args.p_changes).toEqual([
      { code: 'WIND_GATE_ENHANCED_MIN_KMH', value: 16 },
      { code: 'WIND_GATE_STOP_KMH', value: 26 },
    ]);
    expect(rpcCalls[0].args.p_published_by).toBe('admin-1');
    expect(rpcCalls[0].args.p_change_reason_ar).toBe('ملف تشغيلي جديد');
  });

  it('خطأ تحقق من RPC (22023) يُعرَض كما هو، لا رسالة عامة', async () => {
    rpcResult = { data: null, error: { code: '22023', message: 'المعامل WIND_GATE_STOP_KMH: القيمة 500 أعلى من الحد الأقصى الآمن 100' } };
    const { POST } = await import('./route');
    const res = await POST(makeRequest({ changes: [{ code: 'WIND_GATE_STOP_KMH', value: 500 }], changeReasonAr: 'اختبار' }));
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toContain('WIND_GATE_STOP_KMH');
  });

  it('خطأ داخلي غير متوقع (لا 22023/23503) يُعرَض برسالة عامة', async () => {
    rpcResult = { data: null, error: { code: '08000', message: 'connection reset by peer at 10.0.0.5:5432' } };
    const { POST } = await import('./route');
    const res = await POST(makeRequest({ changes: [{ code: 'WIND_GATE_STOP_KMH', value: 25 }], changeReasonAr: 'اختبار' }));
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body.error).not.toContain('10.0.0.5');
  });
});
