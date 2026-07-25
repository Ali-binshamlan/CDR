import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { requireUserId, verifyProjectOwnership } from '@/app/lib/apiAuth';

// حذف نشاط غبار واحد (صف project_dust_profiles) وكل ما يرتبط به —
// يُستدعى من MultiIndicatorActivityBox.tsx (handleDelete)، جسم الطلب:
// { targets: [{ projectId, activityId, source: 'dust' }, ...] } — دايماً
// عنصر واحد فعلياً (مؤشر الغبار وحده في DCR)، لكن الشكل مصفوفة لمرونة
// مستقبلية (توافقاً مع UnifiedDecisionTarget[] في MultiIndicatorActivityBox).
//
// ترتيب الحذف يطابق DELETE /api/projects/[projectId] بالضبط (نفس القيود:
// current_dust_decisions/current_dust_compliance_decisions تشير عبر
// latest_evaluation_id لـ dust_evaluations/dust_compliance_evaluations
// بلا cascade، فيجب حذفها أولاً) — لكن مفلترة هنا بـ activity_group_id
// (dust-{activityId}, أو activity_group_id المخصص إن وُجد) بدل project_id
// كاملاً، حتى لا تُحذف بقية أنشطة نفس المشروع.
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
      .maybeSingle();
    if (!profileRow) {
      return NextResponse.json({ error: 'النشاط غير موجود أو تم حذفه مسبقاً' }, { status: 404 });
    }

    const groupId = profileRow.activity_group_id || `dust-${activityId}`;

    const { error: currentDecisionsError } = await supabaseAdmin
      .from('current_dust_decisions')
      .delete()
      .eq('activity_group_id', groupId);
    if (currentDecisionsError) {
      console.error(`فشل حذف current_dust_decisions للنشاط ${activityId}:`, currentDecisionsError.message);
      return NextResponse.json({ error: `فشل حذف بيانات مرتبطة (current_dust_decisions): ${currentDecisionsError.message}` }, { status: 500 });
    }

    const { error: currentComplianceError } = await supabaseAdmin
      .from('current_dust_compliance_decisions')
      .delete()
      .eq('activity_group_id', groupId);
    if (currentComplianceError) {
      console.error(`فشل حذف current_dust_compliance_decisions للنشاط ${activityId}:`, currentComplianceError.message);
      return NextResponse.json({ error: `فشل حذف بيانات مرتبطة (current_dust_compliance_decisions): ${currentComplianceError.message}` }, { status: 500 });
    }

    // dust_evaluations وdust_compliance_evaluations لهما on delete cascade
    // من project_dust_profiles، لكن نحذفهما صراحة قبل الصف الأب لضمان عدم
    // بقاء أي صف يتيم لو تغيّر تعريف القيد لاحقاً — بلا اعتماد صامت على cascade.
    const childTables = ['dust_evaluations', 'dust_compliance_evaluations', 'alerts', 'decision_records'];
    for (const table of childTables) {
      const column = table === 'dust_evaluations' || table === 'dust_compliance_evaluations' ? 'dust_profile_id' : 'activity_id';
      const { error: childError } = await supabaseAdmin.from(table).delete().eq(column, activityId);
      if (childError && childError.code !== '42703' && childError.code !== '42P01') {
        console.error(`فشل حذف صفوف ${table} للنشاط ${activityId}:`, childError.code, childError.message);
        return NextResponse.json({ error: `فشل حذف بيانات مرتبطة (${table}): ${childError.message}` }, { status: 500 });
      }
    }

    const { error: profileError } = await supabaseAdmin
      .from('project_dust_profiles')
      .delete()
      .eq('id', activityId);
    if (profileError) {
      console.error(`فشل حذف صف project_dust_profiles ${activityId}:`, profileError.message);
      return NextResponse.json({ error: profileError.message }, { status: 500 });
    }
  }

  return NextResponse.json({ success: true });
}
