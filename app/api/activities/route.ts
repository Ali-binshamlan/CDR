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

// أرشفة نشاط غبار واحد (صف project_dust_profiles) —
// يُستدعى من MultiIndicatorActivityBox.tsx (handleDelete)، جسم الطلب:
// { targets: [{ projectId, activityId, source: 'dust' }, ...] } — دايماً
// عنصر واحد فعلياً (مؤشر الغبار وحده في DCR)، لكن الشكل مصفوفة لمرونة
// مستقبلية (توافقاً مع UnifiedDecisionTarget[] في MultiIndicatorActivityBox).
//
// خطأ مكتشَف ومُصلَح سابقاً: بعد تطبيق append-only على جداول الأدلة
// (dust_evaluations/dust_compliance_evaluations/alerts/decision_records)،
// كان هذا المسار يحاول حذف صفوف منها صراحة فيفشل بخطأ 500 — تم التوقف عن
// ذلك، تبقى محفوظة دون حذف كما هي.
//
// خطأ ثانٍ مكتشَف ومُصلَح (مراجعة تصحيح خارجية — "الأرشفة بدل الحذف"):
// حذف project_dust_profiles نفسه فعلياً (delete()) كان يُصفّر dust_profile_id
// على dust_evaluations/dust_compliance_evaluations المرتبطة به (on delete
// set null) — الأدلة التاريخية تبقى موجودة لكن تفقد رابطها المرئي بأي
// نشاط أنتجها، فيصعب التدقيق لاحقاً على "أي نشاط كان هذا القرار؟". الإصلاح:
// UPDATE archived_at بدل DELETE — الصف يبقى موجوداً وقابلاً للربط دائماً،
// فقط مستبعَد من دورات التقييم الحية الجديدة (راجع archived_at is null في
// app/lib/evaluateProject.ts وapp/api/alerts/generate/route.ts).
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

    // current_dust_decisions/current_dust_compliance_decisions ليسا جدولي
    // أدلة (مجرد "آخر قرار حالي" مرجعي يُعاد بناؤه من دورة التقييم القادمة
    // لأي نشاط غير مؤرشَف) — حذفهما يبقى صحيحاً؛ نشاط مؤرشَف لا يجب أن يظهر
    // في أي "قرار حالي" بعد الآن.
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

    const { error: archiveError } = await supabaseAdmin
      .from('project_dust_profiles')
      .update({ archived_at: new Date().toISOString(), archived_by: auth.userId })
      .eq('id', activityId);
    if (archiveError) {
      return NextResponse.json({ error: safeErrorResponse(archiveError, `فشل أرشفة صف project_dust_profiles ${activityId}`) }, { status: 500 });
    }
  }

  return NextResponse.json({ success: true });
}
