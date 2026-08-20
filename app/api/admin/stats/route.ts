import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { requireSuperAdmin } from '@/app/lib/apiAuth';

/*
 * Aggregated metrics for the admin landing dashboard, derived directly from existing database tables.
 * Session/visit tracking is excluded (no supporting infrastructure exists).
 * 
 * Note: `alertsByKind` is explicitly aggregated by `kind` rather than `risk_level` 
 * as `risk_level` does not exist in the `alerts` table schema (see `app/lib/decisionMeta.ts` for details).
 */
export async function GET(request: NextRequest) {
  const auth = await requireSuperAdmin(request);
  if ('error' in auth) return auth.error;

  const [
    { count: totalUsers },
    { data: allProjects },
    { data: allAlerts },
  ] = await Promise.all([
    supabaseAdmin.from('profiles').select('id', { count: 'exact', head: true }),
    /*
     * Filter (`archived_at IS NULL`): Ensures project stats by status and city reflect active projects only.
     * Including archived projects artificially skews totals without providing operational utility.
     */
    supabaseAdmin.from('projects').select('id, city, project_status').is('archived_at', null),
    supabaseAdmin.from('alerts').select('id, kind').neq('state', 'CLOSED'),
  ]);

  const projects = allProjects || [];
  const projectsByStatus: Record<string, number> = {};
  const projectsByCity: Record<string, number> = {};
  for (const p of projects) {
    const status = p.project_status || 'not_started';
    projectsByStatus[status] = (projectsByStatus[status] || 0) + 1;
    const city = p.city || 'غير محدد';
    projectsByCity[city] = (projectsByCity[city] || 0) + 1;
  }

  const alerts = allAlerts || [];
  const alertsByKind: Record<string, number> = {};
  for (const a of alerts) {
    alertsByKind[a.kind] = (alertsByKind[a.kind] || 0) + 1;
  }

  return NextResponse.json({
    data: {
      totalUsers: totalUsers || 0,
      totalProjects: projects.length,
      projectsByStatus,
      projectsByCity,
      totalActiveAlerts: alerts.length,
      alertsByKind,
    },
  });
}