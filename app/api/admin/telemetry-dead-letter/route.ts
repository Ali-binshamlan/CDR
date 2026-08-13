import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { requireSuperAdmin } from '@/app/lib/apiAuth';
import { safeErrorResponse } from '@/app/lib/apiError';

// إدارة telemetry_dead_letter (migration 202608120002) — قراءات جهاز فشلت
// نهائياً في الكتابة (device_readings_history/pm10_readings_history) بعد
// استنفاد كل المحاولات في telemetry-worker، ونُقلت هنا بدل حذفها المباشر
// (راجع تعليق db-cleanup-worker/route.ts الكامل للسياق). سوبر أدمن فقط —
// نفس نمط admin/provider-instances، لا وصول لمالك مشروع عادي (هذا سجل
// تشغيلي عابر للمشاريع، لا بيانات مشروع واحد).
export async function GET(request: NextRequest) {
  const auth = await requireSuperAdmin(request);
  if ('error' in auth) return auth.error;

  const { searchParams } = new URL(request.url);
  // resolved=false (افتراضي) — الصفوف التي لا تزال تنتظر قراراً (لا replay
  // ولا اعتماد بشري بعد). resolved=true يعرض ما اكتمل التعامل معه.
  const showResolved = searchParams.get('resolved') === 'true';

  let query = supabaseAdmin
    .from('telemetry_dead_letter')
    .select('*')
    .order('archived_at', { ascending: false })
    .limit(200);

  query = showResolved
    ? query.or('replayed_at.not.is.null,acknowledged_at.not.is.null')
    : query.is('replayed_at', null).is('acknowledged_at', null);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: safeErrorResponse(error, 'telemetry-dead-letter fetch failed') }, { status: 500 });
  return NextResponse.json({ data });
}

// action='replay': يعيد إدراج الحمولة في telemetry_ingestion_queue بحالة
// PENDING عبر replay_dead_telemetry_letter — telemetry-worker يعالجها في
// دورته التالية كأي قراءة جديدة. الصف هنا يبقى موجوداً دائماً (لا حذف)،
// فقط replayed_at/replayed_by/replay_queue_id يُضبطان.
//
// action='acknowledge': اعتماد بشري موثَّق أن القراءة مفقودة نهائياً —
// reason إلزامي (يُرفَض فارغاً من الدالة الذرية نفسها، لا فقط هنا). لا حذف
// أبداً — فقط توثيق القرار (من/متى/لماذا) على الصف نفسه، فيبقى سجلاً
// تاريخياً دائماً لماذا فُقدت هذه القراءة تحديداً.
export async function POST(request: NextRequest) {
  const auth = await requireSuperAdmin(request);
  if ('error' in auth) return auth.error;

  const body = await request.json().catch(() => null);
  const id = typeof body?.id === 'string' ? body.id : '';
  const action = typeof body?.action === 'string' ? body.action : '';
  if (!id) return NextResponse.json({ error: 'id مطلوب' }, { status: 400 });

  if (action === 'replay') {
    const { data, error } = await supabaseAdmin.rpc('replay_dead_telemetry_letter', {
      p_dead_letter_id: id,
      p_replayed_by: auth.userId,
    });
    if (error) return NextResponse.json({ error: safeErrorResponse(error, 'replay_dead_telemetry_letter failed') }, { status: 500 });
    return NextResponse.json({ success: true, queueId: data });
  }

  if (action === 'acknowledge') {
    const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
    if (!reason) return NextResponse.json({ error: 'reason مطلوب (سبب الاعتماد النهائي بأن القراءة مفقودة)' }, { status: 400 });

    const { data, error } = await supabaseAdmin.rpc('acknowledge_dead_telemetry_letter', {
      p_dead_letter_id: id,
      p_acknowledged_by: auth.userId,
      p_reason: reason,
    });
    if (error) return NextResponse.json({ error: safeErrorResponse(error, 'acknowledge_dead_telemetry_letter failed') }, { status: 500 });
    if (!data) return NextResponse.json({ error: 'الصف غير موجود أو تم التعامل معه مسبقاً (replay أو اعتماد سابق)' }, { status: 409 });
    return NextResponse.json({ success: true });
  }

  return NextResponse.json({ error: "action يجب أن يكون 'replay' أو 'acknowledge'" }, { status: 400 });
}
