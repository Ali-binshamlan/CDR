'use client';

import React, { useState, useEffect } from 'react';
import { apiClient } from '@/app/lib/apiClient';
import {
  X, ArrowUpRight, Gauge, ShieldCheck,
  Clock, AlertTriangle, Printer, CheckCircle2,
  CheckCircle, ShieldAlert, Scale, Wind, Compass, CircleGauge, MapPin,
} from 'lucide-react';
import type { DustComplianceResult, DustComplianceDecisionCategory, SensitiveReceptorType } from '@/app/utils/dust-compliance-engine/types';
import type { AeiEvaluationResult, AeiColor } from '@/app/utils/aei-engine/types';
import { ACTIVITY_LABEL_AR } from '@/app/utils/dust-engine/tables';

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
  /** قد يحمل النشاط الواحد أكثر من نشاط تنظيمي (هدم + كسارة مثلاً) عبر ميزة
   * "إضافة نشاط تنظيمي آخر" — كل عنصر له قرار امتثال مستقل تماماً. */
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
  projectName?: string;
  hideDecisionPanel?: boolean;
  hideSchedule?: boolean;
  windowStartIso?: string;
  windowEndIso?: string;
  durationHours?: number;
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

// ترتيب أولوية القرارات من الأخف إلى الأشد — يُستخدم لاختيار "أسوأ قرار"
// عندما يحمل النشاط الفيزيائي أكثر من نشاط تنظيمي واحد.
const DECISION_SEVERITY_ORDER: DustComplianceDecisionCategory[] = [
  'ALLOW',
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

const getConfirmedUI = (status: string) => {
  switch (status) {
    case 'safe': return { text: 'تم اعتماد النشاط وتوثيقه', bg: 'bg-emerald-50', border: 'border-emerald-200', textCol: 'text-emerald-700', iconCol: 'text-emerald-500' };
    case 'caution': return { text: 'تم اعتماد النشاط مع الحذر', bg: 'bg-amber-50', border: 'border-amber-200', textCol: 'text-amber-700', iconCol: 'text-amber-500' };
    case 'stopped': return { text: 'تم إيقاف النشاط احترازياً', bg: 'bg-red-50', border: 'border-red-200', textCol: 'text-red-700', iconCol: 'text-red-500' };
    case 'postpone': return { text: 'تم تأجيل النشاط احترازياً', bg: 'bg-indigo-50', border: 'border-indigo-200', textCol: 'text-indigo-700', iconCol: 'text-indigo-500' };
    default: return { text: 'تم توثيق القرار', bg: 'bg-slate-50', border: 'border-slate-200', textCol: 'text-slate-700', iconCol: 'text-slate-500' };
  }
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
  projectName,
  hideDecisionPanel = false,
  hideSchedule = false,
  windowStartIso,
  windowEndIso,
  durationHours,
}: ComplianceWidgetCardProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [activeAlert, setActiveAlert] = useState<any>(null);
  const [confirmedDecision, setConfirmedDecision] = useState<{ status: string; time: string } | null>(null);

  const complianceEntries = (complianceList ?? []).filter(Boolean);
  const worst = pickWorstCompliance(complianceEntries);
  // مؤشر AEI هو القرار الموحّد المعروض فعلياً في كل أنحاء البطاقة (العنوان،
  // اللون، البطاقة المطوية، شبكة الساعات) — قرار الامتثال (worst) يبقى
  // مصدر البيانات الداعمة (القواعد/الإجراءات/الأدلة) فقط، وليس عنواناً
  // منافساً. AEI مضمون توفره عملياً (يُمرَّر من الأب دائماً)، لكن نتوقّع
  // غيابه نظرياً فنستخدم أسلوب امتثال محايد كـ fallback أخير فقط.
  const aeiStyle = aei ? getAeiStyle(aei.color) : null;
  const style = aeiStyle ?? (worst ? COMPLIANCE_DECISION_STYLE[worst.decisionCategory] : COMPLIANCE_DECISION_STYLE.ALLOW);
  const hourlyEntries = (complianceHourly ?? []).filter((h) => !!h?.result);

  const complianceBlocksApproval = complianceEntries.some(
    (c) => c.decisionCategory === 'MANDATORY_STOP' || c.decisionCategory === 'STOP_AFFECTED_ACTIVITY'
  );

  const isFutureActivity = !!windowStartIso && new Date(windowStartIso).getTime() > Date.now();

  const activityLabel = (ACTIVITY_LABEL_AR as Record<string, string>)[activityType] ?? EXTENDED_ACTIVITY_LABEL[activityType] ?? activityType;

  useEffect(() => {
    async function fetchInitialData() {
      if (!projectId || !activityId) return;

      // DCR: activity_source مقيَّد بـ CHECK على 'dust' فقط (لا 'dust_compliance'
      // منفصلة كما في مرقاب) — راجع supabase-dcr-full-schema.sql وapp/api/
      // alerts/generate/route.ts. بطاقة DVI الفيزيائية (Dustwidgetcard) مخفاة
      // فعلياً في واجهة DCR فلا يوجد تعارض عملي على نفس activityId.
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
    if (!worst) return;

    setIsSaving(true);
    try {
      await apiClient.post('/decisions', {
        insert: {
          project_id: projectId,
          activity_source: 'dust',
          activity_id: activityId,
          status: dbStatus,
          reason: aei ? `مؤشر قابلية التنفيذ (AEI): ${aei.statusLabelAr}` : `الامتثال التنظيمي: ${worst.decisionLabelAr}`,
          required_action: worst.requiredActions.join('، ') || 'لا توجد متطلبات إضافية',
          approved_by: 'مستخدم النظام (مدير الموقع)',
          approval_note: isFutureActivity && dbStatus === 'postpone' ? 'تم تأجيل النشاط بناءً على التوقعات' : 'قرار ميداني مباشر',
          weather_snapshot: [
            { label: 'سرعة الرياح', value: `${fmt2(worst.evidence.windSpeedKmh)} كم/س` },
            { label: 'اتجاه الرياح', value: formatWindDirectionAr(worst.evidence.windDirectionDeg) },
            { label: 'PM10', value: `${fmt2(worst.evidence.pm10UgM3)} ميكروغرام/م³` },
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

  if (!worst) return null;

  return (
    <>
      <div className="bg-white rounded-[24px] border border-slate-200 shadow-sm hover:shadow-md transition-all duration-300 flex flex-col overflow-hidden relative">
        <div className={`absolute top-0 left-0 w-full h-1 ${style.dot}`}></div>

        {activeAlert && (
          <div className="bg-red-500 text-white text-[10px] font-black px-4 py-1.5 flex items-center gap-2 animate-pulse">
            <ShieldAlert className="w-3.5 h-3.5" />
            يوجد تنبيه أمني نشط لهذا النشاط يرجى المراجعة!
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
                      {new Date(windowStartIso).toLocaleDateString('ar-SA', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Riyadh' })}
                      {' '}
                      {new Date(windowStartIso).toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Riyadh' })}
                      {' ← '}
                      {new Date(windowEndIso).toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Riyadh' })}
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
                  {aei ? `${aei.score} · ${aei.statusLabelAr}` : worst.decisionLabelAr}
                </span>
              </div>
              <p className="text-[11px] font-bold text-slate-600 leading-relaxed">
                {aei ? aei.shortReasonAr : worst.shortReasonAr}
              </p>
              {complianceEntries.length > 1 && (
                <span className="inline-block mt-2 text-[10px] font-bold px-2 py-0.5 rounded-full bg-slate-50 border border-slate-200 text-slate-500">
                  محسوب من أسوأ حالة بين {complianceEntries.length} أنشطة تنظيمية
                </span>
              )}
            </div>
          </div>

          <div className="grid grid-cols-4 gap-2 mb-4">
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
                {fmt2(worst.evidence.pm10UgM3)}
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
          </div>

          <div className="flex items-center gap-2 mt-auto flex-wrap">
            <span className="text-[10px] font-bold px-2 py-1 rounded-lg bg-slate-50 border border-slate-200 text-slate-500">
              درجة الثقة: {worst.confidenceScore} · {worst.confidenceLabelAr}
            </span>
            {aei?.closedByGate && (
              <span className="text-[10px] font-bold px-2 py-1 rounded-lg bg-slate-900/5 border border-slate-700 text-slate-800">
                إيقاف إلزامي
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
                    <div className="font-bold text-[#061B40]" dir="ltr">{fmt2(worst.evidence.pm10UgM3)} / {fmt2(worst.evidence.pm25UgM3)}</div>
                  </div>
                </div>
              </div>

              {/* المستقبِلات حول وحدة الكسارة/الخلاطة تحديداً — تُعرض قبل
                  قائمة المشروع العامة لأنها الأوثق صلة بالقرار: مسافة
                  الكسارة عن مستقبِل سكني/مدرسي/صحي تُفعّل إيقافاً إلزامياً
                  فعلياً، بخلاف قائمة الـ1كم التوعوية. */}
              {unitReceptors && unitReceptors.length > 0 && unitReceptors.map((unit) => (
                <div
                  key={`${unit.unitType}-${unit.lat}-${unit.lng}`}
                  className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm"
                >
                  <h3 className="text-sm font-black text-[#061B40] mb-1 flex items-center gap-2">
                    <MapPin className="w-4 h-4 text-rose-500" />
                    المستقبِلات الحساسة حول {unit.unitLabelAr} (ضمن {unit.radiusM} م من موقعها)
                  </h3>
                  <p className="text-[11px] text-slate-400 mb-4">
                    {unit.hasBindingDistanceRule
                      ? `المسافة تُقاس من موقع ${unit.unitLabelAr} نفسها، لا من حدود المشروع. وجود مستقبِل سكني أو مدرسي أو صحي ضمن ${unit.radiusM} م يُفعّل إيقافاً إلزامياً.`
                      : `المسافة تُقاس من موقع ${unit.unitLabelAr} نفسها، لا من حدود المشروع. عرض توعوي بالجوار الحساس — لا توجد قاعدة مسافة مُلزمة لمحطة الخلط في الدليل التنظيمي الحالي.`}
                  </p>
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

              {/* بطاقة موحّدة واحدة: العنوان والدرجة من AEI (القرار الوحيد
                  المعروض)، وتفاصيل كل نشاط تنظيمي (قواعد/إجراءات/شروط
                  استئناف/التزامات رصد) كأقسام داعمة تحتها — لا بطاقة
                  "امتثال" منفصلة بقرار خاص بها، بطلب صريح بدمج كل القرارات
                  في مؤشر AEI الموحّد. فئة المشروع (risk class) محذوفة عمداً
                  من هذا العرض لأنها غير مهمة للمستخدم. */}
              {aei && aeiStyle && (
                <div className={`rounded-2xl border-2 p-5 space-y-4 ${aeiStyle.bg} ${aeiStyle.border}`}>
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <h3 className={`font-black text-base ${aeiStyle.text}`}>
                      مؤشر قابلية التنفيذ (AEI): {aei.statusLabelAr}
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
                    <div className="text-xs font-bold text-[#061B40]/60 mb-1">السبب المباشر</div>
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
                            {compliance.decisionLabelAr}
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

                        {compliance.monitoringObligations.length > 0 && (
                          <div>
                            <div className="text-xs font-bold text-[#061B40]/60 mb-1">التزامات الرصد</div>
                            <ul className="space-y-1 text-[13px] text-[#061B40]">
                              {compliance.monitoringObligations.map((ob, idx) => {
                                const statusStyle =
                                  ob.status === 'COMPLIANT' ? 'text-emerald-700 bg-emerald-50 border-emerald-200'
                                  : ob.status === 'NON_COMPLIANT' ? 'text-red-700 bg-red-50 border-red-200'
                                  : ob.status === 'NOT_APPLICABLE' ? 'text-slate-500 bg-slate-50 border-slate-200'
                                  : 'text-amber-700 bg-amber-50 border-amber-200';
                                const statusLabel =
                                  ob.status === 'COMPLIANT' ? 'مطابق'
                                  : ob.status === 'NON_COMPLIANT' ? 'غير مطابق'
                                  : ob.status === 'NOT_APPLICABLE' ? 'غير منطبق'
                                  : 'غير معروف';
                                return (
                                  <li key={idx} className={`flex items-center justify-between gap-2 rounded-lg border px-2 py-1.5 ${statusStyle}`}>
                                    <span className="font-medium">{ob.descriptionAr}</span>
                                    <span className="text-[10px] font-black shrink-0">{statusLabel}</span>
                                  </li>
                                );
                              })}
                            </ul>
                          </div>
                        )}

                        {compliance.missingCriticalInputs.length > 0 && (
                          <div className="text-xs font-bold text-amber-700 bg-white border border-amber-200 rounded-lg p-2">
                            بيانات ناقصة تحد من دقة القرار: {compliance.missingCriticalInputs.join('، ')}
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
                        {!complianceBlocksApproval && (
                          <button
                            disabled={isSaving}
                            onClick={() => saveDecision('safe')}
                            className="flex-1 md:flex-none bg-emerald-600 hover:bg-emerald-700 text-white px-5 py-2.5 rounded-xl text-xs font-bold transition-all shadow-sm flex items-center justify-center gap-1.5"
                          >
                            <CheckCircle2 className="w-4 h-4" /> اعتماد التنفيذ
                          </button>
                        )}
                        {!complianceBlocksApproval && (
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
