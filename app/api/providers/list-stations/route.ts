import { NextResponse, type NextRequest } from 'next/server';
import { requireUserId } from '@/app/lib/apiAuth';
import { getConnector } from '@/app/lib/providers/registry';

// جلب قائمة المحطات المتاحة بحساب المستخدم عند الشركة المختارة (بعد نجاح
// اختبار الاتصال) — لا يحفظ شيئاً، فقط يعرض القائمة ليختار المستخدم منها.
export async function POST(request: NextRequest) {
  const auth = await requireUserId(request);
  if ('error' in auth) return auth.error;

  const body = await request.json().catch(() => null);
  const provider = typeof body?.provider === 'string' ? body.provider : '';
  const credentials = body?.credentials && typeof body.credentials === 'object' ? body.credentials : {};

  if (!provider) {
    return NextResponse.json({ error: 'provider مطلوب' }, { status: 400 });
  }

  const connector = getConnector(provider);
  if (!connector) {
    return NextResponse.json({ error: `provider غير مسجَّل: ${provider}` }, { status: 400 });
  }

  try {
    const stations = await connector.listStations(credentials);
    return NextResponse.json({ stations });
  } catch (error) {
    console.error(`listStations failed for provider ${provider}:`, error);
    return NextResponse.json({ error: 'تعذّر جلب قائمة المحطات من المزوّد' }, { status: 502 });
  }
}
