import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { timingSafeStringEqual } from '@/app/lib/timingSafe';
import { recordWorkerHeartbeat } from '@/app/lib/workerHeartbeat';
import { PM10_VIOLATION_STOP_UG_M3 } from '@/app/utils/dust-compliance-engine/rulebook';

const WORKER_NAME = 'alert-outbox-worker';

/*
 * Section 11.3 / 11.5 of the Mirqab Outbox Specification:
 * Outbox Worker: Consumes the `decision_alert_outbox` table (populated atomically by `persist_activity_decision_atomic`)
 * and generates or closes active system alerts via atomic stored procedures (`create_alert_atomic` / `close_alert_atomic`).
 *
 * Operational & Concurrency Protections:
 * 1. Batch Execution with Lease Locking: Uses `claim_alert_outbox_batch` with `FOR UPDATE SKIP LOCKED` and active leases.
 * 2. Per-Row Lease Renewal: Invokes `renew_alert_outbox_lease` before processing each row to maintain explicit lease ownership.
 * 3. Atomic State Management: Atomically marks outbox rows as completed (`complete_alert_outbox_row`) or failed (`fail_alert_outbox_row`).
 */
const BATCH_SIZE = 20;
const LEASE_SECONDS = 60;
const MAX_ATTEMPTS = 5;

interface OutboxRow {
  id: string;
  final_decision_id: string;
  project_id: string;
  activity_group_id: string;
  activity_id: string;
  kind: 'SAFETY_BREACH' | 'PROTECTIVE_STOP' | 'COMPLIANCE_VIOLATION' | 'COMPLIANCE_RESTRICTION' | 'PM10_IMPROVED';
  action: 'OPEN' | 'CLOSE';
  payload: { shortReasonAr?: string; decisionLabelAr?: string; mandatoryStop?: boolean; level?: string; pm10UgM3?: number | null };
  attempts: number;
}

/*
 * Section 11.4 Specification: Pure function for alert payload parsing.
 * Constructs localized UI strings, recommended actions, and metric limits strictly from the Outbox payload.
 */
function deriveAlertMessage(row: OutboxRow): {
  message: string;
  viewerMessage: string | null;
  recommendedAction: string;
  metricLabel: string | null;
  metricThreshold: string | null;
} {
  const reason = row.payload?.shortReasonAr || row.payload?.decisionLabelAr || 'قرار تشغيلي يستوجب المراجعة';
  if (row.kind === 'SAFETY_BREACH') {
    return {
      message: `تجاوز حد صارم — إيقاف إلزامي: ${reason}`,
      viewerMessage: null,
      recommendedAction: row.payload?.decisionLabelAr || 'إيقاف إلزامي نظامي',
      metricLabel: 'القرار التشغيلي',
      metricThreshold: 'إيقاف إلزامي',
    };
  }
  if (row.kind === 'PROTECTIVE_STOP') {
    return {
      message: `إيقاف احترازي معلَّق (بانتظار تأكيد): ${reason}`,
      viewerMessage: null,
      recommendedAction: row.payload?.decisionLabelAr || 'إيقاف احترازي — راجع الحالة للتأكد قبل الاستئناف',
      metricLabel: 'القرار التشغيلي',
      metricThreshold: 'إيقاف احترازي معلَّق',
    };
  }
  if (row.kind === 'COMPLIANCE_VIOLATION') {
    const pm10Value = row.payload?.pm10UgM3;
    const viewerText =
      pm10Value !== null && pm10Value !== undefined
        ? `تم تجاوز الحد ${PM10_VIOLATION_STOP_UG_M3}، حيث أن PM10 الحالي ${pm10Value}`
        : `تم تجاوز الحد ${PM10_VIOLATION_STOP_UG_M3}`;
    return {
      message: reason,
      viewerMessage: viewerText,
      recommendedAction: reason,
      metricLabel: 'PM10',
      metricThreshold: `${PM10_VIOLATION_STOP_UG_M3} ميكروجرام/م³`,
    };
  }
  if (row.kind === 'PM10_IMPROVED') {
    const pm10Value = row.payload?.pm10UgM3;
    const viewerText =
      pm10Value !== null && pm10Value !== undefined
        ? `تحسّنت القراءة: تركيز PM10 الحالي ${pm10Value} — أصبح دون حد المخالفة ${PM10_VIOLATION_STOP_UG_M3}`
        : `تحسّنت القراءة: تركيز PM10 أصبح دون حد المخالفة ${PM10_VIOLATION_STOP_UG_M3}`;
    return {
      message: viewerText,
      viewerMessage: viewerText,
      recommendedAction: 'استمر بمراقبة القراءة — التحسّن لا يعني إغلاق الملف نهائياً إن عاد الارتفاع لاحقاً.',
      metricLabel: 'PM10',
      metricThreshold: `${PM10_VIOLATION_STOP_UG_M3} ميكروجرام/م³`,
    };
  }
  return {
    message: reason,
    viewerMessage: null,
    recommendedAction: reason,
    metricLabel: null,
    metricThreshold: null,
  };
}

export async function GET(request: Request) {
  if (!process.env.ALERT_OUTBOX_CRON_SECRET) {
    return NextResponse.json({ ok: false, error: 'ALERT_OUTBOX_CRON_SECRET غير مُعرَّف بالخادم' }, { status: 503 });
  }
  const authHeader = request.headers.get('authorization') || '';
  if (!timingSafeStringEqual(authHeader, `Bearer ${process.env.ALERT_OUTBOX_CRON_SECRET}`)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const workerId = crypto.randomUUID();
  await recordWorkerHeartbeat(WORKER_NAME, 'started');

  const { data: rows, error: claimError } = await supabaseAdmin.rpc('claim_alert_outbox_batch', {
    p_worker_id: workerId,
    p_batch_size: BATCH_SIZE,
    p_lease_seconds: LEASE_SECONDS,
  });

  if (claimError) {
    await recordWorkerHeartbeat(WORKER_NAME, 'failed', claimError.message);
    return NextResponse.json({ ok: false, error: claimError.message }, { status: 500 });
  }

  const results: Array<{ id: string; ok: boolean; alertId?: string | null; error?: string }> = [];

  for (const row of (rows || []) as OutboxRow[]) {
    // Validate lease ownership before processing each batch row
    const renewed = await supabaseAdmin.rpc('renew_alert_outbox_lease', {
      p_row_id: row.id,
      p_worker_id: workerId,
      p_lease_seconds: LEASE_SECONDS,
    });
    if (renewed.error || !renewed.data) {
      results.push({ id: row.id, ok: false, error: 'lease لم يعد يطابق (استرجعه عامل آخر) — تم التخطي بلا معالجة' });
      continue;
    }

    try {
      let alertId: string | null;

      if (row.action === 'CLOSE') {
        const { data, error: rpcError } = await supabaseAdmin.rpc('close_alert_atomic', {
          p_project_id: row.project_id,
          p_activity_id: row.activity_id,
          p_kind: row.kind,
        });
        if (rpcError) throw new Error(rpcError.message);
        alertId = (data as string | null) ?? null;
      } else {
        const { message, viewerMessage, recommendedAction, metricLabel, metricThreshold } = deriveAlertMessage(row);
        const pm10Value = row.payload?.pm10UgM3;
        const metricActual =
          (row.kind === 'COMPLIANCE_VIOLATION' || row.kind === 'PM10_IMPROVED') && pm10Value !== null && pm10Value !== undefined
            ? `${pm10Value} ميكروجرام/م³`
            : null;
        const { data, error: rpcError } = await supabaseAdmin.rpc('create_alert_atomic', {
          p_project_id: row.project_id,
          p_activity_id: row.activity_id,
          p_timing: 'DURING',
          p_kind: row.kind,
          p_message: message,
          p_viewer_message: viewerMessage,
          p_metric_label: metricLabel,
          p_metric_actual: metricActual,
          p_metric_threshold: metricThreshold,
          p_recommended_action: recommendedAction,
          p_opened_by_final_decision_id: row.final_decision_id,
        });
        if (rpcError) throw new Error(rpcError.message);
        alertId = data as string;
      }

      const { data: completed, error: completeError } = await supabaseAdmin.rpc('complete_alert_outbox_row', {
        p_row_id: row.id,
        p_worker_id: workerId,
        p_alert_id: alertId,
      });

      if (completeError || !completed) {
        results.push({
          id: row.id,
          ok: false,
          alertId,
          error: completeError?.message || 'complete_alert_outbox_row: lease لم يعد يطابق (استرجعه عامل آخر) رغم نجاح العملية',
        });
        continue;
      }

      results.push({ id: row.id, ok: true, alertId });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`alert-outbox-worker: failed to process outbox row ${row.id}:`, message);
      const { data: failed, error: failRpcError } = await supabaseAdmin.rpc('fail_alert_outbox_row', {
        p_row_id: row.id,
        p_worker_id: workerId,
        p_error: message,
        p_max_attempts: MAX_ATTEMPTS,
      });

      results.push({
        id: row.id,
        ok: false,
        error: failRpcError || !failed ? `${message} (lease لم يعد يطابق عند fail)` : message,
      });
    }
  }

  const failedCount = results.filter((r) => !r.ok).length;
  const status = results.length === 0 || failedCount === 0 ? 200 : failedCount === results.length ? 502 : 207;

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
    },
    { status }
  );
}