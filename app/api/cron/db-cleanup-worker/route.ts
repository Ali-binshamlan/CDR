import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { timingSafeStringEqual } from '@/app/lib/timingSafe';
import { recordWorkerHeartbeat } from '@/app/lib/workerHeartbeat';

const WORKER_NAME = 'db-cleanup-worker';

/*
 * Long-Term Data Retention & Maintenance Strategy (Consolidated Endpoint):
 * Manages periodic batch deletion and archival across transient database tables:
 * 1. `telemetry_ingestion_queue` (Processed rows purged, DEAD rows archived to `telemetry_dead_letter`)
 * 2. `decision_alert_outbox`
 * 3. `project_evaluation_jobs`
 * 4. `provider_pull_run_lock`, `scheduler_locks`, `forecast_snapshots`, `db_cleanup_run_lock`, `scheduler_tick_run_lock`, `forecast_refresh_run_lock`
 *
 * Security & Audit Safeguards:
 * - Evidence & Audit Tables: Strictly excluded from deletion. SQL functions enforce explicit table white-listing,
 *   supplemented by database-level triggers blocking deletion/truncation on evidentiary records.
 * - Archival Integrity: Failed telemetry records (`status = 'DEAD'`) are moved atomically to `telemetry_dead_letter`
 *   rather than permanently deleted, preserving field sensor audit trails for manual inspection or replay.
 * - Concurrency Control: Uses `db_cleanup_run_lock` with a 5-minute bucket window to prevent execution overlaps.
 */
const RUN_BUCKET_SECONDS = 300;
const BATCH_LIMIT = 500;
const MAX_BATCHES_PER_TABLE = 20;

type StatusCleanupTarget = {
  table: string;
  timestampColumn: string;
  statusValues: string[];
  olderThan: string;
};

type AgeCleanupTarget = {
  table: string;
  timestampColumn: string;
  olderThan: string;
};

/*
 * Retention Schedules for Transient Queue & Status Tables
 */
const STATUS_TARGETS: StatusCleanupTarget[] = [
  { table: 'telemetry_ingestion_queue', timestampColumn: 'processed_at', statusValues: ['PROCESSED'], olderThan: '24 hours' },
  { table: 'decision_alert_outbox', timestampColumn: 'processed_at', statusValues: ['PROCESSED'], olderThan: '7 days' },
  { table: 'decision_alert_outbox', timestampColumn: 'created_at', statusValues: ['DEAD'], olderThan: '30 days' },
  { table: 'project_evaluation_jobs', timestampColumn: 'completed_at', statusValues: ['SUCCEEDED'], olderThan: '7 days' },
  { table: 'project_evaluation_jobs', timestampColumn: 'created_at', statusValues: ['DEAD'], olderThan: '30 days' },
];

/*
 * Retention Schedules for Lock & Ephemeral Snapshot Tables
 */
const AGE_TARGETS: AgeCleanupTarget[] = [
  { table: 'provider_pull_run_lock', timestampColumn: 'started_at', olderThan: '24 hours' },
  { table: 'scheduler_locks', timestampColumn: 'locked_at', olderThan: '24 hours' },
  { table: 'forecast_snapshots', timestampColumn: 'updated_at', olderThan: '14 days' },
  { table: 'db_cleanup_run_lock', timestampColumn: 'started_at', olderThan: '24 hours' },
  { table: 'scheduler_tick_run_lock', timestampColumn: 'started_at', olderThan: '24 hours' },
  { table: 'forecast_refresh_run_lock', timestampColumn: 'started_at', olderThan: '24 hours' },
];

const DEAD_TELEMETRY_ARCHIVE_OLDER_THAN = '7 days';

type CleanupResult = {
  table: string;
  column: string;
  status?: string[];
  deleted: number;
  batches: number;
  error?: string;
};

export async function GET(request: Request) {
  if (!process.env.DB_CLEANUP_CRON_SECRET) {
    return NextResponse.json({ ok: false, error: 'DB_CLEANUP_CRON_SECRET غير مُعرَّف بالخادم' }, { status: 503 });
  }
  const authHeader = request.headers.get('authorization') || '';
  if (!timingSafeStringEqual(authHeader, `Bearer ${process.env.DB_CLEANUP_CRON_SECRET}`)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  // Enforce single-worker execution window using timestamp bucket lock
  const runBucket = Math.floor(Date.now() / (RUN_BUCKET_SECONDS * 1000));
  const { error: lockError } = await supabaseAdmin.from('db_cleanup_run_lock').insert({ run_bucket: runBucket });
  if (lockError) {
    return NextResponse.json({ ok: true, skipped: true, reason: 'previous cleanup run still in window' }, { status: 200 });
  }

  await recordWorkerHeartbeat(WORKER_NAME, 'started');

  const results: CleanupResult[] = [];

  // Batch cleanup for status-filtered transient tables
  for (const target of STATUS_TARGETS) {
    let totalDeleted = 0;
    let batches = 0;
    let lastError: string | undefined;
    for (; batches < MAX_BATCHES_PER_TABLE; batches++) {
      const { data, error } = await supabaseAdmin.rpc('cleanup_transient_table_batch', {
        p_table_name: target.table,
        p_timestamp_column: target.timestampColumn,
        p_status_column: 'status',
        p_status_values: target.statusValues,
        p_older_than: target.olderThan,
        p_limit: BATCH_LIMIT,
      });
      if (error) {
        lastError = error.message;
        break;
      }
      const deleted = (data as number) ?? 0;
      totalDeleted += deleted;
      if (deleted < BATCH_LIMIT) break;
    }
    results.push({ table: target.table, column: target.timestampColumn, status: target.statusValues, deleted: totalDeleted, batches: batches + 1, error: lastError });
  }

  // Batch cleanup for age-filtered transient lock tables
  for (const target of AGE_TARGETS) {
    let totalDeleted = 0;
    let batches = 0;
    let lastError: string | undefined;
    for (; batches < MAX_BATCHES_PER_TABLE; batches++) {
      const { data, error } = await supabaseAdmin.rpc('cleanup_transient_table_batch_by_age', {
        p_table_name: target.table,
        p_timestamp_column: target.timestampColumn,
        p_older_than: target.olderThan,
        p_limit: BATCH_LIMIT,
      });
      if (error) {
        lastError = error.message;
        break;
      }
      const deleted = (data as number) ?? 0;
      totalDeleted += deleted;
      if (deleted < BATCH_LIMIT) break;
    }
    results.push({ table: target.table, column: target.timestampColumn, deleted: totalDeleted, batches: batches + 1, error: lastError });
  }

  // Archival execution: Moves unprocessable DEAD telemetry from active queue to permanent dead-letter store
  {
    let totalArchived = 0;
    let batches = 0;
    let lastError: string | undefined;
    for (; batches < MAX_BATCHES_PER_TABLE; batches++) {
      const { data, error } = await supabaseAdmin.rpc('archive_dead_telemetry_batch', {
        p_older_than: DEAD_TELEMETRY_ARCHIVE_OLDER_THAN,
        p_limit: BATCH_LIMIT,
      });
      if (error) {
        lastError = error.message;
        break;
      }
      const archived = (data as number) ?? 0;
      totalArchived += archived;
      if (archived < BATCH_LIMIT) break;
    }
    results.push({
      table: 'telemetry_ingestion_queue→telemetry_dead_letter',
      column: 'created_at',
      status: ['DEAD'],
      deleted: totalArchived,
      batches: batches + 1,
      error: lastError,
    });
  }

  const failedCount = results.filter((r) => r.error).length;
  const totalDeleted = results.reduce((sum, r) => sum + r.deleted, 0);

  if (failedCount === 0) {
    await recordWorkerHeartbeat(WORKER_NAME, 'succeeded');
  } else {
    await recordWorkerHeartbeat(WORKER_NAME, 'failed', `${failedCount}/${results.length} أهداف تنظيف فشلت`);
  }

  return NextResponse.json(
    {
      ok: failedCount === 0,
      checkedAt: new Date().toISOString(),
      runBucket,
      totalDeleted,
      results,
    },
    { status: failedCount === 0 ? 200 : 207 }
  );
}