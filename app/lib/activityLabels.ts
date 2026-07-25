// نقطة الحقيقة الواحدة لترجمة activity_type (نص خام كـ HEAVY_EQUIPMENT_MOVEMENT)
// إلى تسمية عربية معروضة — بديل النُسخ المكرَّرة سابقاً (نفس القاموس
// تقريباً، بقيم متضاربة أحياناً) في app/api/projects/[projectId]/route.ts،
// app/dashboard/alerts/page.tsx، وapp/components/dashborad/projectdashborad/
// {Dustwidgetcard,Compliancewidgetcard}.tsx.
//
// المصدر الأساسي (canonical) هو ACTIVITY_LABEL_AR في app/utils/dust-engine/
// tables.ts — مبني على ActivityCategory الفعلي المستخدم في محرك الغبار،
// لا نصوصاً حرة. الأسماء الإضافية أدناه (LEGACY_ACTIVITY_LABEL_AR) قيم قديمة
// ظهرت فعلياً في project_dust_profiles.activity_type عبر الزمن ولا تقابل
// مفتاحاً في ActivityCategory الحالي (مثال: 'INDOOR_WORK', 'WELDING').

import { ACTIVITY_LABEL_AR } from '@/app/utils/dust-engine/tables';

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
  ...(ACTIVITY_LABEL_AR as Record<string, string>),
  ...LEGACY_ACTIVITY_LABEL_AR,
};

export function translateActivityType(type: string | null | undefined): string {
  if (!type) return 'نشاط عام';
  const trimmed = String(type).trim();

  if ((ACTIVITY_LABEL_AR as Record<string, string>)[trimmed]) return (ACTIVITY_LABEL_AR as Record<string, string>)[trimmed];
  if (LEGACY_ACTIVITY_LABEL_AR[trimmed]) return LEGACY_ACTIVITY_LABEL_AR[trimmed];

  const normalized = trimmed.toUpperCase().replace(/[\s-]+/g, '_');
  if ((ACTIVITY_LABEL_AR as Record<string, string>)[normalized]) return (ACTIVITY_LABEL_AR as Record<string, string>)[normalized];
  if (LEGACY_ACTIVITY_LABEL_AR[normalized]) return LEGACY_ACTIVITY_LABEL_AR[normalized];

  return trimmed;
}
