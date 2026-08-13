import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { requireUserId } from '@/app/lib/apiAuth';
import { safeErrorResponse } from '@/app/lib/apiError';

// نفس قيم AlertState في app/dashboard/alerts/page.tsx — أي نص آخر يُفسد
// منطق دورة حياة التنبيه المعتمد على مطابقة نصية دقيقة في مسارات أخرى
// (مثال: .neq('state', 'CLOSED') في alerts/count/route.ts).
const VALID_ALERT_STATES = ['NEW', 'REVIEWED', 'ACTION_TAKEN', 'CLOSED'] as const;

// خطأ أمني مكتشَف ومُصلَح (مراجعة كود خبير خارجي — "سجل القرارات والتنبيهات
// قابل للتعديل والحذف"): كان هذا المسار يُنفِّذ UPDATE alerts SET state=...
// مباشرة — مالك المشروع يقدر يغيّر حالة تنبيه مخالفة تنظيمية (COMPLIANCE_
// VIOLATION) إلى CLOSED بنفسه بلا أي أثر تدقيق يوثّق من غيّر الحالة ومتى
// وماذا كانت الحالة السابقة. الإصلاح: تغيير الحالة الآن حدث جديد يُدرَج في
// alert_state_events (append-only، trigger يمنع UPDATE/DELETE عليه أيضاً،
// راجع supabase-append-only-evidence-and-alert-events-migration.sql) بدل
// استبدال الحالة القديمة. trigger في قاعدة البيانات (alert_state_events_
// sync) يُحدِّث alerts.state تلقائياً بعد كل إدراج — فكل قراءات alerts.state
// الحالية في التطبيق (9+ موقع: العدادات، لوحة التحكم، الخريطة، التقارير)
// تستمر بالعمل بلا أي تعديل، فقط مسار الكتابة تغيّر جذرياً. actor_user_id
// يوثّق مَن غيّر الحالة فعلياً — معلومة لم تكن مسجَّلة إطلاقاً سابقاً.
export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ alertId: string }> }
) {
  const auth = await requireUserId(request);
  if ('error' in auth) return auth.error;

  const { alertId } = await context.params;
  const body = await request.json();
  const state = body?.state;
  if (!VALID_ALERT_STATES.includes(state)) {
    return NextResponse.json({ error: `state يجب أن يكون أحد: ${VALID_ALERT_STATES.join('، ')}` }, { status: 400 });
  }

  // تحقق ملكية غير مباشر: التنبيه يخص مشروعاً يخص المستخدم الحالي، عبر
  // JOIN بدل تمرير project_id من العميل (لا يمكن الوثوق به)
  const { data: alertRow } = await supabaseAdmin
    .from('alerts')
    .select('id, project_id, state, projects!inner(user_id)')
    .eq('id', alertId)
    .single();

  const alertOwner = alertRow as { id: string; project_id: string; state: string; projects: { user_id: string } | null } | null;
  const ownerId = alertOwner?.projects?.user_id;
  if (!alertOwner || ownerId !== auth.userId) {
    return NextResponse.json({ error: 'لا تملك هذا التنبيه' }, { status: 403 });
  }

  const { error } = await supabaseAdmin.from('alert_state_events').insert({
    alert_id: alertId,
    previous_state: alertOwner.state ?? null,
    new_state: state,
    actor_user_id: auth.userId,
  });
  if (error) return NextResponse.json({ error: safeErrorResponse(error, 'alerts/[alertId] state event insert failed') }, { status: 500 });
  return NextResponse.json({ success: true });
}

// حذف تنبيه — أُزيل نهائياً (كان مراجعة كود خبير خارجي أيضاً: "المالك
// يستطيع حذف سجل المخالفة"). alerts هو سجل أدلة تنظيمية (COMPLIANCE_
// VIOLATION وغيرها) لا مجرد إشعار UI — لا يجوز لمالك المشروع أن يمحو دليل
// مخالفة واجهها فعلياً. حالة "لم يعد التنبيه ذا صلة" تُعبَّر عنها بتغيير
// الحالة إلى CLOSED عبر PATCH أعلاه (حدث جديد موثَّق)، لا بالحذف. 405 بدل
// حذف المسار بالكامل — يوضّح للعميل أن هذا تغيير سياسة متعمَّد، لا مسار
// منسي أو خطأ توجيه.
export async function DELETE() {
  return NextResponse.json(
    { error: 'حذف التنبيهات معطَّل — سجل أدلة تنظيمي غير قابل للحذف. استخدم تغيير الحالة إلى "مغلق" بدلاً من ذلك.' },
    { status: 405 }
  );
}
