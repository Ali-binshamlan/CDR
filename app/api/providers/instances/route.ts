import { NextResponse, type NextRequest } from 'next/server';
import { requireUserId } from '@/app/lib/apiAuth';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';

// قائمة منصات provider_instances المعتمدة والنشطة فقط (is_approved=true AND
// is_active=true) لمزوّد محدد — أي مستخدم مسجَّل يراها ليختار منها بدل كتابة
// base_url حر (القسم 15.1). لا يعرض المنصات غير المعتمدة/المعطَّلة إطلاقاً؛
// تلك تُدار فقط عبر app/api/admin/provider-instances (مسؤول النظام).
export async function GET(request: NextRequest) {
  const auth = await requireUserId(request);
  if ('error' in auth) return auth.error;

  const provider = request.nextUrl.searchParams.get('provider') || '';
  if (!provider) return NextResponse.json({ error: 'provider مطلوب' }, { status: 400 });

  const { data, error } = await supabaseAdmin
    .from('provider_instances')
    .select('id, provider, origin, hostname')
    .eq('provider', provider)
    .eq('is_approved', true)
    .eq('is_active', true)
    .order('origin', { ascending: true });

  if (error) return NextResponse.json({ error: 'تعذّر جلب قائمة المنصات' }, { status: 500 });
  return NextResponse.json({ instances: data });
}
