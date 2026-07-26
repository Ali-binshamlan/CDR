import { NextResponse } from 'next/server';
import { createHash } from 'crypto';
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
// لمشروع مستخدم آخر تلقائياً كما كانت RLS تفعل. السوبر أدمن (is_super_admin)
// يتجاوز فحص الملكية المباشرة ويُعامَل كمالك لأي مشروع موجود — هذا يمنح
// الأدمن صلاحية كتابة كاملة (تعديل/حذف/إضافة) على كل مشروع تلقائياً في كل
// موقع يستدعي هذه الدالة (decisions/dust-profiles/alerts/[projectId] PATCH
// و DELETE)، بلا حاجة لتعديل كل موقع استدعاء على حدة.
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
  if (data) return true;

  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('is_super_admin')
    .eq('id', userId)
    .maybeSingle();
  if (!profile?.is_super_admin) return false;

  const { data: exists } = await supabaseAdmin
    .from('projects')
    .select('id')
    .eq('id', projectId)
    .maybeSingle();
  return !!exists;
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

// تحقق صلاحية "جهة مراقبة" — عمود account_role='viewer' في profiles، حساب
// قراءة فقط يرى كل المشاريع عبر كل المستخدمين (خريطة/تنبيهات/تقارير) بلا
// أي صلاحية تعديل. مستقل تماماً عن is_super_admin — بوابتان منفصلتان
// لغرضين مختلفين (الأدمن قراءة+كتابة، المراقب قراءة فقط فقط)، الأدمن لا
// يُعامَل تلقائياً كمراقب هنا (عنده أصلاً وصول أوسع عبر /api/admin/**).
export async function requireViewer(
  request: Request
): Promise<{ userId: string } | { error: NextResponse }> {
  const auth = await requireUserId(request);
  if ('error' in auth) return auth;

  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('account_role')
    .eq('id', auth.userId)
    .maybeSingle();

  if (profile?.account_role !== 'viewer') {
    return { error: NextResponse.json({ error: 'هذه الصفحة مخصصة لجهة المراقبة فقط' }, { status: 403 }) };
  }

  return { userId: auth.userId };
}

// تحقق هوية جهاز رصد (لا مستخدم بشري — لا جلسة Supabase). ثالث نمط
// Authorization: Bearer في هذا التطبيق بعد جلسة المستخدم (requireUserId)
// وسر الـ Cron الموحّد (alerts/generate/route.ts) — لكن هذا مفتاح لكل جهاز
// على حدة، مخزَّن كهاش SHA-256 في project_devices.api_key_hash، لا مقارَن
// كنص صريح أبداً ولا مطابَق بسر عام واحد. الهوية (deviceId/projectId) تُشتق
// من المفتاح نفسه فقط — بنفس مبدأ requireUserId الذي يشتق userId من
// التوكن لا من حقل يرسله العميل، حتى لا يقدر جهاز أن "يدّعي" هوية جهاز آخر
// بتمرير معرّف مختلف في الجسم/الرابط.
export async function requireDeviceApiKey(
  request: Request
): Promise<{ deviceId: string; projectId: string } | { error: NextResponse }> {
  const authHeader = request.headers.get('authorization') || '';
  const rawKey = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!rawKey) {
    return { error: NextResponse.json({ error: 'مفتاح الجهاز مطلوب' }, { status: 401 }) };
  }

  const keyHash = createHash('sha256').update(rawKey).digest('hex');

  const { data: device } = await supabaseAdmin
    .from('project_devices')
    .select('id, project_id, is_active')
    .eq('api_key_hash', keyHash)
    .maybeSingle();

  if (!device || !device.is_active) {
    return { error: NextResponse.json({ error: 'مفتاح جهاز غير صالح أو مُلغى' }, { status: 401 }) };
  }

  return { deviceId: device.id, projectId: device.project_id };
}
