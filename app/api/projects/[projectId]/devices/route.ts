import { NextResponse, type NextRequest } from 'next/server';
import { randomBytes, createHash } from 'crypto';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { requireUserId, verifyProjectOwnership } from '@/app/lib/apiAuth';

// إدارة أجهزة الرصد المرتبطة بمشروع (project_devices) — يديرها صاحب
// المشروع عبر جلسته العادية (requireUserId + verifyProjectOwnership)، لا
// عبر مفتاح الجهاز نفسه (ذاك مسار منفصل: POST /api/devices/ingest).

const DEVICE_LIST_COLUMNS =
  'id, name, lat, lng, api_key_prefix, is_active, last_reading_at, last_wind_speed_kmh, last_wind_gust_kmh, last_wind_direction_deg, last_pm10, last_pm25, last_visibility_m, created_at, revoked_at';

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

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ devices: data || [] });
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

  const lat = typeof body?.lat === 'number' ? body.lat : null;
  const lng = typeof body?.lng === 'number' ? body.lng : null;

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

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ device: inserted, apiKey: rawKey });
}
