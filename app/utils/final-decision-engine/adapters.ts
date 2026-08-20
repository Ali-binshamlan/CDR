// =============================================================
// Final Decision Engine — Adapters
// يبني FinalDecisionInput من نتائج DVI/الامتثال/AEI الجاهزة — بلا أي
// إعادة حساب لأي منها، فقط تجميع + اشتقاق evidenceQuality/snapshotId.
// نفس نمط buildComplianceContext في dust-compliance-engine/adapters.ts.
// =============================================================

import type { DviEvaluationResult } from '@/app/utils/dust-engine/types';
import type { DustComplianceResult } from '@/app/utils/dust-compliance-engine/types';
import type { AeiEvaluationResult } from '@/app/utils/aei-engine/types';
import { RULEBOOK_VERSION } from '@/app/utils/dust-compliance-engine';
import type { EvidenceQuality, FinalDecisionInput, FinalDecisionMode } from './types';
import { DEVICE_CONNECTION_FRESHNESS_MS } from '@/app/utils/rule-bundles/field-freshness';

// عتبة حداثة قراءة الجهاز — نفس DEVICE_READING_FRESHNESS_MINUTES في
// app/lib/dustEvaluation.ts وDEVICE_READING_STALENESS_MINUTES في
// Compliancewidgetcard.tsx (مكرَّرة عمداً بنفس القيمة، كلاهما مستقل عن
// طبقة عرض/طبقة خادم مختلفة — نفس الاتفاقية القائمة في المشروع). مصدرها
// الآن app/utils/rule-bundles/field-freshness.ts (DEVICE_CONNECTION_
// FRESHNESS_MS) — راجعه لسبب اختلافها عمداً عن عتبة PM10 اللحظية (4 دقائق).
const DEVICE_READING_FRESHNESS_MINUTES = DEVICE_CONNECTION_FRESHNESS_MS / 60_000;

// نفس CONFIDENCE_MIN_FOR_ALLOW في dust-compliance-engine/engine.ts (ثابت
// محلي غير مُصدَّر هناك — مكرَّر هنا بنفس القيمة بدل توسيع الواجهة العامة
// لذلك المحرك لأجل ثابت واحد). أي ثقة أقل من هذا الحد تمنع ALLOW أصلاً في
// محرك الامتثال (يتحول لـFIELD_VERIFICATION_REQUIRED)، فنفس الحد هنا يعني
// "أدلة كافية للثقة الكاملة" (OK) مقابل "كافية لكن غير مثالية" (PARTIAL).
const CONFIDENCE_MIN_FOR_ALLOW = 70;

// خطأ معماري مكتشَف ومُصلَح (مراجعة كود خبير خارجي — "لا يوجد
// FinalDecisionEngine مستقل فعلياً"): جودة الأدلة (evidenceQuality) لم تكن
// موجودة كمفهوم موحَّد سابقاً — كل مستهلك كان يحكم على "هل البيانات كافية؟"
// بطريقته الخاصة (buildStalenessAdvisory في الواجهة يعرض تنبيهاً منفصلاً،
// missingCriticalInputs يمنع فقط ALLOW داخل محرك الامتثال نفسه). الآن دالة
// واحدة تشتق تصنيفاً موحَّداً:
//   UNAVAILABLE: missingCriticalInputs تتضمن حقلاً حرجاً يمنع أي قرار واثق
//     (نفس الحقول التي تُسقِط confidenceScore أسفل CONFIDENCE_MIN_FOR_ALLOW
//     في dust-compliance-engine/engine.ts)، أو النشاط بلا جهاز رصد مرتبط
//     أصلاً (evidence.deviceLastReadingAt === undefined) — راجع تعليق
//     "لا تجعل API الطقس يحضر القراءة" أدناه: القرار الحي/المحفوظ لا يجوز
//     أن يعتمد على تقدير Open-Meteo كأنه قراءة حقيقية، بصرف النظر عن جودته.
//   STALE: النشاط مرتبط بجهاز فعلياً (evidence.deviceLastReadingAt !==
//     undefined) لكن آخر قراءة PM10 غائبة تماماً أو أقدم من عتبة الحداثة.
//   PARTIAL: نقص بيانات غير حرج (missingCriticalInputs غير فارغة لكن لا
//     تصل لحد UNAVAILABLE) أو confidenceScore أقل من الحد الأدنى للثقة.
//   OK: لا نقص، لا قِدم، جهاز مرتبط وقراءته حديثة — الحالة الوحيدة القابلة
//     لإصدار قرار حي واثق (ALLOW أو STOP) اليوم.
// خطأ مكتشَف ومُصلَح (مراجعة كود مدير — "evidenceQuality=PARTIAL قد ينتج
// ALLOW + COMPLIANT" و"غياب compliance ينتج COMPLIANT بدل NOT_DETERMINABLE"):
// كان !compliance يُرجع 'PARTIAL' دائماً بافتراض أن غياب compliance يحدث
// فقط في PLANNING (توقّع مستقبلي بسيط، حيث evidenceUnavailable لا يُطبَّق
// أصلاً بغض النظر عن mode). هذا الافتراض خاطئ: buildFinalDecisionInput
// يُستدعى فعلياً في مسارات LIVE_OPERATIONAL حقيقية (applyComplianceGatesToDustAei
// وcomputeUnifiedActivityDecision بـdustEvaluation.ts، ومولّدات dashboard/
// global وviewer/dashboard وalerts/generate) بـ`compliance ?? null` — فلو
// computeDustComplianceResults فشلت أو أرجعت نتيجة فارغة لأي سبب، يصل
// compliance=null فعلياً هنا وmode='LIVE_OPERATIONAL' (الافتراضي). PARTIAL
// لا يُصعِّد لـHOLD_FOR_VERIFICATION (بتصميم متعمَّد، "نقص غير حرج")، فكان
// القرار الحي يستمر يُبنى من dvi.decisionCategory وحده بثقة كاملة رغم غياب
// أي تقييم امتثال إطلاقاً — قد يصل ALLOW+COMPLIANT بلا أي فحص تنظيمي فعلي.
//
// الإصلاح: غياب compliance كلياً في LIVE_OPERATIONAL هو UNAVAILABLE (لا
// يمكن الحكم إطلاقاً بلا محرك امتثال شغَّال، أشد من "ثقة منخفضة" PARTIAL)
// — نفس معاملة "لا جهاز مرتبط أصلاً" أدناه بالضبط. في PLANNING يبقى
// PARTIAL كما كان (evidenceUnavailable لا يتأثر بالـmode هناك أصلاً، فلا
// فرق عملي، لكن التصنيف الدقيق يبقى صحيحاً لأي مستهلك مستقبلي يفحص
// evidenceQuality مباشرة بمعزل عن operationalDecision).
// خطأ مكتشَف ومُصلَح (طلب صريح من المستخدم — "جودة الدليل تعتمد على
// Date.now() بدل وقت التقييم، بينما بصمة المدخلات لا تشملها؛ قد ينتج replay
// لاحق قراراً مختلفاً لنفس البصمة"): كانت هذه الدالة تستدعي Date.now()
// ضمنياً — مخالفة صريحة لمبدأ H-07 الموثَّق في المشروع (دوال حساب القرار
// يجب أن تستقبل nowMs صراحة، لا Date.now() ضمنياً، لتبقى نقية وقابلة
// لإعادة الحساب بحتمية — نفس المبدأ المطبَّق في determineFinalDecisionMode
// وdust-compliance-engine/engine.ts). الآن nowMs معامل إلزامي — buildFinalDecisionInput
// يمرره من evaluatedAt نفسه (لا Date.now() منفصل)، فيصبح evidenceQuality
// محسوبة دائماً بالنسبة لنفس اللحظة المخزَّنة رسمياً كوقت التقييم.
function deriveEvidenceQuality(compliance: DustComplianceResult | null, mode: FinalDecisionMode, nowMs: number): EvidenceQuality {
  if (!compliance) return mode === 'LIVE_OPERATIONAL' ? 'UNAVAILABLE' : 'PARTIAL';

  // دفاعي عمداً (compliance?.missingCriticalInputs?.length، لا .length
  // مباشرة): مصادر compliance ليست جميعها كائن DustComplianceResult كامل —
  // اختبارات/مستهلكون تاريخيون (applyComplianceGateToAei القديمة) كانوا
  // يبنون كائناً جزئياً يحمل decisionCategory/shortReasonAr فقط، بلا
  // missingCriticalInputs/evidence. غياب الحقل هنا يُعامَل كـ"لا معلومات
  // كافية للحكم" → PARTIAL، لا استثناءً يوقف التقييم بأكمله.
  if ((compliance.missingCriticalInputs?.length ?? 0) > 0) {
    // نفس شرط FIELD_VERIFICATION_REQUIRED في dust-compliance-engine/engine.ts:
    // نقص بيانات حرجة يمنع ALLOW أصلاً — هذا يكفي لتصنيفه UNAVAILABLE (لا
    // يمكن اعتماد قرار واثق بلا هذه الحقول، بصرف النظر عن قِدم الجهاز).
    return 'UNAVAILABLE';
  }

  const deviceLastReadingAt = compliance.evidence?.deviceLastReadingAt;
  const devicePm10LastReadingAt = compliance.evidence?.devicePm10LastReadingAt;

  // خطأ معماري مكتشَف ومُصلَح (طلب صريح من المستخدم — "لا تجعل API الطقس
  // يحضر القراءة حق ساعة النشاط، دايماً اجعله يحتاج قراءة حقيقية من
  // الجهاز"): deviceLastReadingAt === undefined يعني "لا جهاز مرتبط
  // بالنشاط أصلاً" (راجع تعليق buildComplianceContext في adapters.ts —
  // يميّز عمداً عن null="جهاز مرتبط لكن بلا قراءة بعد"). سابقاً كان هذا
  // الفرع بأكمله يُتخطّى صامتاً لغياب الجهاز، فيسقط التقييم لثقة confidenceScore
  // وحدها (مبنية على تقدير Open-Meteo)، وقد يصل OK كاملة رغم أن مصدر
  // القراءة الفعلي كان تقديراً جوياً لا قياساً حقيقياً — تحديداً لساعة
  // النشاط نفسها (الآن)، لا توقعاً مستقبلياً توعوياً (ذاك يبقى مقبولاً
  // ولا يمر عبر هذه الدالة أصلاً — evidenceQuality يُشتق فقط للتقييم الحي
  // الحالي، لا لشبكة توقعات ساعات الدوام القادمة). الآن: غياب الجهاز
  // كلياً في التقييم الحي يعني دائماً UNAVAILABLE — لا قرار حي واثق (ALLOW
  // أو STOP) بلا قراءة جهاز حقيقية، بصرف النظر عن جودة تقدير الطقس.
  if (deviceLastReadingAt === undefined) {
    return 'UNAVAILABLE';
  }

  // نفس مرجع الحداثة الفعلي المستخدَم في buildStalenessAdvisory
  // (Compliancewidgetcard.tsx): قراءة PM10 تحديداً إن توفّر تاريخها،
  // وإلا الرجوع لـdeviceLastReadingAt العام.
  const referenceReadingAt = devicePm10LastReadingAt !== undefined ? devicePm10LastReadingAt : deviceLastReadingAt;
  if (referenceReadingAt === null) return 'STALE'; // محطة متصلة، لا قراءة PM10 قط
  const ageMinutes = (nowMs - new Date(referenceReadingAt).getTime()) / 60000;
  // خطأ مكتشَف ومُصلَح (طلب صريح من المستخدم — "القراءة المستقبلية: محرك
  // الامتثال يصفها FUTURE، لكن محرك القرار النهائي قد يمنحها OK بسبب عدم
  // رفض العمر السالب"): dust-compliance-engine/adapters.ts يتحقق فعلياً من
  // عمر سالب (pm10EvidenceState='FUTURE') لكن هذا التصنيف مقصور على PM10
  // فقط ولا يصل أبداً لهذه الدالة (buildFinalDecisionInput يقرأ الطابع
  // الزمني الخام من compliance.evidence مباشرة، لا حقل pm10EvidenceState).
  // بلا هذا الفحص، referenceReadingAt المستقبلي (خلل ساعة جهاز) ينتج
  // ageMinutes سالبة، وأي رقم سالب يحقق `> DEVICE_READING_FRESHNESS_MINUTES`
  // بقيمة false تلقائياً، فيتخطى شرط STALE ويصل OK — أعلى ثقة ممكنة لقراءة
  // فاسدة زمنياً. الحراسة هنا (لا في dust-compliance-engine) لأن هذه الدالة
  // تعتمد على deviceLastReadingAt العام (كل قراءات الجهاز)، لا PM10 فقط —
  // FUTURE في محرك الامتثال يغطي نطاقاً أضيق. STALE (لا UNAVAILABLE) لأن
  // الجهاز مرتبط فعلاً وأرسل قراءة حقيقية، فقط بتوقيت غير موثوق — نفس
  // معاملة قراءة قديمة جداً (كلاهما "أدلة غير كافية" بنفس الوزن تماماً، راجع
  // evidenceUnavailable في final-decision-engine/engine.ts).
  if (ageMinutes < 0 || ageMinutes > DEVICE_READING_FRESHNESS_MINUTES) return 'STALE';

  if (compliance.confidenceScore !== undefined && compliance.confidenceScore < CONFIDENCE_MIN_FOR_ALLOW) return 'PARTIAL';

  return 'OK';
}

export function buildFinalDecisionInput(
  snapshotId: string,
  dvi: DviEvaluationResult,
  compliance: DustComplianceResult | null,
  aei: AeiEvaluationResult | null,
  mode: FinalDecisionMode = 'LIVE_OPERATIONAL',
  evaluatedAt: string = new Date().toISOString(),
  // اختياري: راجع تعليق isLiveForDevice الكامل في types.ts — يُمرَّر فقط من
  // المسارات التي تعرف فعلياً حالة هامش تفعيل الجهاز المسبق (isActivityLiveForDevice
  // في dustEvaluation.ts). غيابه = السلوك القديم بلا تغيير.
  isLiveForDevice?: boolean
): FinalDecisionInput {
  return {
    snapshotId,
    evaluatedAt,
    mode,
    dvi,
    compliance,
    aei,
    // nowMs مشتقة من evaluatedAt نفسه (لا Date.now() منفصل) — راجع تعليق
    // deriveEvidenceQuality أعلاه.
    evidenceQuality: deriveEvidenceQuality(compliance, mode, new Date(evaluatedAt).getTime()),
    isLiveForDevice,
    ruleBundleVersion: compliance?.rulebookVersion ?? RULEBOOK_VERSION,
  };
}
