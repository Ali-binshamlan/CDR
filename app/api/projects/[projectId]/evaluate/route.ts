import { NextResponse } from 'next/server';
import { requireUserId, verifyProjectOwnership } from '@/app/lib/apiAuth';
import { safeErrorResponse } from '@/app/lib/apiError';
import { evaluateProject, enqueueEvaluationRetryJob } from '@/app/lib/evaluateProject';

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
// idempotent فعلياً: persistActivityDecisionsAtomic تطبّق shouldSkipPersist
// (نافذة 5 دقائق لقرار غير متغيّر، راجع app/lib/dustEvaluation.ts) —
// استدعاءات متكررة لنفس الحالة لا تُنتج صفوفاً مكررة، بلا حاجة لآلية
// idempotency-key إضافية هنا.
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

    const result = await evaluateProject(projectId, 'user_refresh');

    if (!result.success && result.error === 'المشروع غير موجود') {
      return NextResponse.json({ error: result.error }, { status: 404 });
    }
    // تعارض CAS بحت (كل الفشل من نوع conflict، بلا أي failedActivityIds
    // حقيقية معه): 409 يخبر المستدعي أن إعادة المحاولة (لا الاستسلام أو
    // تنبيه المستخدم بخطأ) هي الاستجابة الصحيحة — القرار المخزَّن تغيّر
    // فعلاً من طلب آخر متزامن، وسيُعاد حسابه بشكل صحيح في دورة تالية.
    if (!result.success && result.conflictActivityIds?.length && !result.failedActivityIds?.length) {
      return NextResponse.json(
        {
          success: false,
          persisted: result.persisted,
          conflictActivityIds: result.conflictActivityIds,
          error: result.error + ' — أعد الطلب',
        },
        { status: 409 }
      );
    }
    if (!result.success && result.failedActivityIds?.length) {
      // خطأ معماري مكتشَف ومُصلَح (مراجعة كود خارجي — P1، الملاحظة #13):
      // فشل حفظ جزئي هنا لا يُعاد التقاطه تلقائياً بأي ضمان صريح — الواجهة
      // fire-and-forget لا تنتظر هذه الاستجابة أصلاً (راجع تعليق أعلى
      // الملف). enqueueEvaluationRetryJob يضمن محاولة لاحقة مضمونة عبر
      // scheduler-worker بدل الاعتماد على دورة scheduler-tick العامة القادمة
      // فقط. فشل الإدراج نفسه لا يُسقط الاستجابة (raced بأمان داخل الدالة).
      await enqueueEvaluationRetryJob(projectId, 'USER_REQUEST', result.error ?? 'فشل تقييم جزئي غير محدَّد');
      return NextResponse.json(
        {
          success: false,
          persisted: result.persisted,
          failedActivityIds: result.failedActivityIds,
          conflictActivityIds: result.conflictActivityIds,
          error: result.error + ' — راجع failedActivityIds',
        },
        { status: 207 }
      );
    }
    if (!result.success) {
      await enqueueEvaluationRetryJob(projectId, 'USER_REQUEST', result.error ?? 'فشل تقييم غير محدَّد');
      return NextResponse.json({ error: safeErrorResponse(new Error(result.error), 'project evaluate/persist failed') }, { status: 500 });
    }

    // finalDecisionIdsByActivityGroup (202608160004): يسمح للعميل بالتحقق
    // من صدور قرار رسمي حقيقي لنشاط محدد بعد الحفظ، بدل الافتراض من مجرد
    // نجاح هذا الاستدعاء — راجع المشكلة 4 (AddActivityModal/index.tsx).
    return NextResponse.json({
      success: true,
      persisted: result.persisted,
      finalDecisionIdsByActivityGroup: result.finalDecisionIdsByActivityGroup ?? {},
    });
  } catch (error) {
    return NextResponse.json({ error: safeErrorResponse(error, 'project evaluate/persist failed') }, { status: 500 });
  }
}
