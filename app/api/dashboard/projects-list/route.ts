import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { requireUserId } from '@/app/lib/apiAuth';
import { safeErrorResponse } from '@/app/lib/apiError';

// يستبدل fetchProjectsData المباشر في dashboard/Projects/page.tsx.
// نسخة DCR: غبار فقط، بلا رافعات/حرارة. state != 'CLOSED' يطابق تعريف
// "غير مغلق" المستخدم في باقي مسارات القراءة (لا عمود is_resolved في DCR).
export async function GET(request: NextRequest) {
  const auth = await requireUserId(request);
  if ('error' in auth) return auth.error;
  const userId = auth.userId;

  // archived_at is null: مشاريع مؤرشفة (راجع DELETE في projects/[projectId]/
  // route.ts) لا تظهر في قائمة "مشاريعي" النشطة — نفس مبدأ عدم الحذف
  // الفعلي، فقط الإخفاء عن القوائم اليومية.
  const { data: dbProjects, error: projectsError } = await supabaseAdmin
    .from('projects')
    .select('*')
    .eq('user_id', userId)
    .is('archived_at', null)
    .order('created_at', { ascending: false });
  if (projectsError) return NextResponse.json({ error: safeErrorResponse(projectsError, 'dashboard/projects-list projects fetch failed') }, { status: 500 });

  const { data: alerts, error: alertsError } = await supabaseAdmin
    .from('alerts')
    .select('*, projects!inner(user_id, archived_at)')
    .neq('state', 'CLOSED')
    .eq('projects.user_id', userId)
    .is('projects.archived_at', null)
    .order('created_at', { ascending: false });
  if (alertsError) return NextResponse.json({ error: safeErrorResponse(alertsError, 'dashboard/projects-list alerts fetch failed') }, { status: 500 });

  // خطأ مكتشَف ومُصلَح (المستخدم لاحظ تناقضاً — "7 إجمالي أنشطة" في بطاقة
  // المشروع مقابل نشاط واحد فقط ظاهر فعلياً في صفحة تفاصيل المشروع بعد حذف
  // 6 أنشطة): كان الاستعلام يفلتر projects.archived_at فقط، بلا فلتر على
  // project_dust_profiles.archived_at نفسه — الأرشفة (لا حذف فعلي، راجع
  // DELETE في app/api/activities/route.ts) لا تُخفي الصف هنا رغم إخفائه في
  // كل مسار آخر (evaluateProject.ts:118، app/api/projects/[projectId]/
  // route.ts). is('archived_at', null) الآن يطابق نفس معيار الاستبعاد
  // المستخدم في بقية المشروع.
  const { data: dustActivities, error: dustError } = await supabaseAdmin
    .from('project_dust_profiles')
    .select('id, project_id, projects!inner(user_id, archived_at)')
    .eq('projects.user_id', userId)
    .is('projects.archived_at', null)
    .is('archived_at', null);
  if (dustError) return NextResponse.json({ error: safeErrorResponse(dustError, 'dashboard/projects-list dust fetch failed') }, { status: 500 });

  return NextResponse.json({
    projects: dbProjects || [],
    alerts: alerts || [],
    dustActivities: dustActivities || [],
  });
}
