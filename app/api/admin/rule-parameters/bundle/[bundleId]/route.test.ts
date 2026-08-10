import { describe, it, expect, vi, beforeEach } from 'vitest';

type TableResult = { data: unknown; error: { message: string } | null };
const tableResults: Record<string, TableResult> = {};

function makeChain(tableName: string) {
  const result = tableResults[tableName] ?? { data: null, error: null };
  const chain: Record<string, unknown> = {
    select: () => chain,
    eq: () => chain,
    order: () => chain,
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

vi.mock('@/app/lib/apiAuth', () => ({
  requireSuperAdmin: async () => ({ userId: 'admin-1', role: 'admin' as const }),
}));

function makeRequest() {
  return new Request('http://localhost') as never;
}

describe('GET /api/admin/rule-parameters/bundle/[bundleId]', () => {
  beforeEach(() => {
    for (const key of Object.keys(tableResults)) delete tableResults[key];
    tableResults.rule_parameter_publication_bundles = {
      data: {
        id: 'bundle-1',
        status: 'PUBLISHED',
        change_reason_ar: 'ملف تشغيلي جديد',
        published_by: 'admin-1',
        published_at: '2026-08-10T00:00:00Z',
        is_rollback: false,
        rolled_back_from_bundle_id: null,
        created_at: '2026-08-10T00:00:00Z',
      },
      error: null,
    };
    tableResults.rule_parameter_versions = {
      data: [
        {
          id: 'v1', parameter_code: 'WIND_GATE_ENHANCED_MIN_KMH', value: 16, status: 'PUBLISHED',
          supersedes_version_id: 'v0', created_at: '2026-08-10T00:00:00Z',
          rule_parameter_definitions: { label_ar: 'بداية نطاق الرياح المعزَّز', unit: 'كم/س' },
        },
      ],
      error: null,
    };
  });

  it('يرجع 404 عندما البندلة غير موجودة', async () => {
    tableResults.rule_parameter_publication_bundles = { data: null, error: null };
    const { GET } = await import('./route');
    const res = await GET(makeRequest(), { params: Promise.resolve({ bundleId: 'missing' }) });
    expect(res.status).toBe(404);
  });

  it('يرجع رأس البندلة وكل الأعضاء مع تسمية المعامل', async () => {
    const { GET } = await import('./route');
    const res = await GET(makeRequest(), { params: Promise.resolve({ bundleId: 'bundle-1' }) });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.bundle.id).toBe('bundle-1');
    expect(body.bundle.changeReasonAr).toBe('ملف تشغيلي جديد');
    expect(body.members).toHaveLength(1);
    expect(body.members[0].parameterCode).toBe('WIND_GATE_ENHANCED_MIN_KMH');
    expect(body.members[0].labelAr).toBe('بداية نطاق الرياح المعزَّز');
  });
});
