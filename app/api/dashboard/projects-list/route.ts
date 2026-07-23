import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { requireUserId } from '@/app/lib/apiAuth';

// يستبدل fetchProjectsData المباشر في dashboard/Projects/page.tsx.
// نسخة DCR: غبار فقط، بلا رافعات/حرارة. state != 'CLOSED' يطابق تعريف
// "غير مغلق" المستخدم في باقي مسارات القراءة (لا عمود is_resolved في DCR).
export async function GET(request: NextRequest) {
  const auth = await requireUserId(request);
  if ('error' in auth) return auth.error;
  const userId = auth.userId;

  const { data: dbProjects, error: projectsError } = await supabaseAdmin
    .from('projects')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (projectsError) return NextResponse.json({ error: projectsError.message }, { status: 500 });

  const { data: alerts, error: alertsError } = await supabaseAdmin
    .from('alerts')
    .select('*, projects!inner(user_id)')
    .neq('state', 'CLOSED')
    .eq('projects.user_id', userId)
    .order('created_at', { ascending: false });
  if (alertsError) return NextResponse.json({ error: alertsError.message }, { status: 500 });

  const { data: dustActivities, error: dustError } = await supabaseAdmin
    .from('project_dust_profiles')
    .select('id, project_id, projects!inner(user_id)')
    .eq('projects.user_id', userId);
  if (dustError) return NextResponse.json({ error: dustError.message }, { status: 500 });

  return NextResponse.json({
    projects: dbProjects || [],
    alerts: alerts || [],
    dustActivities: dustActivities || [],
  });
}
