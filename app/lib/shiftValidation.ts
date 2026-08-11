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

// خطأ مكتشَف ومُصلَح (المستخدم سأل: "نشاط 3 أيام بدوام 8 ساعات، هل يُحتسب
// من وقت العمل فقط؟"): كانت هذه الدالة تستقبل duration_hours الإجمالية
// (= ساعات الدوام اليومي × عدد أيام النشاط، مثال: 24 لنشاط 3 أيام بدوام
// 8 ساعات) وتتحقق أن activityStart+durationHours بالكامل يقع ضمن دوام
// يوم واحد — أي نشاط متعدد الأيام كان يُرفَض بالحفظ دائماً (24 ساعة لا
// يمكن أن تقع ضمن نافذة دوام يوم واحد 8 ساعات)، بصرف النظر عن صحة توقيته
// اليومي الفعلي. الإصلاح: dailyDurationHours (اختياري، ساعات الدوام
// اليومي وحدها بمعزل عن الإجمالية) يُستخدَم للتحقق إن توفّر؛ يبقى
// السقوط الافتراضي على durationHours الإجمالية لضمان توافق كامل مع كل
// الاستدعاءات القديمة (نشاط بيوم واحد حيث durationHours=dailyDurationHours
// عملياً، فلا فرق في النتيجة).
export function isActivityTimeWithinWorkHours(
  workHoursStart: string | null | undefined,
  workHoursEnd: string | null | undefined,
  plannedTime: string,
  durationHours: number,
  dailyDurationHours?: number | null
): boolean {
  if (!workHoursStart || !workHoursEnd) return true; // لا أوقات دوام مُعرَّفة = لا قيد

  const workStart = toMinutes(workHoursStart);
  const workEnd = toMinutes(workHoursEnd);
  const activityStart = toMinutes(plannedTime);
  const effectiveDailyHours = dailyDurationHours ?? durationHours;
  const activityEnd = activityStart + Math.round(effectiveDailyHours * 60);

  return activityStart >= workStart && activityEnd <= workEnd;
}
