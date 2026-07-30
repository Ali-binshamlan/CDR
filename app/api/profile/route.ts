import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { requireUserId } from '@/app/lib/apiAuth';
import { safeErrorResponse } from '@/app/lib/apiError';

// ملف المستخدم — الهوية تُشتق من التوكن (requireUserId)، فكل مستخدم يقرأ/
// يعدّل ملفه فقط. أعمدة profiles الفعلية: id, company_name, username,
// phone_number, role. البريد يأتي من auth.users (وليس profiles).
//
// is_super_admin/account_role لم تعودا في profiles (نُقلتا لجدول
// user_authorizations منفصل تماماً، ممنوع الوصول له من anon/authenticated
// إطلاقاً — راجع supabase-add-user-authorizations-table-migration.sql
// وتعليق verifyProjectOwnership في apiAuth.ts للسبب الأمني الكامل). شكل
// استجابة GET هذه بقي كما هو تماماً (نفس المفتاحين ضمن data) حتى لا يحتاج
// أي من صفحات الواجهة الثمانية التي تقرأ profileResp.data.is_super_admin/
// account_role أي تعديل — فقط مصدر القراءة الخلفي تغيّر.
export async function GET(request: NextRequest) {
  const auth = await requireUserId(request);
  if ('error' in auth) return auth.error;

  const [{ data: profile }, { data: authz }] = await Promise.all([
    supabaseAdmin
      .from('profiles')
      .select('company_name, username, phone_number, role')
      .eq('id', auth.userId)
      .single(),
    supabaseAdmin
      .from('user_authorizations')
      .select('is_super_admin, account_role')
      .eq('user_id', auth.userId)
      .maybeSingle(),
  ]);

  // البريد من نظام المصادقة (المصدر الوحيد الموثوق له)
  const { data: userRes } = await supabaseAdmin.auth.admin.getUserById(auth.userId);
  const email = userRes?.user?.email ?? '';

  return NextResponse.json({
    data: {
      ...(profile ?? {}),
      is_super_admin: authz?.is_super_admin ?? false,
      account_role: authz?.account_role ?? 'user',
      email,
    },
  });
}

// حفظ تعديلات ملف المستخدم
export async function PATCH(request: NextRequest) {
  const auth = await requireUserId(request);
  if ('error' in auth) return auth.error;

  const body = await request.json();
  // نقبل فقط الأعمدة القابلة للتعديل في profiles — البريد لا يُعدّل من هنا
  // (يتطلب تدفق تأكيد بريد منفصل في نظام المصادقة)
  const updates: Record<string, any> = {};
  if (typeof body.companyName === 'string') updates.company_name = body.companyName;
  if (typeof body.username === 'string') updates.username = body.username;
  if (typeof body.phoneNumber === 'string') updates.phone_number = body.phoneNumber;
  if (typeof body.role === 'string') updates.role = body.role;

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'لا توجد حقول صالحة للتحديث' }, { status: 400 });
  }

  const { error } = await supabaseAdmin.from('profiles').update(updates).eq('id', auth.userId);
  if (error) {
    // 23505 = تكرار اسم مستخدم فريد
    if (error.code === '23505') {
      return NextResponse.json({ error: 'اسم المستخدم مسجّل مسبقاً، اختر اسماً آخر.' }, { status: 400 });
    }
    return NextResponse.json({ error: safeErrorResponse(error, 'profile update failed') }, { status: 500 });
  }
  return NextResponse.json({ success: true });
}
