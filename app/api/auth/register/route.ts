import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { safeErrorResponse } from '@/app/lib/apiError';
import { checkRateLimit } from '@/app/lib/rateLimit';
import { checkDistributedRateLimit } from '@/app/lib/distributedRateLimit';
import { verifyTurnstileToken } from '@/app/lib/captcha';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { normalizeProfileRole } from '@/app/lib/profileRoles';

// خطأ مكتشَف ومُصلَح (طلب صريح من المستخدم — مراجعة كود خارجي: "محدد
// المعدل غير موزع ومسار التسجيل يحتاج إعادة ضبط") — أربعة إصلاحات مستقلة:
//
// (1) Rate limit موزَّع + CAPTCHA: checkRateLimit المحلي (rateLimit.ts) يبقى
//     خط دفاع أول (خاص بكل instance، فوري بلا اعتماديات خارجية) — لا يُستبدَل،
//     بل يُضاف فوقه checkDistributedRateLimit (distributedRateLimit.ts، عبر
//     Upstash Redis) الذي يعمل عبر كل الـinstances معاً فعلياً. كلاهما
//     fail-open عند غياب Redis (لم يُوصَل بعد وقت هذا التعديل) — لا حماية
//     موزَّعة فعلية حتى إعداد UPSTASH_REDIS_REST_URL/TOKEN، لكن لا تراجع عن
//     مستوى الحماية الحالي أيضاً. CAPTCHA (Cloudflare Turnstile عبر
//     captcha.ts) بنفس مبدأ fail-open — TURNSTILE_SECRET_KEY غير مُعرَّف بعد.
//
// (2) عزل عميل auth.signUp: signUp لا يحتاج صلاحيات service_role إطلاقاً
//     (عملية مستخدم عادية، لا إدارية) — createIsolatedAuthClient ينشئ عميل
//     anon جديد تماماً لكل طلب (لا وحدة مشتركة، لا حالة بين الطلبات)
//     بـpersistSession:false، مخصص حصراً لاستدعاء signUp. supabaseAdmin
//     (service_role، نفس العميل المشترك المستخدَم في كل مسارات الخادم
//     الأخرى بهذا المشروع) يبقى محصوراً في العمليات الإدارية البحتة فقط
//     (RPC الذرّية أدناه، auth.admin.deleteUser).
//
// (3) profile + user_authorizations عبر RPC ذرّية واحدة
//     (create_profile_and_authorization_atomic، migration 202608120014) —
//     ينجحان معاً أو يفشلان معاً داخل معاملة SQL واحدة، بدل إدراجين منفصلين
//     من التطبيق مع تعويض يدوي هش عند فشل جزئي.
const REGISTER_MAX_ATTEMPTS_PER_WINDOW = 5;
const REGISTER_WINDOW_MS = 10 * 60_000;
const REGISTER_WINDOW_SECONDS = REGISTER_WINDOW_MS / 1000;

// خطأ مكتشَف ومُصلَح ("قيم الأدوار في التسجيل لا تطابق API، فتتحول غالبية
// الاختيارات إلى other"): القائمة البيضاء كانت مجموعة قيم عامة قديمة (owner/
// manager/contractor/engineer) لا تطابق إطلاقاً القيم السبع الفعلية التي
// يرسلها نموذج التسجيل (roleOptions في app/signup/page.tsx) — فكل تسجيل كان
// يُسقَط إلى 'other' بلا استثناء. normalizeProfileRole (app/lib/profileRoles.ts)
// هي الآن المصدر المشترك الوحيد لهذه القائمة، تُستخدَم هنا وفي PATCH
// /api/profile معاً حتى لا تتكرر/تتباعد القائمتان مستقبلاً.

// راجع تعليق (2) أعلى الملف — عميل anon معزول لكل طلب، مخصص حصراً لـ
// auth.signUp. لا service_role هنا: signUp عملية مستخدم عادية لا تحتاج
// صلاحيات إدارية، واستخدام service_role لها كان يخلط طبقتين مختلفتين تماماً
// (إنشاء جلسة مستخدم مقابل عمليات إدارية بصلاحية كاملة) في نفس العميل.
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

    // راجع تعليق (1) أعلى الملف — الحد المحلي يبقى الفحص الأول (فوري، بلا
    // اعتماد على شبكة خارجية)، ثم الحد الموزَّع (قد يكون fail-open الآن).
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

    // 1. استقبال البيانات الفعلية القادمة من الواجهة المرفقة (page.tsx)
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

    // التحقق من وجود الحقول الأساسية
    if (!email || !password || !username) {
      return NextResponse.json(
        { error: 'البريد الإلكتروني، كلمة المرور، واسم المستخدم حقول مطلوبة' },
        { status: 400 }
      );
    }

    // راجع تعليق (1) أعلى الملف — CAPTCHA للتسجيل العام (طلب صريح). fail-open
    // حالياً (لا مفتاح مُعرَّف بعد) — captchaResult.configured=false يعني
    // "لم يُتحقَّق فعلياً"، لا "نجح التحقق".
    const captchaResult = await verifyTurnstileToken(captchaToken, ip !== 'unknown' ? ip : undefined);
    if (!captchaResult.ok) {
      return NextResponse.json({ error: 'فشل التحقق من CAPTCHA — الرجاء إعادة المحاولة' }, { status: 400 });
    }

    // 2. تسجيل المستخدم في نظام مصادقة Supabase (auth.users) — عميل anon
    // معزول لكل طلب (راجع تعليق (2) أعلى الملف)، لا service_role.
    const authClient = createIsolatedAuthClient();
    const { data: authData, error: authError } = await authClient.auth.signUp({
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

    // 3. إنشاء profile وuser_authorizations معاً ذرّياً (راجع تعليق (3) أعلى
    // الملف) — RPC واحدة، لا إدراجين منفصلين من التطبيق. service_role
    // (supabaseAdmin المشترك) مطلوب هنا فعلياً: RPC هذه تتجاوز RLS على
    // user_authorizations (بلا سياسات أصلاً — كتابة service_role حصراً).
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

        // إذا فشل إنشاء profile/authorization، نحذف مستخدم الـ auth حتى لا
        // يصبح الحساب معلَّقاً بلا profile — الفشل نفسه أصبح أضيق نطاقاً
        // بكثير الآن (RPC ذرّية واحدة، لا نافذة فشل جزئي بين إدراجين منفصلين).
        await supabaseAdmin.auth.admin.deleteUser(authData.user.id);

        // التحقق من تكرار اسم المستخدم (Unique constraint error)
        if (atomicError.code === '23505') {
          return NextResponse.json({ error: 'اسم المستخدم مسجل مسبقاً، يرجى اختيار اسم آخر.' }, { status: 400 });
        }

        return NextResponse.json({ error: safeErrorResponse(atomicError, 'register profile+authorization insert failed') }, { status: 400 });
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
