import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { requireUserId } from '@/app/lib/apiAuth';
import { safeErrorResponse } from '@/app/lib/apiError';

// يستبدل supabase.from('alerts').select(count) المباشر من Sidebar.tsx —
// يعدّ فقط تنبيهات مشاريع المستخدم الحالي غير المغلقة (state != CLOSED)،
// عبر JOIN على projects.user_id بدل الاعتماد على RLS وحده. اشتراك
// Realtime في Sidebar.tsx يبقى كما هو ويستدعي هذا المسار عند كل تغيير.
// جهة المراقبة (account_role='viewer') لا تملك أي مشروع، فبدون هذا
// الاستثناء كان العداد يطلع صفر دائماً رغم وجود تنبيهات نشطة فعلياً عبر
// كل المشاريع — لذا تُعدّ لها كل التنبيهات النشطة بلا فلترة user_id.
export async function GET(request: NextRequest) {
  const auth = await requireUserId(request);
  if ('error' in auth) return auth.error;

  const { data: authz } = await supabaseAdmin
    .from('user_authorizations')
    .select('account_role')
    .eq('user_id', auth.userId)
    .maybeSingle();
  const isViewer = authz?.account_role === 'viewer';

  let query = supabaseAdmin
    .from('alerts')
    .select('id, projects!inner(user_id)', { count: 'exact', head: true })
    .neq('state', 'CLOSED');
  if (!isViewer) {
    query = query.eq('projects.user_id', auth.userId);
  } else {
    // جهة الرصد تُقصَر على المخالفات التنظيمية الفعلية فقط
    // (COMPLIANCE_VIOLATION) — نفس القيد المطبَّق في app/api/admin/alerts/
    // route.ts، حتى يطابق عداد الشارة عدد الصفوف المعروضة فعلياً في جدول
    // التنبيهات (AllAlertsTable)، لا كل الأنواع.
    query = query.eq('kind', 'COMPLIANCE_VIOLATION');
  }
  const { count, error } = await query;

  if (error) return NextResponse.json({ error: safeErrorResponse(error, 'alerts/count failed') }, { status: 500 });
  return NextResponse.json({ count: count ?? 0 });
}
