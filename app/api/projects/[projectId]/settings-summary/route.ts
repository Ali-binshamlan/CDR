import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { requireUserId, verifyProjectOwnership } from '@/app/lib/apiAuth';
import { safeErrorResponse } from '@/app/lib/apiError';

// مسار GET خفيف مخصص لصفحة إعدادات المشروع (settings/page.tsx) — مشكلة
// أداء مكتشَفة: تلك الصفحة كانت تستدعي GET /api/projects/[projectId] نفسه
// المُستخدَم في لوحة المشروع، الذي يشغّل computeDustResults/
// computeDustComplianceResults/computeUnitReceptors/computeDustComplianceHourly
// بالكامل (DVI فيزيائي + امتثال تنظيمي + طلبات شبكة خارجية لـOpen-Meteo
// وOverpass/OSM لكل نشاط) — حساب ثقيل جداً لصفحة لا تعرض أياً من هذه
// النتائج في واجهتها إطلاقاً، فقط حقول نموذج بسيطة (اسم/موقع/أوقات دوام/
// إلخ). هذا المسار يجلب فقط صف projects الخام + project_shifts، بلا أي
// حساب DVI/امتثال/OSM — يقلّص زمن فتح صفحة الإعدادات من ثوانٍ (بانتظار
// حسابات لا تحتاجها الصفحة) إلى استعلامي قاعدة بيانات بسيطين فقط.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> }
) {
  try {
    const auth = await requireUserId(request);
    if ('error' in auth) return auth.error;

    const resolvedParams = await params;
    const projectId = resolvedParams.projectId.trim();

    const owns = await verifyProjectOwnership(projectId, auth.userId);
    if (!owns) return NextResponse.json({ error: 'لا تملك هذا المشروع' }, { status: 403 });

    const [{ data: project, error: projectError }, { data: projectShifts }] = await Promise.all([
      supabaseAdmin.from('projects').select('*').eq('id', projectId).maybeSingle(),
      supabaseAdmin.from('project_shifts').select('*').eq('project_id', projectId).order('sort_order', { ascending: true }),
    ]);

    if (projectError) {
      return NextResponse.json({ error: safeErrorResponse(projectError, 'project fetch failed') }, { status: 500 });
    }
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    // نفس اسم الحقل المُلحَق في GET الثقيل (route.ts) — settings/page.tsx
    // يقرأ project.shifts بنفس الشكل بالضبط، فلا تعديل مطلوب في الواجهة
    // غير تغيير الرابط المُستدعى.
    project.shifts = projectShifts || [];

    return NextResponse.json({ project });
  } catch (error) {
    return NextResponse.json({ error: safeErrorResponse(error, 'project settings-summary fetch failed') }, { status: 500 });
  }
}
