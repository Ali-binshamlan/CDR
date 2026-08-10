import { describe, it, expect, vi, beforeEach } from 'vitest';

// نموّه supabaseAdmin — يغطي: التحقق من الملكية (خارج هذا الملف عبر
// requireUserId/verifyProjectOwnership)، upsert لـactivity_groups، قراءة
// work_hours لتحقق أوقات الدوام، قراءة project_devices لحساب device_id
// التلقائي، وأخيراً INSERT الفعلي في project_dust_profiles (نلتقط الحمولة
// النهائية للتحقق من is_dust_generating/activity_type).
type TableResult = { data: unknown; error: { message: string } | null };
const tableResults: Record<string, TableResult> = {};
let lastDustProfileInsert: Record<string, unknown> | null = null;

function makeChain(tableName: string) {
  const result = tableResults[tableName] ?? { data: null, error: null };
  const chain: Record<string, unknown> = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => ({ data: result.data ?? null, error: result.error ?? null }),
    upsert: async () => ({ error: null }),
    insert: async (row: Record<string, unknown>) => {
      if (tableName === 'project_dust_profiles') lastDustProfileInsert = row;
      return { error: result.error ?? null };
    },
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

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';

function makeRequest(insert: Record<string, unknown>): Request {
  return new Request('http://localhost/api/dust-profiles', {
    method: 'POST',
    headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
    body: JSON.stringify({ insert }),
  });
}

// حمولة أساسية صالحة — كسارة (CRUSHER) بـactivity_type المتوافق فعلياً
// (HEAVY_EQUIPMENT_MOVEMENT)، مع كل الحقول الإلزامية.
function baseInsert(overrides: Record<string, unknown> = {}) {
  return {
    project_id: PROJECT_ID,
    activity_type: 'HEAVY_EQUIPMENT_MOVEMENT',
    regulatory_activity: 'CRUSHER',
    planned_date: '2999-01-01',
    planned_time: '09:00',
    duration_hours: 2,
    ...overrides,
  };
}

describe('POST /api/dust-profiles', () => {
  beforeEach(() => {
    for (const key of Object.keys(tableResults)) delete tableResults[key];
    lastDustProfileInsert = null;
    mockRequireUserIdResult = { userId: 'user-1' };
    mockOwnershipResult = true;
    tableResults.projects = { data: { work_hours_start: null, work_hours_end: null }, error: null };
    tableResults.project_devices = { data: [], error: null };
  });

  it('يرفض بلا مصادقة', async () => {
    mockRequireUserIdResult = { error: new Response(null, { status: 401 }) };
    const { POST } = await import('./route');
    const res = await POST(makeRequest(baseInsert()) as never);
    expect(res.status).toBe(401);
  });

  it('يرفض المستخدم غير مالك المشروع', async () => {
    mockOwnershipResult = false;
    const { POST } = await import('./route');
    const res = await POST(makeRequest(baseInsert()) as never);
    expect(res.status).toBe(403);
  });

  // خطأ أمني مكتشَف ومُصلَح — طلب صريح من المستخدم.
  describe('is_dust_generating لا يمكن التحكم به من العميل', () => {
    it('is_dust_generating=false مُرسَلة من العميل → تُتجاهَل، الصف يُحفَظ true دائماً', async () => {
      const { POST } = await import('./route');
      const res = await POST(makeRequest(baseInsert({ is_dust_generating: false })) as never);
      expect(res.status).toBe(200);
      expect(lastDustProfileInsert?.is_dust_generating).toBe(true);
    });

    it('is_dust_generating غير مُرسَلة إطلاقاً → لا تزال true صراحةً في الحمولة النهائية', async () => {
      const { POST } = await import('./route');
      const res = await POST(makeRequest(baseInsert()) as never);
      expect(res.status).toBe(200);
      expect(lastDustProfileInsert?.is_dust_generating).toBe(true);
    });
  });

  // خطأ أمني مكتشَف ومُصلَح — طلب صريح من المستخدم: activity_type يجب أن
  // يطابق النوع الجائز فعلياً لـregulatory_activity المُرسَل معه.
  describe('تحقق تناسب activity_type مع regulatory_activity', () => {
    it('CRUSHER مع activity_type مطابق (HEAVY_EQUIPMENT_MOVEMENT) → 200', async () => {
      const { POST } = await import('./route');
      const res = await POST(makeRequest(baseInsert()) as never);
      expect(res.status).toBe(200);
    });

    it('CRUSHER مع activity_type مخالف (INDOOR_WORK) → 400، لا يُحفَظ شيء', async () => {
      const { POST } = await import('./route');
      const res = await POST(makeRequest(baseInsert({ activity_type: 'INDOOR_WORK' })) as never);
      expect(res.status).toBe(400);
      expect(lastDustProfileInsert).toBeNull();
    });

    it('DEMOLITION مع activity_type مطابق (HEAVY_EQUIPMENT_MOVEMENT) → 200', async () => {
      const { POST } = await import('./route');
      const res = await POST(
        makeRequest(baseInsert({ regulatory_activity: 'DEMOLITION', activity_type: 'HEAVY_EQUIPMENT_MOVEMENT' })) as never
      );
      expect(res.status).toBe(200);
    });

    it('EARTHWORKS مع activity_type مطابق (GRADING) → 200', async () => {
      const { POST } = await import('./route');
      const res = await POST(
        makeRequest(baseInsert({ regulatory_activity: 'EARTHWORKS', activity_type: 'GRADING' })) as never
      );
      expect(res.status).toBe(200);
    });

    it('EARTHWORKS مع activity_type مخالف (CRANE_LIFTING) → 400', async () => {
      const { POST } = await import('./route');
      const res = await POST(
        makeRequest(baseInsert({ regulatory_activity: 'EARTHWORKS', activity_type: 'CRANE_LIFTING' })) as never
      );
      expect(res.status).toBe(400);
    });

    it('BATCHING_PLANT مع activity_type مطابق (CONCRETE_POURING) → 200', async () => {
      const { POST } = await import('./route');
      const res = await POST(
        makeRequest(baseInsert({ regulatory_activity: 'BATCHING_PLANT', activity_type: 'CONCRETE_POURING' })) as never
      );
      expect(res.status).toBe(200);
    });

    it('OTHER بلا نوع متوقَّع محدد → أي activity_type صالح يُقبَل بلا رفض تناسب', async () => {
      const { POST } = await import('./route');
      const res = await POST(
        makeRequest(baseInsert({ regulatory_activity: 'OTHER', activity_type: 'OFFICE_WORK' })) as never
      );
      expect(res.status).toBe(200);
    });

    it('ENTRY_EXIT (صف قديم، غير قابل للإنشاء من الواجهة الحالية) بلا نوع متوقَّع محدد → لا رفض تناسب', async () => {
      const { POST } = await import('./route');
      const res = await POST(
        makeRequest(baseInsert({ regulatory_activity: 'ENTRY_EXIT', activity_type: 'MATERIAL_TRANSPORT' })) as never
      );
      expect(res.status).toBe(200);
    });

    it('regulatory_activity غائبة تماماً → لا تحقق تناسب (اختيارية في الـschema)', async () => {
      const insert = baseInsert();
      delete (insert as Record<string, unknown>).regulatory_activity;
      const { POST } = await import('./route');
      const res = await POST(makeRequest(insert) as never);
      expect(res.status).toBe(200);
    });
  });

  it('device_id المُرسَل من العميل يُتجاهَل، يُشتَق تلقائياً من أقرب جهاز نشط', async () => {
    tableResults.project_devices = {
      data: [{ id: 'device-near', lat: 24.7, lng: 46.6, is_active: true }],
      error: null,
    };
    const { POST } = await import('./route');
    const res = await POST(
      makeRequest(baseInsert({ device_id: 'device-spoofed', activity_lat: 24.7, activity_lng: 46.6 })) as never
    );
    expect(res.status).toBe(200);
    expect(lastDustProfileInsert?.device_id).toBe('device-near');
  });
});
