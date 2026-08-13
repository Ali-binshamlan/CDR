import { describe, it, expect, vi, beforeEach } from 'vitest';

// نموّه supabaseAdmin — يغطي: قفل تداخل الدورة (db_cleanup_run_lock)،
// حلقة الدفعات لكل جدول (cleanup_transient_table_batch[_by_age])، عزل
// فشل جدول واحد عن البقية (207 جزئي)، وحد MAX_BATCHES_PER_TABLE.
type RpcCall = { fn: string; args: Record<string, unknown> };

let insertError: { code: string; message: string } | null = null;
const rpcCalls: RpcCall[] = [];
// دالة تُرجع عدد الصفوف المحذوفة لكل استدعاء rpc — قابلة للتخصيص لكل اختبار.
let rpcResponder: (fn: string, args: Record<string, unknown>) => { data: number | null; error: { message: string } | null };

vi.mock('@/app/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from: (table: string) => ({
      insert: async (_row: Record<string, unknown>) => {
        if (table === 'db_cleanup_run_lock') {
          return { error: insertError };
        }
        return { error: null };
      },
    }),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      return rpcResponder(fn, args);
    },
  },
}));

vi.mock('@/app/lib/timingSafe', () => ({
  timingSafeStringEqual: (a: string, b: string) => a === b,
}));

const SECRET = 'test-db-cleanup-secret';

function makeRequest(): Request {
  return new Request('http://localhost/api/cron/db-cleanup-worker', {
    headers: { authorization: `Bearer ${SECRET}` },
  });
}

describe('GET /api/cron/db-cleanup-worker', () => {
  beforeEach(() => {
    process.env.DB_CLEANUP_CRON_SECRET = SECRET;
    insertError = null;
    rpcCalls.length = 0;
    rpcResponder = () => ({ data: 0, error: null });
  });

  it('يرفض بلا سر مُعرَّف بالخادم', async () => {
    delete process.env.DB_CLEANUP_CRON_SECRET;
    const { GET } = await import('./route');
    const res = await GET(makeRequest());
    expect(res.status).toBe(503);
  });

  it('يرفض ترويسة Authorization غير مطابقة', async () => {
    const { GET } = await import('./route');
    const res = await GET(new Request('http://localhost', { headers: { authorization: 'Bearer wrong' } }));
    expect(res.status).toBe(401);
  });

  it('تصادم قفل الدورة (INSERT فاشل) → يتخطى بأمان بلا أي استدعاء تنظيف', async () => {
    insertError = { code: '23505', message: 'duplicate key' };
    const { GET } = await import('./route');
    const res = await GET(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.skipped).toBe(true);
    expect(rpcCalls.length).toBe(0);
  });

  it('دورة عادية بلا صفوف مستحقة → ok=true، كل جدول deleted=0', async () => {
    const { GET } = await import('./route');
    const res = await GET(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.totalDeleted).toBe(0);
    // 5 أهداف status (telemetry_ingestion_queue/DEAD حُذف — راجع اختبار
    // الأرشفة أدناه) + 6 أهداف عمر (scheduler_tick_run_lock — 202608130001،
    // forecast_refresh_run_lock — 202608130002) + هدف أرشفة telemetry
    // الجديد = 12 نتيجة
    expect(body.results.length).toBe(12);
    for (const r of body.results) {
      expect(r.deleted).toBe(0);
      expect(r.batches).toBe(1);
    }
  });

  it('حلقة الدفعات تتوقف عند deleted < BATCH_LIMIT (استنفاد)', async () => {
    rpcResponder = () => ({ data: 200, error: null }); // أقل من 500 → دفعة واحدة تكفي
    const { GET } = await import('./route');
    await GET(makeRequest());

    const telemetryProcessedCall = rpcCalls.filter(
      (c) => c.fn === 'cleanup_transient_table_batch' && c.args.p_table_name === 'telemetry_ingestion_queue' && (c.args.p_status_values as string[])[0] === 'PROCESSED'
    );
    expect(telemetryProcessedCall.length).toBe(1);
  });

  it('حلقة الدفعات تستمر عند deleted === BATCH_LIMIT حتى الاستنفاد', async () => {
    let callCount = 0;
    rpcResponder = (fn) => {
      if (fn === 'cleanup_transient_table_batch') {
        callCount++;
        return { data: callCount < 3 ? 500 : 100, error: null }; // 500,500,100 → 3 دفعات
      }
      return { data: 0, error: null };
    };
    const { GET } = await import('./route');
    const res = await GET(makeRequest());
    const body = await res.json();

    const telemetryProcessedResult = body.results.find(
      (r: { table: string; status?: string[] }) => r.table === 'telemetry_ingestion_queue' && r.status?.[0] === 'PROCESSED'
    );
    expect(telemetryProcessedResult.batches).toBe(3);
    expect(telemetryProcessedResult.deleted).toBe(1100);
  });

  it('حلقة الدفعات تتوقف عند MAX_BATCHES_PER_TABLE=20 حتى لو استمر الاستحقاق', async () => {
    rpcResponder = () => ({ data: 500, error: null }); // دائماً دفعة كاملة — استحقاق لا ينتهي
    const { GET } = await import('./route');
    const res = await GET(makeRequest());
    const body = await res.json();

    const telemetryProcessedResult = body.results.find(
      (r: { table: string; status?: string[] }) => r.table === 'telemetry_ingestion_queue' && r.status?.[0] === 'PROCESSED'
    );
    // الحلقة for(;batches<MAX;batches++) تنفّذ 20 محاولة (batches ينتهي
    // بقيمة 20 بعد آخر تكرار)، والنتيجة المسجَّلة batches+1 = 21 — يثبت أن
    // MAX_BATCHES_PER_TABLE=20 حدّ العدد الفعلي لاستدعاءات RPC (لا أكثر).
    expect(telemetryProcessedResult.batches).toBe(21);
    const actualRpcCallsForThisTarget = rpcCalls.filter(
      (c) => c.fn === 'cleanup_transient_table_batch' && c.args.p_table_name === 'telemetry_ingestion_queue' && (c.args.p_status_values as string[])[0] === 'PROCESSED'
    );
    expect(actualRpcCallsForThisTarget.length).toBe(20);
  });

  it('فشل جدول واحد لا يوقف تنظيف بقية الجداول (207 جزئي)', async () => {
    rpcResponder = (fn, args) => {
      if (fn === 'cleanup_transient_table_batch' && args.p_table_name === 'decision_alert_outbox') {
        return { data: null, error: { message: 'boom' } };
      }
      return { data: 0, error: null };
    };
    const { GET } = await import('./route');
    const res = await GET(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(207);
    expect(body.ok).toBe(false);
    const failedResults = body.results.filter((r: { error?: string }) => r.error);
    expect(failedResults.length).toBe(2); // decision_alert_outbox له هدفان (PROCESSED وDEAD)
    // بقية الأهداف (12 - 2 = 10) تبقى ناجحة رغم فشل decision_alert_outbox
    const succeededResults = body.results.filter((r: { error?: string }) => !r.error);
    expect(succeededResults.length).toBe(10);
  });

  it('لا يستدعي أبداً أي RPC باسم جدول أدلة (pm10_readings_history وما شابه)', async () => {
    const { GET } = await import('./route');
    await GET(makeRequest());

    const evidenceTableNames = [
      'decision_records', 'dust_evaluations', 'dust_compliance_evaluations',
      'pm10_readings_history', 'alert_state_events', 'device_readings_history',
      'final_decisions', 'admin_audit_log', 'device_events', 'device_measurements',
    ];
    for (const call of rpcCalls) {
      expect(evidenceTableNames).not.toContain(call.args.p_table_name);
    }
  });

  // =====================================================================
  // اختبار قبول (مراجعة كود خارجي — "صفوف Telemetry الميتة تُحذف بعد سبعة
  // أيام"): telemetry_ingestion_queue/DEAD يجب ألا يُحذف مباشرة بعد الآن —
  // فقط يُؤرشف عبر archive_dead_telemetry_batch (نقل ذرّي إلى telemetry_
  // dead_letter، لا حذف نهائي).
  // =====================================================================
  it('DEAD telemetry لا يُحذف مباشرة عبر cleanup_transient_table_batch إطلاقاً', async () => {
    const { GET } = await import('./route');
    await GET(makeRequest());

    const directDeleteOfDeadTelemetry = rpcCalls.filter(
      (c) =>
        c.fn === 'cleanup_transient_table_batch' &&
        c.args.p_table_name === 'telemetry_ingestion_queue' &&
        (c.args.p_status_values as string[])?.includes('DEAD')
    );
    expect(directDeleteOfDeadTelemetry.length).toBe(0);
  });

  it('يستدعي archive_dead_telemetry_batch (لا حذف مباشر) لأرشفة DEAD telemetry، ويُدرجها في النتائج', async () => {
    rpcResponder = (fn) => {
      if (fn === 'archive_dead_telemetry_batch') return { data: 42, error: null };
      return { data: 0, error: null };
    };
    const { GET } = await import('./route');
    const res = await GET(makeRequest());
    const body = await res.json();

    const archiveCalls = rpcCalls.filter((c) => c.fn === 'archive_dead_telemetry_batch');
    expect(archiveCalls.length).toBe(1);

    const archiveResult = body.results.find(
      (r: { table: string }) => r.table === 'telemetry_ingestion_queue→telemetry_dead_letter'
    );
    expect(archiveResult).toBeDefined();
    expect(archiveResult.deleted).toBe(42);
  });

  it('فشل archive_dead_telemetry_batch يُبلَّغ كخطأ جزئي بلا إسقاط بقية الأهداف (207)', async () => {
    rpcResponder = (fn) => {
      if (fn === 'archive_dead_telemetry_batch') return { data: null, error: { message: 'archive failed' } };
      return { data: 0, error: null };
    };
    const { GET } = await import('./route');
    const res = await GET(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(207);
    const archiveResult = body.results.find(
      (r: { table: string }) => r.table === 'telemetry_ingestion_queue→telemetry_dead_letter'
    );
    expect(archiveResult.error).toBe('archive failed');
  });
});
