import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { requireSuperAdmin } from '@/app/lib/apiAuth';
import { safeErrorResponse } from '@/app/lib/apiError';

/*
 * Management of `telemetry_dead_letter` table (migration 202608120002).
 * Contains IoT telemetry readings that permanently failed ingestion (`device_readings_history`/`pm10_readings_history`) 
 * after exhausting retries in `telemetry-worker`. Records are redirected here rather than being permanently deleted 
 * (see `db-cleanup-worker/route.ts` for context).
 * 
 * Access Control: Super Admin only (`requireSuperAdmin`), consistent with `admin/provider-instances`. 
 * Project owners cannot access this route as it serves as a cross-project operational log.
 */
export async function GET(request: NextRequest) {
  const auth = await requireSuperAdmin(request);
  if ('error' in auth) return auth.error;

  const { searchParams } = new URL(request.url);
  /*
   * Filter constraint: `resolved=false` (default) selects pending records awaiting decision (neither replayed nor acknowledged).
   * `resolved=true` displays records where resolution action has been completed.
   */
  const showResolved = searchParams.get('resolved') === 'true';

  let query = supabaseAdmin
    .from('telemetry_dead_letter')
    .select('*')
    .order('archived_at', { ascending: false })
    .limit(200);

  query = showResolved
    ? query.or('replayed_at.not.is.null,acknowledged_at.not.is.null')
    : query.is('replayed_at', null).is('acknowledged_at', null);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: safeErrorResponse(error, 'telemetry-dead-letter fetch failed') }, { status: 500 });
  return NextResponse.json({ data });
}

/*
 * `action='replay'`: Re-inserts payload into `telemetry_ingestion_queue` with status `PENDING` via RPC `replay_dead_telemetry_letter`.
 * `telemetry-worker` processes it in the next execution cycle as a new reading.
 * Dead letter record is permanently preserved (append-only architecture); `replayed_at`, `replayed_by`, and `replay_queue_id` are updated.
 * 
 * `action='acknowledge'`: Human acknowledgment documenting that the reading is permanently unrecoverable.
 * `reason` is required (enforced both here and at the RPC level). Records are never deleted; 
 * audit details (who/when/why) are stamped on the row to maintain auditability.
 */
export async function POST(request: NextRequest) {
  const auth = await requireSuperAdmin(request);
  if ('error' in auth) return auth.error;

  const body = await request.json().catch(() => null);
  const id = typeof body?.id === 'string' ? body.id : '';
  const action = typeof body?.action === 'string' ? body.action : '';
  if (!id) return NextResponse.json({ error: 'id مطلوب' }, { status: 400 });

  if (action === 'replay') {
    const { data, error } = await supabaseAdmin.rpc('replay_dead_telemetry_letter', {
      p_dead_letter_id: id,
      p_replayed_by: auth.userId,
    });
    if (error) return NextResponse.json({ error: safeErrorResponse(error, 'replay_dead_telemetry_letter failed') }, { status: 500 });
    return NextResponse.json({ success: true, queueId: data });
  }

  if (action === 'acknowledge') {
    const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
    if (!reason) return NextResponse.json({ error: 'reason مطلوب (سبب الاعتماد النهائي بأن القراءة مفقودة)' }, { status: 400 });

    const { data, error } = await supabaseAdmin.rpc('acknowledge_dead_telemetry_letter', {
      p_dead_letter_id: id,
      p_acknowledged_by: auth.userId,
      p_reason: reason,
    });
    if (error) return NextResponse.json({ error: safeErrorResponse(error, 'acknowledge_dead_telemetry_letter failed') }, { status: 500 });
    if (!data) return NextResponse.json({ error: 'الصف غير موجود أو تم التعامل معه مسبقاً (replay أو اعتماد سابق)' }, { status: 409 });
    return NextResponse.json({ success: true });
  }

  return NextResponse.json({ error: "action يجب أن يكون 'replay' أو 'acknowledge'" }, { status: 400 });
}