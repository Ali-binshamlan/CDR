import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { requireUserId, verifyProjectOwnership } from '@/app/lib/apiAuth';
import { safeErrorResponse } from '@/app/lib/apiError';
import { getConnector } from '@/app/lib/providers/registry';

// أعمدة آمنة للعرض بالواجهة — credentials يُستبعَد دائماً عمداً (يحمل
// مفاتيح API لطرف ثالث، لا داعي لعرضها بعد إدخالها مرة، بنفس فلسفة
// api_key_hash في project_devices).
const CONNECTION_SAFE_COLUMNS =
  'id, device_id, project_id, provider, vendor_station_id, vendor_station_name, is_active, last_pull_at, last_pull_success, last_pull_error, created_at, updated_at';

// نفس الحارس الموجود في app/api/projects/[projectId]/devices/[deviceId]/route.ts —
// يمنع مالك مشروع A من التأثير على جهاز يتبع فعلياً مشروع B.
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
  const owns = await verifyProjectOwnership(projectId, auth.userId);
  if (!owns) return NextResponse.json({ error: 'لا تملك هذا المشروع' }, { status: 403 });

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
  const owns = await verifyProjectOwnership(projectId, auth.userId);
  if (!owns) return NextResponse.json({ error: 'لا تملك هذا المشروع' }, { status: 403 });

  const device = await loadOwnedDevice(projectId, deviceId);
  if (!device) return NextResponse.json({ error: 'الجهاز غير موجود' }, { status: 404 });

  const body = await request.json().catch(() => null);
  const provider = typeof body?.provider === 'string' ? body.provider : '';
  const credentials = body?.credentials && typeof body.credentials === 'object' ? body.credentials : {};
  const vendorStationId = typeof body?.vendorStationId === 'string' ? body.vendorStationId.trim() : '';
  const vendorStationName = typeof body?.vendorStationName === 'string' ? body.vendorStationName.trim() : '';

  if (!provider) return NextResponse.json({ error: 'provider مطلوب' }, { status: 400 });
  if (!vendorStationId) return NextResponse.json({ error: 'vendorStationId مطلوب' }, { status: 400 });

  const connector = getConnector(provider);
  if (!connector) return NextResponse.json({ error: `provider غير مسجَّل: ${provider}` }, { status: 400 });

  // إعادة تحقق أمنية على السيرفر — لا نثق بنتيجة اختبار سابق من المتصفح
  // فقط (طرف قد يتلاعب بالطلب مباشرة متجاوزاً زر "اختبار الاتصال" بالواجهة).
  const testResult = await connector.testConnection(credentials);
  if (!testResult.success) {
    return NextResponse.json(
      { error: testResult.errorMessage || 'فشل اختبار الاتصال — تحقق من بيانات الاتصال' },
      { status: 400 }
    );
  }

  const { data, error } = await supabaseAdmin
    .from('provider_connections')
    .upsert(
      {
        device_id: deviceId,
        project_id: projectId,
        provider,
        credentials,
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
  const owns = await verifyProjectOwnership(projectId, auth.userId);
  if (!owns) return NextResponse.json({ error: 'لا تملك هذا المشروع' }, { status: 403 });

  const device = await loadOwnedDevice(projectId, deviceId);
  if (!device) return NextResponse.json({ error: 'الجهاز غير موجود' }, { status: 404 });

  // حذف الربط فقط (إلغاء الربط) — لا يحذف تاريخ القراءات المسجَّلة سابقاً
  // في device_readings_history/pm10_readings_history.
  const { error } = await supabaseAdmin.from('provider_connections').delete().eq('device_id', deviceId);
  if (error) return NextResponse.json({ error: safeErrorResponse(error, 'provider-connection delete failed') }, { status: 500 });

  return NextResponse.json({ success: true });
}
