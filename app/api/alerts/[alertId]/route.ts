import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { requireUserId } from '@/app/lib/apiAuth';
import { safeErrorResponse } from '@/app/lib/apiError';

// نفس قيم AlertState في app/dashboard/alerts/page.tsx — أي نص آخر يُفسد
// منطق دورة حياة التنبيه المعتمد على مطابقة نصية دقيقة في مسارات أخرى
// (مثال: .neq('state', 'CLOSED') في alerts/count/route.ts).
const VALID_ALERT_STATES = ['NEW', 'REVIEWED', 'ACTION_TAKEN', 'CLOSED'] as const;

// يستبدل supabase.from('alerts').update({state}).eq('id', alertId)
// المباشر من dashboard/alerts/page.tsx (toggleAlertState)
export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ alertId: string }> }
) {
  const auth = await requireUserId(request);
  if ('error' in auth) return auth.error;

  const { alertId } = await context.params;
  const body = await request.json();
  const state = body?.state;
  if (!VALID_ALERT_STATES.includes(state)) {
    return NextResponse.json({ error: `state يجب أن يكون أحد: ${VALID_ALERT_STATES.join('، ')}` }, { status: 400 });
  }

  // تحقق ملكية غير مباشر: التنبيه يخص مشروعاً يخص المستخدم الحالي، عبر
  // JOIN بدل تمرير project_id من العميل (لا يمكن الوثوق به)
  const { data: alertRow } = await supabaseAdmin
    .from('alerts')
    .select('id, project_id, projects!inner(user_id)')
    .eq('id', alertId)
    .single();

  const ownerId = (alertRow as any)?.projects?.user_id;
  if (!alertRow || ownerId !== auth.userId) {
    return NextResponse.json({ error: 'لا تملك هذا التنبيه' }, { status: 403 });
  }

  const { error } = await supabaseAdmin.from('alerts').update({ state }).eq('id', alertId);
  if (error) return NextResponse.json({ error: safeErrorResponse(error, 'alerts/[alertId] update failed') }, { status: 500 });
  return NextResponse.json({ success: true });
}

// حذف تنبيه واحد نهائياً — يستبدل أي حذف مباشر من العميل، بنفس تحقق
// الملكية غير المباشر أعلاه (JOIN على projects.user_id).
export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ alertId: string }> }
) {
  const auth = await requireUserId(request);
  if ('error' in auth) return auth.error;

  const { alertId } = await context.params;

  const { data: alertRow } = await supabaseAdmin
    .from('alerts')
    .select('id, project_id, projects!inner(user_id)')
    .eq('id', alertId)
    .single();

  const ownerId = (alertRow as any)?.projects?.user_id;
  if (!alertRow || ownerId !== auth.userId) {
    return NextResponse.json({ error: 'لا تملك هذا التنبيه' }, { status: 403 });
  }

  const { error } = await supabaseAdmin.from('alerts').delete().eq('id', alertId);
  if (error) return NextResponse.json({ error: safeErrorResponse(error, 'alerts/[alertId] delete failed') }, { status: 500 });
  return NextResponse.json({ success: true });
}
