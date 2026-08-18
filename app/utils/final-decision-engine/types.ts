// =============================================================
// Final Decision Engine — Types
//
// خطأ معماري مكتشَف ومُصلَح (مراجعة كود خبير خارجي — "لا يوجد
// FinalDecisionEngine مستقل فعلياً"): كان دمج DVI + الامتثال التنظيمي في
// قرار واحد موزَّعاً بمنطق مستقل ثلاث مرات: computeUnifiedActivityDecision
// (البانر + الخريطة)، applyComplianceGateToAei (بطاقة AEI)، ومولّد
// التنبيهات (alerts/generate/route.ts، الذي كان يشعل SAFETY_BREACH من
// dvi.mandatoryStop مباشرة وCOMPLIANCE_VIOLATION من compliance.decisionCategory
// مباشرة، بمعزل تام عن الاثنين الآخرين). ثلاث نسخ يدوية = ثلاث نقاط يمكن أن
// تتناقض، وقد تناقضت فعلياً (نفس النشاط قد يظهر "مسموح" على الخريطة بينما
// AEI يظهر مقيَّداً، أو ينبعث تنبيه غبار DVI بلا أي إشارة امتثال مرافقة).
//
// decideFinal() في engine.ts هي الآن المصدر الوحيد المسموح له بقراءة
// dvi.mandatoryStop/compliance.decisionCategory وإنتاج قرار. كل مستهلك آخر
// (البانر/الخريطة/بطاقة AEI/مولّد التنبيهات) يستهلك FinalDecision الجاهز
// فقط — لا يُعاد الحساب محلياً في أي واجهة أو مسار.
// =============================================================

import type { DviEvaluationResult } from '@/app/utils/dust-engine/types';
import type { DustComplianceResult } from '@/app/utils/dust-compliance-engine/types';
import type { AeiEvaluationResult } from '@/app/utils/aei-engine/types';

// جودة الأدلة المتاحة لهذا التقييم — مفهوم جديد لم يكن موجوداً صراحة في
// الكود سابقاً (كان ضمنياً فقط عبر missingCriticalInputs/confidenceScore
// المنفصلين على كل محرك على حدة). يُشتق داخل adapters.ts من:
//   - OK: جهاز رصد مرتبط بقراءة PM10 حديثة، ولا نقص بيانات حرجة أخرى.
//   - PARTIAL: نقص بيانات غير حرج أو confidenceScore دون الحد الأدنى، لكن
//     لا يزال هناك قرار قابل للاعتماد.
//   - STALE: جهاز مرتبط فعلياً لكن آخر قراءة PM10 قديمة جداً (أقدم من
//     DEVICE_READING_FRESHNESS_MINUTES) أو غائبة رغم وجود الربط.
//   - UNAVAILABLE: نقص بيانات حرجة تمنع ALLOW أصلاً في محرك الامتثال، أو —
//     طلب صريح من المستخدم ("لا تجعل API الطقس يحضر القراءة حق ساعة
//     النشاط، دايماً اجعله يحتاج قراءة حقيقية من الجهاز") — لا جهاز رصد
//     مرتبط بالنشاط إطلاقاً (evidence.deviceLastReadingAt === undefined).
//     القرار الحي/المحفوظ لا يجوز أن يعتمد على تقدير Open-Meteo كأنه قراءة
//     حقيقية بصرف النظر عن جودته؛ توقعات المستقبل التوعوية (شبكة ساعات
//     الدوام، اقتراح أفضل/أسوأ وقت) تبقى تستخدم Open-Meteo دون قيد — هذا
//     المفهوم يُشتق فقط للتقييم الحي الحالي، لا لتلك الشبكة.
export type EvidenceQuality = 'OK' | 'PARTIAL' | 'STALE' | 'UNAVAILABLE';

// LIVE_OPERATIONAL: تقييم اللحظة الممثلة للنشاط الآن (windowEval.worst في
// dustEvaluation.ts) — المسار الوحيد الذي يحمل استمرار PM10 الفعلي
// (pm10ConfirmedViolation340) واستقرار الاستئناف (resumeHoldApplied)، ويُبنى
// عليه القرار المُخزَّن والتنبيهات الفعلية.
// PLANNING: أي ساعة من شبكة توقعات يوم العمل الكاملة (computeDustComplianceHourly)
// — عرض توعوي "هل أقدر أشتغل الساعة الفلانية؟" فقط، لا استمرار ولا استقرار
// استئناف (لم تُمرَّر أصلاً لـbuildComplianceContext في ذلك المسار)، ولا
// يُخزَّن ولا يُنبَّه عليه إطلاقاً.
export type FinalDecisionMode = 'LIVE_OPERATIONAL' | 'PLANNING';

export interface FinalDecisionInput {
  snapshotId: string;
  evaluatedAt: string;
  mode: FinalDecisionMode;

  dvi: DviEvaluationResult;
  compliance: DustComplianceResult | null;
  aei: AeiEvaluationResult | null;

  evidenceQuality: EvidenceQuality;

  ruleBundleVersion: string;
}

// operationalDecision — ما يُسمح فعلياً للفريق الميداني بفعله الآن:
//   ALLOW: تشغيل اعتيادي بلا قيود.
//   MONITOR: تشغيل مع مراقبة/تثبيط معزز (لا إيقاف).
//   RESTRICT: تقييد تشغيلي (ضوابط تحكم إضافية إلزامية).
//   HOLD_FOR_VERIFICATION: الأدلة غير كافية لاعتماد قرار واثق — يتطلب تحقق
//     ميداني قبل الاستمرار (evidenceUnavailable في وضع LIVE_OPERATIONAL فقط
//     — PLANNING لا يملك "الآن" ليطلب تحققاً ميدانياً منه أصلاً).
//   PROTECTIVE_STOP: إيقاف احترازي غير مؤكَّد بعد (STOP_AFFECTED_ACTIVITY
//     معلَّق — pendingConfirmation=true) — قد يتحول تلقائياً لـALLOW أو
//     MANDATORY_STOP بالتقييم التالي.
//   MANDATORY_STOP: إيقاف إلزامي قطعي غير قابل للتجاوز — يشمل أيضاً
//     STOP_AFFECTED_ACTIVITY المؤكَّد (pendingConfirmation=false): محرك
//     الامتثال نفسه (dust-compliance-engine/engine.ts) يحسب canOverride=false
//     لكلتا الحالتين على حد سواء (`!mandatoryStop && decisionCategory !==
//     'STOP_AFFECTED_ACTIVITY'`) — الفرق بينهما نص عرض/severity داخلي فقط،
//     لا قوة إلزام فعلية مختلفة، فـmandatoryStop هنا=true لكليهما.
export type OperationalDecision =
  | 'ALLOW'
  | 'MONITOR'
  | 'RESTRICT'
  | 'HOLD_FOR_VERIFICATION'
  | 'PROTECTIVE_STOP'
  | 'MANDATORY_STOP';

// regulatoryFinding — الحكم التنظيمي المستقل عن القرار التشغيلي (نشاط قد
// يكون operationalDecision=ALLOW فيزيائياً بينما regulatoryFinding=
// PENDING_CONFIRMATION إدارياً، مثال: قراءة أخف من عتبة DVI لكن محرك
// الامتثال ما زال بانتظار تأكيد استمرار من تقييم سابق).
//   COMPLIANT: لا مخالفة — decisionCategory=ALLOW في LIVE_OPERATIONAL، أو
//     compliance غائب أصلاً هناك (فشل آمن، لا PLANNING — راجع تعليق مُصحَّح
//     أدناه، الملاحظة #15).
//   PENDING_CONFIRMATION: قرار امتثال معلَّق بانتظار دليل استمرار
//     (compliance.pendingConfirmation=true) في LIVE_OPERATIONAL.
//   NON_COMPLIANT: مخالفة تنظيمية مؤكَّدة (MANDATORY_STOP، أو
//     STOP_AFFECTED_ACTIVITY غير معلَّق — دليل مؤكَّد بالفعل) في LIVE_OPERATIONAL.
//   NOT_DETERMINABLE: الأدلة غير كافية للحكم إطلاقاً — إما evidenceQuality
//     UNAVAILABLE/نقص بيانات حرجة في LIVE_OPERATIONAL، أو mode==='PLANNING'
//     دائماً (توقّع طقس، لا دليل ميداني حقيقي بعد بصرف النظر عن جودة
//     التوقّع — راجع الملاحظة #12، تعليق مُصحَّح إثر الملاحظة #15).
export type RegulatoryFinding =
  | 'COMPLIANT'
  | 'PENDING_CONFIRMATION'
  | 'NON_COMPLIANT'
  | 'NOT_DETERMINABLE';

export interface FinalDecision {
  snapshotId: string;
  mode: FinalDecisionMode;

  operationalDecision: OperationalDecision;
  regulatoryFinding: RegulatoryFinding;

  mandatoryStop: boolean;
  overridable: boolean;

  // نص عربي جاهز للعرض المباشر — نفس مصدر shortReasonAr من الامتثال إن
  // وُجد قرار امتثال غير ALLOW، وإلا dvi.shortReason، بنفس أولوية
  // computeUnifiedActivityDecision السابقة (الامتثال يفوز دائماً إن كان
  // القرار الفعلي أشد من DVI وحده).
  shortReasonAr: string;
  decisionLabelAr: string;

  // مستوى لوني موحَّد للعرض (بانر/خريطة) — يحل محل UnifiedActivityDecision.level
  // القديم (نص حر) بقيم DVI القياسية (GREEN..BLACK) لضمان تطابق الألوان مع
  // بقية النظام.
  level: 'GREEN' | 'YELLOW' | 'ORANGE' | 'RED' | 'DARK_RED' | 'BLACK';

  // تعليق مُصحَّح (مراجعة كود خارجي — P2، الملاحظة #15: "Drift في التعليقات
  // والأنواع" — العبارة السابقة هنا "true فقط عند PROTECTIVE_STOP" أصبحت
  // غير دقيقة بعد إصلاح الملاحظة #10 ولم تُحدَّث، فخاطر إغراء مبرمج لاحق
  // بـ"إصلاح" الكود ليطابق التعليق القديم ويُعيد نفس العلة).
  //
  // الدلالة الفعلية الآن: = compliance?.pendingConfirmation === true مباشرة
  // (راجع تعليق engine.ts الكامل عند هذا الحقل، والملاحظة #10) — مستقلة
  // تماماً عن operationalDecision/level. يمكن أن تكون true بينما
  // operationalDecision=MONITOR (لا PROTECTIVE_STOP إطلاقاً)، وهذا بالتحديد
  // السيناريو المقصود: PM10>340 قبل اكتمال دقيقتي التأكيد (نافذة "أ") يُنتج
  // MONITOR/ALLOW_WITH_CONTROLS مع pendingConfirmation=true معاً — "معلَّق
  // بانتظار تأكيد" لا يعني بالضرورة "قرار تشغيلي محجوب فعلياً". لا تفترض
  // أن true تستلزم PROTECTIVE_STOP أو العكس — الحقلان مستقلان.
  pendingConfirmation: boolean;

  reasonCodes: readonly string[];
  evidenceQuality: EvidenceQuality;
  ruleBundleVersion: string;
}
