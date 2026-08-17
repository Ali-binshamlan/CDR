import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error("تنبيه: متغيرات البيئة لـ Supabase غير معرفة في ملف .env.local");
}

// خطأ مكتشَف ومُصلَح (طلب صريح من المستخدم — بلاغ مباشر: "اذا فتحت
// تبويتين و دخلت مستخدم ادمن و اخر مشاهد يطلعني من واحد"): supabase-js
// يخزّن جلسة الدخول افتراضياً في localStorage — مشترك بين كل تبويبات نفس
// المتصفح لنفس الموقع (سلوك قياسي في كل المتصفحات، لا خطأ في الكود).
// تسجيل دخول حساب في تبويب كان يستبدل جلسة أي تبويب آخر مفتوح لحساب مختلف
// فوراً (localStorage يُبث حدث 'storage' لكل تبويب آخر، فيقرأ التوكن
// الجديد ويستبدل جلسته الخاصة). الإصلاح المعتمَد رسمياً من Supabase لهذا
// السيناريو بالضبط: تبديل مكان التخزين إلى sessionStorage — معزول فعلياً
// لكل تبويب حسب مواصفات المتصفحات القياسية ذاتها (لا مشاركة بين تبويبات،
// حتى لنفس الموقع)، بلا أي منطق جلسات متعددة مُعقَّد إضافي.
//
// ملاحظة: sessionStorage غير متوفر في بيئة الخادم (Next.js يُشغِّل هذه
// الوحدة أيضاً من app/api/auth/login/route.ts حالياً — مسار غير مُستخدَم
// فعلياً من أي شيء في التطبيق، لكن يبقى يُستورَد وقت البناء) — typeof
// window يحمي من محاولة الوصول لـsessionStorage خارج المتصفح، فيسقط
// لسلوك supabase-js الافتراضي (بلا تخزين فعلي) في تلك البيئة بأمان.
export const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    storage: typeof window !== 'undefined' ? window.sessionStorage : undefined,
  },
});