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
    gte: () => chain,
    or: () => chain,
    is: () => chain,
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

// evidence_growth (خطة الاحتفاظ طويلة المدى، 2026-08-10) يستدعي RPC
// get_database_and_table_sizes بدل .from() — نموذج منفصل، قابل للتخصيص لكل
// اختبار عبر rpcTableSizes.
let rpcTableSizes: Array<{ table_name: string; total_bytes: number; row_estimate: number | null }> = [];

// evidence_integrity (بنية Tamper-Evidence، 2026-08-10) يستدعي RPCين إضافيين
// (verify_evidence_chain_tail/check_evidence_trigger_integrity) — افتراضياً
// سلسلة سليمة وكل triggers مفعَّلة، قابل للتخصيص لكل اختبار.
let rpcChainVerify: Array<{ seq: number; is_valid: boolean }> = [];
let rpcTriggerIntegrity: Array<{ table_name: string; trigger_name: string; is_enabled: boolean }> = [];

vi.mock('@/app/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from: (tableName: string) => ({
      select: () => makeChain(tableName),
    }),
    rpc: async (fn: string) => {
      if (fn === 'get_database_and_table_sizes') {
        return { data: rpcTableSizes, error: null };
      }
      if (fn === 'verify_evidence_chain_tail') {
        return { data: rpcChainVerify, error: null };
      }
      if (fn === 'check_evidence_trigger_integrity') {
        return { data: rpcTriggerIntegrity, error: null };
      }
      return { data: null, error: null };
    },
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
    tableResults.telemetry_ingestion_queue = { count: 0, data: null };
    tableResults.db_cleanup_run_lock = { data: { started_at: new Date().toISOString() } };
    tableResults.evidence_anchor_runs = { data: { anchored_at: new Date().toISOString(), error: null } };
    rpcTableSizes = [];
    rpcChainVerify = [{ seq: 1, is_valid: true }];
    rpcTriggerIntegrity = [{ table_name: 'final_decisions', trigger_name: 'final_decisions_immutable', is_enabled: true }];
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

  it('ok=true عندما كل الأنظمة الفرعية سليمة، status=200', async () => {
    const { GET } = await import('./route');
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.alert).toBe(false);
    expect(body.scheduler.alert).toBe(false);
    expect(body.provider_pull.alert).toBe(false);
    expect(body.alert_outbox.alert).toBe(false);
    expect(body.evidence_integrity.alert).toBe(false);
  });

  // خطأ مكتشَف ومُصلَح (طلب صريح من المستخدم — ربط بمراقبة UptimeRobot
  // خارجية فعلية): status يجب أن يكون 503 (لا 200) عند alert=true حتى تلتقط
  // أدوات المراقبة القياسية العطل فعلياً وترسل التنبيه — راجع تعليق route.ts.
  it('ينذر عندما يغيب Heartbeat أكثر من 3 دقائق، status=503', async () => {
    tableResults.scheduler_heartbeat = {
      data: { last_heartbeat_at: new Date(Date.now() - 10 * 60_000).toISOString(), last_successful_project_evaluation_at: null },
    };
    const { GET } = await import('./route');
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(res.status).toBe(503);
    expect(body.scheduler.alert).toBe(true);
    expect(body.ok).toBe(false);
  });

  it('ينذر عندما توجد اتصالات provider فاشلة، status=503', async () => {
    tableResults.provider_connections = { count: 2 };
    const { GET } = await import('./route');
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(res.status).toBe(503);
    expect(body.provider_pull.alert).toBe(true);
    expect(body.ok).toBe(false);
  });

  it('ينذر عندما توجد صفوف outbox ميتة (DEAD)، status=503', async () => {
    tableResults.decision_alert_outbox = { count: 1, data: null };
    const { GET } = await import('./route');
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(res.status).toBe(503);
    expect(body.alert_outbox.alert).toBe(true);
    expect(body.ok).toBe(false);
  });

  // خطة الاحتفاظ طويلة المدى (2026-08-10) — قسم db_cleanup: يكشف تعطّل
  // db-cleanup-worker نفسه (لا فقط تعطّل الاستقبال/المعالجة).
  it('ينذر عندما تغيب دورة db-cleanup-worker الناجحة أكثر من 3 ساعات', async () => {
    tableResults.db_cleanup_run_lock = { data: { started_at: new Date(Date.now() - 4 * 3600_000).toISOString() } };
    const { GET } = await import('./route');
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(res.status).toBe(503);
    expect(body.db_cleanup.alert).toBe(true);
    expect(body.ok).toBe(false);
  });

  it('لا إنذار db_cleanup عندما آخر تشغيلة حديثة (ضمن 3 ساعات)', async () => {
    tableResults.db_cleanup_run_lock = { data: { started_at: new Date(Date.now() - 30 * 60_000).toISOString() } };
    const { GET } = await import('./route');
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.db_cleanup.alert).toBe(false);
  });

  // قسم evidence_growth: عتبات رقمية صريحة على حجم القاعدة الكلي وأكبر
  // جدول أدلة منفرد — لا تنفّذ أي حذف، قراءة فقط عبر get_database_and_table_sizes.
  it('لا إنذار evidence_growth عندما الحجم الكلي وكل جدول أدلة تحت العتبات', async () => {
    rpcTableSizes = [
      { table_name: 'pm10_readings_history', total_bytes: 10 * 1024 * 1024, row_estimate: 100 },
      { table_name: 'dust_evaluations', total_bytes: 5 * 1024 * 1024, row_estimate: 50 },
    ];
    const { GET } = await import('./route');
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.evidence_growth.alert).toBe(false);
    expect(body.evidence_growth.warn).toBe(false);
    expect(body.evidence_growth.total_database_bytes).toBe(15 * 1024 * 1024);
  });

  it('ينذر evidence_growth عندما يتجاوز الحجم الكلي عتبة الإنذار (425MB)', async () => {
    rpcTableSizes = [
      { table_name: 'pm10_readings_history', total_bytes: 430 * 1024 * 1024, row_estimate: 1000000 },
    ];
    const { GET } = await import('./route');
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(res.status).toBe(503);
    expect(body.evidence_growth.alert).toBe(true);
    expect(body.ok).toBe(false);
  });

  it('ينذر evidence_growth عندما يتجاوز جدول أدلة منفرد 500MB حتى لو الحجم الكلي أقل من ذلك', async () => {
    rpcTableSizes = [
      { table_name: 'dust_evaluations', total_bytes: 510 * 1024 * 1024, row_estimate: 10 },
      { table_name: 'telemetry_ingestion_queue', total_bytes: 1024, row_estimate: 5 }, // جدول عابر، غير أدلة — لا يُحسَب ضمن largest_evidence_tables
    ];
    const { GET } = await import('./route');
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.evidence_growth.alert).toBe(true);
    expect(body.evidence_growth.largest_evidence_tables[0].table).toBe('dust_evaluations');
    expect(body.evidence_growth.largest_evidence_tables.every((t: { table: string }) => t.table !== 'telemetry_ingestion_queue')).toBe(true);
  });

  it('warn=true (لا alert) عندما الحجم بين عتبة التحذير والإنذار', async () => {
    rpcTableSizes = [
      { table_name: 'pm10_readings_history', total_bytes: 360 * 1024 * 1024, row_estimate: 1000 },
    ];
    const { GET } = await import('./route');
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.evidence_growth.warn).toBe(true);
    expect(body.evidence_growth.alert).toBe(false);
    // تحذير فقط (لا إنذار) لا يجب أن يُسقط الاستجابة إلى 503 بمفرده
    expect(res.status).toBe(200);
  });

  // بنية Tamper-Evidence (2026-08-10) — قسم evidence_integrity: ثلاثة أسباب
  // مستقلة للإنذار (سلسلة مكسورة، trigger معطَّل، تثبيت GitHub متأخر).
  it('ينذر evidence_integrity عندما تكسر verify_evidence_chain_tail صفاً واحداً', async () => {
    rpcChainVerify = [
      { seq: 3, is_valid: true },
      { seq: 2, is_valid: false },
      { seq: 1, is_valid: true },
    ];
    const { GET } = await import('./route');
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(res.status).toBe(503);
    expect(body.evidence_integrity.alert).toBe(true);
    expect(body.evidence_integrity.chain_broken).toBe(true);
    expect(body.ok).toBe(false);
  });

  it('ينذر evidence_integrity عندما trigger حماية معطَّل على جدول أدلة', async () => {
    rpcTriggerIntegrity = [
      { table_name: 'final_decisions', trigger_name: 'final_decisions_immutable', is_enabled: false },
    ];
    const { GET } = await import('./route');
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(res.status).toBe(503);
    expect(body.evidence_integrity.alert).toBe(true);
    expect(body.evidence_integrity.disabled_triggers).toEqual([
      { table: 'final_decisions', trigger: 'final_decisions_immutable' },
    ]);
  });

  it('ينذر evidence_integrity عندما يتأخر آخر تثبيت GitHub ناجح أكثر من ساعتين', async () => {
    tableResults.evidence_anchor_runs = {
      data: { anchored_at: new Date(Date.now() - 3 * 3600_000).toISOString(), error: null },
    };
    const { GET } = await import('./route');
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(res.status).toBe(503);
    expect(body.evidence_integrity.alert).toBe(true);
    expect(body.evidence_integrity.anchor_stale).toBe(true);
  });

  it('ينذر evidence_integrity عندما لا يوجد أي تثبيت GitHub ناجح إطلاقاً (data=null)', async () => {
    tableResults.evidence_anchor_runs = { data: null };
    const { GET } = await import('./route');
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(res.status).toBe(503);
    expect(body.evidence_integrity.alert).toBe(true);
    expect(body.evidence_integrity.anchor_lag_seconds).toBeNull();
  });
});
