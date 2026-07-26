// نقطة الحقيقة الواحدة لتصنيف حالة الخطر/القرار عبر التطبيق — بديل النُسخ
// المكرَّرة سابقاً في dashboard/Projects/page.tsx وGlobalDashboard.tsx.
//
// alert.kind ليس "risk_level" — جدول alerts لا يملك عمود risk_level إطلاقاً
// (الأعمدة الفعلية kind/state، راجع supabase-dcr-full-schema.sql). التصنيف
// أدناه مبني على getSeverity في app/dashboard/alerts/page.tsx (مصدر موثوق
// موجود مسبقاً)، لا تصنيف مخترَع من جديد.

export type Decision = 'safe' | 'caution' | 'restricted' | 'postpone' | 'stopped';

export const decisionMeta: Record<
  Decision,
  { label: string; text: string; bg: string; border: string; dot: string }
> = {
  safe: { label: 'آمن', text: 'text-emerald-700', bg: 'bg-emerald-50', border: 'border-emerald-200', dot: 'bg-emerald-500' },
  caution: { label: 'مناسب بحذر', text: 'text-amber-700', bg: 'bg-amber-50', border: 'border-amber-200', dot: 'bg-amber-500' },
  restricted: { label: 'مقيد', text: 'text-orange-700', bg: 'bg-orange-50', border: 'border-orange-200', dot: 'bg-orange-500' },
  postpone: { label: 'يفضل التأجيل', text: 'text-rose-700', bg: 'bg-rose-50', border: 'border-rose-200', dot: 'bg-rose-500' },
  stopped: { label: 'إيقاف', text: 'text-red-700', bg: 'bg-red-50', border: 'border-red-200', dot: 'bg-red-700' },
};

// أوزان أولوية خطورة كل alert.kind — تُستخدم لاختيار "أخطر تنبيه نشط" لمشروع
// معيّن، بدل "أحدث تنبيه" (الأحدث ليس بالضرورة الأخطر: تذكير BEFORE_2H قد
// يصل بعد SAFETY_BREACH فعلي لم يُغلق بعد). مطابقة لـ getSeverity في
// app/dashboard/alerts/page.tsx: SAFETY_BREACH حرج، DUST/BEFORE_START/
// NO_DECISION_YET تحذير، BEFORE_1H/BEFORE_2H معلوماتي بحت.
export const ALERT_KIND_WEIGHT: Record<string, number> = {
  // مخالفة تنظيمية فعلية توقف النشاط (محرك الامتثال — مسافة كسارة، كفاءة
  // فلتر، بوابة رياح، DMP، إلخ) بنفس خطورة SAFETY_BREACH (تجاوز فيزيائي
  // صارم من DVI): كلاهما يعني "لا يجوز الاستمرار الآن"، بصرف النظر عن كون
  // السبب تنظيمياً أو فيزيائياً.
  SAFETY_BREACH: 4,
  COMPLIANCE_VIOLATION: 4,
  DUST: 3,
  // تنبيه استباقي PM10 (300-339 ميكروجرام/م³، قبل حد المخالفة التنظيمي
  // 340) — أخطر من "نشاط بلا قرار" لكن أقل من DUST/SAFETY_BREACH الفعليين.
  PM10_APPROACHING_LIMIT: 2,
  // قرار امتثال أخف من الإيقاف (تقييد النشاط أو تحقق ميداني مطلوب) — مخالفة
  // قاعدة فعلية لكن دون إيقاف كامل، فتُصنَّف تحذيراً متوسطاً لا حرجاً.
  COMPLIANCE_RESTRICTION: 2,
  NO_DECISION_YET: 2,
  // تنبيه استباقي من محرك الامتثال (ALLOW_WITH_CONTROLS، مثال PM10-EARLY-
  // WARNING-007 عند 300-339 قبل حد المخالفة 340) — بطلب صريح: تنبيه قبل
  // وقوع المخالفة الفعلية، لا بعدها فقط. نفس درجة PM10_APPROACHING_LIMIT.
  COMPLIANCE_ADVISORY: 2,
  BEFORE_START: 1,
  BEFORE_1H: 0,
  BEFORE_2H: 0,
};

export function alertKindToDecision(kind: string): Decision {
  switch (kind) {
    case 'SAFETY_BREACH': return 'stopped';
    case 'COMPLIANCE_VIOLATION': return 'stopped';
    case 'DUST': return 'postpone';
    case 'COMPLIANCE_RESTRICTION': return 'restricted';
    case 'COMPLIANCE_ADVISORY': return 'caution';
    case 'PM10_APPROACHING_LIMIT': return 'caution';
    case 'NO_DECISION_YET': return 'caution';
    case 'BEFORE_START': return 'caution';
    default: return 'safe'; // BEFORE_1H / BEFORE_2H — تذكير بحت، لا يرفع حالة الخطر
  }
}

// يختار أخطر تنبيه ضمن قائمة تنبيهات نشطة (state != CLOSED) لمشروع واحد.
export function pickMostSevereAlert<T extends { kind: string }>(alerts: T[]): T | null {
  if (alerts.length === 0) return null;
  return alerts.reduce((worst, a) =>
    (ALERT_KIND_WEIGHT[a.kind] ?? 0) > (ALERT_KIND_WEIGHT[worst.kind] ?? 0) ? a : worst
  );
}

export const alertKindLabelAr: Record<string, string> = {
  BEFORE_2H: 'استعداد للنشاط (ساعتين)',
  BEFORE_1H: 'استعداد للنشاط (ساعة)',
  BEFORE_START: 'بدء النشاط الآن',
  DUST: 'عاصفة غبارية محتملة',
  SAFETY_BREACH: 'تجاوز حدود السلامة',
  COMPLIANCE_VIOLATION: 'مخالفة تنظيمية (امتثال الغبار)',
  COMPLIANCE_RESTRICTION: 'تقييد تنظيمي (امتثال الغبار)',
  COMPLIANCE_ADVISORY: 'تنبيه استباقي (امتثال الغبار)',
  NO_DECISION_YET: 'نشاط جارٍ بلا قرار موثّق',
  PM10_APPROACHING_LIMIT: 'اقتراب من حد PM10 التنظيمي',
};

// يحوّل مستوى DVI الحي (DviLevel: GREEN..BLACK، محرك dust-engine) إلى نفس
// Decision الموحَّد — تُستخدم لتلوين نقطة المشروع بالخريطة بحالة نشاطه
// الجاري الفعلية (لا أخطر تنبيه فقط) عندما تتوفر نتيجة DVI حية له. mandatoryStop
// له الأولوية القصوى بصرف النظر عن level (نفس منطق mandatoryStop في محرك
// الغبار — إيقاف إلزامي يتجاوز أي تصنيف لوني آخر).
export function dviLevelToDecision(level: string, mandatoryStop: boolean): Decision {
  if (mandatoryStop) return 'stopped';
  switch (level) {
    case 'BLACK':
    case 'DARK_RED': return 'stopped';
    case 'RED': return 'postpone';
    case 'ORANGE': return 'restricted';
    case 'YELLOW': return 'caution';
    default: return 'safe'; // GREEN
  }
}
