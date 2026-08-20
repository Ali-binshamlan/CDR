import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { requireUserId } from '@/app/lib/apiAuth';
import { safeErrorResponse } from '@/app/lib/apiError';

// يستبدل supabase.from('alerts').select(count) المباشر من Sidebar.tsx —
// يعدّ فقط تنبيهات مشاريع المستخدم الحالي غير المغلقة (state != CLOSED)
// وغير المقروءة بعد من قِبله (alert_reads، طلب مستخدم صريح: "فعل خاصية
// مقروء/غير مقروء لكي يقل الرقم" — راجع تعليق migration 202608200001
// الكامل لسبب فصل هذا عن alerts.state)، عبر JOIN على projects.user_id بدل
// الاعتماد على RLS وحده. اشتراك Realtime في Sidebar.tsx يبقى كما هو
// ويستدعي هذا المسار عند كل تغيير. جهة المراقبة (account_role='viewer')
// لا تملك أي مشروع، فبدون هذا الاستثناء كان العداد يطلع صفر دائماً رغم
// وجود تنبيهات نشطة فعلياً عبر كل المشاريع — لذا تُعدّ لها كل التنبيهات
// النشطة بلا فلترة user_id.
export async function GET(request: NextRequest) {
  const auth = await requireUserId(request);
  if ('error' in auth) return auth.error;
  const userId = auth.userId;

  const { data: authz } = await supabaseAdmin
    .from('user_authorizations')
    .select('account_role')
    .eq('user_id', userId)
    .maybeSingle();
  const isViewer = authz?.account_role === 'viewer';

  let query = supabaseAdmin
    .from('alerts')
    .select('id, projects!inner(user_id)')
    .neq('state', 'CLOSED');
  if (!isViewer) {
    query = query.eq('projects.user_id', userId);
  } else {
    // جهة الرصد تُقصَر على المخالفات التنظيمية الفعلية فقط
    // (COMPLIANCE_VIOLATION) وتنبيه "تحسّن القراءة" المرتبط بها
    // (PM10_IMPROVED) — نفس القيد المطبَّق في app/api/admin/alerts/route.ts،
    // حتى يطابق عداد الشارة عدد الصفوف المعروضة فعلياً في جدول التنبيهات
    // (AllAlertsTable)، لا كل الأنواع.
    //
    // خطأ مكتشَف ومُصلَح (مراجعة كود خارجي — "Outbox يخلط الإيقاف الإلزامي
    // والاحترازي"، راجع migration 202608110020 الكامل): هذا الفلتر صحيح
    // منطقياً دائماً — الإصلاح الفعلي كان في persist_activity_decision_atomic
    // (لم تكن تُنتج kind='COMPLIANCE_VIOLATION' إطلاقاً)، لا هنا.
    query = query.in('kind', ['COMPLIANCE_VIOLATION', 'PM10_IMPROVED']);
  }
  const { data: activeAlerts, error } = await query;
  if (error) return NextResponse.json({ error: safeErrorResponse(error, 'alerts/count failed') }, { status: 500 });

  const activeIds = (activeAlerts || []).map((a: { id: string }) => a.id);
  if (activeIds.length === 0) return NextResponse.json({ count: 0 });

  // نطرح التنبيهات التي قرأها هذا المستخدم تحديداً بالفعل — استعلام ثانٍ
  // بدل subquery واحد لأن alert_reads جدول ربط منفصل (راجع تعليق أعلى
  // الملف)؛ عدد التنبيهات النشطة محدود عملياً فلا كلفة حقيقية لاستعلامين.
  const { data: reads, error: readsError } = await supabaseAdmin
    .from('alert_reads')
    .select('alert_id')
    .eq('user_id', userId)
    .in('alert_id', activeIds);
  if (readsError) return NextResponse.json({ error: safeErrorResponse(readsError, 'alerts/count reads fetch failed') }, { status: 500 });

  const readIds = new Set((reads || []).map((r: { alert_id: string }) => r.alert_id));
  const unreadCount = activeIds.filter((id: string) => !readIds.has(id)).length;
  return NextResponse.json({ count: unreadCount });
}
