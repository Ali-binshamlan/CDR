import { describe, it, expect, vi, beforeEach } from 'vitest';

type TableResult = { data: unknown; error: { message: string } | null };
const tableResults: Record<string, TableResult> = {};

// يسجّل كل استدعاء .is(column, value) لكل جدول — يسمح للاختبار الحرج أدناه
// بالتحقق فعلياً أن project_dust_profiles استُعلِمَت بشرط
// archived_at is null، لا مجرد نجاح المسار شكلياً بلا تحقق حقيقي من الفلتر.
const isCallsByTable: Record<string, [string, unknown][]> = {};

function makeChain(tableName: string) {
  const result = tableResults[tableName] ?? { data: null, error: null };
  const chain: Record<string, unknown> = {
    select: () => chain,
    eq: () => chain,
    is: (column: string, value: unknown) => {
      (isCallsByTable[tableName] ??= []).push([column, value]);
      return chain;
    },
    in: () => chain,
    gte: () => chain,
    lte: () => chain,
    order: () => chain,
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
vi.mock('@/app/lib/apiAuth', () => ({
  requireUserId: async () => mockRequireUserIdResult,
}));

// شكل أدنى يكفي GET (نفس نمط بقية اختبارات route.test.ts في المشروع —
// NextRequest الحقيقي لا يُنشأ بسهولة خارج بيئة Next.js).
type NextRequestLike = { nextUrl: URL };

function makeRequest(from: string, to: string): NextRequestLike {
  return { nextUrl: new URL(`http://localhost/api/dashboard/schedule?from=${from}&to=${to}`) };
}

describe('GET /api/dashboard/schedule', () => {
  beforeEach(() => {
    for (const key of Object.keys(tableResults)) delete tableResults[key];
    for (const key of Object.keys(isCallsByTable)) delete isCallsByTable[key];
    mockRequireUserIdResult = { userId: 'user-1' };
    tableResults.projects = { data: [{ id: 'p1', name: 'مشروع 1' }], error: null };
    tableResults.project_dust_profiles = { data: [], error: null };
  });

  // خطأ مكتشَف ومُصلَح (طلب صريح من المستخدم — "اذا سويت نشاط و حذفته لا
  // زال يظهر في الجدوله"): استعلام project_dust_profiles لم يكن يفلتر
  // archived_at — نشاط مؤرشَف (محذوف عبر DELETE /api/activities، يضبط
  // archived_at على project_dust_profiles نفسها) ضمن مشروع لا يزال نشطاً
  // كان يبقى ظاهراً في جدول الأسبوع. هذا الاختبار يتحقق فعلياً (لا شكلياً)
  // أن الاستعلام يمرر .is('archived_at', null) على project_dust_profiles،
  // بنفس طريقة فحص فلترة المشاريع المؤرشفة.
  it('يستعلم project_dust_profiles بشرط archived_at is null (لا تظهر الأنشطة المحذوفة/المؤرشفة)', async () => {
    const { GET } = await import('./route');
    const res = await GET(makeRequest('2026-08-16', '2026-08-22') as never);
    expect(res.status).toBe(200);
    expect(isCallsByTable.project_dust_profiles).toContainEqual(['archived_at', null]);
  });

  it('يستعلم projects بشرط archived_at is null (نفس الفلترة القائمة على مستوى المشروع)', async () => {
    const { GET } = await import('./route');
    const res = await GET(makeRequest('2026-08-16', '2026-08-22') as never);
    expect(res.status).toBe(200);
    expect(isCallsByTable.projects).toContainEqual(['archived_at', null]);
  });

  it('يعيد الأنشطة المُرجَعة فعلياً من الاستعلام (المصفَّاة مسبقاً على مستوى القاعدة)', async () => {
    tableResults.project_dust_profiles = {
      data: [
        { id: 'a1', project_id: 'p1', activity_type: 'HEAVY_EQUIPMENT_MOVEMENT', regulatory_activity: 'CRUSHER', planned_date: '2026-08-17', planned_time: '08:00:00', duration_hours: 2 },
      ],
      error: null,
    };
    const { GET } = await import('./route');
    const res = await GET(makeRequest('2026-08-16', '2026-08-22') as never);
    const body = await res.json();
    expect(body.activities).toHaveLength(1);
    expect(body.activities[0].id).toBe('a1');
  });

  it('لا مشاريع غير مؤرشفة للمستخدم → قائمة فارغة بلا استعلام أنشطة', async () => {
    tableResults.projects = { data: [], error: null };
    const { GET } = await import('./route');
    const res = await GET(makeRequest('2026-08-16', '2026-08-22') as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.projects).toEqual([]);
    expect(body.activities).toEqual([]);
  });

  it('from/to غائبان → 400', async () => {
    const { GET } = await import('./route');
    const res = await GET({ nextUrl: new URL('http://localhost/api/dashboard/schedule') } as never);
    expect(res.status).toBe(400);
  });
});
