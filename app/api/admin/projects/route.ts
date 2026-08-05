import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { requireSuperAdmin } from '@/app/lib/apiAuth';
import { safeErrorResponse } from '@/app/lib/apiError';

// كل مشاريع كل المستخدمين — بلا أي فلترة user_id، على عكس
// /api/dashboard/projects-list (التي تعرض مشاريع المستخدم الحالي فقط).
// لا FK مباشر من projects إلى profiles (كلاهما يشير إلى auth.users بشكل
// منفصل)، فلا يمكن استخدام صياغة embed الضمنية لـ PostgREST — دمج بالذاكرة.
export async function GET(request: NextRequest) {
  const auth = await requireSuperAdmin(request);
  if ('error' in auth) return auth.error;

  const [
    { data: projects, error: projectsError },
    { data: profiles },
    { data: alertRows },
    { data: decisionRows },
  ] = await Promise.all([
    supabaseAdmin.from('projects').select('*').order('created_at', { ascending: false }),
    supabaseAdmin.from('profiles').select('id, username, company_name'),
    supabaseAdmin.from('alerts').select('project_id').neq('state', 'CLOSED'),
    supabaseAdmin.from('decision_records').select('project_id'),
  ]);
  if (projectsError) return NextResponse.json({ error: safeErrorResponse(projectsError, 'admin/projects fetch failed') }, { status: 500 });

  const profileByUserId = new Map((profiles || []).map((p: { id: string; username: string | null; company_name: string | null }) => [p.id, p]));

  const activeAlertsCountByProject = new Map<string, number>();
  for (const row of alertRows || []) {
    activeAlertsCountByProject.set(row.project_id, (activeAlertsCountByProject.get(row.project_id) || 0) + 1);
  }
  const decisionsCountByProject = new Map<string, number>();
  for (const row of decisionRows || []) {
    decisionsCountByProject.set(row.project_id, (decisionsCountByProject.get(row.project_id) || 0) + 1);
  }

  const data = (projects || []).map((project: { id: string; user_id: string }) => {
    const owner = profileByUserId.get(project.user_id);
    return {
      ...project,
      ownerUsername: owner?.username || null,
      ownerCompany: owner?.company_name || null,
      activeAlertsCount: activeAlertsCountByProject.get(project.id) || 0,
      decisionsCount: decisionsCountByProject.get(project.id) || 0,
    };
  });

  return NextResponse.json({ data });
}
