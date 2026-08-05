// تحقق أن نشاط مجدوَل (بداية/مدة) يقع بالكامل ضمن أوقات دوام المشروع
// الرسمية (work_hours_start/work_hours_end على projects) — طلب مستخدم
// صريح: "زر التعديل الموجود في الأنشطة هو المشكلة بذاتها" (يسمح بضبط وقت
// خارج أوقات الدوام)، بعكس نموذج الإنشاء (AddActivityModal/index.tsx،
// دالة validateSchedule الداخلية) الذي يمنع ذلك فعلاً. هذه الدالة تُطبِّق
// نفس المنطق بالضبط، ليُستخدَم من مسار التعديل (وأي مسار آخر لاحقاً) بلا
// تكرار.
//
// ملاحظة تصحيحية: نسخة سابقة من هذا الملف استخدمت خطأً project_shifts
// (جدول ورديات فرعية اختيارية منفصل تماماً، لا علاقة له بهذا القيد) بدل
// المصدر الحقيقي work_hours_start/work_hours_end — استُبدل بالكامل هنا.
//
// مشروع بلا work_hours_start/work_hours_end مُعرَّفين (عمودان nullable) لا
// يُقيَّد إطلاقاً — نفس فشل آمن مطابق لمنطق الإنشاء (`if (!ws || !we) return null;`).

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

export function isActivityTimeWithinWorkHours(
  workHoursStart: string | null | undefined,
  workHoursEnd: string | null | undefined,
  plannedTime: string,
  durationHours: number
): boolean {
  if (!workHoursStart || !workHoursEnd) return true; // لا أوقات دوام مُعرَّفة = لا قيد

  const workStart = toMinutes(workHoursStart);
  const workEnd = toMinutes(workHoursEnd);
  const activityStart = toMinutes(plannedTime);
  const activityEnd = activityStart + Math.round(durationHours * 60);

  return activityStart >= workStart && activityEnd <= workEnd;
}
