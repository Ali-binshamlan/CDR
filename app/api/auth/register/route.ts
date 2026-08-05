import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { safeErrorResponse } from '@/app/lib/apiError';
import { checkRateLimit } from '@/app/lib/rateLimit';

// نفس مبدأ حد معدّل الدخول (app/api/auth/login/route.ts) — يمنع إنشاء
// عدد كبير من الحسابات الوهمية آلياً من IP واحد (كل حساب يُدرج صفاً في
// profiles و user_authorizations ويستهلك حصة Supabase Auth).
const REGISTER_MAX_ATTEMPTS_PER_WINDOW = 5;
const REGISTER_WINDOW_MS = 10 * 60_000;

// القيم المسموحة لحقل profiles.role (تصنيف عرض فقط — لا صلة بـ
// is_super_admin/account_role المعزولين في user_authorizations). أي قيمة
// خارج هذه القائمة تُرفض بدل إدراجها كما هي من جسم الطلب.
const ALLOWED_ROLES = ['owner', 'manager', 'contractor', 'engineer', 'other'] as const;
type AllowedRole = typeof ALLOWED_ROLES[number];

function normalizeRole(role: unknown): AllowedRole {
  return (ALLOWED_ROLES as readonly string[]).includes(role as string)
    ? (role as AllowedRole)
    : 'other';
}

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
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
    if (!checkRateLimit(`register:${ip}`, REGISTER_MAX_ATTEMPTS_PER_WINDOW, REGISTER_WINDOW_MS)) {
      return NextResponse.json(
        { error: 'محاولات كثيرة جداً، الرجاء الانتظار قليلاً قبل إعادة المحاولة' },
        { status: 429 }
      );
    }

    // 1. استقبال البيانات الفعلية القادمة من الواجهة المرفقة (page.tsx)
    const {
      email,
      password,
      companyName,
      username,
      phoneNumber,
      role: rawRole
    } = await request.json();
    const role = normalizeRole(rawRole);

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

        return NextResponse.json({ error: safeErrorResponse(profileError, 'register profile insert failed') }, { status: 400 });
      }

      // صف صلاحيات منفصل (is_super_admin=false, account_role='user' —
      // القيم الافتراضية فقط، بلا أي مسار يسمح بضبطهما من هذا الطلب) —
      // راجع supabase-add-user-authorizations-table-migration.sql. عميل
      // service_role هنا (المعرَّف أعلاه) يتجاوز REVOKE ALL FROM anon,
      // authenticated على هذا الجدول، وهو المسار الوحيد المسموح له بالكتابة.
      const { error: authzError } = await supabaseAdmin
        .from('user_authorizations')
        .insert([{ user_id: authData.user.id }]);
      if (authzError) {
        console.error('User authorization row creation error:', authzError);
        await supabaseAdmin.from('profiles').delete().eq('id', authData.user.id);
        await supabaseAdmin.auth.admin.deleteUser(authData.user.id);
        return NextResponse.json({ error: safeErrorResponse(authzError, 'register authorization insert failed') }, { status: 400 });
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

  } catch (error) {
    console.error('Registration API Error:', error);
    return NextResponse.json(
      { error: 'حدث خطأ داخلي في السيرفر أثناء المعالجة' },
      { status: 500 }
    );
  }
}
