import { NextResponse, type NextRequest } from 'next/server';
import { randomBytes, createHash } from 'crypto';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { requireUserId, verifyProjectOwnership } from '@/app/lib/apiAuth';
import { safeErrorResponse } from '@/app/lib/apiError';

// إدارة أجهزة الرصد المرتبطة بمشروع (project_devices) — يديرها صاحب
// المشروع عبر جلسته العادية (requireUserId + verifyProjectOwnership)، لا
// عبر مفتاح الجهاز نفسه (ذاك مسار منفصل: POST /api/devices/ingest).

const DEVICE_LIST_COLUMNS =
  'id, name, lat, lng, api_key_prefix, is_active, last_reading_at, last_wind_speed_kmh, last_wind_gust_kmh, last_wind_direction_deg, last_pm10, last_pm25, last_visibility_m, created_at, revoked_at, true_north_alignment_documented, true_north_alignment_type, true_north_verification_method, true_north_verified_by, true_north_verified_at, true_north_deviation_deg, true_north_evidence_url';

// أعمدة آمنة للعرض — credentials مُستبعَد دائماً عمداً (نفس فلسفة
// api_key_hash أعلاه)، يطابق CONNECTION_SAFE_COLUMNS في provider-connection/route.ts.
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

  // استعلام أعمدة صريح — لا select('*') أبداً على هذا الجدول لأنه يحمل
  // api_key_hash (سر لا يجوز أن يغادر السيرفر تحت أي ظرف).
  const { data, error } = await supabaseAdmin
    .from('project_devices')
    .select(DEVICE_LIST_COLUMNS)
    .eq('project_id', projectId)
    .order('created_at', { ascending: false });

  if (error) return NextResponse.json({ error: safeErrorResponse(error, 'devices list fetch failed') }, { status: 500 });

  // خطأ أداء مكتشَف — مراجعة صفحة settings/page.tsx: كانت تجلب هذه القائمة
  // ثم تُطلق طلب GET منفصل لكل جهاز على حدة (N+1) لجلب حالة اتصال المزوّد
  // الخارجي الخاص به (provider-connection/route.ts) — استعلام واحد مجمَّع هنا
  // (project_id بدل device_id) يستبدل كل تلك الطلبات المنفصلة بطلب شبكة واحد.
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

  // إحداثيات الجهاز إجبارية (طلب صريح: الربط التلقائي بأقرب جهاز عند إنشاء
  // نشاط — resolveNearestActiveDeviceId في dust-profiles/route.ts — يحتاج
  // موقعاً فعلياً لكل جهاز، وإلا يبقى مستبعداً من الحساب صامتاً). لا نقبل
  // بعد الآن قيمة غير رقمية تتحول لـnull بصمت.
  const lat = typeof body?.lat === 'number' ? body.lat : NaN;
  const lng = typeof body?.lng === 'number' ? body.lng : NaN;
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return NextResponse.json({ error: 'إحداثيات الجهاز (خط العرض وخط الطول) مطلوبة وبمدى صالح' }, { status: 400 });
  }

  // المفتاح الخام يُنشأ هنا فقط ويُعاد مرة واحدة في هذه الاستجابة — لا
  // يُخزَّن أبداً، فقط هاشه (نفس أسلوب GitHub/Stripe لعرض مفاتيح API).
  const rawKey = `dcr_${randomBytes(32).toString('hex')}`;
  const apiKeyHash = createHash('sha256').update(rawKey).digest('hex');
  const apiKeyPrefix = rawKey.slice(0, 12);

  const { data: inserted, error } = await supabaseAdmin
    .from('project_devices')
    .insert({
      project_id: projectId,
      name,
      lat,
      lng,
      api_key_hash: apiKeyHash,
      api_key_prefix: apiKeyPrefix,
    })
    .select(DEVICE_LIST_COLUMNS)
    .single();

  if (error) return NextResponse.json({ error: safeErrorResponse(error, 'device create failed') }, { status: 500 });

  return NextResponse.json({ device: inserted, apiKey: rawKey });
}
