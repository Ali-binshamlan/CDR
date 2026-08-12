// رسالة خطأ آمنة للعميل — يستبدل تمرير error.message الخام من Supabase/JS
// مباشرة في استجابة API. رسائل Supabase/PostgREST غالباً تحتوي أسماء
// جداول/أعمدة/قيود فعلية (مثال: 'duplicate key value violates unique
// constraint "idx_project_devices_api_key_hash"') — مفيدة لمهاجم يجمع
// معلومات استطلاعية عن البنية الداخلية لقاعدة البيانات (CWE-209)، بلا أي
// فائدة عملية للمستخدم النهائي. التفاصيل الكاملة تبقى في console.error
// على الخادم فقط (لا تُحذف، فقط لا تُرسَل للعميل).
//
// server-side logging: نستدعي console.error هنا حتى لا يُضطر كل موقع
// استدعاء لتكرار نفس السطر — يبقى بإمكان أي موقع استدعاء تمرير سياق إضافي
// عبر المعامل الثاني (context) ليظهر في السجل فقط.
//
// خطأ تشخيصي حرج مكتشَف ومُصلَح (المستخدم لاحظ: "ما تغيّر شي" بعد إصلاح
// RPC ناقصة — Vercel logs أظهرت `[object Object]` بلا أي تفاصيل فعلية):
// error instanceof Error كان false دائماً لأخطاء Supabase/PostgREST (كل
// نتائج .rpc()/.from() تُرجع كائن عادي {message, details, hint, code}،
// ليس JS Error حقيقياً) — فيسقط دائماً إلى String(error) التي تطبع حرفياً
// "[object Object]" لأي كائن عادي بلا toString مخصص. هذا كان يُفقِد رسالة
// الخطأ الحقيقية في console.error عبر كل الـ81 موقع استدعاء لهذه الدالة في
// المشروع بأكمله — لا يقتصر على مسار واحد، بل يُعطِّل التشخيص الفعلي لأي
// خطأ خادمي 500 من قاعدة البيانات في كل الـAPI routes. الإصلاح: استخراج
// صريح لحقل message من أي كائن يحمله (Supabase/PostgREST وأي كائن خطأ
// مشابه آخر)، قبل السقوط إلى String(error) كحل أخير فقط لقيم بدائية حقاً
// (نص/رقم/undefined) التي لا يوجد لها حقل message أصلاً.
export function safeErrorResponse(error: unknown, context?: string): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === 'object' && error !== null && 'message' in error && typeof (error as { message: unknown }).message === 'string'
        ? (error as { message: string }).message
        : String(error);
  console.error(context ? `${context}:` : 'API error:', raw);
  return 'حدث خطأ أثناء تنفيذ الطلب. الرجاء المحاولة لاحقاً أو التواصل مع الدعم إن استمرت المشكلة.';
}
