import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { safeErrorResponse } from '@/app/lib/apiError';
import { checkRateLimit } from '@/app/lib/rateLimit';
import { checkDistributedRateLimit } from '@/app/lib/distributedRateLimit';
import { verifyTurnstileToken } from '@/app/lib/captcha';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { normalizeProfileRole } from '@/app/lib/profileRoles';

/*
 * Registration Rate Limiting Parameters
 */
const REGISTER_MAX_ATTEMPTS_PER_WINDOW = 5;
const REGISTER_WINDOW_MS = 10 * 60_000;
const REGISTER_WINDOW_SECONDS = REGISTER_WINDOW_MS / 1000;

/*
 * Creates an isolated standard anonymous Supabase auth client per request.
 * Dedicated exclusively for `auth.signUp` execution. 
 * Avoids using administrative `service_role` credentials for public registration actions,
 * ensuring complete separation between user authentication flows and system admin privileges.
 */
function createIsolatedAuthClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

export async function POST(request: Request) {
  try {
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';

    /*
     * Dual-Layer Rate Limiting:
     * 1. Local in-memory rate check (immediate local instance defense).
     * 2. Distributed rate check via Upstash Redis (cross-instance rate protection).
     */
    if (!checkRateLimit(`register:${ip}`, REGISTER_MAX_ATTEMPTS_PER_WINDOW, REGISTER_WINDOW_MS)) {
      return NextResponse.json(
        { error: 'محاولات كثيرة جداً، الرجاء الانتظار قليلاً قبل إعادة المحاولة' },
        { status: 429 }
      );
    }
    const distributedCheck = await checkDistributedRateLimit(
      `register:${ip}`,
      REGISTER_MAX_ATTEMPTS_PER_WINDOW,
      REGISTER_WINDOW_SECONDS
    );
    if (!distributedCheck.allowed) {
      return NextResponse.json(
        { error: 'محاولات كثيرة جداً، الرجاء الانتظار قليلاً قبل إعادة المحاولة' },
        { status: 429 }
      );
    }

    const {
      email,
      password,
      companyName,
      username,
      phoneNumber,
      role: rawRole,
      captchaToken,
    } = await request.json();

    const role = normalizeProfileRole(rawRole);

    if (!email || !password || !username) {
      return NextResponse.json(
        { error: 'البريد الإلكتروني، كلمة المرور، واسم المستخدم حقول مطلوبة' },
        { status: 400 }
      );
    }

    // CAPTCHA verification (Cloudflare Turnstile)
    const captchaResult = await verifyTurnstileToken(captchaToken, ip !== 'unknown' ? ip : undefined);
    if (!captchaResult.ok) {
      return NextResponse.json({ error: 'فشل التحقق من CAPTCHA — الرجاء إعادة المحاولة' }, { status: 400 });
    }

    /*
     * User Authentication Account Creation
     * Executes via isolated anon client rather than privileged `supabaseAdmin`.
     */
    const authClient = createIsolatedAuthClient();
    const { data: authData, error: authError } = await authClient.auth.signUp({
      email,
      password,
      options: {
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

    /*
     * Atomic Profile and Authorization Creation
     * Calls `create_profile_and_authorization_atomic` RPC (migration `202608120014`) via `supabaseAdmin`
     * to guarantee transactional integrity across `profiles` and `user_authorizations` tables.
     * Rolls back auth user creation via `auth.admin.deleteUser` if the atomic database transaction fails.
     */
    if (authData?.user) {
      const { error: atomicError } = await supabaseAdmin.rpc('create_profile_and_authorization_atomic', {
        p_user_id: authData.user.id,
        p_company_name: companyName ?? null,
        p_username: username,
        p_phone_number: phoneNumber ?? null,
        p_role: role,
      });

      if (atomicError) {
        console.error('Profile+authorization atomic creation error:', atomicError);

        await supabaseAdmin.auth.admin.deleteUser(authData.user.id);

        if (atomicError.code === '23505') {
          return NextResponse.json({ error: 'اسم المستخدم مسجل مسبقاً، يرجى اختيار اسم آخر.' }, { status: 400 });
        }

        return NextResponse.json({ error: safeErrorResponse(atomicError, 'register profile+authorization insert failed') }, { status: 400 });
      }
    }

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