import { NextResponse, type NextRequest } from 'next/server';
import { randomBytes, createHash } from 'crypto';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { requireUserId, verifyProjectOwnership } from '@/app/lib/apiAuth';
import { safeErrorResponse } from '@/app/lib/apiError';

// Monitoring devices endpoint for a project (project_devices) — managed by the project
// owner via standard session auth (requireUserId + verifyProjectOwnership), NOT via
// device API key itself (that belongs to a dedicated route: POST /api/devices/ingest).

// true_north_* (migration 202608190002 — restoring True North documentation):
// Per-device wind direction calibration documentation fields — see field comment for
// windDirectionEvidence in dustEvaluation.ts for full details on why last_wind_direction_deg
// cannot be used directly in spatial propagation analysis without this documentation.
const DEVICE_LIST_COLUMNS =
  'id, name, lat, lng, api_key_prefix, is_active, last_reading_at, last_wind_speed_kmh, last_wind_gust_kmh, last_wind_direction_deg, last_pm10, last_pm25, last_visibility_m, created_at, revoked_at, true_north_alignment_documented, true_north_alignment_type, true_north_verification_method, true_north_verified_by, true_north_verified_at, true_north_deviation_deg, true_north_evidence_url';

// Safe projection columns — credentials are always intentionally excluded (same philosophy as
// api_key_hash above), matching CONNECTION_SAFE_COLUMNS in provider-connection/route.ts.
const CONNECTION_SAFE_COLUMNS =
  'id, device_id, project_id, provider, vendor_station_id, vendor_station_name, is_active, last_pull_at, last_pull_success, last_pull_error, created_at, updated_at';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const auth = await requireUserId(request);
  if ('error' in auth) return auth.error;

  const { projectId } = await params;
  const owns = await verifyProjectOwnership(projectId, auth.userId);
  if (!owns) return NextResponse.json({ error: 'لا تملك هذا المشروع' }, { status: 403 });

  // Explicit column selection — NEVER select('*') on this table because it contains
  // api_key_hash (a secret that must never leave the server under any circumstance).
  const { data, error } = await supabaseAdmin
    .from('project_devices')
    .select(DEVICE_LIST_COLUMNS)
    .eq('project_id', projectId)
    .order('created_at', { ascending: false });

  if (error) return NextResponse.json({ error: safeErrorResponse(error, 'devices list fetch failed') }, { status: 500 });

  // Performance issue discovered — review of settings/page.tsx: it previously fetched this list
  // then fired a separate GET request per device (N+1) to retrieve external provider connection state
  // (provider-connection/route.ts) — a single aggregated query here (project_id instead of device_id)
  // replaces all those individual network requests with a single query.
  const { data: connections } = await supabaseAdmin
    .from('provider_connections')
    .select(CONNECTION_SAFE_COLUMNS)
    .eq('project_id', projectId);

  const connectionsByDeviceId: Record<string, unknown> = {};
  for (const conn of connections || []) {
    connectionsByDeviceId[(conn as { device_id: string }).device_id] = conn;
  }

  return NextResponse.json({ devices: data || [], connectionsByDeviceId });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const auth = await requireUserId(request);
  if ('error' in auth) return auth.error;

  const { projectId } = await params;
  const owns = await verifyProjectOwnership(projectId, auth.userId);
  if (!owns) return NextResponse.json({ error: 'لا تملك هذا المشروع' }, { status: 403 });

  const body = await request.json().catch(() => null);
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  if (!name) return NextResponse.json({ error: 'اسم الجهاز مطلوب' }, { status: 400 });

  // Device coordinates are mandatory (Explicit requirement: auto-linking nearest active device during
  // activity creation — resolveNearestActiveDeviceId in dust-profiles/route.ts — requires a physical
  // location for every device, otherwise it remains silently excluded from calculation). We no longer
  // accept non-numeric values that silently convert to null.
  const lat = typeof body?.lat === 'number' ? body.lat : NaN;
  const lng = typeof body?.lng === 'number' ? body.lng : NaN;
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return NextResponse.json({ error: 'إحداثيات الجهاز (خط العرض وخط الطول) مطلوبة وبمدى صالح' }, { status: 400 });
  }

  // The raw API key is generated here once and returned only in this response — it is
  // NEVER stored, only its hash (following standard GitHub/Stripe API key security pattern).
  const rawKey = `dcr_${randomBytes(32).toString('hex')}`;
  const apiKeyHash = createHash('sha256').update(rawKey).digest('hex');
  const apiKeyPrefix = rawKey.slice(0, 12);

  // True North documentation (migration 202608190002) — completely optional on
  // creation (allowing device registration without documentation, implicitly UNVERIFIED status
  // — see resolveWindDirectionEvidence in dustEvaluation.ts). If true_north_alignment_documented=true
  // is passed, all four core documentation fields must be present — same consistency constraint
  // enforced at DB level (project_devices_true_north_documentation_chk), checked here to return
  // a clear, friendly Arabic error message instead of a raw database SQL error.
  const trueNorthDocumented = body?.true_north_alignment_documented === true;
  if (
    trueNorthDocumented &&
    (
      body?.true_north_alignment_type !== 'TRUE_NORTH' &&
      body?.true_north_alignment_type !== 'MAGNETIC_NORTH' ||
      typeof body?.true_north_verification_method !== 'string' ||
      !body.true_north_verification_method.trim() ||
      typeof body?.true_north_verified_by !== 'string' ||
      !body.true_north_verified_by.trim() ||
      !body?.true_north_verified_at
    )
  ) {
    return NextResponse.json({ error: 'توثيق الشمال الحقيقي غير مكتمل' }, { status: 400 });
  }

  const { data: inserted, error } = await supabaseAdmin
    .from('project_devices')
    .insert({
      project_id: projectId,
      name,
      lat,
      lng,
      api_key_hash: apiKeyHash,
      api_key_prefix: apiKeyPrefix,
      true_north_alignment_documented: trueNorthDocumented,
      true_north_alignment_type: trueNorthDocumented ? body.true_north_alignment_type : null,
      true_north_verification_method: trueNorthDocumented ? body.true_north_verification_method.trim() : null,
      true_north_verified_by: trueNorthDocumented ? body.true_north_verified_by.trim() : null,
      true_north_verified_at: trueNorthDocumented ? body.true_north_verified_at : null,
      true_north_deviation_deg: typeof body?.true_north_deviation_deg === 'number' ? body.true_north_deviation_deg : null,
      true_north_evidence_url: typeof body?.true_north_evidence_url === 'string' ? body.true_north_evidence_url.trim() : null,
    })
    .select(DEVICE_LIST_COLUMNS)
    .single();

  if (error) return NextResponse.json({ error: safeErrorResponse(error, 'device create failed') }, { status: 500 });

  return NextResponse.json({ device: inserted, apiKey: rawKey });
}