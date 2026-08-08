// Feature Flag للتبديل بين نظام البيانات الحية القديم (polling +
// Supabase Realtime، الموجود فعلاً في app/dashboard/Projects/[id]/page.tsx)
// والجديد (SSE + LiveDataStore). القيمة الافتراضية false — النظام القديم
// يبقى هو الفعّال حتى تُفعَّل هذه الراية صراحة، ويُختبَر SSE بمعزل تام أولاً
// (Phase A/B من الخطة المرحلية). القراءة من env تسمح بالتبديل بلا إعادة
// نشر منطق التطبيق — فقط متغير بيئة على Vercel.
export function isLiveDataV2Enabled(): boolean {
  return process.env.LIVE_DATA_V2 === 'true';
}
