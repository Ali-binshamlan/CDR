import { NextResponse, type NextRequest } from 'next/server';
import { requireUserId } from '@/app/lib/apiAuth';
import { listAvailableProviders } from '@/app/lib/providers/registry';

// قائمة شركات/Connectors مصادر البيانات الخارجية المسجَّلة بالنظام —
// تُبنى منها قائمة اختيار "ربط مصدر بيانات" بالواجهة (settings/page.tsx).
// أي مستخدم مسجَّل يرى القائمة (لا حاجة لملكية مشروع محدد هنا).
export async function GET(request: NextRequest) {
  const auth = await requireUserId(request);
  if ('error' in auth) return auth.error;

  return NextResponse.json({ providers: listAvailableProviders() });
}
