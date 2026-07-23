import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// عميل service_role مخصص لعمليات التسجيل — لا يعتمد على عميل anon
// (app/lib/supabase) الذي يخضع لـ RLS ولجلسة المستخدم. بدونه: (1) إدراج
// profiles يفشل فور تفعيل "تأكيد البريد الإلكتروني" لاحقاً لأن signUp()
// لن تُنشئ جلسة فورية فيفشل شرط auth.uid() = id في سياسة profiles_insert_own،
// (2) auth.admin.deleteUser أدناه (دالة إدارية بحتة) يفشل بصمت دائماً مع
// مفتاح anon بغض النظر عن حالة التأكيد.
const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);

export async function POST(request: Request) {
  try {
    // 1. استقبال البيانات الفعلية القادمة من الواجهة المرفقة (page.tsx)
    const {
      email,
      password,
      companyName,
      username,
      phoneNumber,
      role
    } = await request.json();

    // التحقق من وجود الحقول الأساسية
    if (!email || !password || !username) {
      return NextResponse.json(
        { error: 'البريد الإلكتروني، كلمة المرور، واسم المستخدم حقول مطلوبة' },
        { status: 400 }
      );
    }

    // 2. تسجيل المستخدم في نظام مصادقة Supabase (auth.users)
    const { data: authData, error: authError } = await supabaseAdmin.auth.signUp({
      email,
      password,
      options: {
        // نضع البيانات الإضافية في الـ metadata كنسخة احتياطية وممارسة قياسية
        data: {
          username: username,
          phone_number: phoneNumber,
          company_name: companyName,
          role: role
        },
      },
    });

    if (authError) {
      return NextResponse.json({ error: authError.message }, { status: 400 });
    }

    // 3. إدراج البيانات في جدول public.profiles المخصص لك بأسماء الأعمدة الصحيحة
    if (authData?.user) {
      const { error: profileError } = await supabaseAdmin
        .from('profiles')
        .insert([
          {
            id: authData.user.id,          // ربط الـ UUID بالـ auth.users
            company_name: companyName,     // الحقل الصحيح في جدولك
            username: username,            // الحقل الصحيح في جدولك
            phone_number: phoneNumber,     // الحقل الصحيح في جدولك
            role: role,                    // الحقل الصحيح في جدولك ويطابق الـ constraint
          },
        ]);

      if (profileError) {
        console.error('Profile creation error:', profileError);

        // إذا فشل حفظ البروفايل، نقوم بحذف مستخدم الـ auth حتى لا يصبح الحساب معلقاً بدون بروفايل
        await supabaseAdmin.auth.admin.deleteUser(authData.user.id);

        // التحقق من تكرار اسم المستخدم (Unique constraint error)
        if (profileError.code === '23505') {
          return NextResponse.json({ error: 'اسم المستخدم مسجل مسبقاً، يرجى اختيار اسم آخر.' }, { status: 400 });
        }

        return NextResponse.json({ error: `فشل حفظ ملف المستخدم: ${profileError.message}` }, { status: 400 });
      }
    }

    // 4. التحقق مما إذا كان الحساب يحتاج تأكيد البريد الإلكتروني
    const identities = authData?.user?.identities || [];
    const isUnconfirmed = identities.length === 0 || authData?.session === null;

    if (isUnconfirmed) {
      return NextResponse.json(
        {
          success: true,
          message: 'تم إنشاء الحساب! يرجى مراجعة بريدك الإلكتروني لتفعيله قبل تسجيل الدخول.',
          requiresConfirmation: true
        },
        { status: 200 }
      );
    }

    // 5. في حال كان التأكيد التلقائي مفعلاً في مشروعك
    return NextResponse.json(
      { success: true, message: 'تم إنشاء الحساب وحفظ البيانات بنجاح!' },
      { status: 201 }
    );

  } catch (error: any) {
    console.error('Registration API Error:', error);
    return NextResponse.json(
      { error: 'حدث خطأ داخلي في السيرفر أثناء المعالجة' },
      { status: 500 }
    );
  }
}
