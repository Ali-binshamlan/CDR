import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { requireUserId, verifyProjectOwnership } from '@/app/lib/apiAuth';
import { safeErrorResponse } from '@/app/lib/apiError';
import { getConnector } from '@/app/lib/providers/registry';
import { encryptCredentialsV2 } from '@/app/lib/credentialsEncryption';
import { randomUUID } from 'node:crypto';

/*
 * Device Provider Connections Endpoint:
 * Manages Third-Party Provider (vendor) integrations for project devices. Supports GET (read connection state),
 * POST (upsert and test connection), and DELETE (unlink provider).
 *
 * Operational, Security & Architectural Highlights:
 * 1. Safe Column Projection: Explicitly filters out sensitive key materials (`credentials_ciphertext`) on GET/POST 
 *    responses via `CONNECTION_SAFE_COLUMNS`.
 * 2. Scope & Device Authorization: Enforces project ownership (`verifyProjectOwnership`) and cross-project 
 *    isolation via `loadOwnedDevice` to prevent cross-tenant device modifications.
 * 3. Approved Platform Origin Resolution: Enforces `provider_instance_id` validation against approved system 
 *    instances (`provider_instances`) for providers requiring platform base URLs, avoiding SSRF and unauthorized targets.
 * 4. Mandatory Server-Side Connection Test: Executes `connector.testConnection` on raw credentials before persistence 
 *    to block unverified configurations.
 * 5. Authenticated Encription with AAD (V2): Encrypts credentials with `encryptCredentialsV2` bound to 
 *    `(connectionId, projectId, deviceId, provider)` via Additional Authenticated Data (AAD) before storing.
 */

const CONNECTION_SAFE_COLUMNS =
  'id, device_id, project_id, provider, vendor_station_id, vendor_station_name, is_active, last_pull_at, last_pull_success, last_pull_error, created_at, updated_at';

async function loadOwnedDevice(projectId: string, deviceId: string) {
  const { data } = await supabaseAdmin
    .from('project_devices')
    .select('id, project_id')
    .eq('id', deviceId)
    .maybeSingle();

  if (!data || data.project_id !== projectId) return null;
  return data;
}

export async function GET(
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

  const { data, error } = await supabaseAdmin
    .from('provider_connections')
    .select(CONNECTION_SAFE_COLUMNS)
    .eq('device_id', deviceId)
    .maybeSingle();

  if (error) return NextResponse.json({ error: safeErrorResponse(error, 'provider-connection fetch failed') }, { status: 500 });
  return NextResponse.json({ connection: data });
}

export async function POST(
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
  const provider = typeof body?.provider === 'string' ? body.provider : '';
  const credentials = body?.credentials && typeof body.credentials === 'object' ? body.credentials : {};
  const vendorStationId = typeof body?.vendorStationId === 'string' ? body.vendorStationId.trim() : '';
  const vendorStationName = typeof body?.vendorStationName === 'string' ? body.vendorStationName.trim() : '';
  const providerInstanceId = typeof body?.providerInstanceId === 'string' ? body.providerInstanceId.trim() : '';

  if (!provider) return NextResponse.json({ error: 'provider مطلوب' }, { status: 400 });
  if (!vendorStationId) return NextResponse.json({ error: 'vendorStationId مطلوب' }, { status: 400 });

  const connector = getConnector(provider);
  if (!connector) return NextResponse.json({ error: `provider غير مسجَّل: ${provider}` }, { status: 400 });

  /*
   * Validate provider instance against system-approved records
   */
  if (connector.requiresProviderInstance) {
    if (!providerInstanceId) {
      return NextResponse.json({ error: 'providerInstanceId مطلوب لهذا النوع من المزوّدين' }, { status: 400 });
    }
    const { data: instance } = await supabaseAdmin
      .from('provider_instances')
      .select('id, origin, provider, is_approved, is_active')
      .eq('id', providerInstanceId)
      .maybeSingle();

    if (!instance || instance.provider !== provider || !instance.is_approved || !instance.is_active) {
      return NextResponse.json({ error: 'المنصة المحددة غير معتمدة أو غير نشطة' }, { status: 400 });
    }
  }

  const originForTest = connector.requiresProviderInstance
    ? (
        await supabaseAdmin.from('provider_instances').select('origin').eq('id', providerInstanceId).single()
      ).data?.origin ?? ''
    : '';

  /*
   * Execute mandatory server-side connection pretest
   */
  const testResult = await connector.testConnection(originForTest, credentials);
  if (!testResult.success) {
    return NextResponse.json(
      { error: testResult.errorMessage || 'فشل اختبار الاتصال — تحقق من بيانات الاتصال' },
      { status: 400 }
    );
  }

  /*
   * Resolve existing connection ID or generate UUID for AAD binding prior to encryption
   */
  const { data: existingConnection } = await supabaseAdmin
    .from('provider_connections')
    .select('id')
    .eq('device_id', deviceId)
    .eq('provider', provider)
    .maybeSingle();

  const connectionId = existingConnection?.id ?? randomUUID();

  /*
   * Encrypt raw credentials using V2 AAD context binding
   */
  const { ciphertext, keyVersion } = encryptCredentialsV2(credentials, {
    connectionId,
    projectId,
    deviceId,
    provider,
  });

  const { data, error } = await supabaseAdmin
    .from('provider_connections')
    .upsert(
      {
        id: connectionId,
        device_id: deviceId,
        project_id: projectId,
        provider,
        provider_instance_id: connector.requiresProviderInstance ? providerInstanceId : null,
        credentials_ciphertext: ciphertext,
        credentials_key_version: keyVersion,
        credentials_migrated_at: new Date().toISOString(),
        vendor_station_id: vendorStationId,
        vendor_station_name: vendorStationName || null,
        is_active: true,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'device_id,provider' }
    )
    .select(CONNECTION_SAFE_COLUMNS)
    .single();

  if (error) return NextResponse.json({ error: safeErrorResponse(error, 'provider-connection upsert failed') }, { status: 500 });
  return NextResponse.json({ connection: data });
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
   * Unlink provider connection without removing underlying telemetry history
   */
  const { error } = await supabaseAdmin.from('provider_connections').delete().eq('device_id', deviceId);
  if (error) return NextResponse.json({ error: safeErrorResponse(error, 'provider-connection delete failed') }, { status: 500 });

  return NextResponse.json({ success: true });
}