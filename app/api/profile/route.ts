import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { requireUserId } from '@/app/lib/apiAuth';

// ملف المستخدم — الهوية تُشتق من التوكن (requireUserId)، فكل مستخدم يقرأ/
// يعدّل ملفه فقط. أعمدة profiles الفعلية: id, company_name, username,
// phone_number, role, is_super_admin. البريد يأتي من auth.users (وليس profiles).
export async function GET(request: NextRequest) {
  const auth = await requireUserId(request);
  if ('error' in auth) return auth.error;

  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('company_name, username, phone_number, role, is_super_admin')
    .eq('id', auth.userId)
    .single();

  // البريد من نظام المصادقة (المصدر الوحيد الموثوق له)
  const { data: userRes } = await supabaseAdmin.auth.admin.getUserById(auth.userId);
  const email = userRes?.user?.email ?? '';

  return NextResponse.json({ data: { ...(profile ?? {}), email } });
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
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ success: true });
}
