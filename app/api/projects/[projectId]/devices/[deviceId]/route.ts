import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { requireUserId, verifyProjectOwnership } from '@/app/lib/apiAuth';
import { safeErrorResponse } from '@/app/lib/apiError';

const DEVICE_SAFE_COLUMNS =
  'id, name, lat, lng, api_key_prefix, is_active, last_reading_at, last_wind_speed_kmh, last_wind_gust_kmh, last_wind_direction_deg, last_pm10, last_pm25, last_visibility_m, created_at, revoked_at, true_north_alignment_documented, true_north_alignment_type, true_north_verification_method, true_north_verified_by, true_north_verified_at, true_north_deviation_deg, true_north_evidence_url';

// خطأ مكتشَف ومُصلَح (مراجعة خبير خارجي — "توثيق الشمال الحقيقي: يجب أن
// يكون مرتبطاً بكل محطة أو حساس اتجاه رياح، ويتضمن: تاريخ التوجيه، طريقة
// التحقق، الشخص المنفذ، الشمال الحقيقي أو المغناطيسي، الانحراف المطبق،
// مستند أو صورة الإثبات"): الأعمدة الستة (migration
// 202608060001_device_true_north_calibration.sql) تُحدَّث هنا فقط —
// documented=true لا يجوز أن يُضبَط ذاتياً بلا الحقول الداعمة الأساسية
// (النوع + طريقة التحقق + المنفذ) حتى لا يصبح مجرد علم بلا سياق موثَّق
// فعلياً، بنفس الفلسفة التي انتقدها التقرير أصلاً.
const TRUE_NORTH_ALIGNMENT_TYPES = new Set(['TRUE_NORTH', 'MAGNETIC_NORTH']);

function extractTrueNorthUpdates(body: Record<string, unknown> | null): Record<string, unknown> {
  const updates: Record<string, unknown> = {};
  if (!body || typeof body !== 'object' || !('trueNorth' in body)) return updates;
  const tn = body.trueNorth as Record<string, unknown> | null;
  if (!tn || typeof tn !== 'object') return updates;

  const alignmentType = typeof tn.alignmentType === 'string' ? tn.alignmentType : null;
  const verificationMethod = typeof tn.verificationMethod === 'string' ? tn.verificationMethod.trim() : null;
  const verifiedBy = typeof tn.verifiedBy === 'string' ? tn.verifiedBy.trim() : null;
  const deviationDeg = typeof tn.deviationDeg === 'number' && Number.isFinite(tn.deviationDeg) ? tn.deviationDeg : null;
  const evidenceUrl = typeof tn.evidenceUrl === 'string' ? tn.evidenceUrl.trim() : null;
  const documentedRequested = tn.documented === true;

  if (alignmentType !== null && !TRUE_NORTH_ALIGNMENT_TYPES.has(alignmentType)) {
    throw new Error('نوع محاذاة الشمال يجب أن يكون TRUE_NORTH أو MAGNETIC_NORTH');
  }

  // documented=true يتطلب حداً أدنى من التوثيق الفعلي (نوع + طريقة تحقق +
  // منفذ) — بلا هذا الشرط، الحقل يعود لنفس مشكلة "علم بلا سياق" التي
  // انتقدها التقرير أصلاً في عمود projects.true_north_alignment_documented
  // القديم.
  const documented = documentedRequested && alignmentType !== null && !!verificationMethod && !!verifiedBy;

  updates.true_north_alignment_documented = documented;
  updates.true_north_alignment_type = alignmentType;
  updates.true_north_verification_method = verificationMethod;
  updates.true_north_verified_by = verifiedBy;
  updates.true_north_verified_at = documented ? new Date().toISOString() : null;
  updates.true_north_deviation_deg = deviationDeg;
  updates.true_north_evidence_url = evidenceUrl;
  return updates;
}

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

  try {
    Object.assign(updates, extractTrueNorthUpdates(body));
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'بيانات معايرة الشمال الحقيقي غير صالحة' }, { status: 400 });
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
