import { NextResponse, type NextRequest } from 'next/server';
import { requireUserId } from '@/app/lib/apiAuth';
import { getConnector } from '@/app/lib/providers/registry';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';

// جلب قائمة المحطات المتاحة بحساب المستخدم عند الشركة المختارة (بعد نجاح
// اختبار الاتصال) — لا يحفظ شيئاً، فقط يعرض القائمة ليختار المستخدم منها.
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

  // خطأ أمني مكتشَف ومُصلَح (القسم 15.1) — نفس فحص الاعتماد المطبَّق عند
  // اختبار الاتصال والحفظ الفعلي.
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
    const stations = await connector.listStations(origin, credentials);
    return NextResponse.json({ stations });
  } catch (error) {
    console.error(`listStations failed for provider ${provider}:`, error);
    return NextResponse.json({ error: 'تعذّر جلب قائمة المحطات من المزوّد' }, { status: 502 });
  }
}
