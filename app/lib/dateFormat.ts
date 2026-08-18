// نقطة الحقيقة الواحدة لتنسيق التواريخ العربية المعروضة.
//
// المشكلة التي تُحلّها: locale 'ar-SA' يجعل بعض البيئات (خصوصاً Edge/Windows)
// تعرض التاريخ بالتقويم الهجري (أم القرى) افتراضياً، فيظهر يوم مختلف تماماً
// عن التاريخ الميلادي المخزَّن (مثال: ٢٦ يوليو ميلادي يظهر "٦" هجري). نُثبّت
// calendar: 'gregory' صراحةً في كل مكان حتى يتطابق العرض مع البيانات في كل
// المتصفحات ومحرّكات ICU، مع الإبقاء على أسماء الأيام/الشهور العربية.
//
// كل الدوال بتوقيت الرياض (Asia/Riyadh) افتراضياً — النظام سعودي بالكامل.

const RIYADH_TZ = 'Asia/Riyadh';
const AR_LOCALE = 'ar-SA';

function toDate(value: string | number | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

// تاريخ كامل: "الأحد ٢٦ يوليو ٢٠٢٦".
export function formatArDateLong(value: string | number | Date): string {
  return toDate(value).toLocaleDateString(AR_LOCALE, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: RIYADH_TZ,
    calendar: 'gregory',
  });
}

// وقت فقط: "٠٧:٠٠ ص" — التقويم لا يؤثر على الوقت لكن نُثبّته للاتساق.
export function formatArTime(value: string | number | Date): string {
  return toDate(value).toLocaleTimeString(AR_LOCALE, {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: RIYADH_TZ,
    calendar: 'gregory',
  });
}

// تاريخ + وقت مدمجان: "الأحد ٢٦ يوليو، ٠٧:٠٠ ص".
export function formatArDateTime(value: string | number | Date): string {
  return toDate(value).toLocaleString(AR_LOCALE, {
    weekday: 'long',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: RIYADH_TZ,
    calendar: 'gregory',
  });
}
