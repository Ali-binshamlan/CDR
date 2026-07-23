import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { requireUserId } from '@/app/lib/apiAuth';
import { checkDustActivities } from '../generate/route';

// توليد التنبيهات فور تسجيل الدخول — يفحص أنشطة مشاريع المستخدم الحالي
// فقط (بخلاف /api/alerts/generate الذي يفحص كل المشاريع عبر Cron). يعيد
// استخدام نفس دالة الفحص، مُقيّدة بمعرّفات مشاريع المستخدم.
export async function POST(request: NextRequest) {
  const auth = await requireUserId(request);
  if ('error' in auth) return auth.error;

  const { data: projects } = await supabaseAdmin
    .from('projects')
    .select('id')
    .eq('user_id', auth.userId);

  const projectIds = (projects || []).map((p: any) => p.id);
  if (projectIds.length === 0) {
    return NextResponse.json({ ok: true, generated: false, reason: 'no projects' });
  }

  try {
    await checkDustActivities(projectIds);
    return NextResponse.json({ ok: true, generated: true, checkedAt: new Date().toISOString() });
  } catch (error: any) {
    console.error('generate-mine failed:', error?.message || error);
    return NextResponse.json({ ok: false, error: error?.message || 'unknown error' }, { status: 500 });
  }
}
