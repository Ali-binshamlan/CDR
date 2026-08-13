import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { requireSuperAdmin } from '@/app/lib/apiAuth';

// إحصائيات تجميعية لصفحة هبوط الإدارة — مشتقة من الجداول الموجودة فعلياً،
// لا تتبّع زيارات/سيشن (لا بنية تحتية لذلك بالنظام). alertsByKind تحديداً
// (لا "risk_level" — العمود غير موجود أصلاً بجدول alerts، راجع
// app/lib/decisionMeta.ts للتفاصيل).
export async function GET(request: NextRequest) {
  const auth = await requireSuperAdmin(request);
  if ('error' in auth) return auth.error;

  const [
    { count: totalUsers },
    { data: allProjects },
    { data: allAlerts },
    { count: totalDecisions },
  ] = await Promise.all([
    supabaseAdmin.from('profiles').select('id', { count: 'exact', head: true }),
    // archived_at is null: إحصائيات "المشاريع حسب الحالة/المدينة" تعكس
    // المشاريع النشطة — إدراج المؤرشفة يُضخّم المجموع بلا معنى تشغيلي فعلي.
    supabaseAdmin.from('projects').select('id, city, project_status').is('archived_at', null),
    supabaseAdmin.from('alerts').select('id, kind').neq('state', 'CLOSED'),
    supabaseAdmin.from('decision_records').select('id', { count: 'exact', head: true }),
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
      totalDecisions: totalDecisions || 0,
    },
  });
}
