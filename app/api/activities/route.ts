import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { requireUserId, verifyProjectOwnership } from '@/app/lib/apiAuth';
import { safeErrorResponse } from '@/app/lib/apiError';

// تعديل زمن نشاط غبار (تاريخ/وقت البداية اليومي/المدة) — يُستدعى من
// MultiIndicatorActivityBox.tsx (handleSaveEdit). جسم الطلب:
// { targets: [{ projectId, activityId }, ...], plannedDate, plannedTime,
// durationHours } — targets هي نفس decisionTargets (صف project_dust_profiles
// واحد لكل وحدة: محطة خلط/كسارة/سطح)، فتُحدَّث كل الصفوف المشتركة في نفس
// النشاط دفعة واحدة بنفس القيم الجديدة، حتى لا "ينفصل" توقيت وحدة عن
// أخرى ضمن نفس النشاط. لا تعديل لأي حقل آخر (موقع/ضوابط/نوع) — طلب صريح
// من المستخدم: "التعديل يكون على زمن النشاط" فقط.
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

  // نفس منع الجدولة الماضية المطبَّق عند الإنشاء (POST /api/dust-profiles)
  // — بتوقيت الرياض حتى لا يختلف يوم "اليوم" حسب منطقة السيرفر الزمنية.
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

  for (const t of targets) {
    const { error } = await supabaseAdmin
      .from('project_dust_profiles')
      .update({ planned_date: plannedDate, planned_time: plannedTime, duration_hours: durationHours })
      .eq('id', String(t.activityId))
      .eq('project_id', String(t.projectId));
    if (error) {
      return NextResponse.json({ error: safeErrorResponse(error, `فشل تعديل زمن النشاط ${t.activityId}`) }, { status: 500 });
    }
  }

  return NextResponse.json({ success: true });
}

// حذف نشاط غبار واحد (صف project_dust_profiles) —
// يُستدعى من MultiIndicatorActivityBox.tsx (handleDelete)، جسم الطلب:
// { targets: [{ projectId, activityId, source: 'dust' }, ...] } — دايماً
// عنصر واحد فعلياً (مؤشر الغبار وحده في DCR)، لكن الشكل مصفوفة لمرونة
// مستقبلية (توافقاً مع UnifiedDecisionTarget[] في MultiIndicatorActivityBox).
//
// خطأ مكتشَف ومُصلَح: بعد تطبيق append-only على جداول الأدلة (dust_evaluations/
// dust_compliance_evaluations/alerts/decision_records — راجع
// supabase-append-only-evidence-and-alert-events-migration.sql)، كان هذا
// المسار لا يزال يحاول حذف صفوف من تلك الجداول الأربعة صراحةً — فشل كل
// حذف نشاط بخطأ 500 (trigger forbid_evidence_mutation يرفض DELETE حتى من
// service_role). لم يُعدَّل هذا المسار في حينها لأن التركيز كان على DELETE
// /api/projects/[projectId] فقط، ونُسي هذا المسار المنفصل (حذف نشاط فردي
// لا مشروع كامل).
//
// الإصلاح: التوقف نهائياً عن حذف جداول الأدلة الأربعة — تبقى محفوظة
// كاملة حتى بعد حذف النشاط، غير مربوطة بنشاط مرئي بعد الآن لكن قابلة
// للتدقيق دائماً (نفس مبدأ أرشفة المشروع، بلا حاجة لعمود archived_at على
// project_dust_profiles نفسه لأنه ليس جدول أدلة — حذفه الفعلي آمن).
// current_dust_decisions/current_dust_compliance_decisions ليسا جدولي
// أدلة (مجرد "آخر قرار حالي" مرجعي يُعاد بناؤه من دورة التقييم القادمة)،
// فحذفهما يبقى كما هو.
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
      return NextResponse.json({ error: safeErrorResponse(currentDecisionsError, `فشل حذف current_dust_decisions للنشاط ${activityId}`) }, { status: 500 });
    }

    const { error: currentComplianceError } = await supabaseAdmin
      .from('current_dust_compliance_decisions')
      .delete()
      .eq('activity_group_id', groupId);
    if (currentComplianceError) {
      return NextResponse.json({ error: safeErrorResponse(currentComplianceError, `فشل حذف current_dust_compliance_decisions للنشاط ${activityId}`) }, { status: 500 });
    }

    // dust_evaluations/dust_compliance_evaluations/decision_records أصبحت
    // append-only (trigger forbid_evidence_mutation يرفض أي DELETE عليها،
    // راجع supabase-append-only-evidence-and-alert-events-migration.sql)،
    // وalerts يبقى محفوظاً كأثر تدقيق أيضاً — فلا نحذف من أي منها هنا بعد
    // الآن. dust_evaluations/dust_compliance_evaluations.dust_profile_id لها
    // on delete set null (راجع supabase-fix-evidence-cascade-delete-migration.sql)
    // فتُفصَل تلقائياً عن النشاط المحذوف دون أي حذف صريح مطلوب من هذا المسار.

    const { error: profileError } = await supabaseAdmin
      .from('project_dust_profiles')
      .delete()
      .eq('id', activityId);
    if (profileError) {
      return NextResponse.json({ error: safeErrorResponse(profileError, `فشل حذف صف project_dust_profiles ${activityId}`) }, { status: 500 });
    }
  }

  return NextResponse.json({ success: true });
}
