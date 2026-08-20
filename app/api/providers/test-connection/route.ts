import { NextResponse, type NextRequest } from 'next/server';
import { requireUserId } from '@/app/lib/apiAuth';
import { getConnector } from '@/app/lib/providers/registry';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';

// Connection credentials test before saving — does not persist anything, only calls
// testConnection for the requested Connector and returns result to UI ("Test Connection" button).
export async function POST(request: NextRequest) {
  const auth = await requireUserId(request);
  if ('error' in auth) return auth.error;

  const body = await request.json().catch(() => null);
  const provider = typeof body?.provider === 'string' ? body.provider : '';
  const credentials = body?.credentials && typeof body.credentials === 'object' ? body.credentials : {};
  const providerInstanceId = typeof body?.providerInstanceId === 'string' ? body.providerInstanceId.trim() : '';

  if (!provider) {
    return NextResponse.json({ error: 'provider مطلوب' }, { status: 400 });
  }

  const connector = getConnector(provider);
  if (!connector) {
    return NextResponse.json({ error: `provider غير مسجَّل: ${provider}` }, { status: 400 });
  }

  // Security bug discovered and fixed (Section 15.1): Same verification check applied as in
  // actual persistence — without this, testing connection remained a bypass route for passing
  // an arbitrary origin (even if not subsequently saved without a valid providerInstanceId).
  let origin = '';
  if (connector.requiresProviderInstance) {
    if (!providerInstanceId) {
      return NextResponse.json({ error: 'providerInstanceId مطلوب لهذا النوع من المزوّدين' }, { status: 400 });
    }
    const { data: instance } = await supabaseAdmin
      .from('provider_instances')
      .select('origin, provider, is_approved, is_active')
      .eq('id', providerInstanceId)
      .maybeSingle();
    if (!instance || instance.provider !== provider || !instance.is_approved || !instance.is_active) {
      return NextResponse.json({ error: 'المنصة المحددة غير معتمدة أو غير نشطة' }, { status: 400 });
    }
    origin = instance.origin;
  }

  try {
    const result = await connector.testConnection(origin, credentials);
    return NextResponse.json(result);
  } catch (error) {
    console.error(`testConnection failed for provider ${provider}:`, error);
    return NextResponse.json({ success: false, errorMessage: 'تعذّر الاتصال بالمزوّد — حاول مرة أخرى' }, { status: 200 });
  }
}