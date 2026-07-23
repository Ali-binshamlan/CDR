'use client';

import React, { useState, useEffect } from 'react';
import { apiClient } from '@/app/lib/apiClient';
import {
  Wind, X, ArrowUpRight, Eye, Gauge, ShieldCheck, ListChecks,
  Clock, AlertTriangle, Printer, AlertOctagon, CheckCircle2,
  CheckCircle, ShieldAlert, CalendarClock, Lightbulb, Search, Scale
} from 'lucide-react';
import type { DviDecisionCategory, DustWindowEvaluation, DviHourlyEvaluation } from '@/app/utils/dust-engine/types';
import type { AeiEvaluationResult, AeiColor } from '@/app/utils/aei-engine/types';
import { ACTIVITY_LABEL_AR } from '@/app/utils/dust-engine/tables';
import type { DustComplianceResult, DustComplianceDecisionCategory } from '@/app/utils/dust-compliance-engine/types';

interface DustDetailItem {
  label: string;
  value: string | number | boolean | null;
}

interface DustWidgetCardProps {
  activityType: string;
  windowEval: DustWindowEvaluation;
  aei: AeiEvaluationResult;
  hourlyForecasts?: DviHourlyEvaluation[]; 
  /** بيانات إدخال إضافية تُعرض في شبكة مرجعية عامة داخل التفاصيل، بنفس أسلوب بطاقة الإجهاد الحراري */
  details?: DustDetailItem[];
  projectId?: string;
  activityId?: string;
  projectName?: string;
  hideDecisionPanel?: boolean;
  /** أخفِ شريط التوقيت/الحالة داخل هذه البطاقة (يُستخدم فقط عند عرضها داخل MultiIndicatorActivityBox الذي يعرض توقيت النشاط الموحّد مرة واحدة) */
  hideSchedule?: boolean;
  /** نتائج محرك الامتثال التنظيمي (Riyadh Dust Compliance) — مستقلة تماماً
   * عن قرار DVI أعلاه، تُعرض كأقسام إضافية منفصلة ولا تستبدل أي جزء من DVI.
   * عنصر واحد لكل نشاط تنظيمي (regulatory_activity) أُضيف لهذا النشاط
   * الفيزيائي — نشاط واحد قد يحمل عدة أنشطة تنظيمية (هدم + كسارة مثلاً)
   * عبر ميزة "إضافة نشاط تنظيمي آخر"، فكل واحد له قرار امتثال مستقل. */
  complianceList?: DustComplianceResult[] | null;
}

const COMPLIANCE_RULES_TRANSLATIONS: Record<string, string> = {
  'GATE-DMP-001': 'نشاط غبار نشط/مخطط بلا موافقة معتمدة على خطة إدارة الغبار (DMP)',
  'GATE-DVI-002': 'إيقاف إلزامي بسبب خطورة فيزيائية حالية (رؤية منعدمة أو تركيز غبار خطر) لا علاقة له بمخالفة تنظيمية',
  'GATE-SUPPRESSION-003': 'نظام تثبيط الغبار غير عامل على نشاط مولّد للغبار',
  'GATE-WIND-ABOVE-25-004': 'إيقاف الأنشطة المكشوفة المولّدة للغبار بسبب رياح تتجاوز 25 كم/س (بروتوكول الملحق أ)',
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
  ALLOW_WITH_CONTROLS: { bg: 'bg-amber-50', border: 'border-amber-200', text: 'text-amber-700', dot: 'bg-amber-500' },
  FIELD_VERIFICATION_REQUIRED: { bg: 'bg-blue-50', border: 'border-blue-200', text: 'text-blue-700', dot: 'bg-blue-500' },
  RESTRICT_ACTIVITY: { bg: 'bg-orange-50', border: 'border-orange-200', text: 'text-orange-700', dot: 'bg-orange-500' },
  STOP_AFFECTED_ACTIVITY: { bg: 'bg-red-50', border: 'border-red-200', text: 'text-red-700', dot: 'bg-red-600' },
  MANDATORY_STOP: { bg: 'bg-slate-900/5', border: 'border-slate-700', text: 'text-slate-800', dot: 'bg-slate-800' },
};

// يحوّل رمز إصدار كتاب القواعد التقني (مثل RCRC-NCEC-RIYADH-DUST-2026.1)
// إلى نص عربي مفهوم للمستخدم غير التقني — الرمز الخام يبقى فقط كـ tooltip.
function formatRulebookVersionAr(version: string): string {
  const match = version.match(/(\d{4})\.(\d+)$/);
  const yearRevision = match ? `${match[1]} (تحديث ${match[2]})` : version;
  return `لوائح الغبار التنظيمية للرياض — إصدار ${yearRevision}`;
}

const RISK_CLASS_LABEL_AR: Record<string, string> = {
  CATEGORY_I_LOW: 'الفئة الأولى — مخاطر منخفضة',
  CATEGORY_II_MEDIUM: 'الفئة الثانية — مخاطر متوسطة',
  CATEGORY_III_HIGH: 'الفئة الثالثة — مخاطر عالية',
  UNCLASSIFIED: 'غير مصنَّف (بيانات ناقصة)',
};

const WIND_BAND_LABEL_AR: Record<string, string> = {
  BELOW_15: 'أقل من 15 كم/س',
  FROM_15_TO_25: 'من 15 إلى 25 كم/س',
  ABOVE_25: 'أعلى من 25 كم/س',
  UNKNOWN: 'غير معروف',
};

// يُنسّق أي قيمة رقمية عشرية (رؤية/رياح) برقمين بعد الفاصلة فقط
const fmt2 = (value: number | null | undefined): string =>
  value === null || value === undefined ? '—' : value.toFixed(2);

const CAUSE_LABEL_AR: Record<string, string> = {
  DUST: 'غبار', FOG: 'ضباب', RAIN_REDUCED_VISIBILITY: 'مطر', SMOKE: 'دخان', MIXED: 'مختلط', UNKNOWN: 'غير محدد',
};

// تم تعديل الدالة لتستقبل الـ score وتجبر عرض "ظروف طبيعية" إذا كان الوضع أخضر
function getCauseDisplayLabel(
  causeClassification: string,
  decisionCategory: string,
  mandatoryStop: boolean,
  score: number
): string {
  if ((decisionCategory === 'ALLOW' || score < 25) && !mandatoryStop) {
    return 'ظروف طبيعية';
  }
  return CAUSE_LABEL_AR[causeClassification] ?? 'غير محدد';
}

export const DUST_RULES_TRANSLATIONS: Record<string, string> = {
  'DVI-VISIBILITY-MANDATORY-STOP-001': 'توصية إيقاف إلزامي فوري بسبب انعدام الرؤية (أقل من 0.5 كم)',
  'DVI-VISIBILITY-RED-002': 'توصية تقييد شديد للعمل بسبب انخفاض الرؤية الخطر (أقل من 1 كم)',
  'DVI-PM10-ACTION-003': 'إجراءات فورية مطلوبة للتحكم بالغبار بسبب ارتفاع الجسيمات العالقة',
  'DVI-DUST-ACTIVITY-STOP-004': 'توصية بإيقاف الأعمال المثيرة للغبار بسبب التلوث العالي مع رياح نشطة',
  'DVI-WIND-LOOSE-MATERIAL-005': 'رياح نشطة مع وجود مواد سائبة مكشوفة تتطلب التغطية فوراً',
  'DVI-RECEPTOR-ESCALATION-006': 'تصعيد القيود بسبب الرياح التي تنقل الغبار نحو جوار حساس',
  'DVI-NCM-DUST-WARNING-007': 'تحذير عاصفة رملية أو غبار كثيف متوقع',
};

const getDecisionStyle = (decision: DviDecisionCategory, mandatoryStop: boolean) => {
  if (mandatoryStop || decision === 'MANDATORY_STOP') {
    return { bg: 'bg-slate-900/5', border: 'border-slate-700', text: 'text-slate-800', dot: 'bg-slate-800', pulse: true };
  }
  switch (decision) {
    case 'ALLOW': return { bg: 'bg-emerald-50', border: 'border-emerald-200', text: 'text-emerald-700', dot: 'bg-emerald-500', pulse: false };
    case 'ALLOW_WITH_MONITORING': return { bg: 'bg-amber-50', border: 'border-amber-200', text: 'text-amber-700', dot: 'bg-amber-500', pulse: false };
    case 'RESTRICT': return { bg: 'bg-orange-50', border: 'border-orange-200', text: 'text-orange-700', dot: 'bg-orange-500', pulse: false };
    case 'RESTRICT_SEVERE':
    case 'STOP_DUST_GENERATING_ACTIVITIES':
    case 'STOP_VISIBILITY_DEPENDENT_ACTIVITIES':
      return { bg: 'bg-red-50', border: 'border-red-200', text: 'text-red-700', dot: 'bg-red-600', pulse: true };
    default: return { bg: 'bg-slate-50', border: 'border-slate-200', text: 'text-slate-700', dot: 'bg-slate-400', pulse: false };
  }
};

const getAeiStyle = (color: AeiColor) => {
  switch (color) {
    case 'GREEN': return { bg: 'bg-emerald-50', border: 'border-emerald-200', text: 'text-emerald-700' };
    case 'YELLOW': return { bg: 'bg-amber-50', border: 'border-amber-200', text: 'text-amber-700' };
    case 'ORANGE': return { bg: 'bg-orange-50', border: 'border-orange-200', text: 'text-orange-700' };
    case 'BLACK': return { bg: 'bg-slate-900/5', border: 'border-slate-700', text: 'text-slate-800' };
    default: return { bg: 'bg-slate-50', border: 'border-slate-200', text: 'text-slate-700' };
  }
};

const HOUR_LABEL_AR = (iso: string) =>
  new Date(iso).toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Riyadh' });

// دالة تحويل الساعات إلى نصوص عربية منسقة
const formatHoursLabel = (hours: number | undefined): string => {
  if (hours === undefined || hours === null) return '';
  if (hours === 1) return 'ساعة واحدة';
  if (hours === 2) return 'ساعتان';
  if (hours >= 3 && hours <= 10) return `${hours} ساعات`;
  return `${hours} ساعة`;
};

const RISK_ZONES = [
  { level: 'GREEN', min: 0, max: 24, color: 'bg-emerald-400', label: 'تشغيل عادي' },
  { level: 'YELLOW', min: 25, max: 44, color: 'bg-amber-400', label: 'تشغيل مع مراقبة' },
  { level: 'ORANGE', min: 45, max: 64, color: 'bg-orange-400', label: 'تقليل / ضوابط تشغيل' },
  { level: 'RED', min: 65, max: 84, color: 'bg-red-500', label: 'إيقاف الأنشطة المتأثرة / تقييد شديد' },
  { level: 'DARK_RED', min: 85, max: 100, color: 'bg-red-900', label: 'خطر شديد' },
] as const;

function RiskScoreGauge({
  score,
  decisionLabelAr,
  mandatoryStop,
}: {
  score: number;
  decisionLabelAr: string;
  mandatoryStop: boolean;
}) {
  const clamped = Math.max(0, Math.min(100, score));
  const currentZoneIdx = RISK_ZONES.findIndex((z) => clamped >= z.min && clamped <= z.max);
  const nextZone = RISK_ZONES[currentZoneIdx + 1];
  const pointsToNext = nextZone ? nextZone.min - clamped : null;

  if (mandatoryStop) {
    return (
      <div className="w-full">
        <div className="flex items-baseline gap-2 mb-1.5">
          <span className="text-4xl font-black text-slate-800 leading-none">{score}</span>
          <span className="text-[11px] font-bold text-slate-400">/ 100 نقطة خطر</span>
        </div>
        <div className="bg-slate-900 text-white rounded-lg px-3 py-2 text-[11px] font-black flex items-center gap-2">
          ⚠ إيقاف إلزامي — تجاوز حد صارم في المواصفة الدرجة الرقمية، بغض النظر عن موقعها على المقياس
        </div>
        <p className="text-[10px] font-bold text-slate-400 mt-1">التوصية: {decisionLabelAr}</p>
      </div>
    );
  }

  return (
    <div className="w-full">
      <div className="flex items-baseline gap-2 mb-1.5">
        <span className="text-4xl font-black text-[#061B40] leading-none">{score}</span>
        <span className="text-[11px] font-bold text-slate-400">/ 100 نقطة خطر (كلما ارتفع الرقم زاد التقييد)</span>
      </div>

      <div dir="ltr" className="relative h-2.5 w-full rounded-full overflow-hidden flex mb-1">
        {RISK_ZONES.map((z) => (
          <div key={z.level} className={z.color} style={{ width: `${z.max - z.min + 1}%` }} />
        ))}
        <div
          className="absolute top-1/2 -translate-y-1/2 w-3.5 h-3.5 rounded-full bg-white border-2 border-[#061B40] shadow"
          style={{ left: `calc(${clamped}% - 7px)` }}
          title={`${score} نقطة`}
        />
      </div>

      <div dir="ltr" className="flex items-center justify-between text-[9px] font-bold text-slate-400 mb-1.5">
        <span>0 · آمن</span>
        <span>100 · إيقاف كامل</span>
      </div>

      <p className="text-[11px] font-bold text-slate-600 leading-relaxed">
        الوضع الحالي: <span className="font-black">{decisionLabelAr}</span>
        {!mandatoryStop && pointsToNext !== null && pointsToNext <= 15 && (
          <span className="text-orange-600"> — يبعد {Math.ceil(pointsToNext)} نقطة فقط عن تصعيد القرار للمستوى الأشد</span>
        )}
      </p>
    </div>
  );
}

export default function DustWidgetCard({ activityType, windowEval, aei, complianceList = null, hourlyForecasts, details = [], projectId, activityId, projectName, hideDecisionPanel = false, hideSchedule = false }: DustWidgetCardProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [activeAlert, setActiveAlert] = useState<any>(null);
  const [confirmedDecision, setConfirmedDecision] = useState<{status: string, time: string} | null>(null);

  const result = windowEval.worst;
  const style = getDecisionStyle(result.decisionCategory, result.mandatoryStop);
  const aeiStyle = getAeiStyle(aei.color);

  // قد يحمل النشاط الواحد أكثر من نشاط تنظيمي (هدم + كسارة مثلاً) عبر ميزة
  // "إضافة نشاط تنظيمي آخر" — كل عنصر في complianceList له قرار امتثال
  // مستقل تماماً عن DVI أعلاه. اعتماد التنفيذ يُمنع إن أوقف أي واحد منها
  // النشاط (إيقاف إلزامي أو إيقاف النشاط المتأثر)، بصرف النظر عن البقية.
  const complianceEntries = (complianceList ?? []).filter(Boolean);
  const complianceBlocksApproval = complianceEntries.some(
    (c) => c.decisionCategory === 'MANDATORY_STOP' || c.decisionCategory === 'STOP_AFFECTED_ACTIVITY'
  );
  
  const isFutureActivity = new Date(windowEval.windowStartIso).getTime() > Date.now();

  const nowTs = Date.now();
  const startTs = new Date(windowEval.windowStartIso).getTime();
  const endTs = new Date(windowEval.windowEndIso).getTime();
  const activityStatus: 'upcoming' | 'ongoing' | 'past' = nowTs < startTs ? 'upcoming' : nowTs <= endTs ? 'ongoing' : 'past';

  const formatRelative = (diffMs: number): string => {
    const mins = Math.round(Math.abs(diffMs) / 60000);
    if (mins < 60) return `${mins} دقيقة`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours} ساعة`;
    const days = Math.round(hours / 24);
    return `${days} يوم`;
  };

  // نص/لون حالة النشاط يُعرضان فقط عندما لا تكون البطاقة داخل
  // MultiIndicatorActivityBox، لأن الأخير يعرض توقيت النشاط الموحّد مرة واحدة
  let finalActivityStatusLabel = '';
  let finalActivityStatusColor = '';

  if (confirmedDecision?.status === 'postpone') {
    finalActivityStatusLabel = '● تم تأجيل النشاط';
    finalActivityStatusColor = 'text-indigo-600';
  } else if (confirmedDecision?.status === 'stopped') {
    finalActivityStatusLabel = '● تم إيقاف النشاط';
    finalActivityStatusColor = 'text-red-600';
  } else {
    finalActivityStatusLabel =
      activityStatus === 'ongoing'
        ? '● جارٍ الآن'
        : activityStatus === 'past'
          ? `انتهى منذ ${formatRelative(nowTs - endTs)}`
          : `يبدأ خلال ${formatRelative(startTs - nowTs)}`;

    finalActivityStatusColor =
      activityStatus === 'ongoing' ? 'text-emerald-600'
      : activityStatus === 'past' ? 'text-slate-400'
      : 'text-blue-600';
  }

  const hasBetterWindow =
    activityStatus === 'upcoming' &&
    !!windowEval.bestWindowStartIso &&
    !!windowEval.bestWindowWorst &&
    windowEval.bestWindowWorst.score < result.score - 5 &&
    new Date(windowEval.bestWindowStartIso).getTime() !== startTs;

  // تحذير "تجنّب هذا الوقت" — نفس مفهوم hasWorseTimeWarning في بطاقة الحرارة،
  // يظهر فقط لو النشاط مجدول فعلياً داخل أسوأ نافذة موجودة (وليس أي نشاط
  // مستقبلي عشوائي)، لتوحيد المزايا المعروضة بين مؤشري الحرارة والغبار
  const hasWorseWindow =
    !!windowEval.avoidWindowStartIso &&
    !!windowEval.avoidWindowWorst &&
    windowEval.avoidWindowWorst.score > result.score + 5 &&
    new Date(windowEval.avoidWindowStartIso).getTime() === startTs;

  const EXTENDED_ACTIVITY_LABEL: Record<string, string> = {
    'COATING': 'أعمال طلاء وعزل', 'ROAD_WORKS': 'أعمال طرق ومسارات', 'WELDING': 'أعمال لحام',
    'SCAFFOLDING': 'أعمال سقالات', 'CRANE_LIFTING': 'عمليات رفع', 'CONCRETE_POURING': 'صب خرسانة',
    'ASPHALT_PAVING': 'سفلتة', 'EXCAVATION': 'حفر وردم', 'GRADING': 'أعمال ترابية',
    'WORK_AT_HEIGHT': 'أعمال على ارتفاع', 'GENERAL_OUTDOOR_WORK': 'أعمال خارجية عامة',
    'EXTERNAL_PAINTING': 'دهانات وعزل خارجي', 'MATERIAL_TRANSPORT': 'نقل مواد',
    'HEAVY_EQUIPMENT_MOVEMENT': 'حركة معدات ثقيلة', 'MEP_EXTERNAL_WORK': 'أعمال ميكانيكية/كهربائية'
  };

  const activityLabel = (ACTIVITY_LABEL_AR as Record<string, string>)[activityType] ?? EXTENDED_ACTIVITY_LABEL[activityType] ?? activityType;

  useEffect(() => {
    async function fetchInitialData() {
      if (!projectId || !activityId) return;
      
      const { data: alertResp } = await apiClient.get('/alerts', {
        params: { projectId, activityId, activitySource: 'dust' },
      });
      const alertData = alertResp?.data;
      if (alertData && alertData.length > 0) setActiveAlert(alertData[0]);

      const { data: decisionResp } = await apiClient.get('/decisions', {
        params: { projectId, activityId, activitySource: 'dust' },
      });
      const decisionData = decisionResp?.data;

      if (decisionData) {
        setConfirmedDecision({
          status: decisionData.status,
          time: new Date(decisionData.created_at).toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Riyadh' })
        });
      }
    }
    fetchInitialData();
  }, [projectId, activityId]);

  const saveDecision = async (dbStatus: 'safe' | 'caution' | 'restricted' | 'postpone' | 'stopped') => {
    if (!projectId || !activityId) {
      alert("الربط بقاعدة البيانات غير مكتمل.");
      return;
    }
    
    setIsSaving(true);
    try {
      await apiClient.post('/decisions', {
        insert: {
          project_id: projectId,
          activity_source: 'dust',
          activity_id: activityId,
          status: dbStatus,
          reason: `توصية مرقاب: ${result.decisionLabelAr} (${result.score} نقطة)`,
          required_action: result.requiredActions.join('، ') || 'لا توجد متطلبات إضافية',
          approved_by: 'مستخدم النظام (مدير الموقع)',
          approval_note: isFutureActivity && dbStatus === 'postpone' ? 'تم تأجيل النشاط بناءً على التوقعات' : 'قرار ميداني مباشر',
          weather_snapshot: [
            { label: 'الرؤية', value: `${fmt2(result.visibilityKm)} كم` },
            { label: 'الرياح', value: `${fmt2(result.effectiveWindKmh)} كم/س` },
            { label: 'السبب', value: CAUSE_LABEL_AR[result.causeClassification] }
          ]
        },
      });
      
      setConfirmedDecision({
        status: dbStatus,
        time: new Date().toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Riyadh' })
      });
      
    } catch (error) {
      console.error('Error saving decision:', error);
      alert('حدث خطأ أثناء حفظ القرار.');
    } finally {
      setIsSaving(false);
    }
  };

  const translateConfidence = (val: string) => {
    const dict: Record<string, string> = { 'High': 'عالية', 'Medium': 'متوسطة', 'Low': 'منخفضة' };
    return dict[val] || val;
  };

  const formatValue = (value: string | number | boolean | null) => {
    if (value === null || value === undefined || value === '') return '—';
    if (typeof value === 'boolean') return value ? 'نعم' : 'لا';
    return String(value);
  };

  // نُفضّل عرض توقعات كامل ساعات الدوام (تجيب على "هل أقدر أشتغل فيها؟"
  // لكل ساعة دوام) إن توفّرت، وإلا نرجع لساعات نافذة النشاط المجدولة فقط.
  const hasWorkDayHourly = !!hourlyForecasts && hourlyForecasts.length > 0;
  const hasWindowHourly = windowEval.hourly && windowEval.hourly.length > 0;
  const displayHourly = hasWorkDayHourly ? hourlyForecasts! : (hasWindowHourly ? windowEval.hourly : []);

  const totalHoursLabel = hasWorkDayHourly
    ? 'طوال ساعات الدوام اليوم'
    : hasWindowHourly
    ? `${formatHoursLabel(windowEval.durationHours)} (نافذة النشاط)`
    : 'أقرب 12 ساعة من الآن — غير مرتبطة بوقت النشاط المجدول';

  const getConfirmedUI = (status: string) => {
    switch(status) {
      case 'safe': return { text: 'تم اعتماد النشاط وتوثيقه', bg: 'bg-emerald-50', border: 'border-emerald-200', textCol: 'text-emerald-700', iconCol: 'text-emerald-500' };
      case 'caution': return { text: 'تم اعتماد النشاط مع الحذر', bg: 'bg-amber-50', border: 'border-amber-200', textCol: 'text-amber-700', iconCol: 'text-amber-500' };
      case 'stopped': return { text: 'تم إيقاف النشاط احترازياً', bg: 'bg-red-50', border: 'border-red-200', textCol: 'text-red-700', iconCol: 'text-red-500' };
      case 'postpone': return { text: 'تم تأجيل النشاط احترازياً', bg: 'bg-indigo-50', border: 'border-indigo-200', textCol: 'text-indigo-700', iconCol: 'text-indigo-500' };
      default: return { text: 'تم توثيق القرار', bg: 'bg-slate-50', border: 'border-slate-200', textCol: 'text-slate-700', iconCol: 'text-slate-500' };
    }
  };

  return (
    <>
      <div className="bg-white rounded-[24px] border border-slate-200 shadow-sm hover:shadow-md transition-all duration-300 flex flex-col overflow-hidden relative">
        <div className={`absolute top-0 left-0 w-full h-1 ${style.dot}`}></div>

        {activeAlert && (
          <div className="bg-red-500 text-white text-[10px] font-black px-4 py-1.5 flex items-center gap-2 animate-pulse">
            <AlertOctagon className="w-3.5 h-3.5" />
            يوجد تنبيه أمني نشط لهذا النشاط يرجى المراجعة!
          </div>
        )}

        {/* الامتثال التنظيمي هو القرار الملزم النهائي — يُعرض هنا صراحة حتى
            لو كانت توصية مرقاب (DVI) الفيزيائية أدناه تبدو آمنة، لتفادي أي
            انطباع بالتناقض بين البطاقتين (المعيارين مختلفان: DVI فيزيائي
            عام، والامتثال قواعد تنظيمية أشد لأنشطة محددة). */}
        {complianceBlocksApproval && (
          <div className="bg-slate-900 text-white text-[10px] font-black px-4 py-1.5 flex items-center gap-2">
            <Scale className="w-3.5 h-3.5" />
            الامتثال التنظيمي يوقف هذا النشاط — القرار الملزم رغم أي توصية أخرى أدناه
          </div>
        )}

        <div className="p-5 pb-4 border-b border-slate-100 bg-slate-50/50 flex justify-between items-start">
          <div className="flex items-center gap-3">
            <div className={`w-11 h-11 rounded-2xl ${style.bg} border ${style.border} flex items-center justify-center shrink-0`}>
              <Wind className={`w-5 h-5 ${style.text}`} strokeWidth={2} />
            </div>
            <div>
              <h3 className="font-black text-[#061B40] text-[15px]">الرؤية والغبار</h3>
              <p className="text-[11px] font-bold text-slate-400">{activityLabel}</p>
              {/* يُعرض التوقيت هنا فقط عند استخدام البطاقة بشكل مستقل؛ داخل بوكس المؤشرات المتعددة يُعرض توقيت النشاط الموحّد مرة واحدة بدلاً من ذلك */}
              {!hideSchedule && (
                <>
                  <p className="text-[10px] font-bold text-slate-400 flex items-center gap-1 mt-0.5" dir="ltr">
                    <Clock className="w-3 h-3" />
                    <span dir="rtl">
                      {new Date(windowEval.windowStartIso).toLocaleDateString('ar-SA', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Riyadh' })}
                      {' '}
                      {new Date(windowEval.windowStartIso).toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Riyadh' })}
                      {' ← '}
                      {new Date(windowEval.windowEndIso).toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Riyadh' })}
                      {' '}({formatHoursLabel(windowEval.durationHours)})
                    </span>
                  </p>
                  <p className="text-[10px] font-black mt-1">
                    <span className={finalActivityStatusColor}>
                      {finalActivityStatusLabel}
                    </span>
                  </p>
                </>
              )}
            </div>
          </div>
        </div>

        <div className="p-5 flex-1 flex flex-col">
          <div className="flex items-start justify-between mb-5 gap-3">
            <RiskScoreGauge score={result.score} decisionLabelAr={result.decisionLabelAr} mandatoryStop={result.mandatoryStop} />
            {aei && (
              <div className={`border rounded-xl px-3 py-2 text-center shrink-0 ${aeiStyle.bg} ${aeiStyle.border}`}>
                <div className="text-[9px] font-bold text-slate-400 mb-0.5">مؤشر AEI المدمج</div>
                <div className={`text-xs font-black ${aeiStyle.text}`}>{aei.score} · {aei.statusLabelAr}</div>
              </div>
            )}
          </div>

          <div className="flex items-center gap-1.5 mb-3 px-1">
             <CalendarClock className="w-4 h-4 text-blue-500" />
             <span className="text-[11px] font-bold text-blue-600">
               {isFutureActivity ? 'توقعات الطقس لوقت التنفيذ المجدول' : 'قراءات الطقس الحالية'}
             </span>
          </div>

          <div className="grid grid-cols-3 gap-3 mb-4">
            <div className="flex flex-col items-center justify-center p-3 rounded-xl bg-slate-50 border border-slate-100 text-center">
              <Eye className="w-5 h-5 text-indigo-400 mb-2" />
              <span className="text-sm font-black text-slate-800" dir="ltr">
                {fmt2(result.visibilityKm)}
              </span>
              <span className="text-[9px] font-bold text-slate-400">رؤية (كم)</span>
            </div>
            <div className="flex flex-col items-center justify-center p-3 rounded-xl bg-slate-50 border border-slate-100 text-center">
              <Gauge className="w-5 h-5 text-rose-500 mb-2" />
              <span className="text-sm font-black text-slate-800" dir="ltr">
                {fmt2(result.effectiveWindKmh)}
              </span>
              <span className="text-[9px] font-bold text-slate-400">رياح كم/س</span>
            </div>
            <div className="flex flex-col items-center justify-center p-3 rounded-xl bg-slate-50 border border-slate-100 text-center">
              <Search className="w-5 h-5 text-violet-500 mb-2" />
              <span className="text-sm font-black text-slate-800">{getCauseDisplayLabel(result.causeClassification, result.decisionCategory, result.mandatoryStop, result.score)}</span>
              <span className="text-[9px] font-bold text-slate-400">السبب الأرجح</span>
            </div>
          </div>

          

          {hasWorseWindow && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 mb-3 flex items-start gap-2.5">
              <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
              <p className="text-[11px] font-bold text-amber-800 leading-relaxed">
                التوقيت الحالي من أسوأ أوقات الغبار/الرؤية القريبة — درجة الخطر ({result.score}) أعلى من المعتاد لهذه المدة.
              </p>
            </div>
          )}

          {hasBetterWindow && (
            <div className="rounded-xl border border-blue-200 bg-blue-50 px-3 py-2.5 mb-3 flex items-start gap-2">
              <Lightbulb className="w-4 h-4 text-blue-500 mt-0.5 shrink-0" />
              <p className="text-[11px] font-bold text-blue-700 leading-relaxed">
                فيه وقت أفضل قريب:{' '}
                <span className="font-black">
                  {new Date(windowEval.bestWindowStartIso!).toLocaleString('ar-SA', { weekday: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Riyadh' })}
                </span>
                {' '}— درجة خطر أقل ({windowEval.bestWindowWorst!.score} بدل {result.score})
              </p>
            </div>
          )}

          <div className="flex items-center gap-2 mt-auto flex-wrap">
            <span className="text-[10px] font-bold px-2 py-1 rounded-lg bg-slate-50 border border-slate-200 text-slate-500">
              دقة التوقع: {translateConfidence(result.confidenceLabel)}
            </span>
            {result.respiratoryPPERequired && (
              <span className="text-[10px] font-bold px-2 py-1 rounded-lg bg-blue-50 border border-blue-200 text-blue-600">
                كمامات مطلوبة
              </span>
            )}
          </div>
        </div>

        <div className="p-4 pt-0 mt-auto">
          <button
            onClick={() => setIsOpen(true)}
            className="w-full bg-white border border-slate-200 hover:border-[#3995FF] hover:bg-blue-50 text-slate-600 hover:text-[#0176FB] text-[13px] font-bold py-2.5 rounded-xl transition-all flex items-center justify-center gap-2"
          >
            عرض التفاصيل الكاملة واتخاذ القرار <ArrowUpRight className="w-3.5 h-3.5" />
          </button>
        </div>
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
                  <Wind className={`w-5 h-5 ${style.text}`} />
                </div>
                <div>
                  <h2 className="font-black text-[#061B40] text-lg">تفاصيل تقييم الرؤية والغبار الميدانية</h2>
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
              
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
                
                <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm relative overflow-hidden">
                  <div className="absolute top-0 right-0 w-1 h-full bg-sky-500"></div>
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-sm font-black text-[#061B40] flex items-center gap-2">
                      <Eye className="w-4 h-4 text-sky-500" /> الرؤية والطقس
                    </h3>
                    {isFutureActivity && (
                      <span className="text-[10px] font-bold text-blue-600 bg-blue-50 px-2 py-1 rounded-md border border-blue-100 flex items-center gap-1">
                        <CalendarClock className="w-3 h-3" /> توقعات وقت النشاط
                      </span>
                    )}
                  </div>
                  <ul className="space-y-3 text-sm">
                    <li className="flex justify-between border-b border-slate-100 pb-3 items-center">
                      <span className="text-slate-500 text-[12px] font-bold">الرؤية المتوقعة:</span>
                      <span className="font-mono font-bold text-sky-600 text-base">{result.visibilityKm !== null ? `${fmt2(result.visibilityKm)} كم` : '—'}</span>
                    </li>
                    <li className="flex justify-between border-b border-slate-100 pb-3 items-center">
                      <span className="text-slate-500 text-[12px] font-bold">الرياح الفعالة:</span>
                      <span className="font-mono font-bold text-rose-600 text-base">{result.effectiveWindKmh !== null ? `${fmt2(result.effectiveWindKmh)} كم/س` : '—'}</span>
                    </li>
                    <li className="flex justify-between items-center pt-1">
                      <span className="text-slate-500 text-[12px] font-bold">السبب الأرجح:</span>
                      <span className="font-mono font-bold text-[#061B40] text-base">{getCauseDisplayLabel(result.causeClassification, result.decisionCategory, result.mandatoryStop, result.score)}</span>
                    </li>
                  </ul>
                </div>

                <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm">
                  <h3 className="text-sm font-black text-indigo-600 mb-4 flex items-center gap-2">
                    <Wind className="w-4 h-4" /> معلومات النشاط
                  </h3>
                  <ul className="space-y-3 text-sm">
                    <li className="flex justify-between border-b border-slate-100 pb-3">
                      <span className="text-slate-500 text-[12px] font-bold">مدة النشاط:</span>
                      <span className="font-bold text-[#061B40]">{formatHoursLabel(windowEval.durationHours) || '—'}</span>
                    </li>
                    <li className="flex justify-between border-b border-slate-100 pb-3">
                      <span className="text-slate-500 text-[12px] font-bold">دقة التوقع:</span>
                      <span className="font-bold text-[#061B40]">{translateConfidence(result.confidenceLabel)}</span>
                    </li>
                    <li className="flex justify-between">
                      <span className="text-slate-500 text-[12px] font-bold">كمامات تنفسية:</span>
                      <span className="font-bold text-[#061B40]">{result.respiratoryPPERequired ? 'مطلوبة' : 'غير مطلوبة'}</span>
                    </li>
                  </ul>
                </div>

                <div className={`p-5 rounded-2xl border shadow-sm flex flex-col ${style.bg} ${style.border}`}>
                  <h3 className={`text-sm font-black mb-4 flex items-center gap-2 ${style.text}`}>
                    <ShieldCheck className="w-4 h-4" /> توصية مرقاب
                  </h3>
                  <RiskScoreGauge score={result.score} decisionLabelAr={result.decisionLabelAr} mandatoryStop={result.mandatoryStop} />
                  {(result as any).overridable === false && (
                    <div className="bg-white/60 border border-current/20 p-2 rounded-lg text-[11px] font-bold mt-4 text-center flex items-center justify-center gap-1">
                      <ShieldAlert className="w-3.5 h-3.5" /> توصية إلزاميّة — يرجى الالتزام
                    </div>
                  )}
                  {complianceBlocksApproval && (
                    <div className="bg-slate-900 text-white p-2 rounded-lg text-[11px] font-bold mt-2 text-center flex items-center justify-center gap-1.5">
                      <Scale className="w-3.5 h-3.5" /> هذه توصية فيزيائية عامة فقط — الامتثال التنظيمي أدناه أشد ويوقف النشاط فعلياً
                    </div>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm">
                  <h4 className="text-sm font-black text-amber-600 mb-3 flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4" /> مبررات التوصية (القواعد المفعّلة)
                  </h4>
                  <ul className="list-disc list-inside space-y-2 text-[13px] text-slate-600 leading-relaxed">
                    {result.triggeredRules.length > 0 ? (
                      result.triggeredRules.map((rule, idx) => (
                        <li key={idx} className="font-medium">{DUST_RULES_TRANSLATIONS[rule] || rule}</li>
                      ))
                    ) : complianceBlocksApproval ? (
                      <li className="font-medium text-slate-800">
                        لا توجد قواعد DVI فيزيائية مفعّلة — لكن النشاط موقوف فعلياً بسبب قواعد الامتثال التنظيمي أدناه (انظر قسم "الامتثال التنظيمي").
                      </li>
                    ) : (
                      <li>لا توجد قواعد إيقاف مفعّلة حاليًا</li>
                    )}
                  </ul>
                </div>
                
                <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm">
                  <h4 className="text-sm font-black text-indigo-600 mb-3 flex items-center gap-2">
                    <ListChecks className="w-4 h-4" /> الإجراءات المقترحة
                  </h4>
                  <ul className="list-disc list-inside space-y-2 text-[13px] text-slate-600 leading-relaxed">
                    {result.requiredActions.length > 0 ? (
                      result.requiredActions.map((action, idx) => <li key={idx} className="font-medium">{action}</li>)
                    ) : complianceBlocksApproval ? (
                      <li className="font-medium text-slate-800">راجع قسم "الامتثال التنظيمي" أدناه لشروط الاستئناف المطلوبة لرفع الإيقاف.</li>
                    ) : (
                      <li>لا توجد توصيات إضافية مطلوبة</li>
                    )}
                  </ul>
                </div>
              </div>

              {aei && aeiStyle && (
                <div className={`rounded-2xl border-2 p-5 space-y-4 ${aeiStyle.bg} ${aeiStyle.border}`}>
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <h3 className={`font-black text-base ${aeiStyle.text}`}>
                      مؤشر التنفيذ المدمج (AEI): {aei.statusLabelAr}
                    </h3>
                    <span className="text-xs font-bold px-3 py-1 rounded-full bg-white/70 text-[#061B40]">
                      التقييم الكلي = {aei.score}
                    </span>
                  </div>

                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                    <div className="bg-white/70 rounded-lg p-2">
                      <div className="text-xs text-[#061B40]/60">النشاط</div>
                      <div className="font-bold text-[#061B40] truncate" title={aei.activityLabelAr}>{aei.activityLabelAr}</div>
                    </div>
                    <div className="bg-white/70 rounded-lg p-2">
                      <div className="text-xs text-[#061B40]/60">درجة السلامة</div>
                      <div className="font-bold text-[#061B40]">{aei.score}</div>
                    </div>
                    <div className="bg-white/70 rounded-lg p-2">
                      <div className="text-xs text-[#061B40]/60">درجة الجودة</div>
                      <div className="font-bold text-[#061B40]">{aei.qualityScore}</div>
                    </div>
                    <div className="bg-white/70 rounded-lg p-2">
                      <div className="text-xs text-[#061B40]/60">التقييم الأولي</div>
                      <div className="font-bold text-[#061B40]">{aei.baseScore}</div>
                    </div>
                  </div>

                  <div>
                    <div className="text-xs font-bold text-[#061B40]/60 mb-1">المبررات</div>
                    <div className="text-sm text-[#061B40]">{aei.shortReasonAr}</div>
                  </div>

                  <div>
                    <div className="text-xs font-bold text-[#061B40]/60 mb-1">التوصية النهائية</div>
                    <div className="text-sm text-[#061B40]">{aei.recommendationAr}</div>
                  </div>

                  {aei.gateReasonAr && (
                    <div className="text-xs font-bold text-red-600 bg-red-50 border border-red-200 rounded-lg p-2 mt-2">
                      {aei.gateReasonAr}
                    </div>
                  )}

                  {aei.closedByGate && (
                    <div className="text-red-600 text-xs font-bold mt-1">
                      تم الإيقاف عبر بوابة حاكمة، دون المرور بحساب الدرجة.
                    </div>
                  )}
                </div>
              )}

              {complianceEntries.map((compliance, entryIdx) => {
                const complianceStyle = COMPLIANCE_DECISION_STYLE[compliance.decisionCategory];
                const entryBlocks =
                  compliance.decisionCategory === 'MANDATORY_STOP' || compliance.decisionCategory === 'STOP_AFFECTED_ACTIVITY';
                return (
                  <div key={entryIdx} className={`rounded-2xl border-2 p-5 space-y-4 ${complianceStyle.bg} ${complianceStyle.border}`}>
                    <div className="flex items-center justify-between flex-wrap gap-2">
                      <h3 className={`font-black text-base flex items-center gap-2 ${complianceStyle.text}`}>
                        <Scale className="w-4.5 h-4.5" /> الامتثال التنظيمي (الرياض)
                        {complianceEntries.length > 1 && (
                          <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-white/70 text-[#061B40]/70">
                            نشاط تنظيمي {entryIdx + 1} من {complianceEntries.length}
                          </span>
                        )}
                      </h3>
                      <span className="text-xs font-bold px-3 py-1 rounded-full bg-white/70 text-[#061B40]">
                        {compliance.decisionLabelAr}
                      </span>
                    </div>

                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                      <div className="bg-white/70 rounded-lg p-2">
                        <div className="text-xs text-[#061B40]/60">فئة المشروع</div>
                        <div className="font-bold text-[#061B40] text-[12px]">
                          {RISK_CLASS_LABEL_AR[compliance.riskClass] ?? compliance.riskClass}
                        </div>
                      </div>
                      <div className="bg-white/70 rounded-lg p-2">
                        <div className="text-xs text-[#061B40]/60">نطاق الرياح</div>
                        <div className="font-bold text-[#061B40] text-[12px]">
                          {WIND_BAND_LABEL_AR[compliance.windBand] ?? compliance.windBand}
                        </div>
                      </div>
                      <div className="bg-white/70 rounded-lg p-2">
                        <div className="text-xs text-[#061B40]/60">درجة الثقة</div>
                        <div className="font-bold text-[#061B40]">{compliance.confidenceScore} · {compliance.confidenceLabelAr}</div>
                      </div>
                      <div className="bg-white/70 rounded-lg p-2 col-span-2 md:col-span-1">
                        <div className="text-xs text-[#061B40]/60">إصدار القواعد</div>
                        <div className="font-bold text-[#061B40] text-[11px]" title={compliance.rulebookVersion}>
                          {formatRulebookVersionAr(compliance.rulebookVersion)}
                        </div>
                      </div>
                    </div>

                    <div>
                      <div className="text-xs font-bold text-[#061B40]/60 mb-1">السبب المباشر</div>
                      <div className="text-sm text-[#061B40]">{compliance.shortReasonAr}</div>
                    </div>

                    {/* توضيح اللبس: نطاق رياح فوق 25 كم/س لكن النشاط مسموح
                        لأنه عملية مغلقة/محكمة الإغلاق مستثناة من بوابة إيقاف
                        الرياح (الإغلاق يمنع تطاير الغبار). بدون هذا التوضيح
                        يبدو "أعلى من 25 كم/س" متناقضاً مع قرار "مسموح". */}
                    {compliance.windBand === 'ABOVE_25' && compliance.isEnclosedOperation && (
                      <div className="text-xs font-bold text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg p-2 flex items-start gap-1.5">
                        <ShieldCheck className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                        <span>رغم أن سرعة الرياح تتجاوز 25 كم/س، فإن هذا النشاط عملية مغلقة (محكمة الإغلاق) ومستثناة تنظيمياً من إيقاف الرياح لأن الإغلاق يمنع تطاير الغبار.</span>
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

                    {compliance.missingCriticalInputs.length > 0 && (
                      <div className="text-xs font-bold text-amber-700 bg-white/70 border border-amber-200 rounded-lg p-2">
                        بيانات ناقصة تحد من دقة القرار: {compliance.missingCriticalInputs.join('، ')}
                      </div>
                    )}

                    {entryBlocks && (
                      <div className="bg-white/60 border border-current/20 p-2 rounded-lg text-[11px] font-bold text-center flex items-center justify-center gap-1">
                        <ShieldAlert className="w-3.5 h-3.5" /> الامتثال التنظيمي يمنع اعتماد التنفيذ الآمن لهذا النشاط
                      </div>
                    )}
                  </div>
                );
              })}

              {details.length > 0 && (
                <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm">
                  <h3 className="text-sm font-black text-slate-700 mb-4 flex items-center gap-2">
                    <ListChecks className="w-4 h-4" /> بيانات الإدخال المرجعية
                  </h3>
                  <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 text-sm text-slate-600">
                    <div className="rounded-xl bg-slate-50 border border-slate-100 p-3">
                      <div className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1">مدة النشاط</div>
                      <div className="font-black text-[#061B40]">{formatHoursLabel(windowEval.durationHours) || '—'}</div>
                    </div>

                    {details.map((item, idx) => (
                      <div key={idx} className="rounded-xl bg-slate-50 border border-slate-100 p-3">
                        <div className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1 truncate" title={item.label}>{item.label}</div>
                        <div className="font-black text-[#061B40]">{formatValue(item.value)}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {displayHourly && displayHourly.length > 0 && (
                <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm space-y-4">
                  <div className="flex items-center justify-between flex-wrap gap-3">
                    <h3 className="text-sm font-black text-[#061B40] flex items-center gap-2">
                      <Clock className="w-4 h-4 text-[#3995FF]" />
                      {hasWorkDayHourly ? 'توقعات الطقس طوال فترة الدوام' : 'التوقعات للساعات القادمة'}
                    </h3>
                    <span className="text-[11px] font-bold text-slate-500 bg-slate-50 px-3 py-1 rounded-full border border-slate-200">
                      إجمالي: {totalHoursLabel}
                    </span>
                  </div>
                  
                  <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
                    {displayHourly.map((h) => {
                      // بوابة الرياح التنظيمية (>25 كم/س) لهذه الساعة تحديداً —
                      // مستقلة عن عتبات DVI الفيزيائي المختلفة، فتُطغى على
                      // مظهر الساعة حتى لو كانت توصية DVI لتلك الساعة آمنة،
                      // لتفادي عرض ساعة "آمنة" رغم إيقاف تنظيمي فعلي فيها.
                      const hourGated = (h as any).regulatoryWindGateActive === true;
                      const hStyle = hourGated
                        ? { bg: 'bg-slate-900/5', border: 'border-slate-700', text: 'text-slate-800' }
                        : getDecisionStyle(h.decisionCategory, h.mandatoryStop);
                      return (
                        <div key={h.time} className={`rounded-2xl border p-3 ${hStyle.bg} ${hStyle.border}`}>
                          <div className="flex items-center justify-between">
                            <div className="text-[10px] font-black uppercase tracking-widest text-slate-400">
                              {HOUR_LABEL_AR(h.time)}
                            </div>
                            <div className={`text-lg font-black ${hStyle.text}`}>
                              {h.score}<span className="text-[9px] font-bold opacity-60">/100</span>
                            </div>
                          </div>
                          <div className={`text-[11px] font-bold ${hStyle.text}`}>{h.decisionLabelAr}</div>

                          {hourGated && (
                            <div className="bg-slate-900 text-white text-[10px] font-black px-2 py-1 rounded-md mt-1.5 flex items-center gap-1">
                              <Scale className="w-3 h-3" /> إيقاف تنظيمي: رياح تتجاوز 25 كم/س
                            </div>
                          )}

                          <div className="mt-2 grid grid-cols-2 gap-1.5">
                            <div className="rounded-lg bg-white/70 border border-black/5 px-2 py-1">
                              <div className="text-[9px] font-bold text-slate-400">مدى الرؤية</div>
                              <div className="text-[11px] font-black text-slate-700" dir="ltr">{fmt2(h.visibilityKm)} كم</div>
                            </div>
                            <div className="rounded-lg bg-white/70 border border-black/5 px-2 py-1">
                              <div className="text-[9px] font-bold text-slate-400">سرعة الرياح</div>
                              <div className="text-[11px] font-black text-slate-700" dir="ltr">{fmt2(h.effectiveWindKmh)} كم/س</div>
                            </div>
                          </div>

                          <div className="text-[10px] text-slate-500 leading-tight mt-2">{h.shortReason}</div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            {!hideDecisionPanel && (
            <div className="bg-white shrink-0 border-t border-slate-200 z-20 shadow-[0_-10px_20px_-10px_rgba(0,0,0,0.05)]">
              {confirmedDecision ? (
                <div className={`p-6 animate-in slide-in-from-bottom-4 fade-in duration-500 ${getConfirmedUI(confirmedDecision.status).bg}`}>
                  <div className="flex items-start gap-4">
                    <div className={`w-12 h-12 rounded-full flex items-center justify-center shrink-0 bg-white shadow-sm border ${getConfirmedUI(confirmedDecision.status).border}`}>
                      <CheckCircle className={`w-6 h-6 ${getConfirmedUI(confirmedDecision.status).iconCol}`} />
                    </div>
                    <div>
                      <h4 className={`text-lg font-black ${getConfirmedUI(confirmedDecision.status).textCol}`}>
                        {getConfirmedUI(confirmedDecision.status).text}
                      </h4>
                      <p className="text-[13px] font-bold text-slate-500 mt-1 flex items-center gap-1.5">
                        <Clock className="w-3.5 h-3.5" />
                        تم حفظ قرارك رسمياً في سجل المشروع الساعة {confirmedDecision.time}
                      </p>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="p-6 animate-in fade-in duration-300">
                  <div className="flex flex-col md:flex-row items-center justify-between gap-4">
                    <div>
                      <p className="text-sm font-black text-[#061B40]">قرارك النهائي (مدير الموقع)</p>
                      <p className="text-[11px] font-bold text-slate-500 mt-0.5">بصفتك المسؤول، اختر الإجراء الأنسب ليتم توثيقه في السجل.</p>
                    </div>

                    <div className="flex gap-2 w-full md:w-auto">
                      {!result.mandatoryStop && !complianceBlocksApproval && (
                        <button
                          disabled={isSaving}
                          onClick={() => saveDecision('safe')}
                          className="flex-1 md:flex-none bg-emerald-600 hover:bg-emerald-700 text-white px-5 py-2.5 rounded-xl text-xs font-bold transition-all shadow-sm flex items-center justify-center gap-1.5"
                        >
                          <CheckCircle2 className="w-4 h-4" /> اعتماد التنفيذ
                        </button>
                      )}
                      {!result.mandatoryStop && !complianceBlocksApproval && (
                        <button
                          disabled={isSaving}
                          onClick={() => saveDecision('caution')}
                          className="flex-1 md:flex-none bg-amber-50 hover:bg-amber-100 text-amber-700 border border-amber-200 px-5 py-2.5 rounded-xl text-xs font-bold transition-all flex items-center justify-center gap-1.5"
                        >
                          <AlertTriangle className="w-4 h-4" /> اعتماد بحذر
                        </button>
                      )}
                      <button
                        disabled={isSaving}
                        onClick={() => saveDecision(isFutureActivity ? 'postpone' : 'stopped')}
                        className="flex-1 md:flex-none bg-red-50 hover:bg-red-100 text-red-600 border border-red-200 px-5 py-2.5 rounded-xl text-xs font-bold transition-all flex items-center justify-center gap-1.5"
                      >
                        <X className="w-4 h-4" /> {isFutureActivity ? 'تأجيل النشاط' : 'إيقاف النشاط'}
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}