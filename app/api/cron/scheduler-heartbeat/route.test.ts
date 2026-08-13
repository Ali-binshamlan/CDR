import { describe, it, expect, vi, beforeEach } from 'vitest';

// نموّه supabaseAdmin بمنشئ استعلام سلسلي عام (from/select/eq/in/lte/or/
// order/limit/maybeSingle) يعيد قيمة مُهيَّأة لكل جدول عبر TABLE_RESULTS —
// القسم 17 (P1 — "مراقبة Queue وProvider وScheduler"): يتحقق هذا الاختبار
// من منطق حساب الإنذار (alert) لكل نظام فرعي (Scheduler/Provider Pull/
// Alert Outbox) بمعزل عن قاعدة بيانات حقيقية، لا من صحة استعلامات SQL نفسها
// (يغطيها supabase/tests/*.dbtest.ts).
type TableResult = { count?: number | null; data?: unknown; error?: { message: string } | null };
const tableResults: Record<string, TableResult> = {};
// يسجّل قيم .in() الفعلية لكل جدول — يُستخدَم للتحقق من أن استعلامات outbox
// تشمل RETRY فعلياً (اختبار قبول صريح أدناه)، لا لفلترة النتائج المُعادة
// (makeChain لا تُطبِّق الفلاتر فعلياً على البيانات، فقط تُسجِّلها).
const inCallsByTable: Record<string, string[][]> = {};

function makeChain(tableName: string) {
  const result = tableResults[tableName] ?? { count: 0, data: null, error: null };
  const chain: Record<string, unknown> = {
    eq: () => chain,
    in: (_col: string, values: string[]) => {
      (inCallsByTable[tableName] ??= []).push(values);
      return chain;
    },
    lte: () => chain,
    gte: () => chain,
    or: () => chain,
    is: () => chain,
    order: () => chain,
    limit: () => chain,
    maybeSingle: async () => ({ data: result.data ?? null, error: result.error ?? null }),
    select: () => chain,
    // thenable — يدعم كلا الشكلين: count-mode (head:true، لا data مصفوفة
    // مُعرَّفة في نتيجة الجدول) يُرجع {count, error}؛ استعلام مصفوفة صريح
    // (worker_heartbeats.select().in() بلا maybeSingle) يُرجع {data, error}
    // إن كانت result.data مصفوفة فعلاً (خطأ مكتشَف ومُصلَح — طلب صريح من
    // المستخدم: "لا نبضة مستقلة لكل Worker"، migration 202608120013).
    then: (resolve: (value: { count?: number | null; data?: unknown; error: { message: string } | null }) => void) =>
      Array.isArray(result.data)
        ? resolve({ data: result.data, error: result.error ?? null })
        : resolve({ count: result.count ?? 0, error: result.error ?? null }),
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
//
// خطأ مكتشَف ومُصلَح (طلب صريح من المستخدم — مراجعة كود خارجي: "فحص Hash لا
// يقارن السجل بالمصدر الأصلي"): verify_evidence_source_integrity (migration
// 202608120010) RPC ثالثة — تكتشف تعديل/حذف الصف المصدر نفسه، لا فقط الدفتر.
let rpcChainVerify: Array<{ seq: number; is_valid: boolean }> = [];
let rpcSourceVerify: Array<{ seq: number; is_valid: boolean; source_row_missing: boolean }> = [];
let rpcTriggerIntegrity: Array<{ table_name: string; trigger_name: string; is_enabled: boolean }> = [];
// خطأ مكتشَف (طلب صريح من المستخدم — مراجعة كود خارجي: "لا Backfill للأدلة
// القديمة"): get_evidence_chain_coverage_started_at (migration 202608120011)
// RPC رابعة — نقطة بداية تغطية السلسلة صراحة، معلوماتية بحتة (لا alert).
let rpcCoverageStartedAt: string | null = new Date('2026-08-11T00:00:00.000Z').toISOString();

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
      if (fn === 'verify_evidence_source_integrity') {
        return { data: rpcSourceVerify, error: null };
      }
      if (fn === 'check_evidence_trigger_integrity') {
        return { data: rpcTriggerIntegrity, error: null };
      }
      if (fn === 'get_evidence_chain_coverage_started_at') {
        return { data: rpcCoverageStartedAt, error: null };
      }
      return { data: null, error: null };
    },
  },
}));

vi.mock('@/app/lib/timingSafe', () => ({
  timingSafeStringEqual: (a: string, b: string) => a === b,
}));

const SECRET = 'test-scheduler-secret';
// نفس القيمة الثابتة في route.ts (HEARTBEAT_STALE_SECONDS) — منسوخة هنا
// محلياً (لا استيراد من route.ts، الملف لا يُصدِّرها) لبناء فارق زمني أكيد
// التجاوز في الاختبار أعلاه بلا اعتماد هش على رقم سحري مكرَّر بلا تفسير.
const HEARTBEAT_STALE_SECONDS_TEST = 180;

function makeRequest(): Request {
  return new Request('http://localhost/api/cron/scheduler-heartbeat', {
    headers: { authorization: `Bearer ${SECRET}` },
  });
}

// يُحدِّث نبضة عامل واحد ضمن tableResults.worker_heartbeats.data دون المساس
// ببقية العمال الأربعة — يُستخدَم في اختبارات db_cleanup/workers أدناه.
function setWorkerHeartbeat(workerName: string, overrides: Record<string, unknown>) {
  const rows = (tableResults.worker_heartbeats?.data as Array<Record<string, unknown>>) ?? [];
  tableResults.worker_heartbeats = {
    data: rows.map((r) => (r.worker_name === workerName ? { ...r, ...overrides } : r)),
  };
}

describe('GET /api/cron/scheduler-heartbeat', () => {
  beforeEach(() => {
    process.env.SCHEDULER_CRON_SECRET = SECRET;
    for (const key of Object.keys(tableResults)) delete tableResults[key];
    for (const key of Object.keys(inCallsByTable)) delete inCallsByTable[key];
    tableResults.scheduler_heartbeat = {
      data: { last_heartbeat_at: new Date().toISOString(), last_successful_project_evaluation_at: new Date().toISOString() },
    };
    tableResults.project_evaluation_jobs = { count: 0 };
    tableResults.provider_connections = { count: 0 };
    tableResults.decision_alert_outbox = { count: 0, data: null };
    tableResults.telemetry_ingestion_queue = { count: 0, data: null };
    // خطأ مكتشَف ومُصلَح (طلب صريح من المستخدم — "لا نبضة مستقلة لكل Worker"):
    // worker_heartbeats (migration 202608120013) يحل محل db_cleanup_run_lock
    // كمصدر لصحة db-cleanup-worker، ويضيف نبضة مستقلة لبقية العمال الأربعة.
    // كل العمال الخمسة "سليمون" افتراضياً (نجحوا للتو) — كل اختبار يُخصِّص
    // ما يحتاجه فقط.
    tableResults.worker_heartbeats = {
      data: [
        'telemetry-worker',
        'alert-outbox-worker',
        'provider-pull',
        'scheduler-worker',
        'db-cleanup-worker',
      ].map((worker_name) => ({
        worker_name,
        last_run_started_at: new Date().toISOString(),
        last_run_succeeded_at: new Date().toISOString(),
        last_run_failed_at: null,
        last_error: null,
      })),
    };
    tableResults.evidence_anchor_runs = { data: { anchored_at: new Date().toISOString(), error: null } };
    rpcTableSizes = [];
    rpcChainVerify = [{ seq: 1, is_valid: true }];
    rpcSourceVerify = [{ seq: 1, is_valid: true, source_row_missing: false }];
    rpcTriggerIntegrity = [{ table_name: 'final_decisions', trigger_name: 'final_decisions_immutable', is_enabled: true }];
    rpcCoverageStartedAt = new Date('2026-08-11T00:00:00.000Z').toISOString();
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

  // اختبار قبول صريح (طلب المستخدم بالحرف — "يقيس heartbeat الخاص بالـtick
  // بدل آخر تقييم ناجح"): last_heartbeat_at حديث (scheduler-tick يعمل، ينشئ
  // مهام بنجاح) لكن last_successful_project_evaluation_at قديم جداً (تقييم
  // فعلي متوقّف، عامل scheduler-worker معطَّل) → alert=true. قبل الإصلاح كان
  // هذا يُظهر alert=false (أخضر زائف) لاعتماده على last_heartbeat_at وحده.
  it('ينذر عندما last_heartbeat_at حديث لكن last_successful_project_evaluation_at قديم جداً (تقييم فعلي متوقّف رغم أن tick يعمل)', async () => {
    tableResults.scheduler_heartbeat = {
      data: {
        last_heartbeat_at: new Date().toISOString(), // scheduler-tick حديث تماماً
        last_successful_project_evaluation_at: new Date(Date.now() - 30 * 60_000).toISOString(), // لكن لا تقييم ناجح منذ 30 دقيقة
      },
    };
    const { GET } = await import('./route');
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(res.status).toBe(503);
    expect(body.scheduler.alert).toBe(true);
    expect(body.scheduler.evaluation_lag_seconds).toBeGreaterThan(HEARTBEAT_STALE_SECONDS_TEST);
  });

  // اختبارا قبول صريحان (طلب المستخدم بالحرف — "jobs_due/jobs_dead لا يدخلان
  // دائمًا في قرار الصحة"): باكلوغ ضخم يجب أن يُنذِر حتى لو last_successful_
  // project_evaluation_at حديثاً تماماً (نبضة حية لا تعني عدم وجود تراكم).
  it('ينذر عندما jobs_due يتجاوز عتبة الباكلوغ (100) رغم last_successful_project_evaluation_at حديث', async () => {
    tableResults.project_evaluation_jobs = { count: 150 };
    const { GET } = await import('./route');
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(res.status).toBe(503);
    expect(body.scheduler.jobs_backlog_alert).toBe(true);
    expect(body.scheduler.alert).toBe(true);
  });

  it('ينذر عندما jobs_dead يتجاوز عتبة (10) رغم last_successful_project_evaluation_at حديث', async () => {
    tableResults.project_evaluation_jobs = { count: 15 };
    const { GET } = await import('./route');
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(res.status).toBe(503);
    expect(body.scheduler.jobs_backlog_alert).toBe(true);
  });

  it('لا إنذار باكلوغ عندما jobs_due وjobs_dead تحت العتبتين معاً', async () => {
    tableResults.project_evaluation_jobs = { count: 5 };
    const { GET } = await import('./route');
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.scheduler.jobs_backlog_alert).toBe(false);
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

  // اختبار قبول صريح (طلب المستخدم بالحرف — "Outbox RETRY غير محسوبة"):
  // استعلامات alert_outbox (pending وoldest_pending) يجب أن تشمل RETRY في
  // .in()، لا PENDING/RUNNING فقط — صف فشل مرة (RETRY، ينتظر backoff) لا
  // يجوز أن يختفي من الفحص.
  it('استعلامات alert_outbox تشمل RETRY صراحة في .in() (لا PENDING/RUNNING فقط)', async () => {
    const { GET } = await import('./route');
    await GET(makeRequest());
    const outboxInCalls = inCallsByTable.decision_alert_outbox ?? [];
    const statusFilterCalls = outboxInCalls.filter((values) => values.includes('PENDING'));
    expect(statusFilterCalls.length).toBeGreaterThan(0);
    for (const values of statusFilterCalls) {
      expect(values).toContain('RETRY');
    }
  });

  // خطة الاحتفاظ طويلة المدى (2026-08-10) — قسم db_cleanup: يكشف تعطّل
  // db-cleanup-worker نفسه (لا فقط تعطّل الاستقبال/المعالجة).
  //
  // خطأ مكتشَف ومُصلَح (طلب صريح من المستخدم — "Cleanup يقيس started_at
  // كأنه نجاح"): worker_heartbeats (migration 202608120013) يحل محل
  // db_cleanup_run_lock.started_at كمصدر — started_at كان يُقاس كـ"نجاح"
  // لمجرد بداية الدورة، حتى لو فشلت لاحقاً.
  it('ينذر عندما تغيب دورة db-cleanup-worker الناجحة أكثر من 3 ساعات', async () => {
    const staleIso = new Date(Date.now() - 4 * 3600_000).toISOString();
    setWorkerHeartbeat('db-cleanup-worker', { last_run_started_at: staleIso, last_run_succeeded_at: staleIso });
    const { GET } = await import('./route');
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(res.status).toBe(503);
    expect(body.db_cleanup.alert).toBe(true);
    expect(body.ok).toBe(false);
  });

  it('لا إنذار db_cleanup عندما آخر تشغيلة حديثة (ضمن 3 ساعات)', async () => {
    const recentIso = new Date(Date.now() - 30 * 60_000).toISOString();
    setWorkerHeartbeat('db-cleanup-worker', { last_run_started_at: recentIso, last_run_succeeded_at: recentIso });
    const { GET } = await import('./route');
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.db_cleanup.alert).toBe(false);
  });

  // اختبار قبول صريح (طلب المستخدم بالحرف): "Cleanup يقيس started_at كأنه
  // نجاح" — دورة بدأت (started_at حديث) لكن فشلت (last_run_failed_at أحدث
  // من last_run_succeeded_at) يجب أن تُنذِر، رغم حداثة started_at نفسها.
  it('ينذر db_cleanup عندما بدأت الدورة (started_at حديث) لكنها فشلت فعلياً (last_run_failed_at أحدث من succeeded)', async () => {
    const startedIso = new Date(Date.now() - 60_000).toISOString();
    const failedIso = new Date(Date.now() - 30_000).toISOString();
    const oldSucceededIso = new Date(Date.now() - 5 * 3600_000).toISOString();
    setWorkerHeartbeat('db-cleanup-worker', {
      last_run_started_at: startedIso,
      last_run_succeeded_at: oldSucceededIso,
      last_run_failed_at: failedIso,
      last_error: 'فشل حذف دفعة',
    });
    const { GET } = await import('./route');
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(res.status).toBe(503);
    expect(body.db_cleanup.alert).toBe(true);
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

  // اختبارا قبول صريحان (طلب المستخدم — تقرير المراجعة الخارجي: "فحص Hash لا
  // يقارن السجل بالمصدر الأصلي"): verify_evidence_source_integrity منفصلة عن
  // verify_evidence_chain_tail — تكتشف تعديل/حذف الصف المصدر نفسه حتى لو بقي
  // الدفتر (evidence_hash_ledger) سليماً تماماً بلا أي تلاعب فيه هو نفسه.
  it('ينذر evidence_integrity عندما يختلف row_hash المصدر المُعاد حسابه عن المخزَّن (تعديل الصف الأصلي مباشرة)', async () => {
    rpcSourceVerify = [{ seq: 5, is_valid: false, source_row_missing: false }];
    const { GET } = await import('./route');
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(res.status).toBe(503);
    expect(body.evidence_integrity.alert).toBe(true);
    expect(body.evidence_integrity.source_integrity_broken).toBe(true);
    // السلسلة نفسها (chain_broken) تبقى سليمة — التلاعب في المصدر لا الدفتر.
    expect(body.evidence_integrity.chain_broken).toBe(false);
  });

  it('ينذر evidence_integrity عندما يكون الصف المصدر محذوفاً (source_row_missing=true)', async () => {
    rpcSourceVerify = [{ seq: 7, is_valid: false, source_row_missing: true }];
    const { GET } = await import('./route');
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(res.status).toBe(503);
    expect(body.evidence_integrity.alert).toBe(true);
    expect(body.evidence_integrity.source_rows_missing).toEqual([7]);
  });

  // اختبار قبول صريح (طلب المستخدم — تقرير المراجعة الخارجي: "لا Backfill
  // للأدلة القديمة"): chain_coverage_started_at يُعرَض في الاستجابة، معلوماتياً
  // بحتاً — لا يؤثر على evidenceIntegrityAlert (قيمة ثابتة، لا تتغيّر بمرور
  // الوقت، فلا معنى لتنبيه متكرر عليها).
  it('يعرض chain_coverage_started_at من get_evidence_chain_coverage_started_at بلا التأثير على alert', async () => {
    const { GET } = await import('./route');
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.evidence_integrity.chain_coverage_started_at).toBe('2026-08-11T00:00:00.000Z');
    expect(body.evidence_integrity.alert).toBe(false);
  });

  it('chain_coverage_started_at=null (RPC لم تُنشَر بعد) لا يُسقِط الاستجابة، يُعرَض null صراحة', async () => {
    rpcCoverageStartedAt = null;
    const { GET } = await import('./route');
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.evidence_integrity.chain_coverage_started_at).toBeNull();
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

  // اختبار قبول صريح (طلب المستخدم بالحرف — "أخطاء معظم استعلامات القياس
  // تُهمل وتصبح أصفارًا"): فشل استعلام واحد (حتى لو كل الحقول المشتقة منه
  // بلا خطأ ظاهر لأن count=null → ?? 0) يجب أن يُسقِط الصحة العامة صراحة عبر
  // query_errors/queryErrorsAlert — لا "صفر صحي" صامت.
  it('ينذر عندما يفشل استعلام قياس واحد (حتى لو بقية الأنظمة سليمة) — query_errors غير فارغة، alert=true', async () => {
    tableResults.provider_connections = { count: null, error: { message: 'connection pool exhausted' } };
    const { GET } = await import('./route');
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(res.status).toBe(503);
    expect(body.query_errors.length).toBeGreaterThan(0);
    expect(body.query_errors.some((e: string) => e.includes('connection pool exhausted'))).toBe(true);
    expect(body.alert).toBe(true);
    // provider_pull.alert نفسه قد يبقى false (count ?? 0 = 0 ظاهرياً) — هذا
    // بالضبط سبب الحاجة لـqueryErrorsAlert منفصلة: لا يعتمد الاكتشاف على أن
    // كل استهلاك للحقل يتحقق من الخطأ بنفسه.
    expect(body.query_errors).toContain('provider_connections_failing: connection pool exhausted');
  });

  // ستة اختبارات قبول صريحة (طلب المستخدم بالحرف — "لا توجد نبضة مستقلة لكل
  // Worker"): قسم workers الجديد يعكس worker_heartbeats مباشرة، ويُنذِر عند
  // تأخر أي عامل أو فشل آخر محاولة له، بصرف النظر عن حالة بقية الأنظمة.
  describe('قسم workers (worker_heartbeats) — اختبار قبول صريح', () => {
    it('كل العمال الخمسة سليمون افتراضياً (نجحوا للتو) → workers كلها alert=false', async () => {
      const { GET } = await import('./route');
      const res = await GET(makeRequest());
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.workers).toHaveLength(5);
      expect(body.workers.every((w: { alert: boolean }) => w.alert === false)).toBe(true);
    });

    it('ينذر عندما عامل واحد بلا أي نبضة مسجَّلة إطلاقاً (غائب عن worker_heartbeats)', async () => {
      const rows = (tableResults.worker_heartbeats?.data as Array<Record<string, unknown>>) ?? [];
      tableResults.worker_heartbeats = { data: rows.filter((r) => r.worker_name !== 'telemetry-worker') };
      const { GET } = await import('./route');
      const res = await GET(makeRequest());
      const body = await res.json();
      expect(res.status).toBe(503);
      const telemetryWorker = body.workers.find((w: { worker: string }) => w.worker === 'telemetry-worker');
      expect(telemetryWorker.alert).toBe(true);
      expect(telemetryWorker.lag_seconds).toBeNull();
      expect(body.alert).toBe(true);
    });

    it('ينذر عندما عامل نجح منذ فترة طويلة (lag_seconds > 300)، status=503', async () => {
      const staleIso = new Date(Date.now() - 10 * 60_000).toISOString();
      setWorkerHeartbeat('alert-outbox-worker', { last_run_started_at: staleIso, last_run_succeeded_at: staleIso });
      const { GET } = await import('./route');
      const res = await GET(makeRequest());
      const body = await res.json();
      expect(res.status).toBe(503);
      const worker = body.workers.find((w: { worker: string }) => w.worker === 'alert-outbox-worker');
      expect(worker.alert).toBe(true);
      expect(worker.lag_seconds).toBeGreaterThan(300);
    });

    it('ينذر عندما آخر محاولة لعامل فشلت (last_run_failed_at أحدث من last_run_succeeded_at) حتى لو النبضة حديثة زمنياً', async () => {
      const oldSucceededIso = new Date(Date.now() - 3600_000).toISOString();
      const recentFailedIso = new Date().toISOString();
      setWorkerHeartbeat('provider-pull', {
        last_run_started_at: recentFailedIso,
        last_run_succeeded_at: oldSucceededIso,
        last_run_failed_at: recentFailedIso,
        last_error: 'GitHub 502',
      });
      const { GET } = await import('./route');
      const res = await GET(makeRequest());
      const body = await res.json();
      expect(res.status).toBe(503);
      const worker = body.workers.find((w: { worker: string }) => w.worker === 'provider-pull');
      expect(worker.alert).toBe(true);
      expect(worker.last_error).toBe('GitHub 502');
    });

    it('لا إنذار عامل عندما last_run_failed_at أقدم من last_run_succeeded_at (فشل قديم، نجح لاحقاً)', async () => {
      const oldFailedIso = new Date(Date.now() - 3600_000).toISOString();
      const recentSucceededIso = new Date().toISOString();
      setWorkerHeartbeat('scheduler-worker', {
        last_run_started_at: recentSucceededIso,
        last_run_succeeded_at: recentSucceededIso,
        last_run_failed_at: oldFailedIso,
        last_error: 'خطأ قديم تم تجاوزه',
      });
      const { GET } = await import('./route');
      const res = await GET(makeRequest());
      const body = await res.json();
      const worker = body.workers.find((w: { worker: string }) => w.worker === 'scheduler-worker');
      expect(worker.alert).toBe(false);
    });
  });
});
