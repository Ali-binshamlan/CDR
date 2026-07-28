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
export function safeErrorResponse(error: unknown, context?: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  console.error(context ? `${context}:` : 'API error:', raw);
  return 'حدث خطأ أثناء تنفيذ الطلب. الرجاء المحاولة لاحقاً أو التواصل مع الدعم إن استمرت المشكلة.';
}
