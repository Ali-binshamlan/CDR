// نقطة الحقيقة الواحدة لتصنيف حالة الخطر/القرار عبر التطبيق — بديل النُسخ
// المكرَّرة سابقاً في dashboard/Projects/page.tsx وGlobalDashboard.tsx.
//
// alert.kind ليس "risk_level" — جدول alerts لا يملك عمود risk_level إطلاقاً
// (الأعمدة الفعلية kind/state، راجع supabase-dcr-full-schema.sql). التصنيف
// أدناه مبني على getSeverity في app/dashboard/alerts/page.tsx (مصدر موثوق
// موجود مسبقاً)، لا تصنيف مخترَع من جديد.

// طلب مستخدم صريح: "نريد جعلها مثل مؤشر الامتثال 3 مستويات فقط" — تبسيط
// عرضي بحت (كان 5 قيم: safe/caution/restricted/postpone/stopped). caution
// دُمجت في safe (كلتاهما "لا قيد فعلي")، وpostpone دُمجت في stopped (كلتاهما
// "لا يجوز الاستمرار الآن"). restricted تبقى وحدها كالمستوى الأوسط. الدمج
// عرضي فقط — لا تغيير على أي منطق قرار حقيقي (mandatoryStop/decisionCategory
// الخام في dust-engine/dust-compliance-engine تبقى كما هي تماماً، هذا فقط
// يجمّع تصنيف الألوان/الشارات المشتق منها).
export type Decision = 'safe' | 'restricted' | 'stopped';

export const decisionMeta: Record<
  Decision,
  { label: string; text: string; bg: string; border: string; dot: string }
> = {
  safe: { label: 'سماح', text: 'text-emerald-700', bg: 'bg-emerald-50', border: 'border-emerald-200', dot: 'bg-emerald-500' },
  restricted: { label: 'مراقبة', text: 'text-amber-700', bg: 'bg-amber-50', border: 'border-amber-200', dot: 'bg-amber-500' },
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
  // خطأ مكتشَف ومُصلَح (مراجعة كود خارجي — "Outbox يخلط الإيقاف الإلزامي
  // والاحترازي"، راجع migration 202608110020 الكامل): kind مستقل جديد —
  // إيقاف احترازي معلَّق (pendingConfirmation=true، operationalDecision=
  // PROTECTIVE_STOP) لم يعد يُصنَّف SAFETY_BREACH. النشاط متوقف فعلياً الآن
  // (نفس أثر mandatoryStop=true التشغيلي)، فيبقى وزنه أعلى من DUST/أي تحذير
  // آخر — لكن أقل من الإيقاف المؤكَّد قطعياً (SAFETY_BREACH/COMPLIANCE_VIOLATION)
  // لتمييز عدم اليقين الفعلي في الواجهة (قد يتحول لاحقاً إلى ALLOW).
  PROTECTIVE_STOP: 3,
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
  // تحذير توقّعي (ساعة قادمة ضمن نافذة النشاط لا حالة حيّة الآن) — أخطر من
  // تذكير BEFORE_START البحت لكن أقل من أي حالة حيّة فعلية، فلا يجوز أن
  // يرفع لون نقطة المشروع بالخريطة لدرجة "إيقاف/تأجيل" لخطر لم يقع بعد.
  FORECAST_WARNING: 1,
  BEFORE_START: 1,
  BEFORE_1H: 0,
  BEFORE_2H: 0,
};

export function alertKindToDecision(kind: string): Decision {
  switch (kind) {
    case 'SAFETY_BREACH': return 'stopped';
    case 'COMPLIANCE_VIOLATION': return 'stopped';
    // إيقاف احترازي معلَّق — النشاط متوقف فعلياً الآن (نفس أثر mandatoryStop
    // التشغيلي)، فيُصنَّف 'stopped' كالإيقاف المؤكَّد.
    case 'PROTECTIVE_STOP': return 'stopped';
    // DUST كانت 'postpone' (مستوى منفصل) قبل الدمج إلى 3 مستويات — الآن
    // تندمج مع 'stopped' (نفس مبدأ "لا يجوز الاستمرار الآن").
    case 'DUST': return 'stopped';
    case 'COMPLIANCE_RESTRICTION': return 'restricted';
    // كانت 'caution' (مستوى منفصل) قبل الدمج — الآن تندمج مع 'safe' (لا قيد
    // فعلي، مجرد تنبيه/معلومة).
    case 'COMPLIANCE_ADVISORY': return 'safe';
    case 'PM10_APPROACHING_LIMIT': return 'safe';
    case 'NO_DECISION_YET': return 'safe';
    case 'FORECAST_WARNING': return 'safe';
    case 'BEFORE_START': return 'safe';
    // تحسّن القراءة — خبر إيجابي صراحة، لا يرفع حالة الخطر إطلاقاً.
    case 'PM10_IMPROVED': return 'safe';
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
  PROTECTIVE_STOP: 'إيقاف احترازي معلَّق (بانتظار تأكيد)',
  COMPLIANCE_VIOLATION: 'مخالفة تنظيمية (امتثال الغبار)',
  COMPLIANCE_RESTRICTION: 'تقييد تنظيمي (امتثال الغبار)',
  COMPLIANCE_ADVISORY: 'تنبيه استباقي (امتثال الغبار)',
  NO_DECISION_YET: 'نشاط جارٍ بلا قرار موثّق',
  PM10_APPROACHING_LIMIT: 'اقتراب من حد PM10 التنظيمي',
  FORECAST_WARNING: 'تحذير توقّعي (ساعة قادمة ضمن النافذة)',
  // جديد (202608190001، طلب صريح من المستخدم): تحسّن القراءة بعد مخالفة
  // مؤكَّدة وقبل دخول الإيقاف الفعلي — راجع alert-outbox-worker/route.ts.
  PM10_IMPROVED: 'تحسّن القراءة (PM10 عاد دون حد المخالفة)',
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
    // RED كانت 'postpone' (مستوى منفصل) قبل الدمج إلى 3 مستويات — الآن
    // تندمج مع 'stopped'.
    case 'RED': return 'stopped';
    case 'ORANGE': return 'restricted';
    // YELLOW كانت 'caution' (مستوى منفصل) قبل الدمج — الآن تندمج مع 'safe'.
    case 'YELLOW': return 'safe';
    default: return 'safe'; // GREEN
  }
}
