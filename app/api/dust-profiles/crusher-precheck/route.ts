import { NextResponse } from 'next/server';
import { requireUserId, verifyProjectOwnership } from '@/app/lib/apiAuth';
import { validateDustUnitPlacement } from '@/app/lib/dustPlacementValidation';

/*
 * Crusher Placement Precheck Endpoint:
 * Validates real-time map placement coordinates for a proposed crusher unit prior to persistence,
 * enforcing project risk category constraints (`CRUSHER-CATEGORY-001`) and sensitive receptor buffer 
 * distances (`CRUSHER-DISTANCE-*`) defined in `rulebook.ts`.
 *
 * Operational & Security Highlights:
 * 1. User & Project Authorization: Enforces session-based authentication (`requireUserId`) 
 *    and ownership verification (`verifyProjectOwnership`) on the targeted project scope.
 * 2. Unified Placement Validator: Shares spatial and category validation logic via `validateDustUnitPlacement`
 *    with explicit activity type `CRUSHER`.
 * 3. Frontend Hard-Block Enforcer: Directly feeds UI controls (e.g., `index.tsx`) to prevent persisting 
 *    crusher activities when `blocked = true`.
 * 4. Fail-Safe Error Handling: Returns a HTTP 503 status code when GIS or category validation fails to execute 
 *    (`!result.verified`), avoiding false-pass evaluations (infinite distance bypass).
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
   * Validate spatial placement against crusher category rules and sensitive receptor buffers
   */
  const result = await validateDustUnitPlacement({ projectId, lat, lng, activityType: 'CRUSHER' });

  if (!result.verified) {
    return NextResponse.json({ error: 'PLACEMENT_NOT_VERIFIED', detail: result.error }, { status: 503 });
  }

  return NextResponse.json({
    blocked: result.blocked,
    reasonsAr: result.reasonsAr,
    riskClass: result.riskClass,
    nearestReceptorM: result.nearestReceptorM,
    nearestResidentialReceptorM: result.nearestResidentialReceptorM,
  });
}