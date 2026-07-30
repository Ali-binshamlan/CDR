import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { requireViewer } from '@/app/lib/apiAuth';
import { safeErrorResponse } from '@/app/lib/apiError';

// نسخة غير مقيّدة من app/api/dashboard/reports/route.ts — نفس الشكل تماماً
// ({projects, decisions, alerts}, نفس fromDate/toDate)، لكن بلا فلترة
// user_id على projects، لتقرير جهة المراقبة المجمّع عن كل المشاريع.
// ReportsView.tsx يستهلك هذا المسار بلا أي تعديل على محرك التحليل.
export async function GET(request: NextRequest) {
  const auth = await requireViewer(request);
  if ('error' in auth) return auth.error;

  const fromDate = request.nextUrl.searchParams.get('fromDate');
  const toDate = request.nextUrl.searchParams.get('toDate');
  if (!fromDate || !toDate) {
    return NextResponse.json({ error: 'fromDate و toDate مطلوبان' }, { status: 400 });
  }

  const { data: dbProjects, error: projectsError } = await supabaseAdmin
    .from('projects')
    .select('id, name')
    .is('archived_at', null);
  if (projectsError) return NextResponse.json({ error: safeErrorResponse(projectsError, 'viewer/reports projects fetch failed') }, { status: 500 });

  const projectIds = (dbProjects || []).map((p: any) => p.id);
  if (projectIds.length === 0) {
    return NextResponse.json({ projects: dbProjects || [], decisions: [], alerts: [] });
  }

  const endOfDay = new Date(toDate);
  endOfDay.setHours(23, 59, 59, 999);

  const [decisionsRes, alertsRes] = await Promise.all([
    supabaseAdmin
      .from('decision_records')
      .select('id, project_id, status, activity_source')
      .in('project_id', projectIds)
      .gte('created_at', new Date(fromDate).toISOString())
      .lte('created_at', endOfDay.toISOString()),
    supabaseAdmin
      .from('alerts')
      .select('id, project_id, kind')
      .in('project_id', projectIds)
      .gte('created_at', new Date(fromDate).toISOString())
      .lte('created_at', endOfDay.toISOString()),
  ]);
  if (decisionsRes.error) return NextResponse.json({ error: safeErrorResponse(decisionsRes.error, 'viewer/reports decisions fetch failed') }, { status: 500 });
  if (alertsRes.error) return NextResponse.json({ error: safeErrorResponse(alertsRes.error, 'viewer/reports alerts fetch failed') }, { status: 500 });

  return NextResponse.json({
    projects: dbProjects || [],
    decisions: decisionsRes.data || [],
    alerts: alertsRes.data || [],
  });
}
