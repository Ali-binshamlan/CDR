import { describe, it, expect, vi, beforeEach } from 'vitest';

type TableResult = { data: unknown; error: { message: string } | null };
const tableResults: Record<string, TableResult> = {};

function makeChain(tableName: string) {
  const result = tableResults[tableName] ?? { data: null, error: null };
  const chain: Record<string, unknown> = {
    select: () => chain,
    then: (resolve: (value: { data: unknown; error: unknown }) => void) =>
      resolve({ data: result.data ?? null, error: result.error ?? null }),
  };
  return chain;
}

vi.mock('@/app/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from: (tableName: string) => makeChain(tableName),
  },
}));

let mockRequireUserIdResult: { userId: string } | { error: Response } = { userId: 'user-1' };
let mockOwnershipResult = true;

vi.mock('@/app/lib/apiAuth', () => ({
  requireUserId: async () => mockRequireUserIdResult,
  verifyProjectOwnership: async () => mockOwnershipResult,
}));

vi.mock('@/app/utils/dust-compliance-engine', async () => {
  const actual = await vi.importActual('@/app/utils/dust-compliance-engine');
  return {
    ...actual,
    refreshRuleParameters: vi.fn(async () => undefined),
  };
});

// راجع نفس التعليق في crusher-precheck/route.test.ts — يمنع نداء شبكة
// Overpass حقيقياً أثناء الاختبار.
let mockOsmWarning: string | null = null;
vi.mock('@/app/utils/geo/overpassReceptors', () => ({
  buildOsmProximityWarning: async () => mockOsmWarning,
}));

function makeRequest(body: unknown): Request {
  return new Request('http://localhost/api/dust-profiles/batching-precheck', {
    method: 'POST',
    headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/dust-profiles/batching-precheck', () => {
  beforeEach(() => {
    for (const key of Object.keys(tableResults)) delete tableResults[key];
    tableResults.sensitive_receptors = { data: [], error: null };
    mockRequireUserIdResult = { userId: 'user-1' };
    mockOwnershipResult = true;
    mockOsmWarning = null;
  });

  it('يرفض بلا مصادقة (401)', async () => {
    mockRequireUserIdResult = { error: new Response(null, { status: 401 }) };
    const { POST } = await import('./route');
    const res = await POST(makeRequest({ projectId: 'p1', lat: 24.7, lng: 46.6 }));
    expect(res.status).toBe(401);
  });

  it('يرفض المستخدم غير مالك المشروع (403)', async () => {
    mockOwnershipResult = false;
    const { POST } = await import('./route');
    const res = await POST(makeRequest({ projectId: 'p1', lat: 24.7, lng: 46.6 }));
    expect(res.status).toBe(403);
  });

  it('يرفض بلا projectId', async () => {
    const { POST } = await import('./route');
    const res = await POST(makeRequest({ lat: 24.7, lng: 46.6 }));
    expect(res.status).toBe(400);
  });

  it('يرفض بلا lat/lng صالحين', async () => {
    const { POST } = await import('./route');
    const res = await POST(makeRequest({ projectId: 'p1', lat: 'x', lng: 46.6 }));
    expect(res.status).toBe(400);
  });

  it('لا مستقبلات قريبة → blocked=false', async () => {
    const { POST } = await import('./route');
    const res = await POST(makeRequest({ projectId: 'p1', lat: 24.7, lng: 46.6 }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.blocked).toBe(false);
    expect(body.reasonsAr).toEqual([]);
  });

  it('مسجد على بُعد 100م (أقل من 200م) → blocked=true (المساجد تُحسَب ضمن nearestAnyM)', async () => {
    tableResults.sensitive_receptors = {
      data: [{ id: 'r1', name: 'مسجد', receptor_type: 'MOSQUE', lat: 24.7009, lng: 46.6 }],
      error: null,
    };
    const { POST } = await import('./route');
    const res = await POST(makeRequest({ projectId: 'p1', lat: 24.7, lng: 46.6 }));
    const body = await res.json();
    expect(body.blocked).toBe(true);
    expect(body.nearestReceptorM).not.toBeNull();
    expect(body.nearestReceptorM).toBeLessThan(200);
  });

  it('مستقبل سكني على بُعد 300م (أبعد من 200م) → blocked=false', async () => {
    tableResults.sensitive_receptors = {
      data: [{ id: 'r1', name: 'حي سكني', receptor_type: 'RESIDENTIAL', lat: 24.703, lng: 46.6 }],
      error: null,
    };
    const { POST } = await import('./route');
    const res = await POST(makeRequest({ projectId: 'p1', lat: 24.7, lng: 46.6 }));
    const body = await res.json();
    expect(body.blocked).toBe(false);
  });

  it('فشل استعلام sensitive_receptors → 503 PLACEMENT_NOT_VERIFIED صريح، لا أمان كاذب', async () => {
    tableResults.sensitive_receptors = { data: null, error: { message: 'db down' } };
    const { POST } = await import('./route');
    const res = await POST(makeRequest({ projectId: 'p1', lat: 24.7, lng: 46.6 }));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe('PLACEMENT_NOT_VERIFIED');
  });

  // طلب صريح من المستخدم — نفس إصلاح crusher-precheck: sensitive_receptors
  // اليدوي فارغ لا يعني عدم وجود مستقبِل حساس حقيقي.
  it('OSM يكتشف معلَماً قريباً رغم sensitive_receptors فارغ → blocked=true بتحذير OSM', async () => {
    mockOsmWarning = 'تحذير: تم اكتشاف معلَم قريب محتمل الحساسية عبر خرائط OpenStreetMap ("مسجد أبو بكر الصديق"، على بُعد 7 م تقريباً) — بيانات غير رسمية تتطلب تحققاً ميدانياً.';
    const { POST } = await import('./route');
    const res = await POST(makeRequest({ projectId: 'p1', lat: 24.7, lng: 46.6 }));
    const body = await res.json();
    expect(body.blocked).toBe(true);
    expect(body.reasonsAr).toContain(mockOsmWarning);
  });

  it('لا تحذير OSM ولا مستقبلات يدوية قريبة → blocked=false', async () => {
    mockOsmWarning = null;
    const { POST } = await import('./route');
    const res = await POST(makeRequest({ projectId: 'p1', lat: 24.7, lng: 46.6 }));
    const body = await res.json();
    expect(body.blocked).toBe(false);
  });
});
