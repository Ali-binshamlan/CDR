import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { requireUserId } from '@/app/lib/apiAuth';
import { safeErrorResponse } from '@/app/lib/apiError';

// أنشطة الغبار المجدولة ضمن نطاق تاريخ (from/to، YYYY-MM-DD) لكل مشاريع
// المستخدم — يغذي صفحة جدول الأسبوع (تقويم أسبوعي). نفس نمط تحقق
// dashboard/reports/route.ts (requireUserId + فلترة user_id عبر projects،
// بلا verifyProjectOwnership الفردي لأنها قائمة لا مشروع واحد).
export async function GET(request: NextRequest) {
  const auth = await requireUserId(request);
  if ('error' in auth) return auth.error;
  const userId = auth.userId;

  const from = request.nextUrl.searchParams.get('from');
  const to = request.nextUrl.searchParams.get('to');
  if (!from || !to) {
    return NextResponse.json({ error: 'from و to مطلوبان' }, { status: 400 });
  }

  const { data: projects, error: projectsError } = await supabaseAdmin
    .from('projects')
    .select('id, name')
    .eq('user_id', userId)
    .is('archived_at', null);
  if (projectsError) return NextResponse.json({ error: safeErrorResponse(projectsError, 'dashboard/schedule projects fetch failed') }, { status: 500 });

  const projectIds = (projects || []).map((p: { id: string }) => p.id);
  if (projectIds.length === 0) {
    return NextResponse.json({ projects: [], activities: [] });
  }

  // خطأ مكتشَف ومُصلَح (طلب صريح من المستخدم — "اذا سويت نشاط و حذفته لا
  // زال يظهر في الجدوله"): الاستعلام كان يفلتر المشاريع المؤرشفة فقط
  // (أعلاه)، لكن لا يفلتر أنشطة الغبار المؤرشفة فردياً (DELETE /api/activities
  // يُنفِّذ archived_at على project_dust_profiles نفسها — راجع تعليقها
  // الكامل هناك) — نشاط محذوف ضمن مشروع لا يزال نشطاً كان يبقى ظاهراً في
  // جدول الأسبوع لأن archived_at لم يُفحَص هنا إطلاقاً.
  const { data: activities, error } = await supabaseAdmin
    .from('project_dust_profiles')
    .select('id, project_id, activity_type, regulatory_activity, planned_date, planned_time, duration_hours')
    .in('project_id', projectIds)
    .is('archived_at', null)
    .gte('planned_date', from)
    .lte('planned_date', to)
    .order('planned_date', { ascending: true })
    .order('planned_time', { ascending: true });
  if (error) return NextResponse.json({ error: safeErrorResponse(error, 'dashboard/schedule activities fetch failed') }, { status: 500 });

  return NextResponse.json({ projects: projects || [], activities: activities || [] });
}
