import { NextResponse } from 'next/server';
import { supabase } from '@/app/lib/supabase';
import { checkRateLimit } from '@/app/lib/rateLimit';
import { safeErrorResponse } from '@/app/lib/apiError';

// حد معدّل محاولات الدخول لكل IP — يمنع تخمين كلمة مرور مستخدم معروف
// بطلبات آلية غير محدودة (brute force). المفتاح هو IP لا البريد، حتى لا
// يقدر مهاجم يجرّب بريداً مختلفاً كل مرة للتحايل على الحد.
const LOGIN_MAX_ATTEMPTS_PER_WINDOW = 10;
const LOGIN_WINDOW_MS = 5 * 60_000;

export async function POST(request: Request) {
  try {
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
    if (!checkRateLimit(`login:${ip}`, LOGIN_MAX_ATTEMPTS_PER_WINDOW, LOGIN_WINDOW_MS)) {
      return NextResponse.json(
        { error: 'محاولات كثيرة جداً، الرجاء الانتظار قليلاً قبل إعادة المحاولة' },
        { status: 429 }
      );
    }

    const { email, password } = await request.json();

    if (!email || !password) {
      return NextResponse.json(
        { error: 'البريد الإلكتروني وكلمة المرور مطلوبان' },
        { status: 400 }
      );
    }

    // محاولة تسجيل الدخول عبر Supabase Auth
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      const errorMessage = error.message.includes('Invalid login credentials')
        ? 'بيانات الدخول غير صحيحة، تأكد من البريد وكلمة المرور'
        : safeErrorResponse(error, 'login failed');

      return NextResponse.json({ error: errorMessage }, { status: 400 });
    }

    return NextResponse.json(
      { success: true, message: 'تم تسجيل الدخول بنجاح', user: data.user },
      { status: 200 }
    );

  } catch (error) {
    console.error('Login API Error:', error);
    return NextResponse.json(
      { error: 'حدث خطأ داخلي في الخادم' },
      { status: 500 }
    );
  }
}
