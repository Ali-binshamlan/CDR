import { NextResponse } from 'next/server';
import { requireUserId, verifyProjectOwnership } from '@/app/lib/apiAuth';
import { validateDustUnitPlacement } from '@/app/lib/dustPlacementValidation';

/*
 * Batching Plant Placement Precheck Endpoint:
 * Validates real-time map placement coordinates for a proposed concrete batching plant unit
 * prior to persistence, enforcing the 200m buffer distance (`BATCHING-DISTANCE-200`) against 
 * nearby sensitive receptors defined in `rulebook.ts`.
 *
 * Operational & Security Highlights:
 * 1. User & Project Authorization: Enforces session-based authentication (`requireUserId`) 
 *    and ownership verification (`verifyProjectOwnership`) on the targeted project scope.
 * 2. Shared Placement Validator: Delegates spatial verification logic to `validateDustUnitPlacement`
 *    with explicit activity type `BATCHING_PLANT`.
 * 3. Fail-Safe Error Handling: Returns a HTTP 503 status code when GIS calculations cannot be 
 *    verified (`!result.verified`), preventing unverified spatial claims from being treated 
 *    as safe defaults (infinite distance bypass).
 */
export async function POST(request: Request) {
  const auth = await requireUserId(request);
  if ('error' in auth) return auth.error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'جسم الطلب غير صالح' }, { status: 400 });
  }

  const { projectId, lat, lng } = (body ?? {}) as { projectId?: unknown; lat?: unknown; lng?: unknown };
  if (typeof projectId !== 'string' || !projectId) {
    return NextResponse.json({ error: 'projectId مطلوب' }, { status: 400 });
  }
  if (typeof lat !== 'number' || typeof lng !== 'number' || Number.isNaN(lat) || Number.isNaN(lng)) {
    return NextResponse.json({ error: 'lat/lng مطلوبان كأرقام صالحة' }, { status: 400 });
  }

  /*
   * Verify project ownership boundaries
   */
  const isOwner = await verifyProjectOwnership(projectId, auth.userId);
  if (!isOwner) {
    return NextResponse.json({ error: 'غير مصرّح بالوصول لهذا المشروع' }, { status: 403 });
  }

  /*
   * Validate spatial placement against sensitive receptor buffer rules
   */
  const result = await validateDustUnitPlacement({ projectId, lat, lng, activityType: 'BATCHING_PLANT' });

  if (!result.verified) {
    return NextResponse.json({ error: 'PLACEMENT_NOT_VERIFIED', detail: result.error }, { status: 503 });
  }

  return NextResponse.json({
    blocked: result.blocked,
    reasonsAr: result.reasonsAr,
    nearestReceptorM: result.nearestReceptorM,
  });
}