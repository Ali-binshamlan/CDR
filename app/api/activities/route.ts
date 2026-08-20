import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { requireUserId, verifyProjectOwnership } from '@/app/lib/apiAuth';
import { safeErrorResponse } from '@/app/lib/apiError';
import { isActivityTimeWithinWorkHours } from '@/app/lib/shiftValidation';

/*
 * Updates dust activity schedule (planned date, start time, duration hours).
 * Invoked from MultiIndicatorActivityBox.tsx (handleSaveEdit).
 *
 * Payload: { targets: [{ projectId, activityId }, ...], plannedDate, plannedTime, durationHours }
 * 
 * Note: `targets` mirrors `decisionTargets` (one row per facility unit in `project_dust_profiles`).
 * All associated rows update in bulk to ensure synchronized timing across units.
 * Modifies timing fields ONLY—location, controls, and type remain untouched.
 */

export async function PATCH(request: NextRequest) {
  const auth = await requireUserId(request);
  if ('error' in auth) return auth.error;

  const body = await request.json().catch(() => null);
  const targets = body?.targets;
  const plannedDate = body?.plannedDate;
  const plannedTime = body?.plannedTime;
  const durationHours = Number(body?.durationHours);

  if (!Array.isArray(targets) || targets.length === 0) {
    return NextResponse.json({ error: 'targets مطلوبة ويجب أن تكون مصفوفة غير فارغة' }, { status: 400 });
  }
  if (!plannedDate || !plannedTime || !Number.isFinite(durationHours) || durationHours <= 0) {
    return NextResponse.json({ error: 'plannedDate وplannedTime وdurationHours (رقم موجب) مطلوبة' }, { status: 400 });
  }

/*
 * Enforces past-date scheduling prevention (same rule as POST /api/dust-profiles).
 * Uses Riyadh timezone (Asia/Riyadh) to define "today" consistently, 
 * regardless of the server's local timezone.
 */
  const todayRiyadh = new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10);
  if (String(plannedDate) < todayRiyadh) {
    return NextResponse.json({ error: 'لا يمكن جدولة نشاط في تاريخ سابق لليوم.' }, { status: 400 });
  }

  for (const t of targets) {
    if (!t?.projectId || !t?.activityId) {
      return NextResponse.json({ error: 'كل هدف يجب أن يحتوي projectId وactivityId' }, { status: 400 });
    }
    const owns = await verifyProjectOwnership(t.projectId, auth.userId);
    if (!owns) return NextResponse.json({ error: 'لا تملك أحد هذه المشاريع' }, { status: 403 });
  }

  /*
 * Bug Fix: Resolves issue where the activity edit button bypassed project working hours validation 
 * (unlike the creation modal which strictly enforced it).
 *
 * Previous Attempt Flaw: Incorrectly checked `project_shifts` (optional sub-shifts), whereas the true 
 * restriction source is `work_hours_start` / `work_hours_end` directly on the `projects` table 
 * (matching `AddActivityModal/index.tsx` -> `validateSchedule`).
 *
 * Business Rules & Constraints:
 * - Projects with undefined work hours (nullable columns) bypass validation (fail-safe fallback matching creation logic).
 * - Target projects may have distinct working hours; validation is executed per unique project in the `targets` set 
 *   rather than assuming a uniform project context.
 */

  const uniqueProjectIds = Array.from(new Set(targets.map((t: { projectId: string }) => String(t.projectId))));
  for (const projectId of uniqueProjectIds) {
    const { data: projectRow } = await supabaseAdmin
      .from('projects')
      .select('work_hours_start, work_hours_end')
      .eq('id', projectId)
      .maybeSingle();
    const ws = projectRow?.work_hours_start ?? null;
    const we = projectRow?.work_hours_end ?? null;
    if (!isActivityTimeWithinWorkHours(ws, we, String(plannedTime), durationHours)) {
      return NextResponse.json(
        { error: `وقت النشاط اليومي يجب أن يقع ضمن أوقات دوام المشروع (${String(ws).slice(0, 5)} – ${String(we).slice(0, 5)}).` },
        { status: 400 }
      );
    }
  }

  for (const t of targets) {
  /*
 * Always updates `daily_duration_hours` with `durationHours` here.
 * This flow modifies schedule settings for a single day only (editStartTime/editEndTime for that day, without changing endDate).
 * Thus, the calculated `durationHours` represents daily working hours rather than a multi-day total duration.
 * (See comprehensive `daily_duration_hours` documentation in migration 202608110012).
 */
    const { error } = await supabaseAdmin
      .from('project_dust_profiles')
      .update({ planned_date: plannedDate, planned_time: plannedTime, duration_hours: durationHours, daily_duration_hours: durationHours })
      .eq('id', String(t.activityId))
      .eq('project_id', String(t.projectId));
    if (error) {
      return NextResponse.json({ error: safeErrorResponse(error, `فشل تعديل زمن النشاط ${t.activityId}`) }, { status: 500 });
    }
  }

  return NextResponse.json({ success: true });
}

/*
 * Archives a single dust activity (a `project_dust_profiles` record).
 * Invoked from MultiIndicatorActivityBox.tsx (handleDelete).
 *
 * Payload: { targets: [{ projectId, activityId, source: 'dust' }, ...] }
 * Note: Contains a single target element for dust indicators in DCR, structured as an array for future scalability 
 * (aligning with `UnifiedDecisionTarget[]` in MultiIndicatorActivityBox).
 *
 * Bug Fix 1: Post append-only migration on evidence tables (dust_evaluations, dust_compliance_evaluations, 
 * alerts, decision_records), explicit row deletions caused 500 internal server errors. Explicit deletes were removed; 
 * historical evidence rows are strictly preserved.
 *
 * Bug Fix 2 (Archival vs. Deletion): Hard deleting `project_dust_profiles` triggered Foreign Key `ON DELETE SET NULL` 
 * constraints on linked `dust_evaluations` and `dust_compliance_evaluations`. While audit records remained in DB, 
 * they lost their association to the originating activity, breaking historical traceability.
 * Solution: Set `archived_at` timestamp instead of executing a `DELETE`. The activity record remains permanently queryable for audit, 
 * while being excluded from live evaluation cycles (see `archived_at IS NULL` checks in `app/lib/evaluateProject.ts` 
 * and `app/api/alerts/generate/route.ts`).
 */
export async function DELETE(request: NextRequest) {
  const auth = await requireUserId(request);
  if ('error' in auth) return auth.error;

  const body = await request.json().catch(() => null);
  const targets = body?.targets;
  if (!Array.isArray(targets) || targets.length === 0) {
    return NextResponse.json({ error: 'targets مطلوبة ويجب أن تكون مصفوفة غير فارغة' }, { status: 400 });
  }

  for (const t of targets) {
    if (!t?.projectId || !t?.activityId || t.source !== 'dust') {
      return NextResponse.json({ error: 'كل هدف يجب أن يحتوي projectId وactivityId وsource=dust' }, { status: 400 });
    }
    const owns = await verifyProjectOwnership(t.projectId, auth.userId);
    if (!owns) return NextResponse.json({ error: 'لا تملك أحد هذه المشاريع' }, { status: 403 });
  }

  for (const t of targets) {
    const activityId = String(t.activityId);
    const projectId = String(t.projectId);

    const { data: profileRow } = await supabaseAdmin
      .from('project_dust_profiles')
      .select('id, activity_group_id')
      .eq('id', activityId)
      .eq('project_id', projectId)
      .is('archived_at', null)
      .maybeSingle();
    if (!profileRow) {
      return NextResponse.json({ error: 'النشاط غير موجود أو تمت أرشفته مسبقاً' }, { status: 404 });
    }

    const groupId = profileRow.activity_group_id || `dust-${activityId}`;
/*
 * Deleting records from `current_dust_decisions` and `current_dust_compliance_decisions` remains valid.
 * These are transient reference tables holding only the "latest current decision" state, which is automatically 
 * rebuilt during the next evaluation cycle for all non-archived activities.
 * Archived activities must be removed immediately so they no longer reflect in active decision states.
 */
    const { error: currentDecisionsError } = await supabaseAdmin
      .from('current_dust_decisions')
      .delete()
      .eq('project_id', projectId)
      .eq('activity_group_id', groupId);
    if (currentDecisionsError) {
      return NextResponse.json({ error: safeErrorResponse(currentDecisionsError, `فشل حذف current_dust_decisions للنشاط ${activityId}`) }, { status: 500 });
    }

    const { error: currentComplianceError } = await supabaseAdmin
      .from('current_dust_compliance_decisions')
      .delete()
      .eq('project_id', projectId)
      .eq('activity_group_id', groupId);
    if (currentComplianceError) {
      return NextResponse.json({ error: safeErrorResponse(currentComplianceError, `فشل حذف current_dust_compliance_decisions للنشاط ${activityId}`) }, { status: 500 });
    }

    // خطأ سباق مكتشَف (مراجعة كود — طلبا أرشفة متزامنان لنفس النشاط):
    // .is('archived_at', null) هنا يمنع ثاني طلب أرشفة متزامن من "النجاح"
    // صامتاً على صف أُرشِف بالفعل بين قراءة profileRow أعلاه وهذا التحديث —
    // بلا هذا الشرط، كلا الطلبين كانا يعيدان success رغم أن الحذف من
    // current_dust_decisions/current_dust_compliance_decisions تكرَّر بلا
    // ضرر فعلي، لكن archived_by كان يُستبدَل صامتاً بمستخدم الطلب الثاني
    // (تناقض تدقيقي: من أرشف النشاط فعلياً؟). .select('id') يلزم لمعرفة
    // عدد الصفوف المتأثرة فعلياً (Supabase لا يُرجعه بلا select صريح).
    const { data: archivedRows, error: archiveError } = await supabaseAdmin
      .from('project_dust_profiles')
      .update({ archived_at: new Date().toISOString(), archived_by: auth.userId })
      .eq('id', activityId)
      .is('archived_at', null)
      .select('id');
    if (archiveError) {
      return NextResponse.json({ error: safeErrorResponse(archiveError, `فشل أرشفة صف project_dust_profiles ${activityId}`) }, { status: 500 });
    }
    if (!archivedRows || archivedRows.length === 0) {
      return NextResponse.json({ error: `النشاط ${activityId} أُرشِف بالفعل بواسطة طلب متزامن آخر` }, { status: 409 });
    }
  }

  return NextResponse.json({ success: true });
}
