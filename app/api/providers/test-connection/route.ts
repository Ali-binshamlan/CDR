import { NextResponse, type NextRequest } from 'next/server';
import { requireUserId } from '@/app/lib/apiAuth';
import { getConnector } from '@/app/lib/providers/registry';

// اختبار بيانات اتصال قبل الحفظ — لا يحفظ شيئاً، فقط يستدعي testConnection
// الخاصة بالـConnector المطلوب ويُعيد النتيجة للواجهة (زر "اختبار الاتصال").
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
    const result = await connector.testConnection(credentials);
    return NextResponse.json(result);
  } catch (error) {
    console.error(`testConnection failed for provider ${provider}:`, error);
    return NextResponse.json({ success: false, errorMessage: 'تعذّر الاتصال بالمزوّد — حاول مرة أخرى' }, { status: 200 });
  }
}
