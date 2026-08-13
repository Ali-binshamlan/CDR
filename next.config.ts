import type { NextConfig } from "next";

// ترويسات أمان أساسية — كانت غائبة تماماً سابقاً، ما يترك التطبيق بلا أي
// دفاع ثانوي ضد Clickjacking أو تشغيل موارد من مصادر غير متوقعة حتى لو
// وُجدت ثغرة XSS مستقبلاً. القيم مبنية على الموارد الخارجية الفعلية
// المستخدمة فعلياً في الكود (بلاطات OpenStreetMap لخرائط Leaflet، أيقونات
// unpkg.com، ونطاق Supabase الديناميكي *.supabase.co لجلسة/بيانات المستخدم).
// خطأ أمني مكتشَف ومُصلَح (مراجعة كود خبير خارجي — "CSP يسمح بـunsafe-inline
// وunsafe-eval"): 'unsafe-eval' يسمح بتنفيذ أي كود JS ديناميكي (eval/
// new Function) حتى لو وُجدت ثغرة XSS مستقبلاً — أخطر بكثير من
// 'unsafe-inline' على style-src. 'unsafe-eval' مطلوب فعلياً فقط في وضع
// dev (React Fast Refresh/webpack HMR يعتمدان عليه)، ولا حاجة له في بناء
// الإنتاج (لا استخدام لـeval()/new Function في هذا الكود، وLeaflet/Recharts
// لا تحتاجانه بالإنتاج). style-src 'unsafe-inline' يبقى مطلوباً في كل
// بيئة (React/Leaflet يكتبان style="" مباشرة على DOM على نطاق واسع في
// المشروع) — إزالته يتطلب نظام nonce كامل عبر middleware، خطر تعطيل أعلى
// بكثير من فائدته الأمنية الإضافية مقارنة بإزالة unsafe-eval، فيبقى خارج
// نطاق هذا الإصلاح.
const isProd = process.env.NODE_ENV === 'production';

const securityHeaders = [
  // يمنع تضمين الموقع داخل iframe من موقع آخر (Clickjacking) — لا iframe
  // مستخدَم في هذا التطبيق نفسه، فلا كسر متوقع.
  { key: 'X-Frame-Options', value: 'DENY' },
  // يمنع المتصفح من "تخمين" نوع محتوى ملف مختلف عمّا يعلنه الخادم فعلياً
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  // يقيّد تسريب رابط الصفحة الحالية كاملاً عند النقر على رابط خارجي
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  {
    key: 'Content-Security-Policy',
    value: [
      "default-src 'self'",
      // https://challenges.cloudflare.com: سكربت ودجت Cloudflare Turnstile
      // (CAPTCHA للتسجيل العام، app/components/TurnstileWidget.tsx) — يُحمَّل
      // مباشرة من api.js عند فتح صفحة /signup، لا حزمة npm مجمَّعة محلياً.
      isProd
        ? "script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com"
        : "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://challenges.cloudflare.com",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https://*.tile.openstreetmap.org https://unpkg.com",
      // nominatim.openstreetmap.org: خدمة reverse geocoding — تحويل إحداثيات
      // منطقة المشروع المرسومة إلى اسم مدينة/حي تلقائياً (handleZoneChange
      // في app/dashboard/Projects/create/page.tsx). كانت مفقودة من القائمة
      // (خطأ سابق غير مكتشف لأن الفشل يُبتلع بـtoast لطيف — لكن الميزة
      // الفعلية معطَّلة بالكامل بلا هذا الدومين، يفشل الطلب على مستوى CSP
      // قبل الوصول للشبكة أصلاً).
      // wss://*.supabase.co: اتصال WebSocket الخاص بـSupabase Realtime
      // (اشتراكات postgres_changes في page.tsx وSidebar.tsx) — CSP يفرّق
      // بين scheme الـhttps والـwss رغم نفس الدومين؛ "https://*.supabase.co"
      // وحده لا يغطي wss إطلاقاً، فكان المتصفح يحظر اتصال الـRealtime على
      // مستوى CSP قبل وصوله للشبكة أصلاً (فشل صامت، لا علاقة له بـRLS/auth).
      "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://api.open-meteo.com https://air-quality-api.open-meteo.com https://nominatim.openstreetmap.org",
      "font-src 'self' data:",
      // Turnstile يعرض تحدّيه الفعلي داخل iframe من نطاق Cloudflare نفسه —
      // بلا frame-src صريحة هنا كانت تسقط إلى default-src 'self' (يحظر أي
      // iframe خارجي)، فيفشل عرض التحدي بصمت حتى لو نجح تحميل السكربت نفسه.
      "frame-src https://challenges.cloudflare.com",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; '),
  },
];

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: '/:path*',
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
