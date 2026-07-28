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
  return NextResponse.json({ device: data });
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

  const { error } = await supabaseAdmin.from('project_devices').delete().eq('id', deviceId);
  if (error) return NextResponse.json({ error: safeErrorResponse(error, 'device delete failed') }, { status: 500 });

  return NextResponse.json({ success: true });
}
