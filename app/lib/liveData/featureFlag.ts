// Feature Flag للتبديل بين نظام البيانات الحية القديم (polling +
// Supabase Realtime، الموجود فعلاً في app/dashboard/Projects/[id]/page.tsx)
// والجديد (SSE + LiveDataStore). القيمة الافتراضية false — النظام القديم
// يبقى هو الفعّال حتى تُفعَّل هذه الراية صراحة، ويُختبَر SSE بمعزل تام أولاً
// (Phase A/B من الخطة المرحلية). القراءة من env تسمح بالتبديل بلا إعادة
// نشر منطق التطبيق — فقط متغير بيئة على Vercel.
//
// خطأ مكتشَف ومُصلَح قبل أي استخدام فعلي: page.tsx (المستهلك الوحيد) مكوّن
// 'use client' — process.env.LIVE_DATA_V2 (بلا بادئة NEXT_PUBLIC_) يكون
// undefined دائماً في كود يعمل بالمتصفح، بصرف النظر عن قيمته الفعلية على
// الخادم؛ Next.js لا يُضمّن متغيرات env في حزمة العميل إلا بهذه البادئة
// صراحة (استبدال وقت البناء، لا قراءة runtime حقيقية). NEXT_PUBLIC_
// إلزامية هنا تحديداً لأن هذه الراية تُقرأ من مكوّن عميل، لا من route.ts
// خادمي (حيث كانت ستعمل بلا بادئة).
export function isLiveDataV2Enabled(): boolean {
  return process.env.NEXT_PUBLIC_LIVE_DATA_V2 === 'true';
}
