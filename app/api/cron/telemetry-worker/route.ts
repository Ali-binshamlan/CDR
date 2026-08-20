import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { timingSafeStringEqual } from '@/app/lib/timingSafe';
import { writeDeviceReading } from '@/app/lib/deviceReadingWriter';
import { recordWorkerHeartbeat } from '@/app/lib/workerHeartbeat';
import type { NormalizedReading } from '@/app/lib/providers/types';

const WORKER_NAME = 'telemetry-worker';

/*
 * Telemetry Queue Processing Worker — Phases 3 & 4 Architecture Implementation:
 * Processes raw IoT telemetry queue entries from `telemetry_ingestion_queue` completely 
 * decoupled from provider-pull ingestion routines.
 *
 * Operational Strategy & Technical Safeguards:
 * 1. Claim-Commit-Process Cycle: Uses atomic `claim_telemetry_queue` RPC calls with explicit worker leases (60s)
 *    to prevent duplicate processing across distributed worker instances.
 * 2. Atomic Event Completion & Evaluation Enqueueing: Employs `complete_telemetry_queue_row_and_enqueue_job` 
 *    to execute row status transitions to `PROCESSED` and evaluation job creation (`project_evaluation_jobs`) 
 *    within a single atomic database transaction, ensuring zero dangling raw records without downstream triggers.
 * 3. Granular Lease Verification: Continuously verifies and extends lease ownership via `renew_telemetry_queue_lease` 
 *    prior to handling each record, safely skipping stalled rows claimed by secondary workers during long batches.
 * 4. Precise Historical Coalescing: Derives evaluation time windows (`p_evaluation_at`) from the true sensor reading timestamp
 *    (`observedAtIso`) to maintain unbroken PM10 continuity tracking.
 */
const BATCH_SIZE = 20;
const LEASE_SECONDS = 60;
const MAX_ATTEMPTS = 5;

export async function GET(request: Request) {
  if (!process.env.TELEMETRY_WORKER_CRON_SECRET) {
    return NextResponse.json({ ok: false, error: 'TELEMETRY_WORKER_CRON_SECRET غير مُعرَّف بالخادم' }, { status: 503 });
  }
  const authHeader = request.headers.get('authorization') || '';
  if (!timingSafeStringEqual(authHeader, `Bearer ${process.env.TELEMETRY_WORKER_CRON_SECRET}`)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const workerId = crypto.randomUUID();
  await recordWorkerHeartbeat(WORKER_NAME, 'started');

  /*
   * Claim available telemetry batch with active lease allocation
   */
  const { data: rows, error: claimError } = await supabaseAdmin.rpc('claim_telemetry_queue', {
    p_worker_id: workerId,
    p_batch_size: BATCH_SIZE,
    p_lease_seconds: LEASE_SECONDS,
  });

  if (claimError) {
    await recordWorkerHeartbeat(WORKER_NAME, 'failed', claimError.message);
    return NextResponse.json({ ok: false, error: claimError.message }, { status: 500 });
  }

  const claimedRows = (rows || []) as Array<{
    id: string;
    idempotency_key: string;
    project_id: string;
    device_id: string;
    payload: NormalizedReading;
  }>;

  const results: Array<{ rowId: string; projectId: string; ok: boolean; error?: string }> = [];
  const enqueuedProjectIds = new Set<string>();

  /*
   * Sequential Processing Loop: Maintains chronological observedAt ordering per device
   */
  for (const row of claimedRows) {
    // Confirm lock ownership and extend active lease before execution
    const renewed = await supabaseAdmin.rpc('renew_telemetry_queue_lease', {
      p_row_id: row.id,
      p_worker_id: workerId,
      p_lease_seconds: LEASE_SECONDS,
    });
    if (renewed.error || !renewed.data) {
      results.push({ rowId: row.id, projectId: row.project_id, ok: false, error: 'lease لم يعد يطابق (استرجعه عامل آخر) — تم التخطي بلا معالجة' });
      continue;
    }

    try {
      const writeResult = await writeDeviceReading({
        deviceId: row.device_id,
        projectId: row.project_id,
        reading: row.payload,
        externalEventId: row.idempotency_key,
      });

      if (writeResult.success) {
        // Derive evaluation time bucket using the sensor's original timestamp
        const observedMs = row.payload.observedAtIso ? new Date(row.payload.observedAtIso).getTime() : Date.now();
        const observedMinuteBucket = Math.floor(observedMs / 60_000);
        const evaluationAtIso = new Date((observedMinuteBucket + 1) * 60_000 - 1).toISOString();

        // Atomically complete telemetry queue entry and insert corresponding evaluation job
        const { data: completeData, error: completeError } = await supabaseAdmin.rpc(
          'complete_telemetry_queue_row_and_enqueue_job',
          {
            p_row_id: row.id,
            p_worker_id: workerId,
            p_project_id: row.project_id,
            p_dedupe_key: `ingest:${observedMinuteBucket}`,
            p_trigger_type: 'DEVICE_EVENT',
            p_evaluation_at: evaluationAtIso,
          }
        );
        const completeResult = completeData?.[0] as { row_completed?: boolean; job_enqueued?: boolean } | undefined;

        if (completeError || !completeResult?.row_completed) {
          results.push({
            rowId: row.id,
            projectId: row.project_id,
            ok: false,
            error: completeError?.message || 'complete_telemetry_queue_row_and_enqueue_job: lease لم يعد يطابق (استرجعه عامل آخر) رغم نجاح الكتابة',
          });
        } else {
          results.push({ rowId: row.id, projectId: row.project_id, ok: true });
          if (completeResult.job_enqueued) {
            enqueuedProjectIds.add(row.project_id);
          }
        }
      } else {
        const { data: failed, error: failRpcError } = await supabaseAdmin.rpc('fail_telemetry_queue_row', {
          p_row_id: row.id,
          p_worker_id: workerId,
          p_error: writeResult.error,
          p_max_attempts: MAX_ATTEMPTS,
        });

        results.push({
          rowId: row.id,
          projectId: row.project_id,
          ok: false,
          error: failRpcError || !failed ? `${writeResult.error} (lease لم يعد يطابق عند fail)` : writeResult.error,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`telemetry-worker: writeDeviceReading threw for row ${row.id}:`, message);
      await supabaseAdmin.rpc('fail_telemetry_queue_row', {
        p_row_id: row.id,
        p_worker_id: workerId,
        p_error: message,
        p_max_attempts: MAX_ATTEMPTS,
      });
      results.push({ rowId: row.id, projectId: row.project_id, ok: false, error: message });
    }
  }

  const failedCount = results.filter((r) => !r.ok).length;
  const status = results.length === 0 || failedCount === 0 ? 200 : failedCount === results.length ? 502 : 207;

  /*
   * Record Operational Worker Health Status
   */
  if (status === 502) {
    await recordWorkerHeartbeat(WORKER_NAME, 'failed', `${failedCount}/${results.length} صفوف فشلت`);
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
      evaluationJobsEnqueued: enqueuedProjectIds.size,
    },
    { status }
  );
}