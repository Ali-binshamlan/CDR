import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { requireUserId } from '@/app/lib/apiAuth';
import { safeErrorResponse } from '@/app/lib/apiError';

/*
 * Dashboard Projects List Aggregator Endpoint (DCR Spec — Dust Only):
 * Replaces direct fetch calls in `dashboard/Projects/page.tsx` by returning active projects,
 * unclosed alerts (`state != 'CLOSED'`), and non-archived dust activities in a single request.
 *
 * Operational & Data Scoping Highlights:
 * 1. Soft-Delete Alignment: Strictly filters `archived_at IS NULL` across `projects` and 
 *    `project_dust_profiles` to reflect active counts accurately without counting soft-deleted entities.
 * 2. User Scope Isolation: Ensures `projects!inner` joins check `projects.user_id = userId` 
 *    and non-archived state across all sub-queries.
 */
export async function GET(request: NextRequest) {
  const auth = await requireUserId(request);
  if ('error' in auth) return auth.error;
  const userId = auth.userId;

  /*
   * Fetch active projects belonging to authenticated user
   */
  const { data: dbProjects, error: projectsError } = await supabaseAdmin
    .from('projects')
    .select('*')
    .eq('user_id', userId)
    .is('archived_at', null)
    .order('created_at', { ascending: false });

  if (projectsError) {
    return NextResponse.json(
      { error: safeErrorResponse(projectsError, 'dashboard/projects-list projects fetch failed') },
      { status: 500 }
    );
  }

  /*
   * Fetch active (unclosed) alerts across user's non-archived projects
   */
  const { data: alerts, error: alertsError } = await supabaseAdmin
    .from('alerts')
    .select('*, projects!inner(user_id, archived_at)')
    .neq('state', 'CLOSED')
    .eq('projects.user_id', userId)
    .is('projects.archived_at', null)
    .order('created_at', { ascending: false });

  if (alertsError) {
    return NextResponse.json(
      { error: safeErrorResponse(alertsError, 'dashboard/projects-list alerts fetch failed') },
      { status: 500 }
    );
  }

  /*
   * Fetch non-archived dust activities across user's non-archived projects
   */
  const { data: dustActivities, error: dustError } = await supabaseAdmin
    .from('project_dust_profiles')
    .select('id, project_id, projects!inner(user_id, archived_at)')
    .eq('projects.user_id', userId)
    .is('projects.archived_at', null)
    .is('archived_at', null);

  if (dustError) {
    return NextResponse.json(
      { error: safeErrorResponse(dustError, 'dashboard/projects-list dust fetch failed') },
      { status: 500 }
    );
  }

  return NextResponse.json({
    projects: dbProjects || [],
    alerts: alerts || [],
    dustActivities: dustActivities || [],
  });
}