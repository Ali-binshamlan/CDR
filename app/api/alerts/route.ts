import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { requireUserId, verifyProjectOwnership } from '@/app/lib/apiAuth';

// يجلب التنبيه النشط (غير CLOSED) لنشاط محدد — يُستخدم من Dustwidgetcard.tsx.
export async function GET(request: NextRequest) {
  const auth = await requireUserId(request);
  if ('error' in auth) return auth.error;

  const projectId = request.nextUrl.searchParams.get('projectId');
  const activityId = request.nextUrl.searchParams.get('activityId');
  const activitySource = request.nextUrl.searchParams.get('activitySource');
  if (!projectId || !activityId || !activitySource) {
    return NextResponse.json({ error: 'projectId و activityId و activitySource مطلوبة' }, { status: 400 });
  }

  const owns = await verifyProjectOwnership(projectId, auth.userId);
  if (!owns) return NextResponse.json({ error: 'لا تملك هذا المشروع' }, { status: 403 });

  const { data, error } = await supabaseAdmin
    .from('alerts')
    .select('*')
    .eq('project_id', projectId)
    .eq('activity_id', activityId)
    .eq('activity_source', activitySource)
    .neq('state', 'CLOSED')
    .limit(1);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data });
}
