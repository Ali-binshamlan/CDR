import { describe, it, expect, vi, beforeEach } from 'vitest';

// نموّه supabaseAdmin بمنشئ استعلام سلسلي عام (from/select/eq/in/lte/or/
// order/limit/maybeSingle) يعيد قيمة مُهيَّأة لكل جدول عبر TABLE_RESULTS —
// القسم 17 (P1 — "مراقبة Queue وProvider وScheduler"): يتحقق هذا الاختبار
// من منطق حساب الإنذار (alert) لكل نظام فرعي (Scheduler/Provider Pull/
// Alert Outbox) بمعزل عن قاعدة بيانات حقيقية، لا من صحة استعلامات SQL نفسها
// (يغطيها supabase/tests/*.dbtest.ts).
type TableResult = { count?: number | null; data?: unknown; error?: { message: string } | null };
const tableResults: Record<string, TableResult> = {};

function makeChain(tableName: string) {
  const result = tableResults[tableName] ?? { count: 0, data: null, error: null };
  const chain: Record<string, unknown> = {
    eq: () => chain,
    in: () => chain,
    lte: () => chain,
    or: () => chain,
    order: () => chain,
    limit: () => chain,
    maybeSingle: async () => ({ data: result.data ?? null, error: result.error ?? null }),
    select: () => chain,
    // thenable — استعلامات count-mode (head:true) لا تستدعي maybeSingle/limit
    // صراحة، بل تُنتظَر مباشرة (await supabaseAdmin.from(...).select(...)...)
    then: (resolve: (value: { count: number | null; error: { message: string } | null }) => void) =>
      resolve({ count: result.count ?? 0, error: result.error ?? null }),
  };
  return chain;
}

vi.mock('@/app/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from: (tableName: string) => ({
      select: () => makeChain(tableName),
    }),
  },
}));

vi.mock('@/app/lib/timingSafe', () => ({
  timingSafeStringEqual: (a: string, b: string) => a === b,
}));

const SECRET = 'test-scheduler-secret';

function makeRequest(): Request {
  return new Request('http://localhost/api/cron/scheduler-heartbeat', {
    headers: { authorization: `Bearer ${SECRET}` },
  });
}

describe('GET /api/cron/scheduler-heartbeat', () => {
  beforeEach(() => {
    process.env.SCHEDULER_CRON_SECRET = SECRET;
    for (const key of Object.keys(tableResults)) delete tableResults[key];
    tableResults.scheduler_heartbeat = {
      data: { last_heartbeat_at: new Date().toISOString(), last_successful_project_evaluation_at: new Date().toISOString() },
    };
    tableResults.project_evaluation_jobs = { count: 0 };
    tableResults.provider_connections = { count: 0 };
    tableResults.decision_alert_outbox = { count: 0, data: null };
  });

  it('يرفض بلا سر مُعرَّف بالخادم', async () => {
    delete process.env.SCHEDULER_CRON_SECRET;
    const { GET } = await import('./route');
    const res = await GET(makeRequest());
    expect(res.status).toBe(503);
  });

  it('يرفض ترويسة Authorization غير مطابقة', async () => {
    const { GET } = await import('./route');
    const res = await GET(new Request('http://localhost', { headers: { authorization: 'Bearer wrong' } }));
    expect(res.status).toBe(401);
  });

  it('ok=true عندما كل الأنظمة الفرعية سليمة', async () => {
    const { GET } = await import('./route');
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.alert).toBe(false);
    expect(body.scheduler.alert).toBe(false);
    expect(body.provider_pull.alert).toBe(false);
    expect(body.alert_outbox.alert).toBe(false);
  });

  it('ينذر عندما يغيب Heartbeat أكثر من 3 دقائق', async () => {
    tableResults.scheduler_heartbeat = {
      data: { last_heartbeat_at: new Date(Date.now() - 10 * 60_000).toISOString(), last_successful_project_evaluation_at: null },
    };
    const { GET } = await import('./route');
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.scheduler.alert).toBe(true);
    expect(body.ok).toBe(false);
  });

  it('ينذر عندما توجد اتصالات provider فاشلة', async () => {
    tableResults.provider_connections = { count: 2 };
    const { GET } = await import('./route');
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.provider_pull.alert).toBe(true);
    expect(body.ok).toBe(false);
  });

  it('ينذر عندما توجد صفوف outbox ميتة (DEAD)', async () => {
    tableResults.decision_alert_outbox = { count: 1, data: null };
    const { GET } = await import('./route');
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.alert_outbox.alert).toBe(true);
    expect(body.ok).toBe(false);
  });
});
