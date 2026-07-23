import { NextResponse } from 'next/server';
import { supabaseAdmin } from './supabaseAdmin';

// كل API route جديد يستبدل استدعاءات supabase.from(...) المباشرة من
// المتصفح يستخدم supabaseAdmin (service_role)، الذي يتجاوز RLS بالكامل.
// بدون هذا التحقق، أي شخص يقدر ينادي الـ route ويقرأ/يعدّل بيانات أي
// مستخدم آخر — بالضبط الثغرة التي أُغلقت سابقاً عبر سياسات RLS، لكن هنا
// على مستوى الـ API بدل قاعدة البيانات. الواجهة ترسل access_token الجلسة
// الحالية (supabase.auth.getSession()) عبر رأس Authorization: Bearer.
export async function requireUserId(
  request: Request
): Promise<{ userId: string } | { error: NextResponse }> {
  const authHeader = request.headers.get('authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return { error: NextResponse.json({ error: 'غير مصرّح — الرجاء تسجيل الدخول' }, { status: 401 }) };
  }

  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data?.user) {
    return { error: NextResponse.json({ error: 'جلسة غير صالحة أو منتهية' }, { status: 401 }) };
  }

  return { userId: data.user.id };
}

// تحقق أن project_id يخص المستخدم الحالي فعلاً — إلزامي قبل أي قراءة أو
// كتابة على جدول يرتبط بـ project_id، لأن supabaseAdmin لن يمنع الوصول
// لمشروع مستخدم آخر تلقائياً كما كانت RLS تفعل
export async function verifyProjectOwnership(
  projectId: string,
  userId: string
): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from('projects')
    .select('id')
    .eq('id', projectId)
    .eq('user_id', userId)
    .maybeSingle();
  return !!data;
}

// تحقق صلاحية "سوبر أدمن" — عمود is_super_admin في profiles، يُمنح يدوياً
// فقط عبر SQL Editor مباشرة (لا مسار في الواجهة/الـ API لتفعيله ذاتياً).
// غير مُستخدم في DCR الأولي (لا صفحات سوبر أدمن)، يُبقى للتوافق المستقبلي.
export async function requireSuperAdmin(
  request: Request
): Promise<{ userId: string } | { error: NextResponse }> {
  const auth = await requireUserId(request);
  if ('error' in auth) return auth;

  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('is_super_admin')
    .eq('id', auth.userId)
    .maybeSingle();

  if (!profile?.is_super_admin) {
    return { error: NextResponse.json({ error: 'هذه الصفحة مخصصة للسوبر أدمن فقط' }, { status: 403 }) };
  }

  return { userId: auth.userId };
}
