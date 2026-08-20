import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { timingSafeStringEqual } from '@/app/lib/timingSafe';
import { evaluateProject } from '@/app/lib/evaluateProject';
import { recordWorkerHeartbeat } from '@/app/lib/workerHeartbeat';

const WORKER_NAME = 'scheduler-worker';

/*
 * Scheduler Worker Execution Engine — Section 10.2 of Mirqab Core Architecture:
 * Claims and processes batched evaluation tasks from `project_evaluation_jobs` using row-level locking
 * (`FOR UPDATE SKIP LOCKED`) combined with time-based lease protection.
 *
 * Operational & Concurrency Control Highlights:
 * 1. Resilient Lock Recovery: Expired leases (default: 90s) automatically allow secondary workers
 *    to reclaim stalled or abandoned jobs (e.g., following instance timeouts or restarts).
 * 2. Pre-Execution Lease Renewal: Explicitly verifies ownership via `renew_evaluation_job_lease` 
 *    prior to execution, preventing stale workers from completing jobs claimed elsewhere.
 * 3. Historical Evaluation Precision: Accepts explicit observation timestamps (`evaluation_at`) 
 *    from telemetry payloads to evaluate conditions at event time rather than processing time.
 * 4. Distinct Worker Heartbeats: Feeds worker telemetry (`worker_heartbeats`) to monitor health 
 *    independently from the tick dispatcher (`scheduler-tick`).
 */
const BATCH_SIZE = 20;
const LEASE_SECONDS = 90;
const MAX_ATTEMPTS = 5;

export async function GET(request: Request) {
  if (!process.env.SCHEDULER_CRON_SECRET) {
    return NextResponse.json({ ok: false, error: 'SCHEDULER_CRON_SECRET غير مُعرَّف بالخادم' }, { status: 503 });
  }
  const authHeader = request.headers.get('authorization') || '';
  if (!timingSafeStringEqual(authHeader, `Bearer ${process.env.SCHEDULER_CRON_SECRET}`)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const workerId = crypto.randomUUID();
  await recordWorkerHeartbeat(WORKER_NAME, 'started');

  /*
   * Claim available evaluation jobs batch with active lease duration
   */
  const { data: jobs, error: claimError } = await supabaseAdmin.rpc('claim_evaluation_jobs', {
    p_worker_id: workerId,
    p_batch_size: BATCH_SIZE,
    p_lease_seconds: LEASE_SECONDS,
  });

  if (claimError) {
    await recordWorkerHeartbeat(WORKER_NAME, 'failed', claimError.message);
    return NextResponse.json({ ok: false, error: claimError.message }, { status: 500 });
  }

  const results: Array<{ jobId: string; projectId: string; ok: boolean; error?: string }> = [];

  /*
   * Sequential Processing Loop: Ensures execution clarity and controlled database load
   */
  for (const job of jobs || []) {
    // Confirm ownership and extend lock window before commencing evaluation
    const renewed = await supabaseAdmin.rpc('renew_evaluation_job_lease', {
      p_job_id: job.id,
      p_worker_id: workerId,
      p_lease_seconds: LEASE_SECONDS,
    });
    if (renewed.error || !renewed.data) {
      results.push({ jobId: job.id, projectId: job.project_id, ok: false, error: 'lease لم يعد يطابق (استرجعه عامل آخر) — تم التخطي بلا معالجة' });
      continue;
    }

    try {
      // Parse specific evaluation timestamp if originating from telemetry ingestion
      const evaluationAtMs = job.evaluation_at ? new Date(job.evaluation_at as string).getTime() : undefined;
      const evalResult = await evaluateProject(job.project_id, 'scheduler', evaluationAtMs);

      if (evalResult.success) {
        const { data: completed, error: completeError } = await supabaseAdmin.rpc('complete_evaluation_job', {
          p_job_id: job.id,
          p_worker_id: workerId,
        });

        if (completeError || !completed) {
          results.push({
            jobId: job.id,
            projectId: job.project_id,
            ok: false,
            error: completeError?.message || 'complete_evaluation_job: lease لم يعد يطابق (استرجعه عامل آخر) رغم نجاح التقييم',
          });
        } else {
          results.push({ jobId: job.id, projectId: job.project_id, ok: true });
        }
      } else {
        const { data: failed, error: failRpcError } = await supabaseAdmin.rpc('fail_evaluation_job', {
          p_job_id: job.id,
          p_worker_id: workerId,
          p_error: evalResult.error ?? 'فشل تقييم غير محدَّد',
          p_max_attempts: MAX_ATTEMPTS,
        });
        results.push({
          jobId: job.id,
          projectId: job.project_id,
          ok: false,
          error: failRpcError || !failed ? `${evalResult.error} (lease لم يعد يطابق عند fail)` : evalResult.error,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`scheduler-worker: evaluateProject threw for project ${job.project_id}:`, message);
      await supabaseAdmin.rpc('fail_evaluation_job', {
        p_job_id: job.id,
        p_worker_id: workerId,
        p_error: message,
        p_max_attempts: MAX_ATTEMPTS,
      });
      results.push({ jobId: job.id, projectId: job.project_id, ok: false, error: message });
    }
  }

  const failedCount = results.filter((r) => !r.ok).length;
  const status = results.length === 0 || failedCount === 0 ? 200 : failedCount === results.length ? 502 : 207;

  /*
   * Record Operational Worker Health Status
   */
  if (status === 502) {
    await recordWorkerHeartbeat(WORKER_NAME, 'failed', `${failedCount}/${results.length} مهام فشلت`);
  } else {
    await recordWorkerHeartbeat(WORKER_NAME, 'succeeded');
  }

  return NextResponse.json(
    {
      ok: failedCount === 0,
      checkedAt: new Date().toISOString(),
      workerId,
      claimed: results.length,
      failed: failedCount,
      results,
    },
    { status }
  );
}