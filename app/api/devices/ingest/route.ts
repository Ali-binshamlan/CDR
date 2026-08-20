import { NextResponse, type NextRequest } from 'next/server';
import { requireDeviceApiKey } from '@/app/lib/apiAuth';
import { checkRateLimit } from '@/app/lib/rateLimit';
import { writeDeviceReading } from '@/app/lib/deviceReadingWriter';
import { evaluateProject, enqueueEvaluationRetryJob } from '@/app/lib/evaluateProject';
import type { NormalizedReading } from '@/app/lib/providers/types';

/*
 * Device Telemetry Ingest Endpoint (Push Model):
 * Ingests real-time environmental measurements from physical edge monitoring devices.
 * Authenticates exclusively via Bearer API keys (`Authorization: Bearer <raw_key>`).
 *
 * Operational, Security & Resiliency Highlights:
 * 1. Per-Device Rate Limiting: Enforces a 30 req/min limit per `deviceId` post-authentication 
 *    to prevent payload flooding from compromised or misconfigured keys.
 * 2. Strict Event Contract Enforcement: Validates mandatory `eventId` (non-empty string),
 *    `sequence` (non-negative integer), and `observedAt` (ISO timestamp) attributes.
 * 3. Late Reading Handling: Captures historical data while flagging late reads (`p_is_late = true`)
 *    to preserve audit history without corrupting real-time operational compliance state.
 * 4. Inline Engine Evaluation & Reliable Fallback: Triggers synchronized `evaluateProject` calls upon write, 
 *    automatically enqueuing retry jobs in `project_evaluation_jobs` if evaluation fails.
 */

const INGEST_MAX_REQUESTS_PER_WINDOW = 30;
const INGEST_WINDOW_MS = 60_000;

const MEASUREMENT_FIELDS = [
  'windSpeedKmh',
  'windGustKmh',
  'windDirectionDeg',
  'pm10',
  'pm25',
  'visibilityM',
  'relativeHumidityPercent',
  'temperatureC',
] as const;

export async function POST(request: NextRequest) {
  const auth = await requireDeviceApiKey(request);
  if ('error' in auth) return auth.error;

  /*
   * Apply rate limiting scoped to validated device ID
   */
  if (!checkRateLimit(auth.deviceId, INGEST_MAX_REQUESTS_PER_WINDOW, INGEST_WINDOW_MS)) {
    return NextResponse.json(
      { error: 'تجاوزت الحد المسموح من الطلبات — حاول بعد قليل' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil(INGEST_WINDOW_MS / 1000)) } }
    );
  }

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'جسم الطلب يجب أن يكون JSON صالحاً' }, { status: 400 });
  }

  /*
   * Validate Device Event Contract (eventId, sequence, observedAt)
   */
  const rawEventId = (body as Record<string, unknown>).eventId;
  if (typeof rawEventId !== 'string' || !rawEventId.trim()) {
    return NextResponse.json({ error: 'eventId إلزامي ويجب أن يكون نصاً غير فارغ' }, { status: 400 });
  }
  const eventId = rawEventId.trim();

  const rawSequence = (body as Record<string, unknown>).sequence;
  if (
    typeof rawSequence !== 'number' ||
    !Number.isFinite(rawSequence) ||
    !Number.isInteger(rawSequence) ||
    rawSequence < 0
  ) {
    return NextResponse.json({ error: 'sequence إلزامي ويجب أن يكون رقماً صحيحاً غير سالب' }, { status: 400 });
  }
  const sequence = rawSequence;

  const rawObservedAt = (body as Record<string, unknown>).observedAt;
  if (typeof rawObservedAt !== 'string' || !rawObservedAt.trim()) {
    return NextResponse.json({ error: 'observedAt إلزامي ويجب أن يكون نصاً بصيغة ISO' }, { status: 400 });
  }

  const observedMs = new Date(rawObservedAt).getTime();
  if (Number.isNaN(observedMs)) {
    return NextResponse.json({ error: 'observedAt ليس تاريخاً صالحاً' }, { status: 400 });
  }

  const nowMs = Date.now();
  const CLOCK_SKEW_TOLERANCE_MS = 2 * 60_000;
  if (observedMs > nowMs + CLOCK_SKEW_TOLERANCE_MS) {
    return NextResponse.json({ error: 'observedAt في المستقبل — تحقق من ساعة الجهاز' }, { status: 400 });
  }

  const observedAtIso = new Date(observedMs).toISOString();

  /*
   * Normalize incoming telemetry payload
   */
  const reading: Partial<NormalizedReading> = { observedAtIso };
  for (const field of MEASUREMENT_FIELDS) {
    const value = (body as Record<string, unknown>)[field];
    if (value === undefined || value === null) continue;
    (reading as Record<string, unknown>)[field] = value;
  }

  /*
   * Persist telemetry reading via database writer handler
   */
  const result = await writeDeviceReading({
    deviceId: auth.deviceId,
    projectId: auth.projectId,
    reading,
    externalEventId: eventId,
    sequence,
  });

  if (!result.success) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  if (result.duplicate) {
    return NextResponse.json({ success: true, duplicate: true, receivedAt: new Date().toISOString() });
  }

  /*
   * Skip real-time evaluation if reading is flagged as LATE (prevents live state mutations)
   */
  if (result.late) {
    return NextResponse.json({ success: true, late: true, receivedAt: new Date().toISOString() });
  }

  /*
   * Synchronously evaluate project state following new real-time reading ingestion
   */
  const evalResult = await evaluateProject(auth.projectId, 'device_ingest').catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`ingest: evaluateProject failed for project ${auth.projectId}:`, message);
    return { success: false as const, persisted: 0, error: message };
  });

  if (!evalResult.success) {
    console.error(`ingest: evaluateProject unsuccessful for project ${auth.projectId}:`, evalResult.error);
    await enqueueEvaluationRetryJob(auth.projectId, 'DEVICE_EVENT', evalResult.error ?? 'فشل تقييم غير محدَّد');
  }

  return NextResponse.json({ success: true, receivedAt: new Date().toISOString() });
}