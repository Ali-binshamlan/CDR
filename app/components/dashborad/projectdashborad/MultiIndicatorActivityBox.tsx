"use client";

import { useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import type { AxiosError } from 'axios';
import { ChevronDown, Wind, CheckCircle2, AlertTriangle, XCircle, Clock3, Pencil, Trash2, Loader2 } from 'lucide-react';
import { apiClient } from '@/app/lib/apiClient';
import { isActivityTimeWithinWorkHours } from '@/app/lib/shiftValidation';
import { useNow } from '@/app/lib/useNow';

// DCR: مؤشر واحد فقط (dust) — لا حرارة ولا رافعات إطلاقاً. النوع يبقى
// اتحاداً (بدل ثابت 'dust' وحده) للتوافق البنيوي مع بقية الملف (summaries[]
// قد تتوسع مستقبلاً)، لكن القيمة الفعلية الوحيدة الممكنة اليوم هي 'dust'.
export interface IndicatorSummary {
  kind: 'dust';
  label: string;
  decisionLabel: string;
  riskWeight: number;
  reasonText?: string;
}

// DCR: مصدر واحد فقط (dust) — لا 'heat'/'crane' كما في مرقاب.
export interface UnifiedDecisionTarget {
  projectId: string;
  activityId: string;
  source: 'dust';
  reason: string;
  requiredAction: string;
  weatherSnapshot: { label: string; value: string }[];
}

// 1. إصلاح مشكلة اللون الأخضر عند وجود إيقاف إلزامي
//
// أربع درجات متمايزة بصرياً (لا ثلاث) — إيقاف إلزامي مؤكَّد (mandatoryStop
// الحقيقي، weight=4، أسود) يجب أن يظهر بلون مختلف تماماً عن حالة معلَّقة/
// موقوفة مؤقتاً بانتظار تأكيد (weight=3، أحمر) رغم أن كليهما "إيقاف" —
// الأول قرار نهائي غير قابل للتجاوز، والثاني مؤقت قد يتحول تلقائياً خلال
// دقائق. كانا يتساويان سابقاً (كلاهما أحمر) لأن weight توقّف عند 3 فقط.
function overallBannerStyle(weight: number, mandatoryStop: boolean) {
  if (mandatoryStop || weight >= 4) return { bg: 'bg-slate-900/5', text: 'text-slate-800', border: 'border-slate-700', soft: 'border-slate-700/40', dot: 'bg-slate-800' };
  if (weight >= 3) return { bg: 'bg-red-50', text: 'text-red-800', border: 'border-red-200', soft: 'border-red-200/60', dot: 'bg-red-600' };
  if (weight >= 2) return { bg: 'bg-orange-50', text: 'text-orange-800', border: 'border-orange-200', soft: 'border-orange-200/60', dot: 'bg-orange-500' };
  if (weight >= 1) return { bg: 'bg-amber-50', text: 'text-amber-800', border: 'border-amber-200', soft: 'border-amber-200/60', dot: 'bg-amber-500' };
  return { bg: 'bg-emerald-50', text: 'text-emerald-800', border: 'border-emerald-200', soft: 'border-emerald-200/60', dot: 'bg-emerald-500' };
}

function kindIcon(_kind: IndicatorSummary['kind']) {
  return <Wind className="w-3.5 h-3.5" />;
}

function reasonIcon(weight: number, mandatoryStop: boolean) {
  if (mandatoryStop || weight >= 3) return <XCircle className="w-3.5 h-3.5 text-red-600 shrink-0" />;
  if (weight >= 2) return <AlertTriangle className="w-3.5 h-3.5 text-orange-600 shrink-0" />;
  return <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />;
}

// تنسيق الدقائق إلى نص ساعات عربي، مطابق للدالة المستخدمة سابقاً داخل بطاقات المؤشرات
function formatMinutesToHoursLabel(mins?: number | null): string {
  if (mins === undefined || mins === null || mins <= 0) return '—';
  const hours = mins / 60;
  if (hours === 1) return 'ساعة واحدة';
  if (hours === 2) return 'ساعتان';
  if (hours % 1 === 0) {
    if (hours >= 3 && hours <= 10) return `${hours} ساعات`;
    return `${hours} ساعة`;
  }
  return `${hours.toFixed(1)} ساعة`;
}

function formatRelativeAr(diffMs: number): string {
  const mins = Math.round(Math.abs(diffMs) / 60000);
  if (mins < 60) return `${mins} دقيقة`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} ساعة`;
  const days = Math.round(hours / 24);
  return `${days} يوم`;
}

export default function MultiIndicatorActivityBox({
  activityTitle,
  summaries,
  children,
  defaultOpen = false,
  decisionTargets = [],
  mandatoryStop = false,
  // isFutureActivity: يُستقبَل (page.tsx يمرره فعلياً) بلا استخدام داخلي
  // حالياً هنا — إبقاؤه في التوقيع للتوافق مع الاستدعاء الحالي بلا تغيير
  // واجهة المكوّن، بادئة _ لتفادي تحذير المتغير غير المستخدَم.
  isFutureActivity: _isFutureActivity = false,
  windowStartIso,
  windowEndIso,
  durationMinutes,
  workHoursStart = null,
  workHoursEnd = null,
  onDeleted,
  onEdited,
}: {
  activityTitle: string;
  summaries: IndicatorSummary[];
  children: React.ReactNode;
  defaultOpen?: boolean;
  decisionTargets?: UnifiedDecisionTarget[];
  mandatoryStop?: boolean;
  isFutureActivity?: boolean;
  /** بداية نافذة النشاط (ISO UTC) — تُستخدم أيضاً لتعبئة نموذج تعديل الزمن مبدئياً */
  windowStartIso?: string;
  /** نهاية نافذة النشاط (ISO UTC) */
  windowEndIso?: string;
  /** مدة النشاط بالدقائق، تُستخدم إن لم تُشتق المدة من الفارق بين البداية والنهاية */
  durationMinutes?: number;
  /** أوقات دوام المشروع الرسمية (project.work_hours_start/end من GET
   * /api/projects/[id]) — تُستخدم لعرض توضيحي وتحقق فوري في نموذج التعديل
   * قبل إرسال الطلب للسيرفر (الذي يتحقق أيضاً بنفس المنطق، راجع
   * app/lib/shiftValidation.ts). null/undefined = لا قيد (مشروع لم يحدّد
   * أوقات دوام بعد). */
  workHoursStart?: string | null;
  workHoursEnd?: string | null;
  /** يُستدعى بعد نجاح الحذف فعلياً من قاعدة البيانات، ليقوم الأب بإزالة هذا النشاط من القائمة المعروضة */
  onDeleted?: () => void;
  /** يُستدعى بعد نجاح تعديل الزمن، ليُحدّث الأب بيانات الصفحة (نفس دور onDeleted) */
  onEdited?: () => void;
}) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isDeleted, setIsDeleted] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [isSavingEdit, setIsSavingEdit] = useState(false);
  const router = useRouter();

  // تحويل windowStartIso/windowEndIso (UTC) إلى تاريخ/وقت محلي بتوقيت
  // الرياض لتعبئة نموذج التعديل — نفس منطق toLocaleDateString/TimeString
  // أعلى الملف (calendar: 'gregory' صراحةً لنفس سبب scheduleInfo أدناه).
  const riyadhDatePart = (iso: string) => {
    const d = new Date(new Date(iso).getTime() + 3 * 3600000);
    return d.toISOString().slice(0, 10);
  };
  const riyadhTimePart = (iso: string) => {
    const d = new Date(new Date(iso).getTime() + 3 * 3600000);
    return d.toISOString().slice(11, 16);
  };

  const [editDate, setEditDate] = useState(() => (windowStartIso ? riyadhDatePart(windowStartIso) : ''));
  const [editStartTime, setEditStartTime] = useState(() => (windowStartIso ? riyadhTimePart(windowStartIso) : ''));
  const [editEndTime, setEditEndTime] = useState(() => (windowEndIso ? riyadhTimePart(windowEndIso) : ''));

  const openEdit = () => {
    if (windowStartIso) setEditDate(riyadhDatePart(windowStartIso));
    if (windowStartIso) setEditStartTime(riyadhTimePart(windowStartIso));
    if (windowEndIso) setEditEndTime(riyadhTimePart(windowEndIso));
    setIsEditing(true);
  };

  const handleSaveEdit = async () => {
    if (decisionTargets.length === 0) return;
    if (!editDate || !editStartTime || !editEndTime) {
      alert('حدد التاريخ ووقت البداية ووقت النهاية.');
      return;
    }
    const toMin = (hhmm: string) => {
      const [h, m] = hhmm.split(':').map(Number);
      return (h || 0) * 60 + (m || 0);
    };
    const durationHours = (toMin(editEndTime) - toMin(editStartTime)) / 60;
    if (durationHours <= 0) {
      alert('وقت النهاية يجب أن يكون بعد وقت البداية.');
      return;
    }

    // تحقق فوري بالواجهة قبل الإرسال — نفس منطق shiftValidation.ts المطبَّق
    // أيضاً بالسيرفر (PATCH /api/activities) كخط دفاع حقيقي. لا قيد إن لم
    // يحدّد المشروع أوقات دوام رسمية بعد (workHoursStart/End فارغتان).
    if (!isActivityTimeWithinWorkHours(workHoursStart, workHoursEnd, editStartTime, durationHours)) {
      alert(`وقت النشاط اليومي يجب أن يقع ضمن أوقات دوام المشروع (${(workHoursStart || '').slice(0, 5)} – ${(workHoursEnd || '').slice(0, 5)}).`);
      return;
    }

    setIsSavingEdit(true);
    try {
      // تحقق الملكية والتحديث الفعلي مسؤولية PATCH /api/activities على
      // الخادم (supabaseAdmin) — راجع app/api/activities/route.ts. يحدّث
      // كل صفوف project_dust_profiles المشتركة في هذا النشاط (decisionTargets)
      // بنفس القيم الجديدة دفعة واحدة.
      await apiClient.patch('/activities', {
        targets: decisionTargets.map((t) => ({ projectId: t.projectId, activityId: t.activityId })),
        plannedDate: editDate,
        plannedTime: editStartTime,
        durationHours,
      });

      setIsEditing(false);
      onEdited?.();
      router.refresh();
    } catch (error) {
      console.error('خطأ أثناء تعديل زمن النشاط:', error);
      const err = error as AxiosError<{ error?: string }>;
      alert(err?.response?.data?.error || 'حدث خطأ أثناء تعديل زمن النشاط.');
    } finally {
      setIsSavingEdit(false);
    }
  };

  const sortedSummaries = useMemo(
    () => [...summaries].sort((a, b) => b.riskWeight - a.riskWeight),
    [summaries]
  );
  
  const driverSummary = sortedSummaries[0];
  // استخدام الدالة المحدثة لضمان اللون الأحمر في حالة الإيقاف
  const bannerStyle = overallBannerStyle(driverSummary?.riskWeight ?? 0, mandatoryStop);

  // معلومات النشاط العامة (توقيت وحالة) — تُحسب مرة واحدة هنا بدلاً من تكرارها داخل كل بطاقة مؤشر
  const hasSchedule = Boolean(windowStartIso && windowEndIso);
  // "الآن" كقيمة حالة متحدّثة دورياً (لا Date.now() مباشر أثناء useMemo) —
  // يكفي تحديث كل دقيقة لحالة "قادم/جارٍ/انتهى" أدناه.
  const nowTs = useNow(60000);
  const scheduleInfo = useMemo(() => {
    if (!hasSchedule) return null;
    const start = new Date(windowStartIso as string);
    const end = new Date(windowEndIso as string);
    const startTs = start.getTime();
    const endTs = end.getTime();
    const status: 'upcoming' | 'ongoing' | 'past' = nowTs < startTs ? 'upcoming' : nowTs <= endTs ? 'ongoing' : 'past';
    const derivedDurationMinutes = durationMinutes ?? Math.round((endTs - startTs) / 60000);

    // calendar: 'gregory' صراحةً — بعض المتصفحات (Edge/Windows) تجعل ar-SA
    // تعرض بالتقويم الهجري (أم القرى) افتراضياً، فيظهر يوم مختلف تماماً عن
    // التاريخ الميلادي المقصود (مثال: ٢٦ يوليو ميلادي يظهر "٦" هجري). نُثبّت
    // الميلادي حتى يتطابق العرض مع planned_date المخزَّن في كل البيئات.
    const dateLabel = start.toLocaleDateString('ar-SA', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Riyadh', calendar: 'gregory' });
    const startLabel = start.toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Riyadh', calendar: 'gregory' });
    const endLabel = end.toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Riyadh', calendar: 'gregory' });

    let statusLabel: string;
    let statusColor: string;
    // نشاط منتهٍ فعلياً (status==='past') يجب أن يعرض "انتهى منذ..." دائماً
    // بصرف النظر عن mandatoryStop — تلك حالة إيقاف حية مبنية على طقس هذه
    // اللحظة، لا تنطبق على نشاط لم يعد قائماً أصلاً. يجب فحص status==='past'
    // قبل mandatoryStop، وإلا يظهر "إيقاف إلزامي نظامي" بجانب الساعة لنشاط
    // منتهى من دقائق/ساعات رغم أن القرار الموحد أسفله يعرض "انتهى النشاط".
    if (status === 'past') {
      statusLabel = `انتهى منذ ${formatRelativeAr(nowTs - endTs)}`;
      statusColor = 'text-slate-400';
    } else if (mandatoryStop) {
      statusLabel = '● إيقاف إلزامي نظامي';
      statusColor = 'text-red-600';
    } else if (status === 'ongoing') {
      statusLabel = '● جارٍ الآن';
      statusColor = 'text-emerald-600';
    } else {
      statusLabel = `يبدأ خلال ${formatRelativeAr(startTs - nowTs)}`;
      statusColor = 'text-blue-600';
    }

    return {
      dateLabel,
      startLabel,
      endLabel,
      durationLabel: formatMinutesToHoursLabel(derivedDurationMinutes),
      statusLabel,
      statusColor,
      status,
    };
  }, [hasSchedule, windowStartIso, windowEndIso, durationMinutes, mandatoryStop, nowTs]);

  const handleDelete = async () => {
    if (decisionTargets.length === 0) return;
    const confirmed = window.confirm(
      'سيتم حذف هذا النشاط وكل مؤشراته نهائياً من النظام، ولن يظهر بعدها في أي تقارير أو سجلات قادمة. هل أنت متأكد؟'
    );
    if (!confirmed) return;

    setIsDeleting(true);
    try {
      // تحقق الملكية والحذف الفعلي (row count) صارا مسؤولية
      // DELETE /api/activities على الخادم (supabaseAdmin) — راجع
      // app/api/activities/route.ts للتفاصيل، بدل الاعتماد على RLS هنا
      await apiClient.delete('/activities', {
        data: {
          targets: decisionTargets.map((t) => ({
            projectId: t.projectId,
            activityId: t.activityId,
            source: t.source,
          })),
        },
      });

      setIsDeleted(true);
      onDeleted?.();
      // نحدّث بيانات الصفحة (Server Component) عشان أي عدّادات أو أقسام
      // ثانية بالصفحة تعتمد على نفس البيانات المحذوفة تتحدث بدون Reload كامل
      router.refresh();
    } catch (error) {
      console.error('خطأ أثناء حذف النشاط:', error);
      alert('حدث خطأ أثناء حذف النشاط. راجع صلاحيات قاعدة البيانات (RLS) على جداول الأنشطة إن استمرت المشكلة.');
    } finally {
      setIsDeleting(false);
    }
  };

  if (isDeleted) {
    return (
      <div className="bg-slate-50 rounded-2xl border border-dashed border-slate-300 p-5 mb-6 text-center">
        <p className="text-[13px] font-bold text-slate-500">تم حذف هذا النشاط.</p>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden mb-6">
      <div className="p-5">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="font-black text-[#061B40] text-[15px]">{activityTitle}</h3>
            <p className="text-[11px] font-bold text-slate-400 mt-0.5">تقييم مدمج لـ {summaries.length} مؤشرات</p>

            {scheduleInfo && (
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                <p className="text-[11px] font-bold text-slate-500 flex items-center gap-1.5" dir="ltr">
                  <Clock3 className="w-3.5 h-3.5" />
                  <span dir="rtl">
                    {scheduleInfo.dateLabel} {scheduleInfo.startLabel} {' ← '} {scheduleInfo.endLabel} ({scheduleInfo.durationLabel})
                  </span>
                </p>
                <span className={`text-[11px] font-black ${scheduleInfo.statusColor}`}>{scheduleInfo.statusLabel}</span>
              </div>
            )}
          </div>

          {/* تعديل زمن النشاط: مخفي لنشاط منتهٍ فعلياً (لا معنى لتعديل زمن
              نافذة انقضت أصلاً) — الحذف يبقى متاحاً دائماً بصرف النظر عن
              حالة النشاط. */}
          <div className="flex items-center gap-2 shrink-0">
            {scheduleInfo?.status !== 'past' && (
              <button
                type="button"
                onClick={openEdit}
                className="flex items-center gap-1.5 text-[11px] font-bold text-slate-500 bg-slate-50 hover:bg-slate-100 border border-slate-200 px-3 py-1.5 rounded-lg transition-colors"
              >
                <Pencil className="w-3.5 h-3.5" /> تعديل
              </button>
            )}
            <button
              type="button"
              disabled={isDeleting}
              onClick={handleDelete}
              className="flex items-center gap-1.5 text-[11px] font-bold text-red-600 bg-red-50 hover:bg-red-100 border border-red-200 px-3 py-1.5 rounded-lg transition-colors disabled:opacity-60"
            >
              {isDeleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
              حذف
            </button>
          </div>
        </div>

        {/* لوحة تعديل زمن النشاط — تاريخ + وقت بداية/نهاية فقط (طلب صريح
            من المستخدم: "التعديل يكون على زمن النشاط")، لا موقع/ضوابط/نوع.
            تحدّث كل صفوف project_dust_profiles المشتركة في هذا النشاط
            (decisionTargets) دفعة واحدة عبر PATCH /api/activities. */}
        {isEditing && (
          <div className="mb-4 rounded-xl border border-blue-200 bg-blue-50/50 p-4 space-y-3">
            <p className="text-[12px] font-black text-[#061B40]">تعديل زمن النشاط</p>
            {workHoursStart && workHoursEnd && (
              <p className="text-[11px] font-bold text-slate-500">
                أوقات دوام المشروع: {workHoursStart.slice(0, 5)}–{workHoursEnd.slice(0, 5)} — يجب أن يقع النشاط بالكامل ضمنها.
              </p>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="text-[10px] font-bold text-slate-500 block mb-1">التاريخ</label>
                <input
                  type="date"
                  value={editDate}
                  onChange={(e) => setEditDate(e.target.value)}
                  className="w-full text-[12px] font-bold border border-slate-200 rounded-lg px-2.5 py-1.5 bg-white"
                />
              </div>
              <div>
                <label className="text-[10px] font-bold text-slate-500 block mb-1">وقت البداية</label>
                <input
                  type="time"
                  value={editStartTime}
                  onChange={(e) => setEditStartTime(e.target.value)}
                  className="w-full text-[12px] font-bold border border-slate-200 rounded-lg px-2.5 py-1.5 bg-white"
                />
              </div>
              <div>
                <label className="text-[10px] font-bold text-slate-500 block mb-1">وقت النهاية</label>
                <input
                  type="time"
                  value={editEndTime}
                  onChange={(e) => setEditEndTime(e.target.value)}
                  className="w-full text-[12px] font-bold border border-slate-200 rounded-lg px-2.5 py-1.5 bg-white"
                />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={isSavingEdit}
                onClick={handleSaveEdit}
                className="flex items-center gap-1.5 text-[11px] font-bold text-white bg-[#0176FB] hover:bg-[#0176FB]/90 px-4 py-1.5 rounded-lg transition-colors disabled:opacity-60"
              >
                {isSavingEdit ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                حفظ
              </button>
              <button
                type="button"
                disabled={isSavingEdit}
                onClick={() => setIsEditing(false)}
                className="text-[11px] font-bold text-slate-500 bg-white hover:bg-slate-100 border border-slate-200 px-4 py-1.5 rounded-lg transition-colors"
              >
                إلغاء
              </button>
            </div>
          </div>
        )}

        {/* القرار الموحد - تصميم واضح وصارم
            نشاط منتهٍ فعلياً (نافذته الزمنية انقضت، scheduleInfo.status
            === 'past') لا يجوز أن يعرض قراراً حياً مبنياً على طقس/DVI هذه
            اللحظة (قد يظهر "إيقاف إلزامي نظامي" بنقطة نابضة حمراء لنشاط
            انتهى من دقائق ولا حاجة لأي إجراء بشأنه) — نعرض بدلاً عنه حالة
            محايدة واضحة "انتهى النشاط" بلا أي قرار تشغيلي أو نبض تنبيهي. */}
        {driverSummary && scheduleInfo?.status === 'past' && (
          <div className="rounded-xl border p-5 bg-slate-50 border-slate-200">
            <div className="flex items-center gap-2 mb-1">
              <span className="w-2 h-2 rounded-full shrink-0 bg-slate-400" />
              <span className="text-[11px] font-black uppercase tracking-wide opacity-80 text-slate-500">القرار الموحد للنشاط</span>
            </div>

            <p className="text-xl font-black mb-1 text-slate-600">انتهى النشاط</p>
            <p className="text-[12px] font-bold text-slate-500">
              انقضت نافذة تنفيذ هذا النشاط ({scheduleInfo.statusLabel}) — لا يوجد قرار تشغيلي حالي بشأنه.
            </p>
          </div>
        )}

        {driverSummary && scheduleInfo?.status !== 'past' && (
          <div className={`rounded-xl border p-5 ${bannerStyle.bg} ${bannerStyle.border}`}>
            <div className="flex items-center gap-2 mb-1">
              <span className={`w-2 h-2 rounded-full shrink-0 ${bannerStyle.dot} ${mandatoryStop ? 'animate-pulse' : ''}`} />
              <span className={`text-[11px] font-black uppercase tracking-wide opacity-80 ${bannerStyle.text}`}>القرار الموحد للنشاط</span>
            </div>

            <p className={`text-xl font-black mb-4 ${bannerStyle.text}`}>
              {mandatoryStop ? 'إيقاف إلزامي نظامي' : driverSummary.decisionLabel}
            </p>

            {sortedSummaries.some((s) => !!s.reasonText) && (
              <div className={`rounded-lg border px-3 py-2 mb-4 bg-white/40 ${bannerStyle.soft}`}>
                <p className={`text-[12px] font-bold leading-relaxed ${bannerStyle.text}`}>
                  موجز التوصية:{' '}
                  {sortedSummaries
                    .map((s) => `${s.label}: ${s.reasonText || s.decisionLabel}`)
                    .join('، كما أن ')}
                  .
                </p>
              </div>
            )}

            <div className={`pt-4 border-t ${bannerStyle.soft} space-y-2`}>
              <p className={`text-[10px] font-black uppercase tracking-wide opacity-70 ${bannerStyle.text}`}>حالة المؤشرات الحالية</p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {sortedSummaries.map((s, idx) => (
                  <div key={idx} className={`flex items-center gap-2 text-[12px] font-bold bg-white/40 p-2 rounded-lg border ${bannerStyle.soft} ${bannerStyle.text}`}>
                    {reasonIcon(s.riskWeight, mandatoryStop && idx === 0)}
                    <span className="flex-1 truncate">{s.label}: {s.decisionLabel}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* زر إظهار/إخفاء التفاصيل النظيفة */}
      <button
        type="button"
        onClick={() => setIsOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-3 px-5 py-4 border-t border-slate-100 text-right hover:bg-slate-50 transition-colors bg-slate-50/50"
      >
        <span className="flex items-center gap-2 text-[13px] font-black text-[#061B40]">
          تفاصيل الأرقام والتحليلات للمؤشرات المدمجة
          <span className="flex items-center gap-1">
            {sortedSummaries.map((s, idx) => (
              <span key={idx} className="text-slate-400">{kindIcon(s.kind)}</span>
            ))}
          </span>
        </span>
        <ChevronDown className={`w-5 h-5 text-slate-400 shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && (
        <div className="border-t border-slate-100 bg-slate-100/30 p-5 space-y-6">
          {children}
        </div>
      )}
    </div>
  );
}