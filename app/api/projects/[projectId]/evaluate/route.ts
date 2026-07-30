import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import {
  computeDustResults,
  computeDustComplianceResults,
  persistDustEvaluations,
  persistDustComplianceEvaluations,
  persistFinalDecisions,
} from '@/app/lib/dustEvaluation';
import { buildSensitiveReceptor } from '@/app/utils/dust-compliance-engine';
import { requireUserId, verifyProjectOwnership } from '@/app/lib/apiAuth';
import { safeErrorResponse } from '@/app/lib/apiError';

// يكتب تقييمات غبار/امتثال جديدة لمشروع (dust_evaluations، current_dust_decisions،
// dust_compliance_evaluations، current_dust_compliance_decisions — بما فيها
// stopped_since/pending_resume_since التي يعتمد عليها استقرار الاستئناف
// وبوابة الرياح). كان هذا يحدث كأثر جانبي داخل GET /api/projects/[projectId]
// على كل تحميل صفحة — مخالف لدلالة HTTP GET (يجب أن يكون idempotent وبلا
// أثر جانبي) وثغرة تضخيم قاعدة بيانات محتملة. تستدعيه الواجهة الأمامية
// صراحة (fire-and-forget) فور نجاح GET — راجع fetchDashboardData في
// app/dashboard/Projects/[id]/page.tsx.
//
// قرار أمني متعمَّد: لا يقبل هذا المسار أي بيانات تقييم من جسم الطلب —
// يعيد الحساب بنفسه من الصفر (بنفس أنابيب GET بالضبط) بدل الوثوق ببيانات
// عميل قد تكون مزوَّرة وتُكتب مباشرة كقرار امتثال تنظيمي حقيقي. ازدواج
// الحساب بين GET وPOST مقبول مقابل هذا الضمان.
//
// idempotent فعلياً: persistDustEvaluations/persistDustComplianceEvaluations
// تطبّقان shouldSkipPersist (نافذة 5 دقائق لقرار غير متغيّر، راجع
// app/lib/dustEvaluation.ts) — استدعاءات متكررة لنفس الحالة لا تُنتج صفوفاً
// مكررة، بلا حاجة لآلية idempotency-key إضافية هنا.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> }
) {
  try {
    const auth = await requireUserId(request);
    if ('error' in auth) return auth.error;

    const { projectId: rawProjectId } = await params;
    const projectId = rawProjectId.trim();

    const owns = await verifyProjectOwnership(projectId, auth.userId);
    if (!owns) return NextResponse.json({ error: 'لا تملك هذا المشروع' }, { status: 403 });

    const { data: project } = await supabaseAdmin
      .from('projects')
      .select('*')
      .eq('id', projectId)
      .maybeSingle();
    if (!project) {
      return NextResponse.json({ error: 'المشروع غير موجود' }, { status: 404 });
    }

    const [{ data: dustProfiles }, { data: projectShifts }] = await Promise.all([
      supabaseAdmin.from('project_dust_profiles').select('*').eq('project_id', projectId),
      supabaseAdmin.from('project_shifts').select('*').eq('project_id', projectId).order('sort_order', { ascending: true }),
    ]);
    // buildDustInput (dustEvaluation.ts) يقرأ project.shifts — نفس الاسم
    // المُرفَق في GET، مطلوب هنا لتطابق حساب ساعات العمل.
    project.shifts = projectShifts || [];

    const dustResults = await computeDustResults(dustProfiles || [], project, supabaseAdmin);
    if (dustResults.length === 0) {
      return NextResponse.json({ success: true, persisted: 0 });
    }

    await persistDustEvaluations(supabaseAdmin, projectId, dustResults, 'user_refresh');

    // خطأ أمني مكتشَف ومُصلَح (مراجعة كود مدير — "فشل استعلام المستقبلات
    // الحساسة يتحول إلى مصفوفة فارغة ثم Infinity؛ قد يظهر الموقع آمناً عند
    // تعطل البيانات"): هذا المسار هو نقطة الكتابة الفعلية لقرارات الامتثال
    // (dust_compliance_evaluations/final_decisions) — فشل صامت هنا يعني
    // تسجيل قرار "آمن" (مسافة Infinity) في سجل تدقيق دائم لموقع قد يكون
    // فعلياً قريباً جداً من مستقبِل حساس. يوقف التقييم بالكامل الآن بدل
    // المتابعة بأمان زائف.
    const { data: sensitiveReceptorRows, error: sensitiveReceptorsError } = await supabaseAdmin
      .from('sensitive_receptors')
      .select('id, name, receptor_type, lat, lng');
    if (sensitiveReceptorsError) {
      return NextResponse.json(
        { error: safeErrorResponse(sensitiveReceptorsError, 'sensitive_receptors fetch failed') },
        { status: 500 }
      );
    }
    const sensitiveReceptors = (sensitiveReceptorRows || []).map(buildSensitiveReceptor);

    const dustComplianceResults = await computeDustComplianceResults(
      dustProfiles || [],
      project,
      dustResults,
      sensitiveReceptors,
      supabaseAdmin,
      true // مسار الكتابة الصريح الوحيد — يُسجِّل عينة PM10 جديدة في السجل التاريخي.
    );
    if (dustComplianceResults.length > 0) {
      await persistDustComplianceEvaluations(supabaseAdmin, projectId, dustComplianceResults, 'user_refresh');
    }

    // نقطة الكتابة الوحيدة لـfinal_decisions — راجع تعليق persistFinalDecisions
    // في dustEvaluation.ts: يحسم القرار النهائي (decideFinal) مرة واحدة هنا
    // فقط، بدل إعادة حسابه بمعزل في كل مسار عرض (البانر/الخريطة/التنبيهات).
    await persistFinalDecisions(supabaseAdmin, projectId, dustResults, dustComplianceResults);

    return NextResponse.json({ success: true, persisted: dustResults.length });
  } catch (error) {
    return NextResponse.json({ error: safeErrorResponse(error, 'project evaluate/persist failed') }, { status: 500 });
  }
}
