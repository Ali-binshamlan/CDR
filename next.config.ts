import type { NextConfig } from "next";

// ترويسات أمان أساسية — كانت غائبة تماماً سابقاً، ما يترك التطبيق بلا أي
// دفاع ثانوي ضد Clickjacking أو تشغيل موارد من مصادر غير متوقعة حتى لو
// وُجدت ثغرة XSS مستقبلاً. القيم مبنية على الموارد الخارجية الفعلية
// المستخدمة فعلياً في الكود (بلاطات OpenStreetMap لخرائط Leaflet، أيقونات
// unpkg.com، ونطاق Supabase الديناميكي *.supabase.co لجلسة/بيانات المستخدم).
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
      // 'unsafe-inline'/'unsafe-eval' مطلوبان لـ Next.js dev/hydration —
      // تشديدها لاحقاً يتطلب nonce-based CSP، خارج نطاق هذا الإصلاح
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https://*.tile.openstreetmap.org https://unpkg.com",
      "connect-src 'self' https://*.supabase.co https://api.open-meteo.com https://air-quality-api.open-meteo.com",
      "font-src 'self' data:",
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
