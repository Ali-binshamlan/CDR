// نقطة الحقيقة الواحدة لترجمة regulatory_activity (نص خام كـ CRUSHER) إلى
// تسمية عربية معروضة — بديل النُسخ المكرَّرة سابقاً (نفس القاموس تقريباً،
// بقيم متضاربة أحياناً) في app/api/projects/[projectId]/route.ts،
// app/dashboard/alerts/page.tsx، وapp/components/dashborad/projectdashborad/
// {Dustwidgetcard,Compliancewidgetcard}.tsx.
//
// المصدر الأساسي (canonical) هو REGULATORY_ACTIVITY_LABEL_AR في dust-
// compliance-engine/rulebook.ts — التسعة أنشطة التنظيمية الفعلية القابلة
// للاختيار من الواجهة. طلب مستخدم صريح (توحيد كامل): ActivityCategory
// وACTIVITY_LABEL_AR (dust-engine/tables.ts) حُذفا بالكامل — لم يعودا مصدر
// ترجمة. LEGACY_ACTIVITY_LABEL_AR أدناه يبقى فقط كخط دفاع أخير لصفوف نادرة
// جداً بلا regulatory_activity صالح (سابقة على إضافة هذا الحقل، عمود
// activity_type نفسه بات غير مستخدَم في أي حساب — راجع project_dvi_activity_
// scope في الذاكرة).
import { REGULATORY_ACTIVITY_LABEL_AR } from '@/app/utils/dust-compliance-engine/rulebook';

const LEGACY_ACTIVITY_LABEL_AR: Record<string, string> = {
  GENERAL_OUTDOOR_WORK: 'أعمال خارجية عامة',
  INDOOR_WORK: 'أعمال داخلية وخارجية خفيفة',
  EARTHWORKS: 'أعمال حفر وتربة',
  CLEANING_WORK: 'أعمال تنظيف وموقع',
  'اعمال تنظيف': 'أعمال تنظيف وموقع',
  HIGH_ALTITUDE_WORK: 'أعمال على ارتفاعات عالية',
  WELDING: 'أعمال لحام',
  SCAFFOLDING: 'أعمال سقالات',
  CRANE_LIFTING: 'عمليات رفع وتحريك أحمال',
  MEP_EXTERNAL_WORK: 'أعمال ميكانيكية/كهربائية',
};

// نسخة مسطّحة تجمع القاموسين — للاستخدام في استبدال نصي حر (regex) مثل
// translateAlertMessage في dashboard/alerts/page.tsx، حيث يلزم التكرار على
// كل المفاتيح لا مجرد lookup مفرد.
export const ALL_ACTIVITY_LABELS_AR: Record<string, string> = {
  ...REGULATORY_ACTIVITY_LABEL_AR,
  ...LEGACY_ACTIVITY_LABEL_AR,
};

export function translateActivityType(type: string | null | undefined): string {
  if (!type) return 'نشاط عام';
  const trimmed = String(type).trim();

  if (REGULATORY_ACTIVITY_LABEL_AR[trimmed]) return REGULATORY_ACTIVITY_LABEL_AR[trimmed];
  if (LEGACY_ACTIVITY_LABEL_AR[trimmed]) return LEGACY_ACTIVITY_LABEL_AR[trimmed];

  const normalized = trimmed.toUpperCase().replace(/[\s-]+/g, '_');
  if (REGULATORY_ACTIVITY_LABEL_AR[normalized]) return REGULATORY_ACTIVITY_LABEL_AR[normalized];
  if (LEGACY_ACTIVITY_LABEL_AR[normalized]) return LEGACY_ACTIVITY_LABEL_AR[normalized];

  return trimmed;
}

// عنوان النشاط المعروض للمستخدم = النشاط التنظيمي المختار فعلياً (كسارة/
// هدم/محطة خلط...). نقطة الحقيقة الواحدة لهذا القرار — بدل تكرار نفس
// الـ ternary في كل صفحة/جدول يعرض اسم نشاط غبار.
export function displayActivityLabel(row: {
  regulatory_activity?: string | null;
  activity_type?: string | null;
} | null | undefined): string {
  const reg = row?.regulatory_activity;
  if (reg && REGULATORY_ACTIVITY_LABEL_AR[reg]) {
    return REGULATORY_ACTIVITY_LABEL_AR[reg];
  }
  return translateActivityType(row?.activity_type);
}
