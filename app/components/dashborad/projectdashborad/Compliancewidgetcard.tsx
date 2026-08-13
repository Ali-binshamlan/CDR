'use client';

import { useState, useEffect } from 'react';
import { toast } from 'react-hot-toast';
import { apiClient } from '@/app/lib/apiClient';
import { useNow } from '@/app/lib/useNow';
import {
  X, ArrowUpRight, Gauge,
  Clock, AlertTriangle, Printer,
  ShieldAlert, Scale, Wind, Compass, CircleGauge, MapPin,
  Thermometer, Droplets, Eye, Timer,
} from 'lucide-react';
import type { DustComplianceResult, DustComplianceDecisionCategory, SensitiveReceptorType } from '@/app/utils/dust-compliance-engine/types';
import type { AeiEvaluationResult, AeiColor } from '@/app/utils/aei-engine/types';
import { ACTIVITY_LABEL_AR } from '@/app/utils/dust-engine/tables';
import { DEVICE_CONNECTION_FRESHNESS_MS } from '@/app/utils/rule-bundles/field-freshness';
import ActivityReadingsCharts from './ActivityReadingsCharts';

/** قرار امتثال ساعة واحدة ضمن ساعات دوام اليوم — نفس نمط DviHourlyEvaluation
 * في DustWidgetCard، لكن كل ساعة هنا هي DustComplianceResult كامل محسوب عبر
 * محرك الامتثال (وليس DVI فقط) لتلك الساعة تحديداً. aei هو الناتج بعد تمرير
 * result عبر نفس بوابة applyComplianceGateToAei المستخدمة للقرار الإجمالي —
 * هو ما يُعرض فعلياً في الشبكة، وليس result.decisionCategory الخام. */
interface HourlyComplianceEntry {
  time: string;
  result: DustComplianceResult;
  aei?: AeiEvaluationResult;
}

/** مستقبِل حساس (مدرسة/مستشفى/سكني...) ضمن 1كم من حدود المشروع — محسوبة
 * في route.ts عن أقرب نقطة على حدود منطقة المشروع الفعلية (مضلع/دائرة)،
 * وليس عن مركزها. خاصية على مستوى المشروع نفسه، لا تختلف بين الأنشطة. */
interface NearbySensitiveReceptor {
  id: string;
  name: string;
  receptorType: SensitiveReceptorType;
  distanceM: number;
}

/** مجموعة المستقبِلات الحساسة حول وحدة كسارة/خلاطة واحدة — تُحسب في
 * computeUnitReceptors من موقع الوحدة نفسها (crusher_lat/lng أو
 * batching_lat/lng)، لا من حدود المشروع، لأن الوحدة قد تقع في طرف موقع
 * كبير فيختلف أقرب مستقبِل لها عن أقرب مستقبِل لحدود المشروع. */
interface UnitReceptorGroup {
  unitType: 'CRUSHER' | 'BATCHING_PLANT';
  unitLabelAr: string;
  lat: number;
  lng: number;
  radiusM: number;
  hasBindingDistanceRule: boolean;
  receptors: NearbySensitiveReceptor[];
}

interface ComplianceWidgetCardProps {
  activityType: string;
  /** قد يحمل النشاط الواحد أكثر من صف امتثال عند تعدد وحداته الفعلية (عدة
   * محطات خلط/كسارات/أسطح ضمن نفس النشاط التنظيمي) — كل عنصر له قرار
   * امتثال مستقل تماماً. لا علاقة له بتعدد أنواع الأنشطة (نظام إضافة نشاط
   * واحد فقط بالجلسة). */
  complianceList: DustComplianceResult[];
  /** توقعات الامتثال لكل ساعة من ساعات دوام اليوم — تُبنى من hourlyForecasts
   * الخاصة بـ DVI (نفس ساعات الدوام) بعد تمرير كل ساعة عبر محرك الامتثال. */
  complianceHourly?: HourlyComplianceEntry[];
  /** مؤشر قابلية التنفيذ المدمج (AEI) لنفس النشاط — يُعرض هنا حتى تحمل
   * بطاقة الامتثال وحدها كل ما يلزم لقرار "هل أقدر أشتغل؟" بعد إخفاء
   * بطاقة DVI الفيزيائية. */
  aei?: AeiEvaluationResult;
  /** المستقبِلات الحساسة ضمن 1كم من حدود المشروع، مرتبة من الأقرب. */
  nearbySensitiveReceptors?: NearbySensitiveReceptor[];
  /** المستقبِلات ضمن 500م من موقع كل وحدة كسارة/خلاطة في هذا النشاط. */
  unitReceptors?: UnitReceptorGroup[];
  projectId?: string;
  activityId?: string;
  /** معرّف مجموعة النشاط (activity_group_id) — يربط سجل قراءات الجهاز
   * التاريخية (device_readings_history) بهذا النشاط تحديداً في
   * ActivityReadingsCharts، بخلاف activityId (وحدة واحدة داخل النشاط). */
  activityGroupId?: string;
  projectName?: string;
  hideSchedule?: boolean;
  windowStartIso?: string;
  windowEndIso?: string;
  durationHours?: number;
  /** يُستدعى بالضبط في لحظة وصول أي عدّاد PM10 (تأكيد المخالفة أو تعليق
   * الـ30 دقيقة) إلى الصفر — يتيح للأب (صفحة تفاصيل المشروع) طلب إعادة
   * تقييم فورية من الخادم بدل انتظار دورة polling التالية (قد تصل دقيقتين
   * كاملتين)، فيظهر القرار الفعلي الجديد في أقرب وقت ممكن بعد انقضاء المهلة
   * فعلياً، لا بعد دورة زمنية ثابتة غير مرتبطة بلحظة الانقضاء الحقيقية. */
  onCountdownElapsed?: () => void;
}

const COMPLIANCE_RULES_TRANSLATIONS: Record<string, string> = {
  'GATE-DMP-001': 'نشاط غبار نشط/مخطط بلا موافقة معتمدة على خطة إدارة الغبار (DMP)',
  // النص السابق كان يصف هذي القاعدة بـ"لا علاقة له بمخالفة تنظيمية" —
  // تناقض مباشر مع سياق عرضها فعلياً (داخل "أساس القرار — الامتثال
  // التنظيمي"، بقرار MANDATORY_STOP ملزم ودرجة ثقة امتثال). الأصل التقني
  // صحيح (القاعدة موروثة من قياس DVI الفيزيائي المباشر، لا من مخالفة ضابط
  // تحكم كالفلاتر/الصوامع)، لكن الصياغة يجب أن تبقى بلغة امتثال تنظيمي
  // موحّدة دائماً — لا عرض قرارين متنافسين (فيزيائي مقابل تنظيمي) لنفس
  // النشاط الواحد.
  'GATE-DVI-002': 'إيقاف إلزامي تنظيمي: تجاوز خطر فوري في تركيز الغبار أو انعدام الرؤية بموقع النشاط',
  'GATE-SUPPRESSION-003': 'نظام تثبيط الغبار غير عامل على نشاط مولّد للغبار',
  'GATE-WIND-ABOVE-25-004': 'إيقاف الأنشطة المكشوفة المولّدة للغبار بسبب رياح تتجاوز 25 كم/س',
  'DEMO-WIND-STOP-001': 'أعمال هدم مكشوفة أثناء رياح تتجاوز 15 كم/س',
  'DEMO-AREA-002': 'مساحة الهدم النشطة تتجاوز 100 م² في المرة الواحدة',
  'DEMO-MISTING-003': 'لا يوجد رش رذاذ مستمر أو مدفع رذاذ لأعمال الهدم',
  'DEMO-SCREEN-004': 'لا توجد شبكة/حاجز غبار حول موقع الهدم',
  'CRUSHER-CATEGORY-001': 'الكسارات مسموحة فقط في مشاريع الفئة الثالثة (عالية المخاطر)',
  'CRUSHER-DISTANCE-002': 'مسافة الكسارة من المستقبِل الحساس أقل من الحد الأدنى المسموح',
  'CRUSHER-CONTROLS-003': 'السيور الناقلة غير مغلقة أو أنظمة الضباب/مدفع الرذاذ غير متوفرة',
  'STONECUT-DRY-001': 'قطع أحجار جاف بلا تبريد مائي وبلا تشغيل مغلق مزود بفلاتر HEPA',
  'ENTRY-WHEELWASH-001': 'وحدة غسيل الإطارات غير متوفرة أو غير عاملة',
  'ENTRY-TRACKOUT-002': 'أتربة منقولة مرئية تتجاوز 15 متراً من بوابة الخروج',
  'ENTRY-INSPECTION-003': 'لم يُسجَّل فحص وحدة غسيل الإطارات كل ساعة أثناء الرياح 15-25 كم/س',
  'TRAFFIC-SPEED-001': 'لا يوجد تطبيق فعلي لحدود السرعة داخل الموقع',
  'TRAFFIC-UNPAVED-002': 'سرعة الطرق غير المسفلتة تتجاوز الحد المسموح',
  'TRAFFIC-PAVED-003': 'سرعة الطرق المسفلتة تتجاوز الحد المسموح',
  'TRAFFIC-LOAD-004': 'حمولة نقل التربة/المواد غير مغطاة',
  'TRAFFIC-SPILL-005': 'تنظيف المواد المنسكبة تجاوز الحد الزمني المسموح',
  'STOCKPILE-HEIGHT-001': 'ارتفاع الأكوام يتجاوز الحد المسموح لفئة المشروع',
  'STOCKPILE-DISTANCE-002': 'مسافة الأكوام/محطة الخلط من المستقبِل الحساس أقل من الحد المسموح',
  'STOCKPILE-COVER-003': 'الأكوام غير مغطاة وغير مرشوشة',
  'STOCKPILE-DROP-004': 'ارتفاع تفريغ المواد يتجاوز الحد المسموح أثناء الرياح النشطة',
  'STOCKPILE-DROP-005': 'ارتفاع تفريغ المواد يتجاوز الحد الاعتيادي المسموح',
  'IDLE-STABILIZE-001': 'سطح غير نشط لأكثر من 5 أيام دون تثبيت',
  'IDLE-COVER-002': 'غطاء السطح غير النشط غير سليم أو تالف',
  'IDLE-COVER-WIND-003': 'رياح تجاوزت 20 كم/س — يلزم فحص أغطية الأسطح غير النشطة وإصلاحها فوراً',
  'BATCHING-SILO-001': 'صوامع الإسمنت غير محكمة الإغلاق',
  'BATCHING-FILTER-002': 'كفاءة فلتر الجسيمات العالقة أقل من الحد الأدنى (99%)',
  'BATCHING-LEAK-003': 'تسرب مرصود من صومعة الإسمنت أو نظام النقل',
  'BATCHING-DRYCLEAN-004': 'استخدام الكنس الجاف أو النفخ بالهواء المضغوط ممنوع؛ يلزم الشفط أو التنظيف الرطب',
  'BATCHING-SUPPRESSION-005': 'نظام تثبيط الغبار غير مُشغَّل عند محطة الخلط',
};

const COMPLIANCE_DECISION_STYLE: Record<DustComplianceDecisionCategory, { bg: string; border: string; text: string; dot: string }> = {
  ALLOW: { bg: 'bg-emerald-50', border: 'border-emerald-200', text: 'text-emerald-700', dot: 'bg-emerald-500' },
  PRECAUTION: { bg: 'bg-yellow-50', border: 'border-yellow-200', text: 'text-yellow-700', dot: 'bg-yellow-500' },
  ALLOW_WITH_CONTROLS: { bg: 'bg-amber-50', border: 'border-amber-200', text: 'text-amber-700', dot: 'bg-amber-500' },
  FIELD_VERIFICATION_REQUIRED: { bg: 'bg-blue-50', border: 'border-blue-200', text: 'text-blue-700', dot: 'bg-blue-500' },
  RESTRICT_ACTIVITY: { bg: 'bg-orange-50', border: 'border-orange-200', text: 'text-orange-700', dot: 'bg-orange-500' },
  STOP_AFFECTED_ACTIVITY: { bg: 'bg-red-50', border: 'border-red-200', text: 'text-red-700', dot: 'bg-red-600' },
  MANDATORY_STOP: { bg: 'bg-slate-900/5', border: 'border-slate-700', text: 'text-slate-800', dot: 'bg-slate-800' },
};

// ترتيب أولوية القرارات من الأخف إلى الأشد — يُستخدم لاختيار "أسوأ قرار"
// عندما يحمل النشاط الفيزيائي أكثر من نشاط تنظيمي واحد.
const DECISION_SEVERITY_ORDER: DustComplianceDecisionCategory[] = [
  'ALLOW',
  'PRECAUTION',
  'ALLOW_WITH_CONTROLS',
  'FIELD_VERIFICATION_REQUIRED',
  'RESTRICT_ACTIVITY',
  'STOP_AFFECTED_ACTIVITY',
  'MANDATORY_STOP',
];

function pickWorstCompliance(list: DustComplianceResult[]): DustComplianceResult | null {
  if (list.length === 0) return null;
  return list.reduce((worst, current) => {
    const worstRank = DECISION_SEVERITY_ORDER.indexOf(worst.decisionCategory);
    const currentRank = DECISION_SEVERITY_ORDER.indexOf(current.decisionCategory);
    return currentRank > worstRank ? current : worst;
  }, list[0]);
}

// يحوّل رمز إصدار كتاب القواعد التقني (مثل RCRC-NCEC-RIYADH-DUST-2026.1)
// إلى نص عربي مفهوم للمستخدم غير التقني — الرمز الخام يبقى فقط كـ tooltip.
function formatRulebookVersionAr(version: string): string {
  const match = version.match(/(\d{4})\.(\d+)$/);
  const yearRevision = match ? `${match[1]} (تحديث ${match[2]})` : version;
  return `لوائح الغبار التنظيمية للرياض — إصدار ${yearRevision}`;
}

const WIND_BAND_LABEL_AR: Record<string, string> = {
  BELOW_15: 'أقل من 15 كم/س',
  FROM_15_TO_25: 'من 15 إلى 25 كم/س',
  ABOVE_25: 'أعلى من 25 كم/س',
  UNKNOWN: 'غير معروف',
};

const RECEPTOR_TYPE_LABEL_AR: Record<SensitiveReceptorType, string> = {
  SCHOOL: 'مدرسة',
  HOSPITAL: 'مستشفى',
  RESIDENTIAL: 'سكني',
  MOSQUE: 'مسجد',
  OTHER: 'أخرى',
};

// يُنسّق أي قيمة رقمية عشرية (رياح/PM) برقمين بعد الفاصلة فقط
const fmt2 = (value: number | null | undefined): string =>
  value === null || value === undefined ? '—' : value.toFixed(2);

// عتبات تنبيهات إعلامية بحتة داخل بطاقة الامتثال — بلا أي علاقة بقرار
// الإيقاف/AEI (ذاك يبقى محسوباً حصراً من محرك DVI/الامتثال). هذه فقط
// نصائح ميدانية عملية عند رؤية ضعيفة أو حرارة مرتفعة، بطلب صريح من
// المستخدم: "اجعلها تنبيهات داخل بطاقة الامتثال لا تتدخل في قرارات
// الإيقاف أبداً" + "لا تقول إيقاف إلزامي أبداً، أعطِ نصائح".
const LOW_VISIBILITY_THRESHOLD_M = 500;
const HIGH_TEMPERATURE_THRESHOLD_C = 40;

interface AdvisoryTip {
  titleAr: string;
  tipsAr: string[];
}

function buildAdvisoryTips(visibilityM: number | null, temperatureC: number | null): AdvisoryTip[] {
  const tips: AdvisoryTip[] = [];

  if (visibilityM !== null && visibilityM < LOW_VISIBILITY_THRESHOLD_M) {
    tips.push({
      titleAr: `تنبيه إعلامي: رؤية ضعيفة (${Math.round(visibilityM)} م)`,
      tipsAr: [
        'تأنَّ عند تشغيل المعدات الثقيلة وحركة النقل داخل الموقع.',
        'فعّل إضاءة تحذيرية إضافية وتأكد من وضوح إشارات المرور الداخلية.',
        'زِد التباعد بين المعدات والعمالة في مسارات الحركة.',
        'راقب تطور الرؤية دورياً وأبلغ مدير الموقع عند أي تدهور إضافي.',
      ],
    });
  }

  if (temperatureC !== null && temperatureC >= HIGH_TEMPERATURE_THRESHOLD_C) {
    tips.push({
      titleAr: `تنبيه إعلامي: درجة حرارة مرتفعة (${fmt2(temperatureC)}°م)`,
      tipsAr: [
        'وزّع فترات راحة متكررة للعمالة في الهواء الطلق وفّر مظلات تبريد.',
        'شجّع على شرب الماء بانتظام لتفادي الإجهاد الحراري.',
        'إن أمكن، أعِد جدولة الأعمال الشاقة إلى ساعات أبرد من اليوم.',
        'راقب علامات الإجهاد الحراري لدى العمال وأبلغ فوراً عند ظهورها.',
      ],
    });
  }

  return tips;
}

// عتبة حداثة قراءة الجهاز — نفس DEVICE_READING_FRESHNESS_MINUTES في
// app/lib/dustEvaluation.ts. مصدرها الآن app/utils/rule-bundles/
// field-freshness.ts (DEVICE_CONNECTION_FRESHNESS_MS، وحدة ثوابت صرفة بلا
// أي استيراد خادمي — آمنة للاستيراد المباشر هنا).
const DEVICE_READING_STALENESS_MINUTES = DEVICE_CONNECTION_FRESHNESS_MS / 60_000;

// نفس عتبات المدة في app/utils/dust-compliance-engine/rulebook.ts
// (PM10_VIOLATION_CONFIRM_MINUTES / PM10_SUSPENSION_MINUTES) — مكرَّرة عمداً
// هنا فقط لبناء نص العدّاد التنازلي، بلا أي تأثير على القرار نفسه (القرار
// الفعلي محسوب مسبقاً في الخادم عبر pendingConfirmation/decisionCategory).
const PM10_VIOLATION_CONFIRM_MINUTES = 2;
const PM10_SUSPENSION_MINUTES = 30;

// نفس PM10_LAST_READING_FRESHNESS_MINUTES في app/lib/dustEvaluation.ts —
// العتبة التي يستخدمها الخادم فعلياً ليقرر isLatestReadingFresh (شرط لازم
// لتأكيد المخالفة، راجع isConfirmedViolation340 هناك). مكرَّرة عمداً هنا
// بنفس القيمة (لا استيراد مباشر بين واجهة/خادم، نفس اتفاقية DEVICE_READING_
// STALENESS_MINUTES أعلاه) لتمييز حالة "الجهاز توقف عن الإرسال فعلياً" عن
// حالة "لا تزال القراءة حديثة والاستمرار قيد التراكم الطبيعي" — بلا هذا
// التمييز، عدّاد "متبقٍ حتى التأكيد" يستمر بالعد التنازلي بثقة كاملة حتى لو
// توقف الجهاز عن الإرسال منذ دقائق، موحياً بأن التأكيد لا يزال يتقدم فعلياً
// بينما هو متجمّد فعلياً بانتظار قراءة جديدة لن تصل.
const PM10_LAST_READING_FRESHNESS_MINUTES = 4;

// عدّاد تنازلي حي لمصداقية القرار — يوضّح للمستخدم "متبقٍ كذا" بدل انتظار
// التقييم التالي بصمت ليعرف النتيجة. sustainedMinutes هو لقطة (snapshot) من
// آخر تقييم خادمي — يصل فورياً عبر Realtime عند كل قرار جديد، مع polling
// احتياطي كل 10 دقائق كشبكة أمان (راجع DASHBOARD_POLL_INTERVAL_MS في صفحة
// تفاصيل المشروع)؛ نُضيف لها محلياً الزمن المنقضي فعلياً منذ لحظة تلك
// اللقطة (asOfMs) حتى يبقى العدّاد دقيقاً بين تحديثين، لا يقفز أو يتجمّد.
//
// onElapsed (اختياري): يُستدعى مرة واحدة بالضبط في لحظة وصول العدّاد للصفر
// فعلياً — عبر setTimeout مجدوَل بدقة على المدة المتبقية الحقيقية، لا عبر
// انتظار دورة polling التالية. هذا هو ما يجعل تحديث القرار "فور انتهاء
// الوقت" بدل تأخير عشوائي قد يصل عدة دقائق لو صادف انتهاء العدّاد مباشرة
// بعد آخر دورة تحديث.
function useCountdownRemainingSeconds(
  sustainedMinutes: number | undefined,
  targetMinutes: number,
  asOfMs: number,
  onElapsed?: () => void
): number | null {
  // نبضة كل ثانية للعرض — نفس نبضة setInterval السابقة، الآن عبر useNow
  // (قيمة حالة، لا Date.now() مباشر أثناء الـrender).
  const now = useNow(1000);

  // جدولة استدعاء دقيق للحظة الصفر — منفصل عن نبضة العرض أعلاه. يُعاد
  // الجدولة كلما تغيّرت لقطة البيانات (sustainedMinutes/asOfMs جديدين بعد
  // كل تحديث من الخادم)، وتُلغى المهلة القديمة تلقائياً عبر cleanup — فلا
  // تراكم لعدة مؤقّتات لنفس النشاط.
  useEffect(() => {
    if (sustainedMinutes === undefined || !onElapsed) return;
    const elapsedSinceSnapshotSec = Math.max(0, (Date.now() - asOfMs) / 1000);
    const sustainedSecondsNow = sustainedMinutes * 60 + elapsedSinceSnapshotSec;
    const remainingMs = (targetMinutes * 60 - sustainedSecondsNow) * 1000;
    if (remainingMs <= 0) return; // انتهت المهلة أصلاً قبل وصول هذه اللقطة — لا داعي لجدولة ماضٍ
    const timeoutId = window.setTimeout(onElapsed, remainingMs);
    return () => window.clearTimeout(timeoutId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sustainedMinutes, targetMinutes, asOfMs]);

  if (sustainedMinutes === undefined) return null;
  const elapsedSinceSnapshotSec = Math.max(0, (now - asOfMs) / 1000);
  const sustainedSecondsNow = sustainedMinutes * 60 + elapsedSinceSnapshotSec;
  const remainingSec = targetMinutes * 60 - sustainedSecondsNow;
  return Math.max(0, Math.round(remainingSec));
}

// نفس منطق formatRelativeAr المستخدم في MultiIndicatorActivityBox.tsx —
// معرَّف محلياً هنا بنفس اتفاقية الملف (كل الدوال المساعدة محلية).
function formatAgeAr(diffMs: number): string {
  const mins = Math.round(Math.abs(diffMs) / 60000);
  if (mins < 60) return `${mins} دقيقة`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} ساعة`;
  const days = Math.round(hours / 24);
  return `${days} يوم`;
}

// تنبيه إعلامي بحت (لا يُغيّر أي قرار/AEI، نفس قيد buildAdvisoryTips أعلاه)
// يظهر فقط عندما يكون النشاط مرتبطاً فعلياً بمحطة رصد (deviceLastReadingAt
// !== undefined في evidence — راجع buildComplianceContext) وكانت آخر
// قراءة معروفة منها غائبة تماماً أو أقدم من عتبة الحداثة. بطلب صريح من
// المستخدم: "تظهر آخر قراءة معروفة حتى لو قديمة، مع تنبيه قدمها" — لا
// إخفاء صامت للبيانات، ولا رجوع لـAPI الطقس كبديل.
// خطأ مكتشَف ومُصلَح: كان التحذير يعتمد فقط على deviceLastReadingAt (آخر
// اتصال من المحطة على الإطلاق، لأي حقل). لأن هذا العمود يتحدّث على أي push
// جزئي من الجهاز (حتى لو حرارة فقط بلا PM10)، كان بإمكان قراءة PM10 قديمة
// فعلياً أن تظهر "حديثة" زوراً لمجرد أن الجهاز أرسل حقلاً آخر مؤخراً.
// devicePm10LastReadingAt (اختياري، undefined = بيانات قديمة قبل هذا
// الإصلاح أو استدعاء لا يمرّره) يُستخدَم كمرجع الحداثة الفعلي لتحذير PM10
// تحديداً عند توفره؛ deviceLastReadingAt يبقى المرجع لتحذير "لا اتصال
// إطلاقاً" (محطة لم ترسل أي شيء قط).
function buildStalenessAdvisory(
  deviceLastReadingAt: string | null | undefined,
  devicePm10LastReadingAt?: string | null
): AdvisoryTip | null {
  if (deviceLastReadingAt === undefined) return null; // لا ربط جهاز أصلاً لهذا النشاط

  if (deviceLastReadingAt === null) {
    return {
      titleAr: 'تنبيه إعلامي: لا توجد أي قراءة من محطة الرصد المختارة بعد',
      tipsAr: ['تأكد من أن المحطة مفعَّلة ومتصلة فعلياً، أو راجع إعدادات ربطها بالمشروع.'],
    };
  }

  // مرجع الحداثة الفعلي: قراءة PM10 تحديداً إن توفّر تاريخها (devicePm10LastReadingAt
  // !== undefined)، وإلا نرجع لـdeviceLastReadingAt العام (سلوك قديم/توافقي).
  const referenceReadingAt = devicePm10LastReadingAt !== undefined ? devicePm10LastReadingAt : deviceLastReadingAt;
  if (referenceReadingAt === null) {
    return {
      titleAr: 'تنبيه إعلامي: لم تُرسِل محطة الرصد قراءة PM10 بعد',
      tipsAr: ['المحطة متصلة لكن لم تصل منها قراءة PM10 حتى الآن — تحقّق من مستشعر PM10 بالجهاز.'],
    };
  }

  const ageMs = Date.now() - new Date(referenceReadingAt).getTime();
  const ageMinutes = ageMs / 60000;
  if (ageMinutes <= DEVICE_READING_STALENESS_MINUTES) return null;

  return {
    titleAr: `تنبيه إعلامي: آخر قراءة من محطة الرصد قديمة (منذ ${formatAgeAr(ageMs)})`,
    tipsAr: ['القراءات المعروضة هنا هي آخر ما أرسلته المحطة، وليست حية الآن — تحقّق من اتصال المحطة إن استمر التأخر.'],
  };
}

// دالة تحويل الساعات إلى نصوص عربية منسقة
const formatHoursLabel = (hours: number | undefined): string => {
  if (hours === undefined || hours === null) return '';
  if (hours === 1) return 'ساعة واحدة';
  if (hours === 2) return 'ساعتان';
  if (hours >= 3 && hours <= 10) return `${hours} ساعات`;
  return `${hours} ساعة`;
};

// يحوّل اتجاه الرياح بالدرجات (0-360) إلى بوصلة نصية عربية من 8 اتجاهات
const WIND_DIRECTION_LABELS_AR = [
  'شمالي', 'شمالي شرقي', 'شرقي', 'جنوبي شرقي',
  'جنوبي', 'جنوبي غربي', 'غربي', 'شمالي غربي',
];

function formatWindDirectionAr(deg: number | null): string {
  if (deg === null || deg === undefined || Number.isNaN(deg)) return '—';
  const normalized = ((deg % 360) + 360) % 360;
  const index = Math.round(normalized / 45) % 8;
  return WIND_DIRECTION_LABELS_AR[index];
}

const HOUR_LABEL_AR = (iso: string) =>
  new Date(iso).toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Riyadh' });

const getAeiStyle = (color: AeiColor) => {
  switch (color) {
    case 'GREEN': return { bg: 'bg-emerald-50', border: 'border-emerald-200', text: 'text-emerald-700', dot: 'bg-emerald-500' };
    case 'YELLOW': return { bg: 'bg-amber-50', border: 'border-amber-200', text: 'text-amber-700', dot: 'bg-amber-500' };
    case 'ORANGE': return { bg: 'bg-orange-50', border: 'border-orange-200', text: 'text-orange-700', dot: 'bg-orange-500' };
    // كانت RED غائبة من هذا التبديل رغم وجودها فعلياً في AeiColor
    // ومُنتَجة من AEI_COLOR_FROM_STATUS (RESTRICT → RED) — فكانت تسقط
    // لـ default الرمادي المحايد بدل الأحمر الفعلي، فيظهر تقييد/تعليق
    // شديد بلون باهت لا يعكس خطورته الحقيقية.
    case 'RED': return { bg: 'bg-red-50', border: 'border-red-200', text: 'text-red-700', dot: 'bg-red-600' };
    case 'BLACK': return { bg: 'bg-slate-900/5', border: 'border-slate-700', text: 'text-slate-800', dot: 'bg-slate-800' };
    default: return { bg: 'bg-slate-50', border: 'border-slate-200', text: 'text-slate-700', dot: 'bg-slate-400' };
  }
};

const EXTENDED_ACTIVITY_LABEL: Record<string, string> = {
  'COATING': 'أعمال طلاء وعزل', 'ROAD_WORKS': 'أعمال طرق ومسارات', 'WELDING': 'أعمال لحام',
  'SCAFFOLDING': 'أعمال سقالات', 'CRANE_LIFTING': 'عمليات رفع', 'CONCRETE_POURING': 'صب خرسانة',
  'ASPHALT_PAVING': 'سفلتة', 'EXCAVATION': 'حفر وردم', 'GRADING': 'أعمال ترابية',
  'WORK_AT_HEIGHT': 'أعمال على ارتفاع', 'GENERAL_OUTDOOR_WORK': 'أعمال خارجية عامة',
  'EXTERNAL_PAINTING': 'دهانات وعزل خارجي', 'MATERIAL_TRANSPORT': 'نقل مواد',
  'HEAVY_EQUIPMENT_MOVEMENT': 'حركة معدات ثقيلة', 'MEP_EXTERNAL_WORK': 'أعمال ميكانيكية/كهربائية'
};

export default function ComplianceWidgetCard({
  activityType,
  complianceList,
  complianceHourly,
  aei,
  nearbySensitiveReceptors,
  unitReceptors,
  projectId,
  activityId,
  activityGroupId,
  projectName,
  hideSchedule = false,
  windowStartIso,
  windowEndIso,
  durationHours,
  onCountdownElapsed,
}: ComplianceWidgetCardProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [activeAlert, setActiveAlert] = useState<Record<string, unknown> | null>(null);
  // خطأ سلامة حرج مكتشَف ومُصلَح (طلب صريح من المستخدم — "أخطاء الشبكة
  // تتحول غالباً إلى أرقام صفرية أو حالات فارغة مضللة"): fetchInitialData
  // أدناه كانت بلا try/catch إطلاقاً — فشل شبكة (لا اتصال، مهلة، 500) كان
  // يعني activeAlert يبقى null بصمت تامة، فيختفي شريط "تنبيه أمني نشط"
  // الأحمر (سطر ~630) تماماً كأن لا تنبيه موجود، بلا أي أثر حتى في الكونسول
  // (unhandled promise rejection فقط). alertFetchFailed يميّز الآن صراحة
  // "تحقّقنا ولا يوجد تنبيه" عن "فشل التحقق نفسه" — الحالة الثانية تستحق
  // تحذيراً بصرياً مستقلاً، لا اختفاءً صامتاً، لأنها مؤشر سلامة/امتثال.
  const [alertFetchFailed, setAlertFetchFailed] = useState(false);
  // "الآن" يتحدّث كل دقيقة — يكفي لحالات "منتهٍ؟"/"جهاز متوقف؟" أدناه (ليست
  // عدّاداً تنازلياً بدقة الثانية كـuseCountdownRemainingSeconds أعلاه).
  const now = useNow(60000);

  const complianceEntries = (complianceList ?? []).filter(Boolean);
  const worst = pickWorstCompliance(complianceEntries);
  // نشاط انتهت نافذته الزمنية فعلياً (windowEndIso في الماضي) — لا يجوز عرض
  // قرار حي (AEI/امتثال) أو عدّادات تنازلية أو تنبيهات مبنية على طقس هذه
  // اللحظة لنشاط منتهٍ منذ دقائق/ساعات. نفس مفهوم scheduleInfo.status==='past'
  // في MultiIndicatorActivityBox (البطاقة الأم)، محسوب محلياً هنا لأن هذا
  // المكوّن لا يستقبل ذلك الكائن جاهزاً.
  const isEnded = Boolean(windowEndIso && new Date(windowEndIso).getTime() < now);
  // مؤشر AEI هو القرار الموحّد المعروض فعلياً في كل أنحاء البطاقة (العنوان،
  // اللون، البطاقة المطوية، شبكة الساعات) — قرار الامتثال (worst) يبقى
  // مصدر البيانات الداعمة (القواعد/الإجراءات/الأدلة) فقط، وليس عنواناً
  // منافساً. AEI مضمون توفره عملياً (يُمرَّر من الأب دائماً)، لكن نتوقّع
  // غيابه نظرياً فنستخدم أسلوب امتثال محايد كـ fallback أخير فقط.
  const aeiStyle = aei ? getAeiStyle(aei.color) : null;
  const endedStyle = { bg: 'bg-slate-50', border: 'border-slate-200', text: 'text-slate-500', dot: 'bg-slate-400' };
  const style = isEnded ? endedStyle : aeiStyle ?? (worst ? COMPLIANCE_DECISION_STYLE[worst.decisionCategory] : COMPLIANCE_DECISION_STYLE.ALLOW);
  const hourlyEntries = (complianceHourly ?? []).filter((h) => !!h?.result);

  // العنوان الفرعي = النشاط التنظيمي المختار فعلياً (كسارة/هدم/...) من قرار
  // الامتثال، لا التصنيف الفيزيائي العام (حركة معدات ثقيلة). نجمع كل الأنشطة
  // التنظيمية المميّزة في البطاقة (قد تضم أكثر من واحد) ونرجع للفيزيائي فقط
  // إن غابت كلها.
  const physicalActivityLabel = (ACTIVITY_LABEL_AR as Record<string, string>)[activityType] ?? EXTENDED_ACTIVITY_LABEL[activityType] ?? activityType;
  const regulatoryLabels = Array.from(
    new Set(
      complianceEntries
        .map((c) => c.regulatoryActivityLabelAr)
        .filter((l): l is string => !!l && l !== 'نشاط غبار عام')
    )
  );
  const activityLabel = regulatoryLabels.length > 0 ? regulatoryLabels.join(' + ') : physicalActivityLabel;

  // لحظة حساب الخادم الفعلية لـsustainedMinutes أعلاه — لا Date.now() محلي.
  //
  // خطأ مكتشَف ومُصلَح (مراجعة مستخدم — "ليش التايمر ينعاد إذا سويت تحديث
  // للصفحة"): كانت هذه اللحظة تُشتق من useMemo(() => Date.now(), ...) —
  // أي "وقت أول عرض للمكوّن في المتصفح"، لا وقت حساب الخادم الفعلي. أثناء
  // التحديث الدوري (polling) الفارق ضئيل فيمر بلا ملاحظة، لكن عند إعادة
  // تحميل الصفحة يدوياً (المكوّن يُعاد بناؤه بالكامل، فوقت "أول عرض" يصبح
  // وقت اكتمال تحميل الصفحة في المتصفح — قد يتأخر ثوانٍ عن حساب الخادم
  // الفعلي)، يظهر العدّاد وكأنه أعاد ضبط نفسه رغم أن الاستمرار الفعلي على
  // الخادم لم ينقطع. worst.evaluatedAt (من dust-compliance-engine/engine.ts)
  // هو المرجع الصحيح دائماً — نفس اللحظة بصرف النظر عن توقيت عرضه بالمتصفح.
  const sustained340 = worst?.pm10SustainedMinutesAbove340;
  const sustained250 = worst?.pm10SustainedMinutesAbove250;
  const snapshotAtMs = worst?.evaluatedAt ? new Date(worst.evaluatedAt).getTime() : now;

  // خطأ مكتشَف ومُصلَح (مراجعة كود خبير خارجي — "إعفاء محطة الخلط مخالف
  // للمرجع"): كان pm10RulesExempt (محطة خلط بصوامع مغلقة + فلتر ≥99%) يُخفي
  // عدّادات PM10 كلياً هنا بحجة أن الخادم "لن يعلّقها بسبب PM10 أبداً" — لكن
  // ذلك الإعفاء الخلفي نفسه كان توسيعاً غير موثَّق تنظيمياً (راجع
  // pm10ThresholdRule في rulebook.ts)، فحُذف من engine.ts. محطة الخلط تخضع
  // الآن لقواعد PM10 كأي نشاط آخر، فحقل pm10RulesExempt لم يعد موجوداً على
  // DustComplianceResult — العدّادان يُبنيان بلا أي استثناء خاص بمحطة الخلط.

  // خطأ مكتشَف ومُصلَح (طلب صريح من المستخدم — "التايمر موجود والقراءات
  // موجودة، أصلح أيضاً"): worst هنا هو DustComplianceResult، محسوب بمعزل
  // تام عن decideFinal/aei.isHoldForVerification — لا يعرف أصلاً أن غياب
  // جهاز الرصد يجعل worst.evidence.pm10UgM3 (وكل عدّاد مبني عليه) تقديرَ
  // طقس (Open-Meteo) لا قراءة جهاز حقيقية. بلا هذا الفحص، عدّادا "متبقٍ
  // حتى..." يستمران بالظهور بثقة كاملة رغم أن البانر الموحَّد أعلاهما يعرض
  // "بانتظار تحقق ميداني" لنفس اللحظة — تناقض مباشر. aei.isHoldForVerification
  // (راجع applyFinalDecisionToAei في dustEvaluation.ts) هو الإشارة الموثوقة
  // الوحيدة هنا، لا إعادة اشتقاق شرط "هل يوجد جهاز؟" محلياً في هذا المكوّن.
  const isAwaitingVerification = aei?.isHoldForVerification === true;

  // خطأ مكتشَف ومُصلَح (مراجعة مستخدم — "هل هذا منطقي؟" حول تعليق الجهاز
  // لدقائق قليلة أثناء pendingConfirmation): بين لحظة توقف الجهاز عن
  // الإرسال ولحظة تصنيف evidenceQuality=STALE فعلياً (10 دقائق، راجع
  // DEVICE_READING_STALENESS_MINUTES/isAwaitingVerification أعلاه)، توجد
  // فجوة (4-10 دقائق) يبقى فيها pendingConfirmation=true من الخادم (آخر
  // قراءة معروفة لا تزال ضمن نافذة "حديثة" حسب isLatestReadingFresh هناك)
  // لكن بلا أي قراءة جديدة تصل فعلياً — العدّاد كان يستمر بالعد التنازلي
  // بثقة كاملة موحياً بأن التأكيد "يتقدم" رغم أن الجهاز متوقف فعلياً ولن
  // تصل قراءة جديدة تثبت الاستمرار. isDeviceStalledDuringPending يميّز هذه
  // الحالة تحديداً: قراءة PM10 الأخيرة أقدم من عتبة الحداثة نفسها التي
  // يعتمدها الخادم (PM10_LAST_READING_FRESHNESS_MINUTES) لكن لم تصل بعد لحد
  // STALE الكامل — نطاق ضيق لكنه حقيقي.
  const devicePm10LastReadingAt = worst?.evidence?.devicePm10LastReadingAt;
  // طلب صريح من المستخدم (عكس القرار السابق الموثَّق في buildStalenessAdvisory
  // أدناه — "تظهر آخر قراءة معروفة حتى لو قديمة"): رقم PM10 في شبكة الحقول
  // يُخفى (يعرض "—") تماماً مثل بقية الحقول عندما تكون آخر قراءة فعلية أقدم
  // من عتبة الحداثة، بدل إبقاء رقم قديم ظاهراً بلا أي إشارة بصرية في مكانه.
  // هذا لا يمس أي منطق قرار (evidenceUnavailable في final-decision-engine
  // يتجاهل القراءة القديمة أصلاً) ولا نص buildStalenessAdvisory التوضيحي —
  // تغيير عرض بحت لقيمة الحقل نفسها فقط.
  const isPm10ReadingStaleForDisplay =
    devicePm10LastReadingAt !== undefined &&
    devicePm10LastReadingAt !== null &&
    (now - new Date(devicePm10LastReadingAt).getTime()) / 60000 > PM10_LAST_READING_FRESHNESS_MINUTES;
  const isDeviceStalledDuringPending =
    !isEnded &&
    !isAwaitingVerification &&
    worst?.pendingConfirmation === true &&
    devicePm10LastReadingAt !== undefined &&
    devicePm10LastReadingAt !== null &&
    (now - new Date(devicePm10LastReadingAt).getTime()) / 60000 > PM10_LAST_READING_FRESHNESS_MINUTES;

  // عدّاد "متبقٍ حتى تتأكد المخالفة" — يظهر فقط أثناء pendingConfirmation
  // (القراءة ≥340 لكن لم تستمر بعد دقيقتين) وطالما لا يزال الجهاز يرسل
  // قراءات حديثة فعلياً (لا isDeviceStalledDuringPending). onElapsed يطلب
  // إعادة تقييم فورية من الخادم بالضبط عند انتهاء المهلة (لا انتظار دورة
  // polling التالية)، فينعكس القرار الفعلي (مؤكَّد أو ALLOW) في أقرب وقت ممكن.
  // القيمة المُرجَعة (ثوانٍ متبقية) غير مُستخدَمة للعرض هنا — الاستدعاء
  // ضروري فقط لأثره الجانبي (onCountdownElapsed عند انتهاء المهلة).
  useCountdownRemainingSeconds(
    !isEnded && !isAwaitingVerification && !isDeviceStalledDuringPending && worst?.pendingConfirmation
      ? sustained340
      : undefined,
    PM10_VIOLATION_CONFIRM_MINUTES,
    snapshotAtMs,
    onCountdownElapsed
  );

  // عدّاد "متبقٍ حتى تعليق النشاط" — يظهر عندما تكون القراءة ≥250 مستمرة
  // (استمرار فعلي مسجَّل) لكن لم تصل بعد 30 دقيقة، والقرار الحالي ليس
  // إيقافاً/تعليقاً مؤكَّداً أصلاً (لا فائدة من عدّاد لحالة موقوفة بالفعل).
  //
  // خطأ معماري مكتشَف ومُصلَح (مراجعة كود خبير خارجي — H-01: "Rulebook ما
  // زال يصدر القرار"): كان الفحص يعتمد حصراً على worst.decisionCategory
  // الخام (نتيجة Rulebook الوسيطة) بدل القرار النهائي المُجمَّع (FinalDecision،
  // عبر aei.closedByGate الذي يعكس FinalDecision.mandatoryStop فعلياً —
  // راجع applyFinalDecisionToAei في dustEvaluation.ts). aei "مضمون توفره
  // عملياً" هنا (نفس افتراض aeiStyle أعلاه)، فيبقى fallback على
  // worst?.decisionCategory فقط لحالة نظرية غير متوقعة (aei غائب).
  const alreadyStopped = aei
    ? aei.closedByGate
    : worst?.decisionCategory === 'STOP_AFFECTED_ACTIVITY' || worst?.decisionCategory === 'MANDATORY_STOP';
  // طلب صريح من المستخدم: بعد أن يتجاوز التعليق (pendingConfirmation) مهلة
  // التأكيد (أكثر من دقيقتين متتاليتين ≥340)، يُعرَض تنبيه صريح "تم تسجيل
  // مخالفة" بدل اختفاء البانر الأحمر بصمت لصالح نص القرار العادي فقط —
  // PM10-VIOLATION-STOP-006 (راجع rulebook.ts) هو الكود الوحيد الذي يفوز به
  // decidingRuleCode تحديداً بعد اكتمال isConfirmedViolation340، فيميّز هذه
  // الحالة بدقة عن أي إيقاف إلزامي آخر مصدره قاعدة مختلفة (رياح/رؤية...).
  const isConfirmedViolationNow = !isEnded && worst?.decidingRuleCode === 'PM10-VIOLATION-STOP-006';
  // خطأ مكتشَف ومُصلَح (مراجعة مستخدم — "تناقض": عدّاد "تعليق 250" كان يظهر
  // حتى عندما تكون القراءة أصلاً معلَّقة بانتظار تأكيد حد المخالفة الأشد
  // (340، worst.pendingConfirmation=true عبر MRQ-PM10-BLACK-PENDING-104) —
  // alreadyStopped وحدها لا تلتقط هذه الحالة (لم يتأكَّد الإيقاف الإلزامي
  // بعد، فقط معلَّق). النتيجة: عدّادان متزامنان لعتبتين مختلفتين (250 و340)
  // لنفس القراءة، فيظن المستخدم أن العتبة الحرجة القادمة هي 250 (أضعف) بينما
  // القراءة أصلاً تجاوزت 340 (الأشد) وتنتظر تأكيدها الخاص. الإصلاح: استبعاد
  // عدّاد 250 أيضاً أثناء pendingConfirmation نشطة — عدّاد 340 الأشد يبقى
  // وحده الظاهر حينها (نفس مبدأ useCountdownRemainingSeconds الأول أعلاه).
  const showSuspensionCountdown =
    !isEnded &&
    !isAwaitingVerification &&
    !!worst &&
    !alreadyStopped &&
    worst.pendingConfirmation !== true &&
    worst.evidence.pm10UgM3 !== null &&
    worst.evidence.pm10UgM3 >= 250 &&
    sustained250 !== undefined &&
    sustained250 < PM10_SUSPENSION_MINUTES;
  // نفس مبدأ الاستدعاء أعلاه — القيمة المُرجَعة غير مُستخدَمة للعرض هنا.
  useCountdownRemainingSeconds(
    showSuspensionCountdown ? sustained250 : undefined,
    PM10_SUSPENSION_MINUTES,
    snapshotAtMs,
    onCountdownElapsed
  );

  // تنبيهات إعلامية (رؤية ضعيفة/حرارة مرتفعة) — إعلامية بحتة، لا تؤثر في
  // worst.decisionCategory أو aei إطلاقاً. راجع buildAdvisoryTips أعلاه.
  const advisoryTips = worst
    ? buildAdvisoryTips(worst.evidence.visibilityM, worst.evidence.temperatureC)
    : [];
  // تنبيه قِدم قراءة محطة الرصد (راجع buildStalenessAdvisory أعلاه) —
  // إعلامي بحت أيضاً، يُدمَج مع advisoryTips لعرضه بنفس النمط والمكان.
  const stalenessAdvisory = worst
    ? buildStalenessAdvisory(worst.evidence.deviceLastReadingAt, worst.evidence.devicePm10LastReadingAt)
    : null;
  const allAdvisoryTips = isEnded ? [] : stalenessAdvisory ? [stalenessAdvisory, ...advisoryTips] : advisoryTips;

  useEffect(() => {
    let cancelled = false;
    async function fetchInitialData() {
      if (!projectId || !activityId) return;

      try {
        // DCR: activity_source مقيَّد بـ CHECK على 'dust' فقط (لا 'dust_compliance'
        // منفصلة كما في مرقاب) — راجع supabase-dcr-full-schema.sql وapp/api/
        // alerts/generate/route.ts. بطاقة DVI الفيزيائية (Dustwidgetcard) مخفاة
        // فعلياً في واجهة DCR فلا يوجد تعارض عملي على نفس activityId.
        const { data: alertResp } = await apiClient.get('/alerts', {
          params: { projectId, activityId, activitySource: 'dust' },
        });
        if (cancelled) return;
        const alertData = alertResp?.data;
        if (alertData && alertData.length > 0) setActiveAlert(alertData[0]);
        setAlertFetchFailed(false);
      } catch (error) {
        if (cancelled) return;
        console.error('Compliancewidgetcard: فشل جلب التنبيه النشط:', error);
        setAlertFetchFailed(true);
        toast.error('تعذّر التحقق من وجود تنبيه أمني نشط لهذا النشاط — تحقّق من الاتصال وأعد المحاولة.');
      }
    }
    fetchInitialData();
    return () => {
      cancelled = true;
    };
  }, [projectId, activityId]);

  if (!worst) return null;

  return (
    <>
      <div className="bg-white rounded-[24px] border border-slate-200 shadow-sm hover:shadow-md transition-all duration-300 flex flex-col overflow-hidden relative">
        <div className={`absolute top-0 left-0 w-full h-1 ${style.dot}`}></div>

        {!isEnded && activeAlert && (
          <div className="bg-red-500 text-white text-[10px] font-black px-4 py-1.5 flex items-center gap-2 animate-pulse">
            <ShieldAlert className="w-3.5 h-3.5" />
            يوجد تنبيه أمني نشط لهذا النشاط يرجى المراجعة!
          </div>
        )}

        {/* راجع تعليق alertFetchFailed أعلى المكوّن — تحذير باقٍ (لا toast
            مؤقت فقط) لأن هذا مؤشر سلامة/امتثال: "لا نعرف" يجب ألا يبدو
            بصرياً كـ"لا يوجد تنبيه". */}
        {!isEnded && alertFetchFailed && (
          <div className="bg-amber-500 text-white text-[10px] font-black px-4 py-1.5 flex items-center gap-2">
            <AlertTriangle className="w-3.5 h-3.5" />
            تعذّر التحقق من وجود تنبيه أمني نشط — قد تكون هناك حالة غير معروضة، تحقّق من الاتصال
          </div>
        )}

        <div className="p-5 pb-4 border-b border-slate-100 bg-slate-50/50 flex justify-between items-start">
          <div className="flex items-center gap-3">
            <div className={`w-11 h-11 rounded-2xl ${style.bg} border ${style.border} flex items-center justify-center shrink-0`}>
              <Gauge className={`w-5 h-5 ${style.text}`} strokeWidth={2} />
            </div>
            <div>
              <h3 className="font-black text-[#061B40] text-[15px]">مؤشر قابلية التنفيذ (AEI)</h3>
              <p className="text-[11px] font-bold text-slate-400">{activityLabel}</p>
              {!hideSchedule && windowStartIso && windowEndIso && (
                <>
                  <p className="text-[10px] font-bold text-slate-400 flex items-center gap-1 mt-0.5" dir="ltr">
                    <Clock className="w-3 h-3" />
                    <span dir="rtl">
                      {new Date(windowStartIso).toLocaleDateString('ar-SA', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Riyadh', calendar: 'gregory' })}
                      {' '}
                      {new Date(windowStartIso).toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Riyadh', calendar: 'gregory' })}
                      {' ← '}
                      {new Date(windowEndIso).toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Riyadh', calendar: 'gregory' })}
                      {durationHours ? ` (${formatHoursLabel(durationHours)})` : ''}
                    </span>
                  </p>
                </>
              )}
            </div>
          </div>
        </div>

        <div className="p-5 flex-1 flex flex-col">
          <div className="flex items-start justify-between mb-5 gap-3">
            <div className="w-full">
              <div className="flex items-baseline gap-2 mb-1.5">
                <span className={`text-2xl font-black leading-none ${style.text}`}>
                  {isEnded ? 'انتهى النشاط' : aei ? aei.statusLabelAr : worst.decisionLabelAr}
                </span>
              </div>
              <p className="text-[11px] font-bold text-slate-600 leading-relaxed">
                {isEnded
                  ? 'انقضت نافذة تنفيذ هذا النشاط — لا يوجد قرار تشغيلي حالي بشأنه.'
                  : aei ? aei.shortReasonAr : worst.shortReasonAr}
              </p>
              {complianceEntries.length > 1 && (
                <span className="inline-block mt-2 text-[10px] font-bold px-2 py-0.5 rounded-full bg-slate-50 border border-slate-200 text-slate-500">
                  محسوب من أسوأ حالة بين {complianceEntries.length} أنشطة تنظيمية
                </span>
              )}
            </div>
          </div>

          {/* خطأ مكتشَف ومُصلَح (طلب صريح من المستخدم — "اخفي التايمر لان
              المستخدم اذا سوا تحديث للصفحه راح ينعاد من اول"): العدّاد
              التنازلي كان يعتمد على asOfMs (لحظة مرجعية) وsustainedMinutes
              (لقطة من الخادم) معاً لحساب "المتبقي" محلياً في المتصفح — حتى
              بعد ربط asOfMs بـworst.evaluatedAt (وقت حساب الخادم الفعلي)،
              ظل عرض عدّاد دقيق بالثانية عرضة لأي تفاوت توقيت بين لحظة تحديث
              الصفحة ولحظة حساب الخادم، فيظهر للمستخدم وكأن الوقت "أعيد من
              الأول" بينما الاستمرار الفعلي مستمر بلا انقطاع خلفياً. الحل:
              استبدال العدّاد الدقيق بنص ثابت لا يعتمد على أي حساب توقيت
              محلي — يخبر المستخدم أن هناك مراقبة استمرار جارية دون الإدعاء
              برقم دقائق/ثوانٍ متبقية قد يتناقض ظاهرياً مع نفسه بين تحديثين.
              القرار الفعلي (معلَّق/مؤكَّد) يبقى محسوباً بدقة كاملة في الخادم
              كما هو، هذا يمس نص العرض فقط. */}
          {isDeviceStalledDuringPending && (
            <div className="flex items-center gap-2 rounded-xl border border-orange-200 bg-orange-50 px-3 py-2 mb-4">
              <Timer className="w-4 h-4 text-orange-600 shrink-0" />
              <span className="text-[11px] font-bold text-orange-700">
                الجهاز لم يرسل قراءة جديدة منذ فترة — تأكيد المخالفة متوقف مؤقتاً بانتظار وصول قراءة حديثة
              </span>
            </div>
          )}
          {!isDeviceStalledDuringPending && worst?.pendingConfirmation && (
            <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 mb-4">
              <Timer className="w-4 h-4 text-red-600 shrink-0" />
              <span className="text-[11px] font-bold text-red-700">
                جارٍ التحقق من استمرار التجاوز — إن استمر التجاوز لأكثر من دقيقتين متتاليتين سيُسجَّل مخالفة تنظيمية مؤكَّدة (إيقاف إلزامي)، وإلا ستعود الحالة آمنة تلقائياً
              </span>
            </div>
          )}
          {!worst?.pendingConfirmation && isConfirmedViolationNow && (
            <div className="flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-900/5 px-3 py-2 mb-4">
              <Timer className="w-4 h-4 text-slate-800 shrink-0" />
              <span className="text-[11px] font-bold text-slate-800">
                تم تسجيل مخالفة تنظيمية مؤكَّدة — استمر التجاوز لأكثر من دقيقتين متتاليتين
              </span>
            </div>
          )}
          {!worst?.pendingConfirmation && showSuspensionCountdown && (
            <div className="flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 mb-4">
              <Timer className="w-4 h-4 text-amber-600 shrink-0" />
              <span className="text-[11px] font-bold text-amber-700">
                جارٍ مراقبة استمرار التجاوز (250 ميكروجرام/م³ فأكثر) — سيُعلَّق النشاط تلقائياً إن استمر التجاوز
              </span>
            </div>
          )}

          <div className="grid grid-cols-3 sm:grid-cols-7 gap-2 mb-4">
            <div className="flex flex-col items-center justify-center p-2.5 rounded-xl bg-slate-50 border border-slate-100 text-center">
              <Eye className="w-4 h-4 text-teal-500 mb-1.5" />
              <span className="text-xs font-black text-slate-800" dir="ltr">
                {worst.evidence.visibilityM !== null ? Math.round(worst.evidence.visibilityM) : '—'}
              </span>
              <span className="text-[8px] font-bold text-slate-400">الرؤية م</span>
            </div>
            <div className="flex flex-col items-center justify-center p-2.5 rounded-xl bg-slate-50 border border-slate-100 text-center">
              <Wind className="w-4 h-4 text-rose-500 mb-1.5" />
              <span className="text-xs font-black text-slate-800" dir="ltr">
                {fmt2(worst.evidence.windSpeedKmh)}
              </span>
              <span className="text-[8px] font-bold text-slate-400">رياح كم/س</span>
            </div>
            <div className="flex flex-col items-center justify-center p-2.5 rounded-xl bg-slate-50 border border-slate-100 text-center">
              <Compass className="w-4 h-4 text-indigo-400 mb-1.5" />
              <span className="text-xs font-black text-slate-800">
                {formatWindDirectionAr(worst.evidence.windDirectionDeg)}
              </span>
              <span className="text-[8px] font-bold text-slate-400">اتجاه الرياح</span>
            </div>
            <div className="flex flex-col items-center justify-center p-2.5 rounded-xl bg-slate-50 border border-slate-100 text-center">
              <Gauge className="w-4 h-4 text-violet-500 mb-1.5" />
              <span className="text-xs font-black text-slate-800" dir="ltr">
                {isPm10ReadingStaleForDisplay ? '—' : fmt2(worst.evidence.pm10UgM3)}
              </span>
              <span className="text-[8px] font-bold text-slate-400">PM10</span>
            </div>
            <div className="flex flex-col items-center justify-center p-2.5 rounded-xl bg-slate-50 border border-slate-100 text-center">
              <CircleGauge className="w-4 h-4 text-sky-500 mb-1.5" />
              <span className="text-xs font-black text-slate-800" dir="ltr">
                {fmt2(worst.evidence.pm25UgM3)}
              </span>
              <span className="text-[8px] font-bold text-slate-400">PM2.5</span>
            </div>
            <div className="flex flex-col items-center justify-center p-2.5 rounded-xl bg-slate-50 border border-slate-100 text-center">
              <Droplets className="w-4 h-4 text-cyan-500 mb-1.5" />
              <span className="text-xs font-black text-slate-800" dir="ltr">
                {fmt2(worst.evidence.relativeHumidityPercent)}%
              </span>
              <span className="text-[8px] font-bold text-slate-400">الرطوبة</span>
            </div>
            <div className="flex flex-col items-center justify-center p-2.5 rounded-xl bg-slate-50 border border-slate-100 text-center">
              <Thermometer className="w-4 h-4 text-orange-500 mb-1.5" />
              <span className="text-xs font-black text-slate-800" dir="ltr">
                {fmt2(worst.evidence.temperatureC)}°م
              </span>
              <span className="text-[8px] font-bold text-slate-400">الحرارة</span>
            </div>
          </div>

          {worst.caveatsAr && worst.caveatsAr.length > 0 && (
            <div className="space-y-1.5 mb-4">
              {worst.caveatsAr.map((c, i) => (
                <div
                  key={i}
                  className="flex items-start gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[10px] font-bold text-amber-700 leading-relaxed"
                >
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  <span>{c}</span>
                </div>
              ))}
            </div>
          )}

          {allAdvisoryTips.length > 0 && (
            <div className="space-y-1.5 mb-4">
              {allAdvisoryTips.map((tip, i) => (
                <div
                  key={i}
                  className="rounded-lg border border-sky-200 bg-sky-50 px-2.5 py-1.5 text-[10px] font-bold text-sky-700 leading-relaxed"
                >
                  <div className="flex items-center gap-1.5">
                    <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                    <span>{tip.titleAr}</span>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="flex items-center gap-2 mt-auto flex-wrap">
            <span className="text-[10px] font-bold px-2 py-1 rounded-lg bg-slate-50 border border-slate-200 text-slate-500">
              درجة الثقة: {worst.confidenceScore} · {worst.confidenceLabelAr}
            </span>
            {!isEnded && aei?.closedByGate && (
              <span className="text-[10px] font-bold px-2 py-1 rounded-lg bg-slate-900/5 border border-slate-700 text-slate-800">
                إيقاف إلزامي
              </span>
            )}
          </div>
        </div>

        {!isEnded && (
          <div className="p-4 pt-0 mt-auto">
            <button
              onClick={() => setIsOpen(true)}
              className="w-full bg-white border border-slate-200 hover:border-[#3995FF] hover:bg-blue-50 text-slate-600 hover:text-[#0176FB] text-[13px] font-bold py-2.5 rounded-xl transition-all flex items-center justify-center gap-2"
            >
              عرض التفاصيل الكاملة واتخاذ القرار <ArrowUpRight className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>

      {/* ======================= MODAL ======================= */}
      {isOpen && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
          onClick={() => setIsOpen(false)}
        >
          <div
            className="bg-[#F4F7FB] w-full max-w-4xl max-h-[90vh] flex flex-col rounded-[28px] shadow-2xl overflow-hidden relative"
            onClick={(e) => e.stopPropagation()}
            dir="rtl"
          >
            <div className="bg-white border-b border-slate-200 p-5 flex items-center justify-between shrink-0">
              <div className="flex items-center gap-3">
                <div className={`w-10 h-10 rounded-xl ${style.bg} border ${style.border} flex items-center justify-center`}>
                  <Gauge className={`w-5 h-5 ${style.text}`} />
                </div>
                <div>
                  <h2 className="font-black text-[#061B40] text-lg">تفاصيل مؤشر قابلية التنفيذ (AEI)</h2>
                  <p className="text-[11px] font-bold text-slate-400">{activityLabel} {projectName ? `- ${projectName}` : ''}</p>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={() => window.print()}
                  className="bg-slate-50 hover:bg-slate-100 text-slate-500 p-2 rounded-xl transition-colors hidden sm:flex items-center gap-2"
                  title="طباعة التقرير"
                >
                  <Printer className="w-5 h-5" />
                  <span className="text-xs font-bold">تصدير</span>
                </button>
                <button onClick={() => setIsOpen(false)} className="bg-slate-50 hover:bg-slate-100 text-slate-500 p-2 rounded-xl transition-colors">
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            <div className="p-6 space-y-6 flex-1 min-h-0 overflow-y-auto">

              <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm">
                <h3 className="text-sm font-black text-[#061B40] mb-4 flex items-center gap-2">
                  <Wind className="w-4 h-4 text-sky-500" /> الطقس المرجعي للقرار
                </h3>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                  <div className="bg-slate-50 rounded-lg p-3 border border-slate-100">
                    <div className="text-xs text-slate-400">سرعة الرياح</div>
                    <div className="font-bold text-[#061B40]" dir="ltr">{fmt2(worst.evidence.windSpeedKmh)} كم/س</div>
                  </div>
                  <div className="bg-slate-50 rounded-lg p-3 border border-slate-100">
                    <div className="text-xs text-slate-400">هبات الرياح</div>
                    <div className="font-bold text-[#061B40]" dir="ltr">{fmt2(worst.evidence.windGustKmh)} كم/س</div>
                  </div>
                  <div className="bg-slate-50 rounded-lg p-3 border border-slate-100">
                    <div className="text-xs text-slate-400">اتجاه الرياح</div>
                    <div className="font-bold text-[#061B40]">{formatWindDirectionAr(worst.evidence.windDirectionDeg)}</div>
                  </div>
                  <div className="bg-slate-50 rounded-lg p-3 border border-slate-100">
                    <div className="text-xs text-slate-400">PM10 / PM2.5</div>
                    <div className="font-bold text-[#061B40]" dir="ltr">
                      {isPm10ReadingStaleForDisplay ? '—' : fmt2(worst.evidence.pm10UgM3)} / {fmt2(worst.evidence.pm25UgM3)}
                    </div>
                  </div>
                  <div className="bg-slate-50 rounded-lg p-3 border border-slate-100">
                    <div className="text-xs text-slate-400">الرطوبة النسبية</div>
                    <div className="font-bold text-[#061B40]" dir="ltr">{fmt2(worst.evidence.relativeHumidityPercent)}%</div>
                  </div>
                  <div className="bg-slate-50 rounded-lg p-3 border border-slate-100">
                    <div className="text-xs text-slate-400">درجة الحرارة</div>
                    <div className="font-bold text-[#061B40]" dir="ltr">{fmt2(worst.evidence.temperatureC)}°م</div>
                  </div>
                  <div className="bg-slate-50 rounded-lg p-3 border border-slate-100">
                    <div className="text-xs text-slate-400">الرؤية</div>
                    <div className="font-bold text-[#061B40]" dir="ltr">
                      {worst.evidence.visibilityM !== null ? `${Math.round(worst.evidence.visibilityM)} م` : '—'}
                    </div>
                  </div>
                </div>
                {worst.caveatsAr && worst.caveatsAr.length > 0 && (
                  <div className="mt-3 space-y-2">
                    {worst.caveatsAr.map((c, i) => (
                      <div
                        key={i}
                        className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] font-bold text-amber-700"
                      >
                        <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                        <span>{c}</span>
                      </div>
                    ))}
                  </div>
                )}

                {/* رسم بياني منفصل لكل عنصر قياس (PM10/PM2.5/رياح/رؤية/
                    رطوبة/حرارة) لسجل قراءات هذا النشاط تحديداً — طلب صريح
                    من المستخدم: "مؤشر للقراءات حق النشاط، رسم بياني منفصل
                    لكل عنصر". يعتمد على activityGroupId (لا activityId
                    الوحدة الواحدة) لأن سجل الجهاز مربوط بالنشاط ككل. */}
                <ActivityReadingsCharts projectId={projectId} activityGroupId={activityGroupId} />
              </div>

              {/* نفس نص "جارٍ التحقق..." الثابت المعروض في البطاقة المطوية
                  (راجع تعليقه هناك — استُبدل العدّاد الدقيق بنص ثابت بطلب
                  صريح من المستخدم)، مكرَّر هنا لأن المستخدم قد يفتح التفاصيل
                  الكاملة مباشرة بلا مرور بالبطاقة المصغّرة. */}
              {isDeviceStalledDuringPending && (
                <div className="flex items-center gap-2 rounded-2xl border border-orange-200 bg-orange-50 px-4 py-3">
                  <Timer className="w-5 h-5 text-orange-600 shrink-0" />
                  <span className="text-[13px] font-bold text-orange-700">
                    الجهاز لم يرسل قراءة جديدة منذ فترة — تأكيد المخالفة متوقف مؤقتاً بانتظار وصول قراءة حديثة
                  </span>
                </div>
              )}
              {!isDeviceStalledDuringPending && worst?.pendingConfirmation && (
                <div className="flex items-center gap-2 rounded-2xl border border-red-200 bg-red-50 px-4 py-3">
                  <Timer className="w-5 h-5 text-red-600 shrink-0" />
                  <span className="text-[13px] font-bold text-red-700">
                    جارٍ التحقق من استمرار التجاوز — إن استمر التجاوز لأكثر من دقيقتين متتاليتين سيُسجَّل مخالفة تنظيمية مؤكَّدة (إيقاف إلزامي)، وإلا ستعود الحالة آمنة تلقائياً
                  </span>
                </div>
              )}
              {!worst?.pendingConfirmation && isConfirmedViolationNow && (
                <div className="flex items-center gap-2 rounded-2xl border border-slate-700 bg-slate-900/5 px-4 py-3">
                  <Timer className="w-5 h-5 text-slate-800 shrink-0" />
                  <span className="text-[13px] font-bold text-slate-800">
                    تم تسجيل مخالفة تنظيمية مؤكَّدة — استمر التجاوز لأكثر من دقيقتين متتاليتين
                  </span>
                </div>
              )}
              {!worst?.pendingConfirmation && showSuspensionCountdown && (
                <div className="flex items-center gap-2 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3">
                  <Timer className="w-5 h-5 text-amber-600 shrink-0" />
                  <span className="text-[13px] font-bold text-amber-700">
                    جارٍ مراقبة استمرار التجاوز (250 ميكروجرام/م³ فأكثر) — سيُعلَّق النشاط تلقائياً إن استمر التجاوز
                  </span>
                </div>
              )}

              {/* تنبيهات إعلامية (رؤية ضعيفة/حرارة مرتفعة) + نصائح ميدانية
                  عملية — إعلامية بحتة، لا تمثّل قراراً/إيقافاً ولا تدخل ضمن
                  محرك الامتثال أو AEI إطلاقاً. */}
              {allAdvisoryTips.length > 0 && (
                <div className="bg-white p-5 rounded-2xl border border-sky-200 shadow-sm space-y-4">
                  <h3 className="text-sm font-black text-[#061B40] flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4 text-sky-500" /> تنبيهات ونصائح ميدانية
                  </h3>
                  {allAdvisoryTips.map((tip, i) => (
                    <div key={i} className="rounded-xl bg-sky-50 border border-sky-200 p-3 space-y-2">
                      <div className="text-[13px] font-black text-sky-700">{tip.titleAr}</div>
                      <ul className="list-disc list-inside space-y-1 text-[12px] text-sky-700 font-medium">
                        {tip.tipsAr.map((t, idx) => (
                          <li key={idx}>{t}</li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              )}

              {/* بطاقة موحّدة واحدة: العنوان والدرجة من AEI (القرار الوحيد
                  المعروض)، وتفاصيل كل نشاط تنظيمي (قواعد/إجراءات/شروط
                  استئناف/التزامات رصد) كأقسام داعمة تحتها — لا بطاقة
                  "امتثال" منفصلة بقرار خاص بها، بطلب صريح بدمج كل القرارات
                  في مؤشر AEI الموحّد. فئة المشروع (risk class) محذوفة عمداً
                  من هذا العرض لأنها غير مهمة للمستخدم. */}
              {aei && aeiStyle && (
                <div className={`rounded-2xl border-2 p-5 space-y-4 ${isEnded ? `${endedStyle.bg} ${endedStyle.border}` : `${aeiStyle.bg} ${aeiStyle.border}`}`}>
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <h3 className={`font-black text-base ${isEnded ? endedStyle.text : aeiStyle.text}`}>
                      مؤشر قابلية التنفيذ (AEI): {isEnded ? 'انتهى النشاط' : aei.statusLabelAr}
                    </h3>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
                    <div className="bg-white/70 rounded-lg p-2">
                      <div className="text-xs text-[#061B40]/60">النشاط</div>
                      <div
                        className="font-bold text-[#061B40] truncate"
                        title={worst?.regulatoryActivityLabelAr ?? aei.activityLabelAr}
                      >
                        {worst?.regulatoryActivityLabelAr ?? aei.activityLabelAr}
                      </div>
                    </div>
                    <div className="bg-white/70 rounded-lg p-2">
                      <div className="text-xs text-[#061B40]/60">الحالة</div>
                      <div className="font-bold text-[#061B40]">{isEnded ? 'انتهى النشاط' : aei.statusLabelAr}</div>
                    </div>
                  </div>

                  <div>
                    <div className="text-xs font-bold text-[#061B40]/60 mb-1">السبب المباشر</div>
                    <div className="text-sm text-[#061B40]">
                      {isEnded ? 'انقضت نافذة تنفيذ هذا النشاط — لا يوجد قرار تشغيلي حالي بشأنه.' : aei.shortReasonAr}
                    </div>
                  </div>

                  {!isEnded && (
                    <div>
                      <div className="text-xs font-bold text-[#061B40]/60 mb-1">التوصية النهائية</div>
                      <div className="text-sm text-[#061B40]">{aei.recommendationAr}</div>
                    </div>
                  )}

                  {!isEnded && aei.gateReasonAr && (
                    <div className="text-xs font-bold text-red-600 bg-red-50 border border-red-200 rounded-lg p-2 mt-2">
                      {aei.gateReasonAr}
                    </div>
                  )}

                  {!isEnded && aei.closedByGate && (
                    <div className="text-red-600 text-xs font-bold mt-1">
                      تم الإيقاف عبر بوابة حاكمة، دون المرور بحساب الدرجة.
                    </div>
                  )}

                  {/* تفاصيل الامتثال التنظيمي الداعمة — بلا عنوان "قرار"
                      مستقل، فقط الأسباب والقواعد التي أثّرت في AEI أعلاه. */}
                  {complianceEntries.map((compliance, entryIdx) => {
                    const entryBlocks =
                      compliance.decisionCategory === 'MANDATORY_STOP' || compliance.decisionCategory === 'STOP_AFFECTED_ACTIVITY';
                    return (
                      <div key={entryIdx} className="rounded-xl bg-white/70 border border-white p-4 space-y-3">
                        <div className="flex items-center justify-between flex-wrap gap-2">
                          <h4 className="font-bold text-[13px] text-[#061B40]/70 flex items-center gap-1.5">
                            <Scale className="w-4 h-4" /> أساس القرار — الامتثال التنظيمي (الرياض)
                            {complianceEntries.length > 1 && (
                              <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-slate-100 text-[#061B40]/60">
                                نشاط تنظيمي {entryIdx + 1} من {complianceEntries.length}
                              </span>
                            )}
                          </h4>
                          <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-slate-100 text-[#061B40]/70">
                            {/* خطأ مكتشَف ومُصلَح (مراجعة مستخدم — "النص متناقض": هذه الشارة
                                كانت تعرض compliance.pendingConfirmation الخام بمعزل تام عن
                                القرار النهائي الموحَّد المعروض أعلاه (aei.statusLabelAr/
                                worst.decisionLabelAr عبر computeUnifiedActivityDecision) —
                                فحين يفوز DVI بقرار MANDATORY_STOP فوراً (قراءة PM10 لحظية
                                طازجة فوق 340، راجع pm10ReadingIsFreshEnoughForImmediateStop
                                في dust-engine/engine.ts) بينما الامتثال التنظيمي بمفرده لم
                                يتجاوز بعد شرط الاستمرار (دقيقتين)، كان العنوان الأعلى يقول
                                "إيقاف إلزامي نظامي" بينما هذه الشارة تقول "معلَّق مؤقتاً —
                                بانتظار تأكيد" لنفس النشاط في نفس اللحظة — تناقض ظاهري مباشر.
                                الإصلاح: "معلَّق مؤقتاً" لا تُعرَض إطلاقاً إن كان القرار النهائي
                                (alreadyStopped، نفس الإشارة المعتمَدة أصلاً في showSuspensionCountdown
                                أعلاه لعكس FinalDecision.mandatoryStop عبر aei.closedByGate) قد
                                أصبح إيقافاً إلزامياً بالفعل من أي مصدر — القرار الحاسم يُعرض
                                حينها فقط (compliance.decisionLabelAr)، لا حالة الامتثال الخام
                                المعزولة عن نفس اللحظة. */}
                            {compliance.pendingConfirmation && !alreadyStopped
                              ? 'معلَّق مؤقتاً — بانتظار تأكيد'
                              : compliance.decisionLabelAr}
                          </span>
                        </div>

                        <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-sm">
                          <div className="bg-slate-50 rounded-lg p-2">
                            <div className="text-xs text-[#061B40]/60">نطاق الرياح</div>
                            <div className="font-bold text-[#061B40] text-[12px]">
                              {WIND_BAND_LABEL_AR[compliance.windBand] ?? compliance.windBand}
                            </div>
                          </div>
                          <div className="bg-slate-50 rounded-lg p-2">
                            <div className="text-xs text-[#061B40]/60">درجة ثقة الامتثال</div>
                            <div className="font-bold text-[#061B40]">{compliance.confidenceScore} · {compliance.confidenceLabelAr}</div>
                          </div>
                          <div className="bg-slate-50 rounded-lg p-2 col-span-2 md:col-span-1">
                            <div className="text-xs text-[#061B40]/60">إصدار القواعد</div>
                            <div className="font-bold text-[#061B40] text-[11px]" title={compliance.rulebookVersion}>
                              {formatRulebookVersionAr(compliance.rulebookVersion)}
                            </div>
                          </div>
                        </div>

                        {/* لا نكرر السبب هنا إن كان مطابقاً لسبب AEI المعروض
                            أعلاه، ولا إن كان مطابقاً لإحدى "القواعد المفعّلة"
                            المعروضة أسفله مباشرة — shortReasonAr هو أصلاً نص
                            أعلى قاعدة مفعّلة، فعرضه مستقلاً يُظهر نفس الجملة
                            مرتين في بطاقة واحدة بلا أي معلومة إضافية. */}
                        {compliance.shortReasonAr !== aei?.shortReasonAr &&
                          !compliance.triggeredRules.some(
                            (rule) =>
                              (COMPLIANCE_RULES_TRANSLATIONS[rule.code] || rule.messageAr) === compliance.shortReasonAr
                          ) && (
                          <div>
                            <div className="text-xs font-bold text-[#061B40]/60 mb-1">أثر هذا النشاط التنظيمي على القرار</div>
                            <div className="text-sm text-[#061B40]">{compliance.shortReasonAr}</div>
                          </div>
                        )}

                        {compliance.triggeredRules.length > 0 && (
                          <div>
                            <div className="text-xs font-bold text-[#061B40]/60 mb-1">القواعد المفعّلة</div>
                            <ul className="list-disc list-inside space-y-1 text-[13px] text-[#061B40]">
                              {compliance.triggeredRules.map((rule, idx) => (
                                <li key={idx} className="font-medium">
                                  {COMPLIANCE_RULES_TRANSLATIONS[rule.code] || rule.messageAr}
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}

                        {compliance.requiredActions.length > 0 && (
                          <div>
                            <div className="text-xs font-bold text-[#061B40]/60 mb-1">الإجراءات المطلوبة</div>
                            <ul className="list-disc list-inside space-y-1 text-[13px] text-[#061B40]">
                              {compliance.requiredActions.map((action, idx) => (
                                <li key={idx} className="font-medium">{action}</li>
                              ))}
                            </ul>
                          </div>
                        )}

                        {compliance.restartConditions.length > 0 && (
                          <div>
                            <div className="text-xs font-bold text-[#061B40]/60 mb-1">شروط الاستئناف</div>
                            <ul className="list-disc list-inside space-y-1 text-[13px] text-[#061B40]">
                              {compliance.restartConditions.map((cond, idx) => (
                                <li key={idx} className="font-medium">{cond}</li>
                              ))}
                            </ul>
                          </div>
                        )}

                       

                        {entryBlocks && (
                          <div className="bg-white border border-current/20 p-2 rounded-lg text-[11px] font-bold text-center flex items-center justify-center gap-1">
                            <ShieldAlert className="w-3.5 h-3.5" /> هذا النشاط التنظيمي هو سبب إغلاق/تقييد مؤشر AEI أعلاه
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {hourlyEntries.length === 0 && (
                <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm">
                  <h3 className="text-sm font-black text-[#061B40] flex items-center gap-2 mb-2">
                    <Clock className="w-4 h-4 text-[#3995FF]" />
                    توقعات قابلية التنفيذ (AEI) للساعات القادمة
                  </h3>
                  <p className="text-[12px] font-bold text-slate-400">
                    لا توجد توقعات ساعية متاحة حالياً لهذا النشاط — إما خارج ساعات دوام المشروع المحددة، أو تعذر جلب توقعات الطقس الساعية مؤقتاً.
                  </p>
                </div>
              )}

              {hourlyEntries.length > 0 && (
                <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm space-y-4">
                  <div className="flex items-center justify-between flex-wrap gap-3">
                    <h3 className="text-sm font-black text-[#061B40] flex items-center gap-2">
                      <Clock className="w-4 h-4 text-[#3995FF]" />
                      توقعات قابلية التنفيذ (AEI) للساعات القادمة
                    </h3>
                    <span className="text-[11px] font-bold text-slate-500 bg-slate-50 px-3 py-1 rounded-full border border-slate-200">
                      إجمالي: طوال ساعات الدوام اليوم
                    </span>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
                    {hourlyEntries.map((h) => {
                      // كل ساعة تعرض حالة AEI (بعد بوابة الامتثال) بدل قرار
                      // الامتثال الخام — نفس منطق البطاقة الإجمالية أعلاه.
                      // hAeiStyle بلا dot (getAeiStyle لا تُرجع dot) فنبني
                      // الأسلوب هنا مباشرة بنفس ألوان getAeiStyle.
                      const hAeiStyle = h.aei ? getAeiStyle(h.aei.color) : null;
                      const hStyle = hAeiStyle ?? COMPLIANCE_DECISION_STYLE[h.result.decisionCategory];
                      const hLabel = h.aei ? `${h.aei.score} · ${h.aei.statusLabelAr}` : h.result.decisionLabelAr;
                      const hReason = h.aei ? h.aei.shortReasonAr : h.result.shortReasonAr;
                      return (
                        <div key={h.time} className={`rounded-2xl border p-3 ${hStyle.bg} ${hStyle.border}`}>
                          <div className="flex items-center justify-between">
                            <div className="text-[10px] font-black uppercase tracking-widest text-slate-400">
                              {HOUR_LABEL_AR(h.time)}
                            </div>
                          </div>
                          <div className={`text-[11px] font-bold ${hStyle.text}`}>{hLabel}</div>

                          <div className="mt-2 grid grid-cols-2 gap-1.5">
                            <div className="rounded-lg bg-white/70 border border-black/5 px-2 py-1">
                              <div className="text-[9px] font-bold text-slate-400">سرعة الرياح</div>
                              <div className="text-[11px] font-black text-slate-700" dir="ltr">{fmt2(h.result.evidence.windSpeedKmh)} كم/س</div>
                            </div>
                            <div className="rounded-lg bg-white/70 border border-black/5 px-2 py-1">
                              <div className="text-[9px] font-bold text-slate-400">اتجاه الرياح</div>
                              <div className="text-[11px] font-black text-slate-700">{formatWindDirectionAr(h.result.evidence.windDirectionDeg)}</div>
                            </div>
                            <div className="rounded-lg bg-white/70 border border-black/5 px-2 py-1">
                              <div className="text-[9px] font-bold text-slate-400">PM10</div>
                              <div className="text-[11px] font-black text-slate-700" dir="ltr">{fmt2(h.result.evidence.pm10UgM3)}</div>
                            </div>
                            <div className="rounded-lg bg-white/70 border border-black/5 px-2 py-1">
                              <div className="text-[9px] font-bold text-slate-400">PM2.5</div>
                              <div className="text-[11px] font-black text-slate-700" dir="ltr">{fmt2(h.result.evidence.pm25UgM3)}</div>
                            </div>
                          </div>

                          <div className="text-[10px] text-slate-500 leading-tight mt-2">{hReason}</div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* المستقبِلات حول وحدة الكسارة/الخلاطة تحديداً، ثم مستقبِلات
                  المشروع العامة — تُعرض في الأسفل بعد كل بيانات القرار
                  (الطقس/النصائح/AEI/التوقعات الساعية)، بطلب صريح من
                  المستخدم بوضع المستقبِلات آخر البطاقة. */}
              {unitReceptors && unitReceptors.length > 0 && unitReceptors.map((unit) => (
                <div
                  key={`${unit.unitType}-${unit.lat}-${unit.lng}`}
                  className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm"
                >
                  <h3 className="text-sm font-black text-[#061B40] mb-1 flex items-center gap-2">
                    <MapPin className="w-4 h-4 text-rose-500" />
                    المستقبِلات الحساسة حول {unit.unitLabelAr} (ضمن {unit.radiusM} م من موقعها)
                  </h3>
                  {unit.receptors.length === 0 ? (
                    <div className="rounded-lg border border-emerald-100 bg-emerald-50 px-3 py-2 text-[13px] font-bold text-emerald-700">
                      لا توجد مستقبِلات حساسة معروفة ضمن {unit.radiusM} م من موقع {unit.unitLabelAr}.
                    </div>
                  ) : (
                    <ul className="space-y-2">
                      {unit.receptors.map((receptor) => (
                        <li
                          key={receptor.id}
                          className="flex items-center justify-between gap-3 rounded-lg border border-slate-100 bg-slate-50 px-3 py-2"
                        >
                          <span className="text-[13px] font-bold text-[#061B40] truncate">
                            {RECEPTOR_TYPE_LABEL_AR[receptor.receptorType] ?? receptor.receptorType} — {receptor.name}
                          </span>
                          <span className="text-[12px] font-black text-rose-600 shrink-0" dir="ltr">
                            {Math.round(receptor.distanceM)} م
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}

              {nearbySensitiveReceptors && nearbySensitiveReceptors.length > 0 && (
                <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm">
                  <h3 className="text-sm font-black text-[#061B40] mb-4 flex items-center gap-2">
                    <MapPin className="w-4 h-4 text-rose-500" /> المستقبِلات الحساسة القريبة (ضمن 1كم من حدود المشروع)
                  </h3>
                  <ul className="space-y-2">
                    {nearbySensitiveReceptors.map((receptor) => (
                      <li
                        key={receptor.id}
                        className="flex items-center justify-between gap-3 rounded-lg border border-slate-100 bg-slate-50 px-3 py-2"
                      >
                        <span className="text-[13px] font-bold text-[#061B40] truncate">
                          {RECEPTOR_TYPE_LABEL_AR[receptor.receptorType] ?? receptor.receptorType} — {receptor.name}
                        </span>
                        <span className="text-[12px] font-black text-rose-600 shrink-0" dir="ltr">
                          {Math.round(receptor.distanceM)} م
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
