import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { requireUserId, verifyProjectOwnership } from '@/app/lib/apiAuth';
import { safeErrorResponse } from '@/app/lib/apiError';
import { getConnector } from '@/app/lib/providers/registry';
import { encryptCredentialsV2 } from '@/app/lib/credentialsEncryption';
import { randomUUID } from 'node:crypto';

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
  const providerInstanceId = typeof body?.providerInstanceId === 'string' ? body.providerInstanceId.trim() : '';

  if (!provider) return NextResponse.json({ error: 'provider مطلوب' }, { status: 400 });
  if (!vendorStationId) return NextResponse.json({ error: 'vendorStationId مطلوب' }, { status: 400 });

  const connector = getConnector(provider);
  if (!connector) return NextResponse.json({ error: `provider غير مسجَّل: ${provider}` }, { status: 400 });

  // خطأ أمني مكتشَف ومُصلَح (القسم 15.1 — "provider_instances سجل معتمد من
  // مسؤول النظام"): base_url لم يعد يأتي من credentials الحرة للمستخدم —
  // المستخدم يختار providerInstanceId من قائمة معتمدة فقط (is_approved
  // AND is_active)، ونحل origin هنا من الجدول مباشرة، لا من إدخاله.
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

  // إعادة تحقق أمنية على السيرفر — لا نثق بنتيجة اختبار سابق من المتصفح
  // فقط (طرف قد يتلاعب بالطلب مباشرة متجاوزاً زر "اختبار الاتصال" بالواجهة).
  const testResult = await connector.testConnection(originForTest, credentials);
  if (!testResult.success) {
    return NextResponse.json(
      { error: testResult.errorMessage || 'فشل اختبار الاتصال — تحقق من بيانات الاتصال' },
      { status: 400 }
    );
  }

  // معرّف الصف مطلوب قبل التشفير (v2 يربط AAD بـconnection_id) — لصف موجود
  // (تحديث بيانات اتصال قائمة) نعيد استخدام نفس id بحيث لا يتغيّر AAD عند
  // إعادة الحفظ؛ لصف جديد نولّد id هنا صراحة بدل ترك gen_random_uuid()
  // بالقاعدة تختاره بعد الكتابة (نحتاجه *قبل* التشفير).
  const { data: existingConnection } = await supabaseAdmin
    .from('provider_connections')
    .select('id')
    .eq('device_id', deviceId)
    .eq('provider', provider)
    .maybeSingle();
  const connectionId = existingConnection?.id ?? randomUUID();

  // تشفير عند الحفظ فقط (خطأ أمني مكتشَف — راجع credentialsEncryption.ts):
  // testConnection أعلاه يستخدم credentials الخام (القادمة من طلب المستخدم
  // مباشرة، لم تُخزَّن بعد) — لا علاقة لها بالتشفير. القيمة المشفَّرة فقط
  // هي ما يُكتَب فعلياً في provider_connections.credentials_ciphertext، مربوطة
  // عبر AAD بـ(connection_id, project_id, device_id, provider) هذا الصف
  // تحديداً — نسخ الـciphertext لصف آخر يفشل عند فك التشفير.
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
