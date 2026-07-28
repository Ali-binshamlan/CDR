import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { requireSuperAdmin, requireViewer } from '@/app/lib/apiAuth';
import { safeErrorResponse } from '@/app/lib/apiError';

// كل تنبيهات كل المشاريع — bلا فلترة project_id. alerts.project_id له FK
// حقيقي لـ projects.id فـ embed !inner صالح هنا (على عكس admin/projects
// حيث لا FK مباشر بين projects وprofiles). حد 200 صف موثّق كقيد معروف —
// لا صفحات pagination بهذه المرحلة.
// يسمح لسوبر أدمن أو جهة مراقبة (requireViewer) — كلاهما قراءة فقط على
// هذا المسار تحديداً، لا فرق بالصلاحية هنا. مستخدَم من app/dashboard/
// admin/alerts/page.tsx وapp/dashboard/viewer/alerts/page.tsx معاً.
export async function GET(request: NextRequest) {
  const adminAuth = await requireSuperAdmin(request);
  // requireSuperAdmin/requireViewer يُرجعان الآن حقل role صريحاً ('admin'
  // | 'viewer') عند النجاح — نعتمد عليه مباشرة لمعرفة هوية الطالب الفعلية
  // بدل استنتاجها من ترتيب فشل/نجاح الاستدعاءين (كان هشاً لأي إعادة ترتيب).
  const auth = 'error' in adminAuth ? await requireViewer(request) : adminAuth;
  if ('error' in auth) return auth.error;
  const isViewerCaller = auth.role === 'viewer';

  // جهة الرصد تحديداً تُقصَر على المخالفات التنظيمية الفعلية فقط
  // (COMPLIANCE_VIOLATION) — طلب صريح من المستخدم: لا تريد كل أنواع
  // التنبيهات (استعداد/بدء نشاط/بلا قرار/تقييد/تنبيه استباقي) ظاهرة لها،
  // فقط المخالفة المؤكَّدة. السوبر أدمن يبقى يرى كل الأنواع كالمعتاد.
  let alertsQuery = supabaseAdmin
    .from('alerts')
    .select('*, projects!inner(id, name, city, neighborhood, latitude, longitude, project_manager, user_id)')
    .order('created_at', { ascending: false })
    .limit(200);
  if (isViewerCaller) {
    alertsQuery = alertsQuery.eq('kind', 'COMPLIANCE_VIOLATION');
  }
  const { data: alerts, error: alertsError } = await alertsQuery;
  if (alertsError) return NextResponse.json({ error: safeErrorResponse(alertsError, 'admin/alerts fetch failed') }, { status: 500 });

  const { data: profiles } = await supabaseAdmin.from('profiles').select('id, username, company_name, phone_number');
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
      // جهة الرصد تحديداً تُعرَض لها viewer_message (النص الرسمي) بدل
      // message التقني الموجَّه لصاحب المشروع، فقط عندما تكون موجودة فعلاً
      // (اليوم: COMPLIANCE_VIOLATION فقط — راجع alerts/generate/route.ts) —
      // غير ذلك يبقى message كما هو (فشل آمن، لا كسر لأي تنبيه بلا viewer_message).
      message: isViewerCaller && alert.viewer_message ? alert.viewer_message : alert.message,
      projectName: alert.projects?.name || null,
      projectCity: alert.projects?.city || null,
      projectNeighborhood: alert.projects?.neighborhood || null,
      projectLatitude: alert.projects?.latitude ?? null,
      projectLongitude: alert.projects?.longitude ?? null,
      projectManager: alert.projects?.project_manager || null,
      ownerUsername: owner?.username || null,
      ownerCompany: owner?.company_name || null,
      ownerPhone: owner?.phone_number || null,
      activityType: dustProfile?.activity_type || null,
      regulatoryActivity: dustProfile?.regulatory_activity || null,
    };
  });

  return NextResponse.json({ data });
}
