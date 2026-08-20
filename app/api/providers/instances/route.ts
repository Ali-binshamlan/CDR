import { NextResponse, type NextRequest } from 'next/server';
import { requireUserId } from '@/app/lib/apiAuth';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';

// Allowed list of approved and active provider_instances (is_approved=true AND
// is_active=true) for a specific provider — any registered user can select from this list
// instead of entering an arbitrary base_url (Section 15.1). Unapproved or inactive instances
// are excluded entirely; those are managed exclusively via app/api/admin/provider-instances (Admin).
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