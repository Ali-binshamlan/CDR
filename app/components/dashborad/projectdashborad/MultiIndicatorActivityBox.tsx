"use client";

import { useState, useEffect, useMemo, Children, cloneElement, isValidElement } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronDown, Wind, CheckCircle2, AlertTriangle, XCircle, X, CheckCircle, Clock3, Pencil, Trash2, Loader2 } from 'lucide-react';
import { apiClient } from '@/app/lib/apiClient';

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

// DCR: activity_source مقيَّد بـ CHECK على 'dust' فقط في decision_records
// (راجع supabase-dcr-full-schema.sql) — لا 'heat'/'crane' كما في مرقاب.
export interface UnifiedDecisionTarget {
  projectId: string;
  activityId: string;
  source: 'dust';
  reason: string;
  requiredAction: string;
  weatherSnapshot: { label: string; value: string }[];
}

type DecisionStatus = 'safe' | 'caution' | 'restricted' | 'postpone' | 'stopped';

// 1. إصلاح مشكلة اللون الأخضر عند وجود إيقاف إلزامي
function overallBannerStyle(weight: number, mandatoryStop: boolean) {
  if (mandatoryStop || weight >= 3) return { bg: 'bg-red-50', text: 'text-red-800', border: 'border-red-200', soft: 'border-red-200/60', dot: 'bg-red-600' };
  if (weight >= 2) return { bg: 'bg-orange-50', text: 'text-orange-800', border: 'border-orange-200', soft: 'border-orange-200/60', dot: 'bg-orange-500' };
  if (weight >= 1) return { bg: 'bg-amber-50', text: 'text-amber-800', border: 'border-amber-200', soft: 'border-amber-200/60', dot: 'bg-amber-500' };
  return { bg: 'bg-emerald-50', text: 'text-emerald-800', border: 'border-emerald-200', soft: 'border-emerald-200/60', dot: 'bg-emerald-500' };
}

function kindIcon(kind: IndicatorSummary['kind']) {
  return <Wind className="w-3.5 h-3.5" />;
}

function reasonIcon(weight: number, mandatoryStop: boolean) {
  if (mandatoryStop || weight >= 3) return <XCircle className="w-3.5 h-3.5 text-red-600 shrink-0" />;
  if (weight >= 2) return <AlertTriangle className="w-3.5 h-3.5 text-orange-600 shrink-0" />;
  return <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />;
}

const getConfirmedUI = (status: string) => {
  switch (status) {
    case 'safe': return { text: 'تم اعتماد النشاط وتوثيقه', bg: 'bg-emerald-50', border: 'border-emerald-200', textCol: 'text-emerald-700', iconCol: 'text-emerald-500' };
    case 'caution': return { text: 'تم اعتماد النشاط مع الحذر', bg: 'bg-amber-50', border: 'border-amber-200', textCol: 'text-amber-700', iconCol: 'text-amber-500' };
    case 'stopped': return { text: 'تم إيقاف النشاط احترازياً', bg: 'bg-red-50', border: 'border-red-200', textCol: 'text-red-700', iconCol: 'text-red-500' };
    case 'postpone': return { text: 'تم تأجيل النشاط احترازياً', bg: 'bg-indigo-50', border: 'border-indigo-200', textCol: 'text-indigo-700', iconCol: 'text-indigo-500' };
    default: return { text: 'تم توثيق القرار', bg: 'bg-slate-50', border: 'border-slate-200', textCol: 'text-slate-700', iconCol: 'text-slate-500' };
  }
};

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
  isFutureActivity = false,
  windowStartIso,
  windowEndIso,
  durationMinutes,
  onEdit,
  onDeleted,
}: {
  activityTitle: string;
  summaries: IndicatorSummary[];
  children: React.ReactNode;
  defaultOpen?: boolean;
  decisionTargets?: UnifiedDecisionTarget[];
  mandatoryStop?: boolean;
  isFutureActivity?: boolean;
  /** بداية نافذة النشاط (ISO UTC) — تُعرض في معلومات النشاط العامة فقط، وليست داخل بطاقات المؤشرات */
  windowStartIso?: string;
  /** نهاية نافذة النشاط (ISO UTC) */
  windowEndIso?: string;
  /** مدة النشاط بالدقائق، تُستخدم إن لم تُشتق المدة من الفارق بين البداية والنهاية */
  durationMinutes?: number;
  /** يُستدعى عند الضغط على "تعديل" — الأب (page.tsx) هو من يملك نموذج التعديل الفعلي ويقرر كيف يفتحه */
  onEdit?: () => void;
  /** يُستدعى بعد نجاح الحذف فعلياً من قاعدة البيانات، ليقوم الأب بإزالة هذا النشاط من القائمة المعروضة */
  onDeleted?: () => void;
}) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isDeleted, setIsDeleted] = useState(false);
  const [confirmedDecision, setConfirmedDecision] = useState<{ status: string; time: string } | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const router = useRouter();

  const hasDecisionTargets = decisionTargets.length > 0;

  const sortedSummaries = useMemo(
    () => [...summaries].sort((a, b) => b.riskWeight - a.riskWeight),
    [summaries]
  );
  
  const driverSummary = sortedSummaries[0];
  // استخدام الدالة المحدثة لضمان اللون الأحمر في حالة الإيقاف
  const bannerStyle = overallBannerStyle(driverSummary?.riskWeight ?? 0, mandatoryStop);

  // معلومات النشاط العامة (توقيت وحالة) — تُحسب مرة واحدة هنا بدلاً من تكرارها داخل كل بطاقة مؤشر
  const hasSchedule = Boolean(windowStartIso && windowEndIso);
  const scheduleInfo = useMemo(() => {
    if (!hasSchedule) return null;
    const start = new Date(windowStartIso as string);
    const end = new Date(windowEndIso as string);
    const nowTs = Date.now();
    const startTs = start.getTime();
    const endTs = end.getTime();
    const status: 'upcoming' | 'ongoing' | 'past' = nowTs < startTs ? 'upcoming' : nowTs <= endTs ? 'ongoing' : 'past';
    const derivedDurationMinutes = durationMinutes ?? Math.round((endTs - startTs) / 60000);

    const dateLabel = start.toLocaleDateString('ar-SA', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Riyadh' });
    const startLabel = start.toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Riyadh' });
    const endLabel = end.toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Riyadh' });

    let statusLabel: string;
    let statusColor: string;
    if (mandatoryStop) {
      statusLabel = '● إيقاف إلزامي نظامي';
      statusColor = 'text-red-600';
    } else if (status === 'ongoing') {
      statusLabel = '● جارٍ الآن';
      statusColor = 'text-emerald-600';
    } else if (status === 'past') {
      statusLabel = `انتهى منذ ${formatRelativeAr(nowTs - endTs)}`;
      statusColor = 'text-slate-400';
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
  }, [hasSchedule, windowStartIso, windowEndIso, durationMinutes, mandatoryStop]);

  useEffect(() => {
    async function fetchLatestDecision() {
      if (!hasDecisionTargets) return;
      try {
        const targets = decisionTargets.map((t) => ({
          projectId: t.projectId,
          activityId: t.activityId,
          activitySource: t.source,
        }));
        const { data } = await apiClient.get('/decisions', {
          params: { targets: JSON.stringify(targets) },
        });
        const latest = data?.data;
        if (latest) {
          setConfirmedDecision({
            status: latest.status,
            time: new Date(latest.created_at).toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit' }),
          });
        }
      } catch (error) {
        console.error('فشل جلب القرار الموحد:', error);
      }
    }
    fetchLatestDecision();
  }, [decisionTargets.map((t) => `${t.projectId}-${t.activityId}-${t.source}`).join('|')]);

  const saveDecision = async (status: DecisionStatus) => {
    if (!hasDecisionTargets) return;
    setIsSaving(true);
    try {
      const inserts = decisionTargets.map((t) => ({
        project_id: t.projectId,
        activity_source: t.source,
        activity_id: t.activityId,
        status,
        reason: t.reason,
        required_action: t.requiredAction || 'لا توجد متطلبات إضافية',
        approved_by: 'مستخدم النظام (مدير الموقع)',
        approval_note: 'قرار موحد لنشاط متعدد المؤشرات',
        weather_snapshot: t.weatherSnapshot,
      }));
      await apiClient.post('/decisions', { inserts });

      setConfirmedDecision({
        status,
        time: new Date().toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit' }),
      });
      setRefreshKey((k) => k + 1);
    } catch (error) {
      console.error('خطأ أثناء حفظ القرار الموحد:', error);
      alert('حدث خطأ أثناء حفظ القرار.');
    } finally {
      setIsSaving(false);
    }
  };

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

  // -----------------------------------------------------------
  // زر الحذف لا يظهر إلا لو انتهى وقت تنفيذ النشاط فعلياً (تفاديًا
  // لحذف نشاط جارٍ أو مجدول بالخطأ) — أو لا يوجد جدول زمني معروف له
  // أصلاً، فلا يوجد أساس لمنع الحذف. التعديل يبقى متاحاً دائماً.
  // -----------------------------------------------------------
  const canDelete = !scheduleInfo || scheduleInfo.status === 'past';

  // 2. تحديث المكونات الأبناء لتتفاعل مع الحفظ (تم إزالة حقن الخاصية لأن page.tsx تتولى ذلك)
  const keyedChildren = useMemo(
    () =>
      Children.map(children, (child, idx) =>
        isValidElement(child)
          ? cloneElement(child as React.ReactElement<any>, { 
              key: `${child.key ?? idx}-r${refreshKey}`
            })
          : child
      ),
    [children, refreshKey]
  );

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

          {/* تعديل وحذف النشاط — الحذف يظهر فقط بعد انتهاء وقت تنفيذ النشاط فعلياً */}
          <div className="flex items-center gap-2 shrink-0">
            {onEdit && (
              <button
                type="button"
                onClick={onEdit}
                className="flex items-center gap-1.5 text-[11px] font-bold text-slate-500 bg-slate-50 hover:bg-slate-100 border border-slate-200 px-3 py-1.5 rounded-lg transition-colors"
              >
                <Pencil className="w-3.5 h-3.5" /> تعديل
              </button>
            )}
            {canDelete && (
              <button
                type="button"
                disabled={isDeleting}
                onClick={handleDelete}
                className="flex items-center gap-1.5 text-[11px] font-bold text-red-600 bg-red-50 hover:bg-red-100 border border-red-200 px-3 py-1.5 rounded-lg transition-colors disabled:opacity-60"
              >
                {isDeleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                حذف
              </button>
            )}
          </div>
        </div>

        {/* القرار الموحد - تصميم واضح وصارم */}
        {driverSummary && (
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

            {hasDecisionTargets && (
              <div className={`mt-4 pt-4 border-t ${bannerStyle.soft}`}>
                {confirmedDecision ? (
                  <div className="flex items-center gap-3">
                    <div className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 bg-white shadow-sm border ${getConfirmedUI(confirmedDecision.status).border}`}>
                      <CheckCircle className={`w-5 h-5 ${getConfirmedUI(confirmedDecision.status).iconCol}`} />
                    </div>
                    <div>
                      <p className={`text-[13px] font-black ${bannerStyle.text}`}>{getConfirmedUI(confirmedDecision.status).text}</p>
                      <p className={`text-[10px] font-bold mt-0.5 opacity-80 flex items-center gap-1 ${bannerStyle.text}`}>
                        <Clock3 className="w-3 h-3" /> تم التوثيق الساعة {confirmedDecision.time}
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
                    <p className={`text-[11px] font-bold opacity-90 ${bannerStyle.text}`}>اختر إجراء واحداً ليتم اعتماده على النشاط ككل:</p>
                    <div className="flex gap-2">
                      {!mandatoryStop && (
                        <button
                          disabled={isSaving}
                          onClick={() => saveDecision('safe')}
                          className="flex-1 sm:flex-none bg-emerald-600 hover:bg-emerald-700 text-white px-5 py-2 rounded-xl text-[12px] font-bold transition-all shadow-sm flex items-center justify-center gap-1.5"
                        >
                          <CheckCircle2 className="w-4 h-4" /> اعتماد التنفيذ
                        </button>
                      )}
                      {!mandatoryStop && (
                        <button
                          disabled={isSaving}
                          onClick={() => saveDecision('caution')}
                          className="flex-1 sm:flex-none bg-amber-50 hover:bg-amber-100 text-amber-700 border border-amber-200 px-5 py-2 rounded-xl text-[12px] font-bold transition-all flex items-center justify-center gap-1.5"
                        >
                          <AlertTriangle className="w-4 h-4" /> التنفيذ بحذر
                        </button>
                      )}
                      <button
                        disabled={isSaving}
                        onClick={() => saveDecision(isFutureActivity ? 'postpone' : 'stopped')}
                        className="flex-1 sm:flex-none bg-red-50 hover:bg-red-100 text-red-600 border border-red-200 px-5 py-2 rounded-xl text-[12px] font-bold transition-all flex items-center justify-center gap-1.5"
                      >
                        <X className="w-4 h-4" /> {isFutureActivity ? 'تأجيل النشاط' : 'إيقاف النشاط'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
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
          {keyedChildren}
        </div>
      )}
    </div>
  );
}