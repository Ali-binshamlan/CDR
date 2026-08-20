import { NextResponse } from 'next/server';
import { requireUserId, verifyProjectOwnership } from '@/app/lib/apiAuth';
import { safeErrorResponse } from '@/app/lib/apiError';
import { evaluateProject, enqueueEvaluationRetryJob } from '@/app/lib/evaluateProject';

// Writes new dust/compliance evaluations for a project (dust_evaluations, current_dust_decisions,
// dust_compliance_evaluations, current_dust_compliance_decisions — including
// stopped_since/pending_resume_since on which resume stability and wind gate depend).
// This previously occurred as a side effect inside GET /api/projects/[projectId]
// on every page load — violating HTTP GET semantics (must be idempotent and side-effect free)
// and posing a potential database amplification vulnerability. The frontend now calls it
// explicitly (fire-and-forget) immediately after GET succeeds — see fetchDashboardData in
// app/dashboard/Projects/[id]/page.tsx.
//
// Intentional security decision: This endpoint does not accept any evaluation data in the request body —
// it recalculates everything from scratch itself (using the exact same GET pipelines) rather than trusting
// client data that could be forged and written directly as official regulatory compliance decisions.
// Double computation between GET and POST is an acceptable trade-off for this guarantee.
//
// Effectively idempotent: persistActivityDecisionsAtomic applies shouldSkipPersist
// (5-minute window for an unchanged decision, see app/lib/dustEvaluation.ts) —
// repeated calls for the same state do not produce duplicate rows, without requiring an additional
// idempotency-key mechanism here.
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
    // Pure CAS conflict (all failures are conflicts, with no real failedActivityIds):
    // 409 informs the caller that retrying (not giving up or alerting the user with an error)
    // is the correct response — the stored decision actually changed from another concurrent request
    // and will be re-evaluated correctly in a subsequent cycle.
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
      // Architectural bug discovered and fixed (external code review — P1, Note #13):
      // Partial persistence failure here was not automatically caught with any explicit guarantee — the
      // fire-and-forget UI does not wait for this response at all (see top comment).
      // enqueueEvaluationRetryJob guarantees a subsequent retry via scheduler-worker rather than
      // relying solely on the next general scheduler-tick cycle.
      // Insertion failure itself does not drop the response (safely raced inside the function).
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

    // finalDecisionIdsByActivityGroup (202608160004): Allows the client to verify
    // that an official decision was actually issued for a specific activity after persistence,
    // rather than assuming based solely on the success of this call — see Issue 4 (AddActivityModal/index.tsx).
    return NextResponse.json({
      success: true,
      persisted: result.persisted,
      finalDecisionIdsByActivityGroup: result.finalDecisionIdsByActivityGroup ?? {},
    });
  } catch (error) {
    return NextResponse.json({ error: safeErrorResponse(error, 'project evaluate/persist failed') }, { status: 500 });
  }
}