import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { timingSafeStringEqual } from '@/app/lib/timingSafe';

/*
 * Scheduler Tick Route — Section 10.1 of Mirqab Architecture Optimization Spec:
 * Decouples job scheduling from execution by creating distinct evaluation tasks
 * in `project_evaluation_jobs` for each active project per 2-minute bucket window.
 *
 * Operational & Concurrency Control Highlights:
 * 1. Asynchronous Decoupling: Offloads execution to `scheduler-worker`, preventing long-running 
 *    evaluations from causing HTTP timeouts or lock contention in the scheduler tick.
 * 2. Early Bucket Lock: Uses `scheduler_tick_run_lock` (bucket-based PK) to short-circuit redundant 
 *    cron-job.org executions, suppressing wasted DB reads and unnecessary I/O budget consumption.
 * 3. Idempotent Enqueueing: Relies on unique constraints on `(project_id, dedupe_key)` within 
 *    `project_evaluation_jobs` (violating `23505` triggers a graceful skipped state).
 */
const SCHEDULER_BUCKET_MS = 2 * 60_000;

export async function GET(request: Request) {
  if (!process.env.SCHEDULER_CRON_SECRET) {
    return NextResponse.json({ ok: false, error: 'SCHEDULER_CRON_SECRET غير مُعرَّف بالخادم' }, { status: 503 });
  }
  const authHeader = request.headers.get('authorization') || '';
  if (!timingSafeStringEqual(authHeader, `Bearer ${process.env.SCHEDULER_CRON_SECRET}`)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const timeBucket = Math.floor(Date.now() / SCHEDULER_BUCKET_MS);
  const dedupeKey = `scheduled:${timeBucket}`;

  /*
   * Single-execution window lock check to prevent concurrent I/O overhead
   */
  const { error: runLockError } = await supabaseAdmin
    .from('scheduler_tick_run_lock')
    .insert({ run_bucket: timeBucket });
  if (runLockError) {
    if (runLockError.code === '23505') {
      return NextResponse.json(
        { ok: true, skipped: true, reason: 'previous scheduler-tick run already handled this window', timeBucket },
        { status: 200 }
      );
    }
    return NextResponse.json({ ok: false, error: runLockError.message }, { status: 500 });
  }

  const { data: projects, error: fetchError } = await supabaseAdmin
    .from('projects')
    .select('id')
    .is('archived_at', null);

  if (fetchError) {
    return NextResponse.json({ ok: false, error: fetchError.message }, { status: 500 });
  }

  const results: Array<{ projectId: string; enqueued: boolean; skipped?: boolean; error?: string }> = [];

  /*
   * Sequential Enqueueing: Enforces batch isolation and clear status tracing
   */
  for (const project of projects || []) {
    const { error: insertError } = await supabaseAdmin.from('project_evaluation_jobs').insert({
      project_id: project.id,
      dedupe_key: dedupeKey,
      trigger_type: 'SCHEDULED',
    });

    if (insertError) {
      if (insertError.code === '23505') {
        results.push({ projectId: project.id, enqueued: false, skipped: true });
      } else {
        results.push({ projectId: project.id, enqueued: false, error: insertError.message });
      }
      continue;
    }

    results.push({ projectId: project.id, enqueued: true });
  }

  /*
   * Record Scheduler Dispatch Heartbeat
   */
  await supabaseAdmin
    .from('scheduler_heartbeat')
    .update({ last_heartbeat_at: new Date().toISOString() })
    .eq('id', true);

  const failedCount = results.filter((r) => r.error).length;
  const status = results.length === 0 || failedCount === 0 ? 200 : failedCount === results.length ? 502 : 207;

  return NextResponse.json(
    {
      ok: failedCount === 0,
      checkedAt: new Date().toISOString(),
      timeBucket,
      total: results.length,
      failed: failedCount,
      results,
    },
    { status }
  );
}