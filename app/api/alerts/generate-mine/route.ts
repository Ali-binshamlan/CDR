import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { requireUserId } from '@/app/lib/apiAuth';
import { safeErrorResponse } from '@/app/lib/apiError';
import { checkRateLimit } from '@/app/lib/rateLimit';
import { checkDustActivities } from '../generate/route';

// حد معدّل لكل مستخدم — الواجهة تنادي هذا المسار كل دقيقة تلقائياً
// (Dashboard layout)، وهو مسموح؛ هذا فقط يمنع مستخدماً مصادقاً من مناداته
// في حلقة ضيقة يدوياً (تكرار طلبات Open-Meteo/Overpass وحساب DVI/الامتثال
// لمشاريعه بلا داعٍ).
const GENERATE_MINE_MAX_REQUESTS_PER_WINDOW = 6;
const GENERATE_MINE_WINDOW_MS = 60_000;

// توليد التنبيهات فور تسجيل الدخول — يفحص أنشطة مشاريع المستخدم الحالي
// فقط (بخلاف /api/alerts/generate الذي يفحص كل المشاريع عبر Cron). يعيد
// استخدام نفس دالة الفحص، مُقيّدة بمعرّفات مشاريع المستخدم.
export async function POST(request: NextRequest) {
  const auth = await requireUserId(request);
  if ('error' in auth) return auth.error;

  if (!checkRateLimit(`generate-mine:${auth.userId}`, GENERATE_MINE_MAX_REQUESTS_PER_WINDOW, GENERATE_MINE_WINDOW_MS)) {
    return NextResponse.json({ error: 'محاولات كثيرة جداً، الرجاء الانتظار قليلاً' }, { status: 429 });
  }

  // archived_at is null: لا فائدة من فحص أنشطة مشروع أرشفه المستخدم بنفسه
  // — checkDustActivities تُصفّي نفس الشيء عند استعلامها الداخلي أيضاً
  // (دفاع مضاعف)، لكن تصفيتها هنا تمنع تمرير معرّفات مشاريع مؤرشفة أصلاً.
  const { data: projects } = await supabaseAdmin
    .from('projects')
    .select('id')
    .eq('user_id', auth.userId)
    .is('archived_at', null);

  const projectIds = (projects || []).map((p: { id: string }) => p.id);
  if (projectIds.length === 0) {
    return NextResponse.json({ ok: true, generated: false, reason: 'no projects' });
  }

  try {
    await checkDustActivities(projectIds);
    return NextResponse.json({ ok: true, generated: true, checkedAt: new Date().toISOString() });
  } catch (error) {
    return NextResponse.json({ ok: false, error: safeErrorResponse(error, 'generate-mine failed') }, { status: 500 });
  }
}
