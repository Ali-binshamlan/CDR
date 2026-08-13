import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { requireUserId } from '@/app/lib/apiAuth';
import { safeErrorResponse } from '@/app/lib/apiError';
import { toReportDecisionRow } from '@/app/lib/finalDecisionStatus';

// يستبدل fetchReportData المباشر في dashboard/reports/page.tsx
export async function GET(request: NextRequest) {
  const auth = await requireUserId(request);
  if ('error' in auth) return auth.error;
  const userId = auth.userId;

  const fromDate = request.nextUrl.searchParams.get('fromDate');
  const toDate = request.nextUrl.searchParams.get('toDate');
  if (!fromDate || !toDate) {
    return NextResponse.json({ error: 'fromDate و toDate مطلوبان' }, { status: 400 });
  }

  const { data: dbProjects, error: projectsError } = await supabaseAdmin
    .from('projects')
    .select('id, name')
    .eq('user_id', userId)
    .is('archived_at', null);
  if (projectsError) return NextResponse.json({ error: safeErrorResponse(projectsError, 'dashboard/reports projects fetch failed') }, { status: 500 });

  const projectIds = (dbProjects || []).map((p: { id: string }) => p.id);
  if (projectIds.length === 0) {
    return NextResponse.json({ projects: dbProjects || [], decisions: [], alerts: [] });
  }

  const endOfDay = new Date(toDate);
  endOfDay.setHours(23, 59, 59, 999);

  // خطأ معماري مكتشَف ومُصلَح ("المكوّن الذي يحفظ decision_records مخفي، بينما
  // التقارير تعتمد عليها؛ لذلك قد تظهر التقارير صفراً رغم وجود قرارات آلية"):
  // كانت التقارير تُبنى من decision_records — جدول قرارات موثَّقة يدوياً فقط
  // (زر "قرار ميداني مباشر" في DustWidgetCard، المكوّن نفسه محذوف الآن، كان
  // معطَّلاً بالفعل خلف {false && ...}). القرارات الآلية الفعلية (من محرك
  // التقييم عبر device ingest/cron) تُكتب في final_decisions فقط — لا علاقة
  // لها بـdecision_records. التقارير الآن تُبنى من final_decisions مباشرة.
  const [decisionsRes, alertsRes] = await Promise.all([
    supabaseAdmin
      .from('final_decisions')
      .select('id, project_id, operational_decision, mandatory_stop')
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
  if (decisionsRes.error) return NextResponse.json({ error: safeErrorResponse(decisionsRes.error, 'dashboard/reports decisions fetch failed') }, { status: 500 });
  if (alertsRes.error) return NextResponse.json({ error: safeErrorResponse(alertsRes.error, 'dashboard/reports alerts fetch failed') }, { status: 500 });

  return NextResponse.json({
    projects: dbProjects || [],
    decisions: (decisionsRes.data || []).map(toReportDecisionRow),
    alerts: alertsRes.data || [],
  });
}
