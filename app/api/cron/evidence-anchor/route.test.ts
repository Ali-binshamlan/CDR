import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// نموّه supabaseAdmin — يغطي: قراءة آخر صف من evidence_hash_ledger، تسجيل
// النتيجة في evidence_anchor_runs (حتى عند فشل GitHub)، وعزل فشل GitHub عن
// فشل قاعدة البيانات.
type LedgerRow = {
  seq: number;
  chain_hash: string;
  source_table: string;
  source_row_id: string;
  row_created_at: string;
} | null;

let ledgerRow: LedgerRow = {
  seq: 42,
  chain_hash: 'abc123',
  source_table: 'final_decisions',
  source_row_id: '11111111-1111-1111-1111-111111111111',
  row_created_at: '2026-08-10T00:00:00Z',
};
let ledgerError: { message: string } | null = null;
let anchorInsertError: { message: string } | null = null;
const anchorInserts: Record<string, unknown>[] = [];

vi.mock('@/app/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === 'evidence_hash_ledger') {
        return {
          select: () => ({
            order: () => ({
              limit: () => ({
                maybeSingle: async () => ({ data: ledgerRow, error: ledgerError }),
              }),
            }),
          }),
        };
      }
      if (table === 'evidence_anchor_runs') {
        return {
          insert: async (row: Record<string, unknown>) => {
            anchorInserts.push(row);
            return { error: anchorInsertError };
          },
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
  },
}));

vi.mock('@/app/lib/timingSafe', () => ({
  timingSafeStringEqual: (a: string, b: string) => a === b,
}));

const SECRET = 'test-evidence-anchor-secret';
const GITHUB_TOKEN = 'test-github-token';
const GITHUB_REPO = 'Ali-binshamlan/CDR';

function makeRequest(): Request {
  return new Request('http://localhost/api/cron/evidence-anchor', {
    headers: { authorization: `Bearer ${SECRET}` },
  });
}

const originalFetch = global.fetch;

describe('GET /api/cron/evidence-anchor', () => {
  beforeEach(() => {
    process.env.EVIDENCE_ANCHOR_CRON_SECRET = SECRET;
    process.env.GITHUB_EVIDENCE_ANCHOR_TOKEN = GITHUB_TOKEN;
    process.env.GITHUB_EVIDENCE_ANCHOR_REPO = GITHUB_REPO;
    ledgerRow = {
      seq: 42,
      chain_hash: 'abc123',
      source_table: 'final_decisions',
      source_row_id: '11111111-1111-1111-1111-111111111111',
      row_created_at: '2026-08-10T00:00:00Z',
    };
    ledgerError = null;
    anchorInsertError = null;
    anchorInserts.length = 0;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.resetModules();
  });

  it('يرفض بلا سر مُعرَّف بالخادم', async () => {
    delete process.env.EVIDENCE_ANCHOR_CRON_SECRET;
    const { GET } = await import('./route');
    const res = await GET(makeRequest());
    expect(res.status).toBe(503);
  });

  it('يرفض ترويسة Authorization غير مطابقة', async () => {
    const { GET } = await import('./route');
    const res = await GET(new Request('http://localhost', { headers: { authorization: 'Bearer wrong' } }));
    expect(res.status).toBe(401);
  });

  it('يرفض بلا GITHUB_EVIDENCE_ANCHOR_TOKEN/GITHUB_EVIDENCE_ANCHOR_REPO', async () => {
    delete process.env.GITHUB_EVIDENCE_ANCHOR_TOKEN;
    const { GET } = await import('./route');
    const res = await GET(makeRequest());
    expect(res.status).toBe(503);
  });

  it('الدفتر فارغ (لا صف) → 500 بلا محاولة اتصال بـGitHub', async () => {
    ledgerRow = null;
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;
    const { GET } = await import('./route');
    const res = await GET(makeRequest());
    expect(res.status).toBe(500);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('نجاح كامل: يثبّت على GitHub ويسجّل commit sha في evidence_anchor_runs', async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      json: async () => ({ commit: { sha: 'deadbeef' } }),
    }));
    global.fetch = fetchSpy as unknown as typeof fetch;

    const { GET } = await import('./route');
    const res = await GET(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.githubCommitSha).toBe('deadbeef');
    expect(body.ledgerSeq).toBe(42);
    expect(anchorInserts.length).toBe(1);
    expect(anchorInserts[0].github_commit_sha).toBe('deadbeef');
    expect(anchorInserts[0].error).toBeNull();
  });

  it('فشل GitHub (HTTP غير ok) → يُسجَّل في evidence_anchor_runs مع error، بلا github_commit_sha', async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: false,
      status: 409,
      text: async () => 'conflict',
    }));
    global.fetch = fetchSpy as unknown as typeof fetch;

    const { GET } = await import('./route');
    const res = await GET(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body.ok).toBe(false);
    expect(body.githubCommitSha).toBeNull();
    expect(anchorInserts.length).toBe(1);
    expect(anchorInserts[0].github_commit_sha).toBeNull();
    expect(anchorInserts[0].error).toContain('409');
  });

  it('استثناء أثناء fetch (شبكة/timeout) → يُسجَّل في evidence_anchor_runs مع رسالة الخطأ', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('network timeout');
    });
    global.fetch = fetchSpy as unknown as typeof fetch;

    const { GET } = await import('./route');
    const res = await GET(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body.error).toBe('network timeout');
    expect(anchorInserts[0].error).toBe('network timeout');
  });

  it('فشل قراءة الدفتر (DB error) → 500 بلا محاولة اتصال بـGitHub', async () => {
    ledgerError = { message: 'db down' };
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;

    const { GET } = await import('./route');
    const res = await GET(makeRequest());
    expect(res.status).toBe(500);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('فشل إدراج evidence_anchor_runs بعد نجاح GitHub → 500', async () => {
    anchorInsertError = { message: 'insert failed' };
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      json: async () => ({ commit: { sha: 'deadbeef' } }),
    }));
    global.fetch = fetchSpy as unknown as typeof fetch;

    const { GET } = await import('./route');
    const res = await GET(makeRequest());
    expect(res.status).toBe(500);
  });
});
