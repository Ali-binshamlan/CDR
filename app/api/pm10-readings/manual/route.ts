import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { requireUserId, verifyProjectOwnership } from '@/app/lib/apiAuth';
import { safeErrorResponse } from '@/app/lib/apiError';

/*
 * Manual PM10 Reading Ingestion Endpoint:
 * Serves as the primary entry point for recording manual field PM10 measurements into `pm10_readings_history`
 * (`source = 'manual'`).
 *
 * Operational, Security & Integrity Highlights:
 * 1. Payload Validation: Utilizes Zod (`ManualPm10ReadingSchema`) to validate field types, non-negative PM10 values, 
 *    and ISO offset timestamps.
 * 2. Strict Session Operator Binding: Resolves `operator_id` directly from authenticated server session (`auth.userId`) 
 *    rather than accepting arbitrary client payload values.
 * 3. Temporal Validation: Rejects future field observation timestamps (`observed_at`), allowing a 5-minute clock-skew tolerance.
 * 4. Atomic Idempotency Execution: Calls `insert_manual_pm10_reading_atomic` RPC to enforce duplicate protection 
 *    per `(project_id, activity_group_id, idempotency_key)` while validating activity existence.
 */

const ManualPm10ReadingSchema = z.object({
  project_id: z.string().uuid(),
  activity_group_id: z.string().min(1).max(200),
  pm10_ug_m3: z.number().finite().min(0),
  observed_at: z.string().datetime({ offset: true }),
  idempotency_key: z.string().min(1).max(200),
});

export async function POST(request: NextRequest) {
  const auth = await requireUserId(request);
  if ('error' in auth) return auth.error;

  const body = await request.json().catch(() => null);
  const parsed = ManualPm10ReadingSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'حمولة القراءة اليدوية غير صالحة', details: parsed.error.issues },
      { status: 400 }
    );
  }
  const { project_id, activity_group_id, pm10_ug_m3, observed_at, idempotency_key } = parsed.data;

  /*
   * Verify project ownership boundaries
   */
  const owns = await verifyProjectOwnership(project_id, auth.userId);
  if (!owns) return NextResponse.json({ error: 'لا تملك هذا المشروع' }, { status: 403 });

  /*
   * Validate observation timestamp against future clock skew (5-minute window)
   */
  if (new Date(observed_at).getTime() > Date.now() + 5 * 60000) {
    return NextResponse.json({ error: 'observed_at لا يمكن أن يكون بالمستقبل' }, { status: 400 });
  }

  /*
   * Atomic RPC execution for manual PM10 reading insertion
   */
  const { data, error } = await supabaseAdmin.rpc('insert_manual_pm10_reading_atomic', {
    p_project_id: project_id,
    p_activity_group_id: activity_group_id,
    p_operator_id: auth.userId,
    p_pm10_ug_m3: pm10_ug_m3,
    p_observed_at: observed_at,
    p_idempotency_key: idempotency_key,
  });

  if (error) {
    if (error.message?.includes('activity_group_id not found')) {
      return NextResponse.json({ error: 'activity_group_id غير موجود لهذا المشروع' }, { status: 404 });
    }
    return NextResponse.json(
      { error: safeErrorResponse(error, 'manual pm10 reading insert failed') },
      { status: 500 }
    );
  }

  const result = (data as { is_duplicate?: boolean; reading_id?: string }[] | null)?.[0];
  return NextResponse.json({
    success: true,
    duplicate: Boolean(result?.is_duplicate),
    readingId: result?.reading_id ?? null,
  });
}