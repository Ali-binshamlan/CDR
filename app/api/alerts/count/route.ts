import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { requireUserId } from '@/app/lib/apiAuth';

// يستبدل supabase.from('alerts').select(count) المباشر من Sidebar.tsx —
// يعدّ فقط تنبيهات مشاريع المستخدم الحالي غير المغلقة (state != CLOSED)،
// عبر JOIN على projects.user_id بدل الاعتماد على RLS وحده. اشتراك
// Realtime في Sidebar.tsx يبقى كما هو ويستدعي هذا المسار عند كل تغيير.
export async function GET(request: NextRequest) {
  const auth = await requireUserId(request);
  if ('error' in auth) return auth.error;

  const { count, error } = await supabaseAdmin
    .from('alerts')
    .select('id, projects!inner(user_id)', { count: 'exact', head: true })
    .neq('state', 'CLOSED')
    .eq('projects.user_id', auth.userId);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ count: count ?? 0 });
}
