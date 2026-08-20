import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { requireSuperAdmin } from '@/app/lib/apiAuth';
import { safeErrorResponse } from '@/app/lib/apiError';

/*
 * Fetches all projects across all users without `user_id` filtering 
 * (unlike `/api/dashboard/projects-list` which only fetches the current user's projects).
 * Since no direct foreign key relationship exists between `projects` and `profiles` 
 * (both reference `auth.users` independently), PostgREST implicit embedded joins cannot be used;
 * data is joined manually in memory instead.
 */
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
    /*
     * Previously, `decisionsCount` was calculated from `decision_records` (manually documented decisions—a fully deprecated feature, 
     * see `app/lib/finalDecisionStatus.ts`). It now aggregates from `final_decisions`, which holds automated decisions produced by the evaluation engine.
     * The business meaning shifted from "manual user confirmations" to "total automated engine evaluations," resulting in higher metric counts 
     * as `final_decisions` writes on every evaluation cycle.
     */
    supabaseAdmin.from('final_decisions').select('project_id'),
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