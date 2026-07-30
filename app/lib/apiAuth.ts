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
//
// خطأ أمني مكتشَف ومُصلَح (مراجعة كود خبير خارجي — "يمكن للمستخدم رفع
// نفسه إلى Super Admin أو Viewer"): is_super_admin/account_role كانا
// عمودين في profiles، وسياسة RLS الوحيدة عليه (auth.uid() = id) لا تقيّد
// أي عمود — فأي مستخدم قادر يرفع نفسه Super Admin مباشرة من المتصفح
// (عميل anon في app/lib/supabase.ts) بلا أي تدخل خلفي. الإصلاح: نُقلا
// لجدول user_authorizations منفصل تماماً، ممنوع الوصول إليه كلياً من
// anon/authenticated (REVOKE ALL) — القراءة هنا تمر حصراً عبر supabaseAdmin
// (service_role) من الخادم. راجع supabase-add-user-authorizations-table-
// migration.sql للتفصيل الكامل.
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

  const { data: authz } = await supabaseAdmin
    .from('user_authorizations')
    .select('is_super_admin')
    .eq('user_id', userId)
    .maybeSingle();
  if (!authz?.is_super_admin) return false;

  const { data: exists } = await supabaseAdmin
    .from('projects')
    .select('id')
    .eq('id', projectId)
    .maybeSingle();
  return !!exists;
}

// تحقق صلاحية "سوبر أدمن" — عمود is_super_admin في user_authorizations
// (منفصل عن profiles، ممنوع الوصول له من anon/authenticated إطلاقاً — راجع
// تعليق verifyProjectOwnership أعلاه)، يُمنح يدوياً فقط عبر SQL Editor
// مباشرة (لا مسار في الواجهة/الـ API لتفعيله ذاتياً). role: 'admin' حقل
// تمييز صريح — بدونه، هذا الشكل يطابق requireViewer حرفياً ({userId} |
// {error})، ما اضطر admin/alerts/route.ts سابقاً لاستنتاج "أي فرع نجح
// فعلياً" من ترتيب استدعاء الدالتين بدل قراءة الهوية مباشرة — هش لأي
// إعادة ترتيب مستقبلية. الحقل الجديد إضافة تراكمية بحتة (لا يكسر أي
// استدعاء حالي يتحقق فقط من 'error' in result).
export async function requireSuperAdmin(
  request: Request
): Promise<{ userId: string; role: 'admin' } | { error: NextResponse }> {
  const auth = await requireUserId(request);
  if ('error' in auth) return auth;

  const { data: authz } = await supabaseAdmin
    .from('user_authorizations')
    .select('is_super_admin')
    .eq('user_id', auth.userId)
    .maybeSingle();

  if (!authz?.is_super_admin) {
    return { error: NextResponse.json({ error: 'هذه الصفحة مخصصة للسوبر أدمن فقط' }, { status: 403 }) };
  }

  return { userId: auth.userId, role: 'admin' };
}

// تحقق صلاحية "جهة مراقبة" — عمود account_role='viewer' في
// user_authorizations (نفس الفصل الأمني أعلاه)، حساب قراءة فقط يرى كل
// المشاريع عبر كل المستخدمين (خريطة/تنبيهات/تقارير) بلا أي صلاحية تعديل.
// مستقل تماماً عن is_super_admin — بوابتان منفصلتان لغرضين مختلفين (الأدمن
// قراءة+كتابة، المراقب قراءة فقط فقط)، الأدمن لا يُعامَل تلقائياً كمراقب
// هنا (عنده أصلاً وصول أوسع عبر /api/admin/**).
export async function requireViewer(
  request: Request
): Promise<{ userId: string; role: 'viewer' } | { error: NextResponse }> {
  const auth = await requireUserId(request);
  if ('error' in auth) return auth;

  const { data: authz } = await supabaseAdmin
    .from('user_authorizations')
    .select('account_role')
    .eq('user_id', auth.userId)
    .maybeSingle();

  if (authz?.account_role !== 'viewer') {
    return { error: NextResponse.json({ error: 'هذه الصفحة مخصصة لجهة المراقبة فقط' }, { status: 403 }) };
  }

  return { userId: auth.userId, role: 'viewer' };
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
