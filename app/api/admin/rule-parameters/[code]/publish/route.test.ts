import { describe, it, expect, vi, beforeEach } from 'vitest';

// خطأ مكتشَف ومُصلَح (مراجعة خبير خارجي — "واجهة إدارة القواعد للعرض فقط؛
// لا يوجد نظام حقيقي يدعم النشر الذري"): هذا الملف يختبر منطق التحقق
// TypeScript-level لمسار النشر (value رقمي، changeReasonAr إلزامي، تمرير
// رسالة RPC الفعلية بدل رسالة عامة لأخطاء التحقق) — منطق RPC الذري نفسه
// (publish_rule_parameter_version) SQL بحت، يُختبر عبر مراجعة الهجرة/تطبيق
// فعلي، لا vitest.

const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
let rpcResult: { data: unknown; error: { code?: string; message: string } | null } = { data: { id: 'v1' }, error: null };

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

describe('POST /api/admin/rule-parameters/[code]/publish', () => {
  beforeEach(() => {
    rpcCalls.length = 0;
    rpcResult = { data: { id: 'v1' }, error: null };
  });

  it('يرفض value غير رقمي بـ400', async () => {
    const { POST } = await import('./route');
    const res = await POST(makeRequest({ value: 'abc', changeReasonAr: 'سبب' }), { params: Promise.resolve({ code: 'STONE_CUTTING_WIND_STOP_KMH' }) });
    expect(res.status).toBe(400);
    expect(rpcCalls).toHaveLength(0);
  });

  it('يرفض changeReasonAr فارغاً بـ400', async () => {
    const { POST } = await import('./route');
    const res = await POST(makeRequest({ value: 12, changeReasonAr: '  ' }), { params: Promise.resolve({ code: 'STONE_CUTTING_WIND_STOP_KMH' }) });
    expect(res.status).toBe(400);
    expect(rpcCalls).toHaveLength(0);
  });

  it('طلب صالح يستدعي publish_rule_parameter_version بالمعاملات الصحيحة', async () => {
    const { POST } = await import('./route');
    const res = await POST(makeRequest({ value: 12, changeReasonAr: 'تعميم جديد' }), { params: Promise.resolve({ code: 'STONE_CUTTING_WIND_STOP_KMH' }) });
    expect(res.status).toBe(200);
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].fn).toBe('publish_rule_parameter_version');
    expect(rpcCalls[0].args.p_parameter_code).toBe('STONE_CUTTING_WIND_STOP_KMH');
    expect(rpcCalls[0].args.p_value).toBe(12);
    expect(rpcCalls[0].args.p_published_by).toBe('admin-1');
    expect(rpcCalls[0].args.p_change_reason_ar).toBe('تعميم جديد');
  });

  it('خطأ تحقق من RPC (22023، خارج المدى الآمن) يُعرَض كما هو، لا رسالة عامة', async () => {
    rpcResult = { data: null, error: { code: '22023', message: 'القيمة 500 أعلى من الحد الأقصى الآمن 100' } };
    const { POST } = await import('./route');
    const res = await POST(makeRequest({ value: 500, changeReasonAr: 'اختبار' }), { params: Promise.resolve({ code: 'STONE_CUTTING_WIND_STOP_KMH' }) });
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toBe('القيمة 500 أعلى من الحد الأقصى الآمن 100');
  });

  it('خطأ داخلي غير متوقع (لا 22023/23503) يُعرَض برسالة عامة، لا تفاصيل خام', async () => {
    rpcResult = { data: null, error: { code: '08000', message: 'connection reset by peer at 10.0.0.5:5432' } };
    const { POST } = await import('./route');
    const res = await POST(makeRequest({ value: 12, changeReasonAr: 'اختبار' }), { params: Promise.resolve({ code: 'STONE_CUTTING_WIND_STOP_KMH' }) });
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body.error).not.toContain('10.0.0.5');
  });
});
