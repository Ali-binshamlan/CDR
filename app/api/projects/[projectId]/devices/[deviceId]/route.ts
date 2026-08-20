import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { requireUserId, verifyProjectOwnership } from '@/app/lib/apiAuth';
import { safeErrorResponse } from '@/app/lib/apiError';

/*
 * Device Management Endpoint (PATCH, DELETE):
 * Manages device configuration updates and soft-deletion/revocation lifecycle operations for `project_devices`.
 *
 * Operational, Security & Architectural Highlights:
 * 1. Safe Projection: Filters out sensitive key material (`api_key_hash`) via `DEVICE_SAFE_COLUMNS`.
 * 2. Scope & Ownership Authorization: Validates user session (`requireUserId`), project ownership (`verifyProjectOwnership`), 
 *    and verifies device assignment to the project (`loadOwnedDevice`) to block cross-tenant modifications.
 * 3. True North Validation & Reset Logic: Validates required metadata when true north documentation is enabled. When 
 *    `true_north_alignment_documented` is set to false, all related calibration metadata is explicitly wiped to prevent stale state.
 * 4. Provider Connection Synchronized Deactivation: Deactivating (`is_active = false`) or revoking a device automatically deactivates 
 *    associated `provider_connections` records to prevent recurring pull cron failures (`/api/cron/provider-pull`).
 * 5. Soft Deletion Preserving Evidence Trails: Replaces hard `DELETE` operations with soft-revocation (`is_active = false`, `revoked_at`) 
 *    to preserve append-only historical telemetry and audit trails (`device_readings_history`).
 */

const DEVICE_SAFE_COLUMNS =
  'id, name, lat, lng, api_key_prefix, is_active, last_reading_at, last_wind_speed_kmh, last_wind_gust_kmh, last_wind_direction_deg, last_pm10, last_pm25, last_visibility_m, created_at, revoked_at, true_north_alignment_documented, true_north_alignment_type, true_north_verification_method, true_north_verified_by, true_north_verified_at, true_north_deviation_deg, true_north_evidence_url';

async function loadOwnedDevice(projectId: string, deviceId: string) {
  const { data } = await supabaseAdmin
    .from('project_devices')
    .select('id, project_id')
    .eq('id', deviceId)
    .maybeSingle();

  if (!data || data.project_id !== projectId) return null;
  return data;
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string; deviceId: string }> }
) {
  const auth = await requireUserId(request);
  if ('error' in auth) return auth.error;

  const { projectId, deviceId } = await params;

  /*
   * Verify project ownership boundaries
   */
  const owns = await verifyProjectOwnership(projectId, auth.userId);
  if (!owns) return NextResponse.json({ error: 'لا تملك هذا المشروع' }, { status: 403 });

  /*
   * Confirm device belongs to the authorized project scope
   */
  const device = await loadOwnedDevice(projectId, deviceId);
  if (!device) return NextResponse.json({ error: 'الجهاز غير موجود' }, { status: 404 });

  const body = await request.json().catch(() => null);
  const updates: Record<string, unknown> = {};

  if (typeof body?.name === 'string' && body.name.trim()) updates.name = body.name.trim();
  if (typeof body?.lat === 'number' || body?.lat === null) updates.lat = body.lat;
  if (typeof body?.lng === 'number' || body?.lng === null) updates.lng = body.lng;

  if (typeof body?.is_active === 'boolean') {
    updates.is_active = body.is_active;
    updates.revoked_at = body.is_active ? null : new Date().toISOString();
  }

  /*
   * True North Orientation Verification Handling
   */
  if (typeof body?.true_north_alignment_documented === 'boolean') {
    const trueNorthDocumented = body.true_north_alignment_documented;

    if (
      trueNorthDocumented &&
      (
        (body?.true_north_alignment_type !== 'TRUE_NORTH' && body?.true_north_alignment_type !== 'MAGNETIC_NORTH') ||
        typeof body?.true_north_verification_method !== 'string' ||
        !body.true_north_verification_method.trim() ||
        typeof body?.true_north_verified_by !== 'string' ||
        !body.true_north_verified_by.trim() ||
        !body?.true_north_verified_at
      )
    ) {
      return NextResponse.json({ error: 'توثيق الشمال الحقيقي غير مكتمل' }, { status: 400 });
    }

    updates.true_north_alignment_documented = trueNorthDocumented;
    if (trueNorthDocumented) {
      updates.true_north_alignment_type = body.true_north_alignment_type;
      updates.true_north_verification_method = body.true_north_verification_method.trim();
      updates.true_north_verified_by = body.true_north_verified_by.trim();
      updates.true_north_verified_at = body.true_north_verified_at;
      updates.true_north_deviation_deg =
        typeof body?.true_north_deviation_deg === 'number' ? body.true_north_deviation_deg : null;
      updates.true_north_evidence_url =
        typeof body?.true_north_evidence_url === 'string' ? body.true_north_evidence_url.trim() : null;
    } else {
      updates.true_north_alignment_type = null;
      updates.true_north_verification_method = null;
      updates.true_north_verified_by = null;
      updates.true_north_verified_at = null;
      updates.true_north_deviation_deg = null;
      updates.true_north_evidence_url = null;
    }
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'لا توجد حقول صالحة للتحديث' }, { status: 400 });
  }

  /*
   * Update project device attributes
   */
  const { data, error } = await supabaseAdmin
    .from('project_devices')
    .update(updates)
    .eq('id', deviceId)
    .select(DEVICE_SAFE_COLUMNS)
    .single();

  if (error) return NextResponse.json({ error: safeErrorResponse(error, 'device update failed') }, { status: 500 });

  /*
   * Cascade deactivation to provider connections on device deactivation
   */
  if (updates.is_active === false) {
    await supabaseAdmin
      .from('provider_connections')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('device_id', deviceId);
  }

  return NextResponse.json({ device: data });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string; deviceId: string }> }
) {
  const auth = await requireUserId(request);
  if ('error' in auth) return auth.error;

  const { projectId, deviceId } = await params;

  /*
   * Verify project ownership boundaries
   */
  const owns = await verifyProjectOwnership(projectId, auth.userId);
  if (!owns) return NextResponse.json({ error: 'لا تملك هذا المشروع' }, { status: 403 });

  /*
   * Confirm device belongs to the authorized project scope
   */
  const device = await loadOwnedDevice(projectId, deviceId);
  if (!device) return NextResponse.json({ error: 'الجهاز غير موجود' }, { status: 404 });

  /*
   * Perform soft-deletion (revocation) to preserve append-only history
   */
  const { error } = await supabaseAdmin
    .from('project_devices')
    .update({ is_active: false, revoked_at: new Date().toISOString() })
    .eq('id', deviceId);

  if (error) return NextResponse.json({ error: safeErrorResponse(error, 'device revoke failed') }, { status: 500 });

  /*
   * Deactivate associated provider connections
   */
  await supabaseAdmin
    .from('provider_connections')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('device_id', deviceId);

  return NextResponse.json({ success: true });
}