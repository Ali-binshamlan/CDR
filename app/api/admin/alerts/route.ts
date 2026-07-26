import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { requireSuperAdmin, requireViewer } from '@/app/lib/apiAuth';

// كل تنبيهات كل المشاريع — bلا فلترة project_id. alerts.project_id له FK
// حقيقي لـ projects.id فـ embed !inner صالح هنا (على عكس admin/projects
// حيث لا FK مباشر بين projects وprofiles). حد 200 صف موثّق كقيد معروف —
// لا صفحات pagination بهذه المرحلة.
// يسمح لسوبر أدمن أو جهة مراقبة (requireViewer) — كلاهما قراءة فقط على
// هذا المسار تحديداً، لا فرق بالصلاحية هنا. مستخدَم من app/dashboard/
// admin/alerts/page.tsx وapp/dashboard/viewer/alerts/page.tsx معاً.
export async function GET(request: NextRequest) {
  const adminAuth = await requireSuperAdmin(request);
  const auth = 'error' in adminAuth ? await requireViewer(request) : adminAuth;
  if ('error' in auth) return auth.error;

  const { data: alerts, error: alertsError } = await supabaseAdmin
    .from('alerts')
    .select('*, projects!inner(id, name, city, user_id)')
    .order('created_at', { ascending: false })
    .limit(200);
  if (alertsError) return NextResponse.json({ error: alertsError.message }, { status: 500 });

  const { data: profiles } = await supabaseAdmin.from('profiles').select('id, username, company_name');
  const profileByUserId = new Map((profiles || []).map((p: any) => [p.id, p]));

  // activity_id نص حر يقارَن بـ project_dust_profiles.id (لا FK رسمي، نفس
  // الاتفاقية المستخدمة في app/api/alerts/generate/route.ts) — نجلب
  // regulatory_activity (النشاط التنظيمي المختار فعلياً: كسارة/هدم/...)
  // لعرضه بدل activity_type الفيزيائي الداخلي (HEAVY_EQUIPMENT_MOVEMENT).
  const activityIds = [...new Set((alerts || []).map((a: any) => a.activity_id).filter(Boolean))];
  const { data: dustProfiles } = activityIds.length > 0
    ? await supabaseAdmin.from('project_dust_profiles').select('id, activity_type, regulatory_activity').in('id', activityIds)
    : { data: [] as any[] };
  const dustProfileById = new Map((dustProfiles || []).map((p: any) => [p.id, p]));

  const data = (alerts || []).map((alert: any) => {
    const owner = profileByUserId.get(alert.projects?.user_id);
    const dustProfile = dustProfileById.get(alert.activity_id);
    return {
      ...alert,
      projectName: alert.projects?.name || null,
      projectCity: alert.projects?.city || null,
      ownerUsername: owner?.username || null,
      ownerCompany: owner?.company_name || null,
      activityType: dustProfile?.activity_type || null,
      regulatoryActivity: dustProfile?.regulatory_activity || null,
    };
  });

  return NextResponse.json({ data });
}
