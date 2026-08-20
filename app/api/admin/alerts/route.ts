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
  // (COMPLIANCE_VIOLATION)، بالإضافة إلى تنبيه "تحسّن القراءة" المرتبط بها
  // (PM10_IMPROVED — طلب صريح من المستخدم: إن تحسّنت القراءة بعد مخالفة
  // مؤكَّدة وقبل دخول الإيقاف الفعلي، تصلها إشعاراً بالتحسّن أيضاً، لا فقط
  // نص المخالفة الأصلي). لا تريد كل أنواع التنبيهات الأخرى (استعداد/بدء
  // نشاط/بلا قرار/تقييد/تنبيه استباقي) ظاهرة لها. السوبر أدمن يبقى يرى كل
  // الأنواع كالمعتاد.
  //
  // خطأ مكتشَف ومُصلَح (مراجعة كود خارجي — "Outbox يخلط الإيقاف الإلزامي
  // والاحترازي"): هذا الفلتر كان صحيحاً منطقياً دائماً، لكن persist_activity_
  // decision_atomic (راجع migration 202608110020 الكامل) لم تكن تُنتج
  // kind='COMPLIANCE_VIOLATION' في decision_alert_outbox إطلاقاً — فتبقى
  // هذه الشاشة فارغة دوماً لجهة الرصد رغم وجود مخالفات تنظيمية مؤكَّدة
  // فعلياً. لا تغيير مطلوب هنا؛ الإصلاح كان في مصدر البيانات (الدالة التي
  // تملأ decision_alert_outbox)، لا في هذا الفلتر نفسه.
  let alertsQuery = supabaseAdmin
    .from('alerts')
    .select('*, projects!inner(id, name, city, neighborhood, latitude, longitude, project_manager, user_id)')
    .order('created_at', { ascending: false })
    .limit(200);
  if (isViewerCaller) {
    alertsQuery = alertsQuery.in('kind', ['COMPLIANCE_VIOLATION', 'PM10_IMPROVED']);
  }
  const { data: alerts, error: alertsError } = await alertsQuery;
  if (alertsError) return NextResponse.json({ error: safeErrorResponse(alertsError, 'admin/alerts fetch failed') }, { status: 500 });

  const { data: profiles } = await supabaseAdmin.from('profiles').select('id, username, company_name, phone_number');
  const profileByUserId = new Map(
    (profiles || []).map((p: { id: string; username: string | null; company_name: string | null; phone_number: string | null }) => [p.id, p])
  );

  // activity_id نص حر يقارَن بـ project_dust_profiles.id (لا FK رسمي، نفس
  // الاتفاقية المستخدمة في app/api/alerts/generate/route.ts) — نجلب
  // regulatory_activity (النشاط التنظيمي المختار فعلياً: كسارة/هدم/...)،
  // المصدر الوحيد لتسمية النشاط الآن (activity_type القديم حُذف نهائياً من
  // project_dust_profiles، راجع migration 202608190005).
  const activityIds = [...new Set((alerts || []).map((a: { activity_id: string }) => a.activity_id).filter(Boolean))];
  const { data: dustProfiles } = activityIds.length > 0
    ? await supabaseAdmin.from('project_dust_profiles').select('id, regulatory_activity').in('id', activityIds)
    : { data: [] as { id: string; regulatory_activity: string | null }[] };
  const dustProfileById = new Map((dustProfiles || []).map((p: { id: string; regulatory_activity: string | null }) => [p.id, p]));

  const data = (alerts || []).map((alert: {
    activity_id: string;
    viewer_message?: string | null;
    message: string;
    projects?: { user_id: string; name: string | null; city: string | null; neighborhood: string | null; latitude: number | null; longitude: number | null; project_manager: string | null };
  }) => {
    const owner = profileByUserId.get(alert.projects?.user_id ?? '');
    const dustProfile = dustProfileById.get(alert.activity_id);
    return {
      ...alert,
      // جهة الرصد تحديداً تُعرَض لها viewer_message (النص الرسمي) بدل
      // message التقني الموجَّه لصاحب المشروع، فقط عندما تكون موجودة فعلاً
      // (اليوم: COMPLIANCE_VIOLATION وPM10_IMPROVED — راجع deriveAlertMessage
      // في alert-outbox-worker/route.ts) — غير ذلك يبقى message كما هو (فشل
      // آمن، لا كسر لأي تنبيه بلا viewer_message).
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
      regulatoryActivity: dustProfile?.regulatory_activity || null,
    };
  });

  return NextResponse.json({ data });
}
