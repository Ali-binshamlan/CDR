import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { requireUserId, verifyProjectOwnership } from '@/app/lib/apiAuth';
import { safeErrorResponse } from '@/app/lib/apiError';

const DEVICE_SAFE_COLUMNS =
  'id, name, lat, lng, api_key_prefix, is_active, last_reading_at, last_wind_speed_kmh, last_wind_gust_kmh, last_wind_direction_deg, last_pm10, last_pm25, last_visibility_m, created_at, revoked_at';

// يتحقق أن الجهاز المطلوب فعلاً ينتمي للمشروع في الرابط — دفاع إضافي رخيص
// فوق verifyProjectOwnership: يمنع مالك مشروع A من التأثير على صف جهاز
// خمّن معرّفه ويتبع فعلياً مشروع B (حتى لو كان سيفشل أصلاً بفحص ملكية B).
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
  const owns = await verifyProjectOwnership(projectId, auth.userId);
  if (!owns) return NextResponse.json({ error: 'لا تملك هذا المشروع' }, { status: 403 });

  const device = await loadOwnedDevice(projectId, deviceId);
  if (!device) return NextResponse.json({ error: 'الجهاز غير موجود' }, { status: 404 });

  const body = await request.json().catch(() => null);
  const updates: Record<string, unknown> = {};

  if (typeof body?.name === 'string' && body.name.trim()) updates.name = body.name.trim();
  if (typeof body?.lat === 'number' || body?.lat === null) updates.lat = body.lat;
  if (typeof body?.lng === 'number' || body?.lng === null) updates.lng = body.lng;
  if (typeof body?.is_active === 'boolean') {
    updates.is_active = body.is_active;
    // الإلغاء يُسجَّل بطابع زمني (revoked_at)؛ إعادة التفعيل تمسحه — يطابق
    // دلالة "متى أُلغي آخر مرة"، لا "هل أُلغي يوماً ما".
    updates.revoked_at = body.is_active ? null : new Date().toISOString();
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'لا توجد حقول صالحة للتحديث' }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin
    .from('project_devices')
    .update(updates)
    .eq('id', deviceId)
    .select(DEVICE_SAFE_COLUMNS)
    .single();

  if (error) return NextResponse.json({ error: safeErrorResponse(error, 'device update failed') }, { status: 500 });

  // خطأ مكتشَف ومُصلَح: تعطيل جهاز (is_active=false) كان يترك أي
  // provider_connections مرتبط به is_active=true — فيستمر /api/cron/
  // provider-pull بمحاولة سحبه كل دورة، تفشل دائماً بخطأ RPC "device not
  // found, revoked, or project mismatch" (persist_activity_decision_atomic/
  // atomic_device_ingest تتحقق من project_devices.is_active صراحة). تعطيل
  // الاتصال تلقائياً هنا يوقف هذه المحاولات الفاشلة المستمرة بلا داعٍ.
  if (updates.is_active === false) {
    await supabaseAdmin
      .from('provider_connections')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('device_id', deviceId);
  }

  return NextResponse.json({ device: data });
}

// خطأ مكتشَف ومُصلَح (مراجعة تصحيح خارجية — "الأرشفة بدل الحذف"): كان هذا
// المسار يحذف صف project_devices فعلياً. device_readings_history/
// pm10_readings_history المرتبطة به append-only (trigger forbid_evidence_
// mutation) فتُحذف بواسطة on delete cascade على device_id — سلسلة أدلة
// تاريخية كاملة تُمحى نهائياً بحذف جهاز واحد. الإصلاح: إلغاء (نفس منطق
// PATCH أعلاه: is_active=false + revoked_at) بدل DELETE — القراءات
// التاريخية تبقى محفوظة ومرتبطة بجهازها الأصلي دائماً.
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

  const { error } = await supabaseAdmin
    .from('project_devices')
    .update({ is_active: false, revoked_at: new Date().toISOString() })
    .eq('id', deviceId);
  if (error) return NextResponse.json({ error: safeErrorResponse(error, 'device revoke failed') }, { status: 500 });

  // راجع نفس التعليق في PATCH أعلاه — يمنع محاولات سحب فاشلة مستمرة
  // لجهاز أُلغي.
  await supabaseAdmin
    .from('provider_connections')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('device_id', deviceId);

  return NextResponse.json({ success: true });
}
