import { describe, it, expect, vi, beforeEach } from 'vitest';

type TableResult = { data: unknown; error: { message: string } | null };
const tableResults: Record<string, TableResult> = {};

function makeChain(tableName: string) {
  const result = tableResults[tableName] ?? { data: null, error: null };
  const chain: Record<string, unknown> = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => ({ data: result.data ?? null, error: result.error ?? null }),
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

// buildOsmProximityWarning يستدعي شبكة Overpass حقيقية بلا هذا التمويه —
// اختبارات هذا الملف تختبر منطق sensitive_receptors اليدوي حصراً، فتُموَّه
// دائماً بـnull (لا تحذير OSM) افتراضياً؛ اختبارات OSM الصريحة أدناه تُغيّر
// mockOsmWarning لكل حالة.
let mockOsmWarning: string | null = null;
vi.mock('@/app/utils/geo/overpassReceptors', () => ({
  buildOsmProximityWarning: async () => mockOsmWarning,
}));

function makeRequest(body: unknown): Request {
  return new Request('http://localhost/api/dust-profiles/crusher-precheck', {
    method: 'POST',
    headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/dust-profiles/crusher-precheck', () => {
  beforeEach(() => {
    for (const key of Object.keys(tableResults)) delete tableResults[key];
    // مشروع فئة ثالثة افتراضياً (مساحة كبيرة) — كل اختبار يُعدِّل ما يلزم.
    tableResults.projects = {
      data: { site_area_m2: 6000, daily_truck_movements: 10, has_onsite_crusher: false, has_onsite_batching_plant: false },
      error: null,
    };
    tableResults.sensitive_receptors = { data: [], error: null };
    mockRequireUserIdResult = { userId: 'user-1' };
    mockOwnershipResult = true;
    mockOsmWarning = null;
  });

  it('يرفض بلا مصادقة (401 من requireUserId)', async () => {
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

  it('مشروع فئة ثالثة + لا مستقبلات قريبة → blocked=false', async () => {
    const { POST } = await import('./route');
    const res = await POST(makeRequest({ projectId: 'p1', lat: 24.7, lng: 46.6 }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.blocked).toBe(false);
    expect(body.riskClass).toBe('CATEGORY_III_HIGH');
    expect(body.reasonsAr).toEqual([]);
  });

  it('مشروع فئة أولى/ثانية (مساحة صغيرة) → blocked=true بسبب الفئة', async () => {
    tableResults.projects = {
      data: { site_area_m2: 1000, daily_truck_movements: 5, has_onsite_crusher: false, has_onsite_batching_plant: false },
      error: null,
    };
    const { POST } = await import('./route');
    const res = await POST(makeRequest({ projectId: 'p1', lat: 24.7, lng: 46.6 }));
    const body = await res.json();
    expect(body.blocked).toBe(true);
    expect(body.riskClass).not.toBe('CATEGORY_III_HIGH');
    expect(body.reasonsAr.length).toBeGreaterThan(0);
  });

  it('مستقبل سكني على بُعد 100م (أقل من 500م) → blocked=true بسبب المسافة', async () => {
    tableResults.sensitive_receptors = {
      data: [{ id: 'r1', name: 'حي سكني', receptor_type: 'RESIDENTIAL', lat: 24.7009, lng: 46.6 }],
      error: null,
    };
    const { POST } = await import('./route');
    const res = await POST(makeRequest({ projectId: 'p1', lat: 24.7, lng: 46.6 }));
    const body = await res.json();
    expect(body.blocked).toBe(true);
    expect(body.nearestResidentialReceptorM).not.toBeNull();
    expect(body.nearestResidentialReceptorM).toBeLessThan(500);
  });

  it('مستقبل غير سكني بعيد (600م) → blocked=false', async () => {
    tableResults.sensitive_receptors = {
      data: [{ id: 'r1', name: 'منطقة صناعية', receptor_type: 'INDUSTRIAL', lat: 24.706, lng: 46.6 }],
      error: null,
    };
    const { POST } = await import('./route');
    const res = await POST(makeRequest({ projectId: 'p1', lat: 24.7, lng: 46.6 }));
    const body = await res.json();
    expect(body.blocked).toBe(false);
  });

  it('فشل استعلام sensitive_receptors → 500 صريح، لا أمان كاذب', async () => {
    tableResults.sensitive_receptors = { data: null, error: { message: 'db down' } };
    const { POST } = await import('./route');
    const res = await POST(makeRequest({ projectId: 'p1', lat: 24.7, lng: 46.6 }));
    expect(res.status).toBe(500);
  });

  it('فشل استعلام المشروع → 500', async () => {
    tableResults.projects = { data: null, error: { message: 'db down' } };
    const { POST } = await import('./route');
    const res = await POST(makeRequest({ projectId: 'p1', lat: 24.7, lng: 46.6 }));
    expect(res.status).toBe(500);
  });

  // طلب صريح من المستخدم — ثغرة مكتشفة: sensitive_receptors اليدوي فارغ
  // لا يعني بالضرورة عدم وجود مستقبِل حساس حقيقي (مثال حقيقي: مسجد على 7م
  // من كسارة، مكتشَف عبر OpenStreetMap لكن غير مُدخَل يدوياً بعد).
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
