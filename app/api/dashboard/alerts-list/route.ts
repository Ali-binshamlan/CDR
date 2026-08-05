import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { requireUserId } from '@/app/lib/apiAuth';
import { safeErrorResponse } from '@/app/lib/apiError';

// يستبدل fetchAlertsData المباشر في dashboard/alerts/page.tsx — يجمع
// المشاريع + التنبيهات + تسميات أنشطة الغبار المرتبطة في نداء خادم واحد.
// منطق التنسيق النهائي (formattedAlerts) يبقى في الواجهة.
export async function GET(request: NextRequest) {
  const auth = await requireUserId(request);
  if ('error' in auth) return auth.error;
  const userId = auth.userId;

  const { data: dbProjects, error: projectsError } = await supabaseAdmin
    .from('projects')
    .select('id, name')
    .eq('user_id', userId)
    .is('archived_at', null);
  if (projectsError) return NextResponse.json({ error: safeErrorResponse(projectsError, 'dashboard/alerts-list projects fetch failed') }, { status: 500 });

  const projectIds = (dbProjects || []).map((p: { id: string }) => p.id);
  if (projectIds.length === 0) {
    return NextResponse.json({ projects: dbProjects || [], alerts: [], activityLabels: {} });
  }

  const { data: dbAlerts, error: alertsError } = await supabaseAdmin
    .from('alerts')
    .select('*')
    .in('project_id', projectIds)
    .order('created_at', { ascending: false });
  if (alertsError) return NextResponse.json({ error: safeErrorResponse(alertsError, 'dashboard/alerts-list alerts fetch failed') }, { status: 500 });

  const dustIds = [
    ...new Set(
      (dbAlerts || [])
        .filter((a: { activity_source: string }) => a.activity_source === 'dust')
        .map((a: { activity_id: string }) => a.activity_id)
    ),
  ];

  // activityLabels: مفتاح "source:id" → بيانات خام كافية لبناء التسمية في
  // الواجهة (translateActivityType نفسها منطق عرض، تبقى في الواجهة)
  const activityLabels: Record<string, { activity_type: string | null; regulatory_activity: string | null }> = {};

  if (dustIds.length > 0) {
    const { data } = await supabaseAdmin.from('project_dust_profiles').select('id, activity_type, regulatory_activity').in('id', dustIds);
    (data || []).forEach((d: { id: string; activity_type: string | null; regulatory_activity: string | null }) => { activityLabels[`dust:${d.id}`] = { activity_type: d.activity_type, regulatory_activity: d.regulatory_activity }; });
  }

  return NextResponse.json({ projects: dbProjects || [], alerts: dbAlerts || [], activityLabels });
}
