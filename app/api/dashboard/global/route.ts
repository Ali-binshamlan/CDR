import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { requireUserId } from '@/app/lib/apiAuth';

// يجمع كل استعلامات المشاريع/التنبيهات/أنشطة اليوم/القرارات في نداء واحد
// لصفحة لوحة التحكم الرئيسية. نسخة DCR: غبار فقط، بلا رافعات/حرارة.
export async function GET(request: NextRequest) {
  const auth = await requireUserId(request);
  if ('error' in auth) return auth.error;
  const userId = auth.userId;

  const todayStr = new Date().toLocaleDateString('en-CA');

  const { data: projectsData, error: projectsError } = await supabaseAdmin
    .from('projects')
    .select('*')
    .eq('user_id', userId);
  if (projectsError) return NextResponse.json({ error: projectsError.message }, { status: 500 });

  const projectIds = (projectsData || []).map((p: any) => p.id);

  // state != 'CLOSED' يطابق تعريف "غير مغلق" المستخدم في مولّد التنبيهات
  // (alertExists) وباقي مسارات القراءة — لا عمود is_resolved في DCR.
  const { data: alerts, error: alertsError } = await supabaseAdmin
    .from('alerts')
    .select('*, projects!inner(name, city, user_id)')
    .neq('state', 'CLOSED')
    .eq('projects.user_id', userId)
    .order('created_at', { ascending: false });
  if (alertsError) return NextResponse.json({ error: alertsError.message }, { status: 500 });

  let dustData: any[] = [];
  let decisionsData: any[] = [];

  if (projectIds.length > 0) {
    const [dustRes, decisionsRes] = await Promise.all([
      supabaseAdmin.from('project_dust_profiles').select('*').in('project_id', projectIds).eq('planned_date', todayStr),
      supabaseAdmin.from('decision_records').select('*').in('project_id', projectIds).order('created_at', { ascending: false }),
    ]);
    dustData = dustRes.data || [];
    decisionsData = decisionsRes.data || [];
  }

  return NextResponse.json({
    projects: projectsData || [],
    alerts: alerts || [],
    dustActivities: dustData,
    decisions: decisionsData,
    executionWindows: [],
  });
}
