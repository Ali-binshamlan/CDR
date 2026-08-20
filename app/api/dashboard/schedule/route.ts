import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { requireUserId } from '@/app/lib/apiAuth';
import { safeErrorResponse } from '@/app/lib/apiError';

/*
 * Dashboard Schedule Aggregator Endpoint:
 * Fetches scheduled dust activity profiles across all active user projects within a date range
 * (`from`/`to`, YYYY-MM-DD) to power the weekly calendar view.
 *
 * Operational & Data Scoping Highlights:
 * 1. Range Validation: Ensures both `from` and `to` query parameters are provided before executing queries.
 * 2. Scope Isolation: Resolves non-archived projects belonging to `userId` and scopes activity checks strictly to `projectIds`.
 * 3. Soft-Delete Alignment: Strictly checks `archived_at IS NULL` on `project_dust_profiles` so soft-deleted activities
 *    do not persist in calendar projections.
 */
export async function GET(request: NextRequest) {
  const auth = await requireUserId(request);
  if ('error' in auth) return auth.error;
  const userId = auth.userId;

  const from = request.nextUrl.searchParams.get('from');
  const to = request.nextUrl.searchParams.get('to');
  if (!from || !to) {
    return NextResponse.json({ error: 'from و to مطلوبان' }, { status: 400 });
  }

  /*
   * Fetch active project inventory for authenticated user
   */
  const { data: projects, error: projectsError } = await supabaseAdmin
    .from('projects')
    .select('id, name')
    .eq('user_id', userId)
    .is('archived_at', null);

  if (projectsError) {
    return NextResponse.json(
      { error: safeErrorResponse(projectsError, 'dashboard/schedule projects fetch failed') },
      { status: 500 }
    );
  }

  const projectIds = (projects || []).map((p: { id: string }) => p.id);
  if (projectIds.length === 0) {
    return NextResponse.json({ projects: [], activities: [] });
  }

  /*
   * Fetch non-archived dust activities scheduled within requested date interval
   */
  const { data: activities, error } = await supabaseAdmin
    .from('project_dust_profiles')
    .select('id, project_id, regulatory_activity, planned_date, planned_time, duration_hours')
    .in('project_id', projectIds)
    .is('archived_at', null)
    .gte('planned_date', from)
    .lte('planned_date', to)
    .order('planned_date', { ascending: true })
    .order('planned_time', { ascending: true });

  if (error) {
    return NextResponse.json(
      { error: safeErrorResponse(error, 'dashboard/schedule activities fetch failed') },
      { status: 500 }
    );
  }

  return NextResponse.json({
    projects: projects || [],
    activities: activities || [],
  });
}