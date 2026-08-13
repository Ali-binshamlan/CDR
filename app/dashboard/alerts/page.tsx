"use client";

import React, { useState, useMemo, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { apiClient } from '@/app/lib/apiClient';
import { translateActivityType, ALL_ACTIVITY_LABELS_AR } from '@/app/lib/activityLabels';
import { REGULATORY_ACTIVITY_LABEL_AR } from '@/app/utils/dust-compliance-engine/rulebook';
import {
  MapPin,
  Layers,
  Clock,
  ArrowRight,
  Bell,
  BellRing,
  Wind,
  Eye,
  ShieldAlert,
  Settings2,
  ChevronDown,
  ChevronUp,
  Loader2,
  Search,
  Activity,
  AlertOctagon,
  AlertTriangle,
  Scale,
  ShieldQuestion,
  ShieldOff,
} from 'lucide-react';

// ============================================================
// أنواع البيانات والقواميس
// ============================================================
type AlertTiming = 'BEFORE' | 'DURING';
type AlertState = 'NEW' | 'REVIEWED' | 'ACTION_TAKEN' | 'CLOSED';
// خطأ مكتشَف ومُصلَح (مراجعة كود خارجي — "Outbox يخلط الإيقاف الإلزامي
// والاحترازي"، راجع migration 202608110020 الكامل): PROTECTIVE_STOP kind
// مستقل جديد — إيقاف احترازي معلَّق (لم يُؤكَّد بعد)، لا يُعامَل كـSAFETY_BREACH.
type AlertKind =
  | 'BEFORE_2H' | 'BEFORE_1H' | 'BEFORE_START'
  | 'LOW_VISIBILITY' | 'DUST' | 'SAFETY_BREACH' | 'PROTECTIVE_STOP'
  | 'NO_DECISION_YET' | 'PM10_APPROACHING_LIMIT' | 'FORECAST_WARNING'
  | 'COMPLIANCE_VIOLATION' | 'COMPLIANCE_RESTRICTION' | 'COMPLIANCE_ADVISORY';
type Severity = 'CRITICAL' | 'WARNING' | 'INFO';

const timingLabel: Record<AlertTiming, string> = { BEFORE: 'قبل التنفيذ', DURING: 'أثناء التنفيذ' };
const stateLabel: Record<AlertState, string> = {
  NEW: 'جديد',
  REVIEWED: 'قيد المراجعة',
  ACTION_TAKEN: 'تم الإجراء',
  CLOSED: 'مغلق',
};

const alertStateMeta: Record<AlertState, { text: string; bg: string; border: string }> = {
  NEW: { text: 'text-red-700', bg: 'bg-red-50', border: 'border-red-200' },
  REVIEWED: { text: 'text-amber-700', bg: 'bg-amber-50', border: 'border-amber-200' },
  ACTION_TAKEN: { text: 'text-blue-700', bg: 'bg-blue-50', border: 'border-blue-200' },
  CLOSED: { text: 'text-slate-600', bg: 'bg-slate-50', border: 'border-slate-200' },
};

const severityMeta: Record<Severity, { label: string; color: string; bg: string }> = {
  CRITICAL: { label: 'خطورة عالية', color: 'text-red-600', bg: 'bg-red-500' },
  WARNING: { label: 'تحذير متوسط', color: 'text-orange-600', bg: 'bg-orange-500' },
  INFO: { label: 'تنبيه معلوماتي', color: 'text-blue-600', bg: 'bg-blue-500' },
};

const alertKindIcon: Record<AlertKind, React.ElementType> = {
  BEFORE_2H: Bell,
  BEFORE_1H: BellRing,
  BEFORE_START: Clock,
  LOW_VISIBILITY: Eye,
  DUST: Wind,
  SAFETY_BREACH: ShieldAlert,
  PROTECTIVE_STOP: ShieldOff,
  COMPLIANCE_VIOLATION: Scale,
  COMPLIANCE_RESTRICTION: ShieldQuestion,
  COMPLIANCE_ADVISORY: AlertTriangle,
  NO_DECISION_YET: AlertOctagon,
  PM10_APPROACHING_LIMIT: AlertTriangle,
  FORECAST_WARNING: Clock,
};

const alertKindLabel: Record<AlertKind, string> = {
  BEFORE_2H: 'استعداد للنشاط (ساعتين)',
  BEFORE_1H: 'استعداد للنشاط (ساعة)',
  BEFORE_START: 'بدء النشاط الآن',
  LOW_VISIBILITY: 'انعدام/انخفاض الرؤية',
  DUST: 'عاصفة غبارية محتملة',
  SAFETY_BREACH: 'تجاوز حدود السلامة',
  PROTECTIVE_STOP: 'إيقاف احترازي معلَّق (بانتظار تأكيد)',
  COMPLIANCE_VIOLATION: 'مخالفة تنظيمية (امتثال الغبار)',
  COMPLIANCE_RESTRICTION: 'تقييد تنظيمي (امتثال الغبار)',
  COMPLIANCE_ADVISORY: 'تنبيه استباقي (امتثال الغبار)',
  NO_DECISION_YET: 'نشاط جارٍ بلا قرار موثّق',
  PM10_APPROACHING_LIMIT: 'اقتراب من حد PM10 التنظيمي',
  FORECAST_WARNING: 'تحذير توقّعي (ساعة قادمة ضمن النافذة)',
};

interface AlertItem {
  id: string;
  timing: AlertTiming;
  kind: AlertKind;
  project: string;
  projectId: string;
  activity: string;
  state: AlertState;
  time: string;
  message: string;
  created_at: string;
  severity: Severity;
  metrics: { label: string; actual: string; threshold: string } | null;
  recommendedAction: string;
}

// شكل صف مشروع خام كما يُرجعه GET /api/dashboard/alerts-list (تُقرأ منه
// id/name فقط هنا لبناء projectNameById).
interface DashboardProjectRow {
  id: string;
  name: string;
}

// شكل صف تنبيه خام من جدول alerts كما يُرجعه نفس المسار — الحقول المقروءة
// فعلياً أدناه فقط (باقي أعمدة الجدول غير مستخدمة بهذه الصفحة).
interface DashboardAlertRow {
  id: string;
  timing?: string;
  kind?: string;
  project_id: string;
  activity_source: string;
  activity_id: string;
  state?: string;
  created_at: string;
  message?: string | null;
  metric_label?: string | null;
  metric_actual?: string | null;
  metric_threshold?: string | null;
  recommended_action?: string | null;
}

// شكل عنصر activityLabels (خريطة "source:id" → بيانات خام) كما يُرجعه نفس
// المسار — راجع تعليق activityLabels في app/api/dashboard/alerts-list/route.ts.
interface ActivityLabelInfo {
  regulatory_activity?: string | null;
  activity_type?: string;
}

// ============================================================
// دوال الخطورة والتوصيات الاحتياطية
// ============================================================
function getSeverity(kind: AlertKind): Severity {
  if (['SAFETY_BREACH', 'COMPLIANCE_VIOLATION'].includes(kind)) return 'CRITICAL';
  // PROTECTIVE_STOP: النشاط متوقف فعلياً الآن لكن غير مؤكَّد بعد (قد يتحول
  // إلى ALLOW لاحقاً) — تحذير، لا خطورة عالية قطعية كـSAFETY_BREACH المؤكَّد.
  if (['LOW_VISIBILITY', 'DUST', 'BEFORE_START', 'NO_DECISION_YET', 'PM10_APPROACHING_LIMIT', 'FORECAST_WARNING', 'COMPLIANCE_RESTRICTION', 'COMPLIANCE_ADVISORY', 'PROTECTIVE_STOP'].includes(kind)) return 'WARNING';
  return 'INFO';
}

function getFallbackRecommendedAction(kind: AlertKind): string {
  switch (kind) {
    case 'DUST':
    case 'LOW_VISIBILITY':
      return 'راجع مستوى الرؤية الفعلي، وأوقف تشغيل المعدات الثقيلة إذا انخفض عن الحد الآمن للنشاط.';
    case 'SAFETY_BREACH':
      return 'هذا تجاوز لحد سلامة صارم — أوقف النشاط فورًا وراجع تفاصيل الحد الذي تم تجاوزه.';
    case 'PROTECTIVE_STOP':
      return 'إيقاف احترازي معلَّق بانتظار تأكيد — راجع الحالة الآن؛ قد يتحول تلقائياً إلى استئناف أو إيقاف إلزامي بالتقييم التالي.';
    case 'COMPLIANCE_VIOLATION':
      return 'راجع قسم "الامتثال التنظيمي" في تفاصيل النشاط لمعرفة القاعدة المخالفة وشروط الاستئناف.';
    case 'COMPLIANCE_RESTRICTION':
      return 'راجع قسم "الامتثال التنظيمي" في تفاصيل النشاط — النشاط مقيَّد أو يتطلب تحقق ميداني حتى تُستوفى شروط القاعدة.';
    case 'COMPLIANCE_ADVISORY':
      return 'تنبيه استباقي قبل وقوع مخالفة فعلية — بادر بإجراء تصحيحي الآن (رش/تغطية/تخفيف) لتفادي الوصول لحد المخالفة.';
    case 'NO_DECISION_YET':
      return 'النشاط قيد التنفيذ ولم يُسجَّل له أي قرار بعد — راجعه في لوحة التحكم واتّخذ القرار المناسب (اعتماد/تقييد/تأجيل).';
    case 'PM10_APPROACHING_LIMIT':
      return 'فعّل التثبيط المعزز فوراً (رش/تغطية) لتفادي تجاوز الحد التنظيمي والتعرض لغرامة.';
    case 'FORECAST_WARNING':
      return 'توقّع طقس/غبار يشير لخطورة مرتفعة في ساعة قادمة ضمن نافذة تنفيذ النشاط — راجع الجدول وجهّز إجراءً وقائياً مسبقاً قبل وصول تلك الساعة.';
    default:
      return 'راجع خطة النشاط والتأكد من تجهيزات السلامة قبل البدء أو الاستمرار.';
  }
}

// ============================================================
// قاموس الترجمة ودوال المعالجة — نقطة الحقيقة الواحدة في
// app/lib/activityLabels.ts، لا نسخة محلية
// ============================================================
function translateAlertMessage(msg: string | null | undefined): string {
  if (!msg) return '';
  let translatedMsg = String(msg);
  Object.entries(ALL_ACTIVITY_LABELS_AR).forEach(([key, val]) => {
    const regex1 = new RegExp(key, 'gi');
    const regex2 = new RegExp(key.replace(/_/g, ' '), 'gi');
    translatedMsg = translatedMsg.replace(regex1, val).replace(regex2, val);
  });
  return translatedMsg;
}

// ============================================================
// المكون الرئيسي للصفحة
// ============================================================
export default function AlertsPage() {
  const [isLoading, setIsLoading] = useState(true);
  const [alertsData, setAlertsData] = useState<AlertItem[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedAlertId, setExpandedAlertId] = useState<string | null>(null);

  const [alertTimingFilter, setAlertTimingFilter] = useState<AlertTiming | 'الكل'>('الكل');
  const [alertProjectFilter, setAlertProjectFilter] = useState<string>('الكل');
  const [alertStateFilterVal, setAlertStateFilterVal] = useState<AlertState | 'الكل'>('الكل');
  // خطأ مكتشَف ومُصلَح (طلب صريح من المستخدم — "أخطاء الشبكة تتحول غالباً
  // إلى أرقام صفرية أو حالات فارغة مضللة"): فشل الجلب في "غرفة التحكم" هذه
  // كان يعني "لا توجد تنبيهات نشطة حالياً" — نفس الرسالة تماماً سواء لم
  // توجد تنبيهات فعلاً أو فشل الجلب، رغم احتمال إخفاء مخالفة تنظيمية نشطة.
  const [error, setError] = useState<string | null>(null);

  const fetchAlertsData = useCallback(async () => {
    // await فوري (microtask) قبل أول setState — يفصل الاستدعاء المباشر من
    // جسم الـEffect عن أول تعديل حالة متزامن، بلا تأخير محسوس.
    await Promise.resolve();
    setIsLoading(true);
    setError(null);
    try {
      const { data: list } = await apiClient.get('/dashboard/alerts-list');
      const dbProjects = list?.projects || [];
      const dbAlerts = list?.alerts || [];
      const activityLabels = list?.activityLabels || {};

      const projectNameById = new Map<string, string>();
      (dbProjects as DashboardProjectRow[]).forEach((p) => projectNameById.set(p.id, p.name));

      // اسم النشاط المعروض = النشاط التنظيمي المختار فعلياً (كسارة/هدم/...)،
      // لا التصنيف الفيزيائي الداخلي (activity_type) المستخدم فقط لتغذية
      // حساب حساسية محرك DVI.
      const activityLabelMap = new Map<string, string>();
      Object.entries(activityLabels as Record<string, ActivityLabelInfo>).forEach(([key, raw]) => {
        const label =
          (raw.regulatory_activity && raw.regulatory_activity !== 'OTHER'
            ? REGULATORY_ACTIVITY_LABEL_AR[raw.regulatory_activity]
            : null) ?? translateActivityType(raw.activity_type);
        activityLabelMap.set(key, label);
      });

      const formattedAlerts: AlertItem[] = ((dbAlerts as DashboardAlertRow[]) || []).map((a) => {
        const kind = (a.kind as AlertKind) || 'SAFETY_BREACH';

        const metrics: AlertItem['metrics'] =
          a.metric_label && a.metric_actual
            ? { label: a.metric_label, actual: a.metric_actual, threshold: a.metric_threshold || '—' }
            : null;

        return {
          id: a.id,
          timing: (a.timing as AlertTiming) || 'DURING',
          kind,
          severity: getSeverity(kind),
          project: projectNameById.get(a.project_id) || '—',
          projectId: a.project_id,
          activity: activityLabelMap.get(`${a.activity_source}:${a.activity_id}`) || 'نشاط غير معروف',
          state: (a.state as AlertState) || 'NEW',
          time: new Date(a.created_at).toLocaleString('ar-SA', { weekday: 'long', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', calendar: 'gregory' }),
          message: translateAlertMessage(a.message),
          created_at: a.created_at,
          metrics,
          recommendedAction: translateAlertMessage(a.recommended_action || getFallbackRecommendedAction(kind)),
        };
      });

      setAlertsData(formattedAlerts);

    } catch (err) {
      console.error('Error fetching alerts data:', err instanceof Error ? err.message : err);
      const axiosErr = err as { response?: { data?: { error?: string } } };
      setError(axiosErr?.response?.data?.error || 'تعذّر جلب بيانات التنبيهات — تحقّق من الاتصال وأعد المحاولة.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    // جدولة عبر microtask بدل استدعاء fetchAlertsData مباشرة من جسم
    // الـEffect — نفس السبب الموثَّق أعلى الدالة (تعديل حالة متزامن داخل Effect).
    let cancelled = false;
    void Promise.resolve().then(() => { if (!cancelled) fetchAlertsData(); });
    return () => { cancelled = true; };
  }, [fetchAlertsData]);

  const projectsList = useMemo(() => Array.from(new Set(alertsData.map((a) => a.project))), [alertsData]);

  const filteredAlerts = useMemo(() => {
    return alertsData.filter(
      (a) =>
        (alertTimingFilter === 'الكل' || a.timing === alertTimingFilter) &&
        (alertProjectFilter === 'الكل' || a.project === alertProjectFilter) &&
        (alertStateFilterVal === 'الكل' || a.state === alertStateFilterVal) &&
        (a.message.includes(searchQuery) || a.activity.includes(searchQuery))
    );
  }, [alertsData, alertTimingFilter, alertProjectFilter, alertStateFilterVal, searchQuery]);

  const toggleExpand = (id: string) => {
    setExpandedAlertId(prev => prev === id ? null : id);
  };

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-[#F4F7FB] text-[#061B40]">
        <Loader2 className="w-10 h-10 animate-spin text-[#0176FB] mb-4" />
        <h2 className="font-bold text-lg">جاري تحميل غرفة العمليات...</h2>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-[#F4F7FB] gap-4 text-center px-4">
        <h2 className="text-xl font-black text-red-600">تعذّر تحميل غرفة العمليات</h2>
        <p className="text-slate-500 text-sm font-medium max-w-md">{error}</p>
        <button
          type="button"
          onClick={() => { void fetchAlertsData(); }}
          className="bg-[#0176FB] hover:bg-[#0176FB]/90 text-white text-sm font-bold px-5 py-2.5 rounded-xl transition-colors"
        >
          إعادة المحاولة
        </button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F4F7FB] p-6 lg:p-8 font-sans" dir="rtl">
      <div className="max-w-[1440px] mx-auto space-y-6">

        {/* الترويسة */}
        <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center gap-4 bg-white p-6 rounded-2xl border border-slate-200 shadow-sm relative overflow-hidden">
          <div className="absolute top-0 right-0 w-2 h-full bg-orange-500"></div>
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 bg-orange-50 text-orange-600 rounded-xl flex items-center justify-center border border-orange-100 shadow-inner">
              <Bell className="w-6 h-6" />
            </div>
            <div>
              <h1 className="text-3xl font-black text-[#061B40] mb-1">غرفة التنبيهات والتحكم</h1>
              <p className="text-sm font-bold text-slate-500">
                مركز المراقبة الحية لالتزام الغبار التنظيمي واتخاذ القرارات العاجلة
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3 w-full lg:w-auto">
            <button className="bg-white border border-slate-200 text-slate-700 px-4 py-2.5 rounded-xl text-sm font-bold hover:bg-slate-50 flex items-center gap-2 shadow-sm transition-all w-full lg:w-auto justify-center">
              <Settings2 className="w-4 h-4" /> إعدادات النظام
            </button>
            <Link
              href="/dashboard/Projects"
              className="bg-[#061B40] hover:bg-[#0a275e] text-white px-5 py-2.5 rounded-xl text-sm font-bold flex items-center gap-2 shadow-sm transition-all w-full lg:w-auto justify-center"
            >
              <ArrowRight className="w-4 h-4" /> المشاريع
            </Link>
          </div>
        </div>

        {/* الفلاتر والقائمة */}
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden flex flex-col min-h-[600px]">

          <div className="p-5 border-b border-slate-100 bg-slate-50/80 flex flex-col xl:flex-row gap-6 justify-between items-start xl:items-center">
            <div className="flex flex-wrap gap-5 items-center w-full xl:w-auto">

              <div className="flex items-center gap-2">
                <span className="text-xs font-black text-slate-500">المشروع:</span>
                <div className="relative">
                  <select
                    value={alertProjectFilter}
                    onChange={(e) => setAlertProjectFilter(e.target.value)}
                    className="appearance-none bg-white border border-slate-200 rounded-lg text-xs font-bold px-4 py-2.5 pl-8 focus:outline-none focus:ring-2 focus:ring-blue-500/20 shadow-sm min-w-[150px]"
                  >
                    <option value="الكل">جميع المشاريع</option>
                    {projectsList.map((p) => <option key={p} value={p}>{p}</option>)}
                  </select>
                  <ChevronDown className="w-4 h-4 text-slate-400 absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none" />
                </div>
              </div>

              <div className="flex items-center gap-2">
                <span className="text-xs font-black text-slate-500">التوقيت:</span>
                <div className="flex bg-slate-200/60 p-1 rounded-lg">
                  {(['الكل', 'BEFORE', 'DURING'] as const).map((t) => (
                    <button
                      key={t}
                      onClick={() => setAlertTimingFilter(t as AlertTiming | 'الكل')}
                      className={`px-4 py-1.5 rounded-md text-xs font-bold transition-all ${
                        alertTimingFilter === t ? 'bg-white text-[#061B40] shadow-sm' : 'text-slate-500 hover:text-slate-700'
                      }`}
                    >
                      {t === 'الكل' ? 'الكل' : timingLabel[t as AlertTiming]}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex flex-wrap gap-2 items-center">
                <span className="text-xs font-black text-slate-500 ml-1">الحالة:</span>
                {(['الكل', 'NEW', 'REVIEWED', 'ACTION_TAKEN', 'CLOSED'] as const).map((s) => (
                  <button
                    key={s}
                    onClick={() => setAlertStateFilterVal(s as AlertState | 'الكل')}
                    className={`px-3 py-1.5 rounded-full text-[11px] font-bold border transition-all ${
                      alertStateFilterVal === s
                        ? 'bg-[#061B40] text-white border-[#061B40] shadow-md'
                        : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
                    }`}
                  >
                    {s === 'الكل' ? 'الكل' : stateLabel[s as AlertState]}
                  </button>
                ))}
              </div>
            </div>

            <div className="relative w-full xl:w-72 shrink-0">
              <Search className="w-4 h-4 text-slate-400 absolute right-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                placeholder="ابحث برقم النشاط أو التفاصيل..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full bg-white border border-slate-200 rounded-xl text-sm font-bold px-4 py-2.5 pr-9 focus:outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 transition-all shadow-sm"
              />
            </div>
          </div>

          {/* قائمة التنبيهات (Expandable Cards) */}
          <div className="divide-y divide-slate-100 flex-1 bg-slate-50/30 p-4 space-y-3">
            {filteredAlerts.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 text-slate-400">
                <ShieldAlert className="w-16 h-16 mb-4 text-slate-200" />
                <p className="text-sm font-bold text-slate-500">لا توجد تنبيهات نشطة حالياً.</p>
              </div>
            ) : (
              filteredAlerts.map((alert) => {
                const Icon = alertKindIcon[alert.kind];
                const sMeta = alertStateMeta[alert.state];
                const isNew = alert.state === 'NEW';
                const isExpanded = expandedAlertId === alert.id;
                const sevMeta = severityMeta[alert.severity];

                return (
                  <div
                    key={alert.id}
                    className={`bg-white border rounded-xl shadow-sm overflow-hidden transition-all duration-200 ${
                      isExpanded ? 'ring-2 ring-blue-500/20 border-blue-200' : 'border-slate-200 hover:border-slate-300'
                    }`}
                  >
                    {/* Header */}
                    <div
                      onClick={() => toggleExpand(alert.id)}
                      className={`p-4 flex flex-col md:flex-row gap-4 items-start md:items-center justify-between cursor-pointer relative ${
                        isNew && !isExpanded ? 'bg-orange-50/20' : ''
                      }`}
                    >
                      <div className={`absolute right-0 top-0 bottom-0 w-1 ${sevMeta.bg}`}></div>

                      <div className="flex items-start gap-4 flex-1 pl-4">
                        <div className={`w-11 h-11 rounded-xl flex items-center justify-center shrink-0 border ${
                          isNew ? 'bg-orange-100 border-orange-200 text-orange-600' : 'bg-slate-50 border-slate-200 text-slate-500'
                        }`}>
                          <Icon className="w-5 h-5" />
                        </div>

                        <div className="flex-1 space-y-1.5">
                          <div className="flex items-center gap-3 flex-wrap">
                            <span className="font-black text-[15px] text-[#061B40]">{alertKindLabel[alert.kind]}</span>
                            <span className={`text-[10px] font-black px-2 py-0.5 rounded ${sevMeta.color} bg-opacity-10 bg-current`}>
                              {sevMeta.label}
                            </span>
                            {isNew && (
                              <span className="flex h-2.5 w-2.5 relative">
                                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span>
                                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-red-500"></span>
                              </span>
                            )}
                          </div>

                          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[12px] text-slate-500 font-bold mt-1">
                            <span className="flex items-center gap-1.5"><MapPin className="w-3.5 h-3.5" /> {alert.project}</span>
                            <span className="flex items-center gap-1.5"><Layers className="w-3.5 h-3.5" /> {alert.activity}</span>
                            <span className="flex items-center gap-1.5"><Clock className="w-3.5 h-3.5" /> {alert.time}</span>
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-4 shrink-0 mt-3 md:mt-0 mr-14 md:mr-0">
                        <span className={`px-3 py-1.5 rounded-full text-[11px] font-black border ${sMeta.bg} ${sMeta.text} ${sMeta.border}`}>
                          {stateLabel[alert.state]}
                        </span>
                        <button className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-slate-100 text-slate-400 transition-colors">
                          {isExpanded ? <ChevronUp className="w-5 h-5" /> : <ChevronDown className="w-5 h-5" />}
                        </button>
                      </div>
                    </div>

                    {/* Body */}
                    {isExpanded && (
                      <div className="border-t border-slate-100 bg-slate-50/50 p-5 cursor-default">

                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">

                          <div className="space-y-4">
                            <div>
                              <h4 className="text-xs font-black text-slate-500 mb-2 flex items-center gap-1.5">
                                <Activity className="w-4 h-4 text-blue-500" /> ما الذي حدث بالضبط
                              </h4>
                              {/* النص الصريح للمخالفة/الحالة (مثال: "مخالفة تنظيمية: تركيز
                                  PM10 (1665.2 ميكروجرام/م³) تجاوز حد المخالفة (340
                                  ميكروجرام/م³)") — يُعرض دائماً بصرف النظر عن توفر metrics،
                                  فلا يجوز أن تحجبه بطاقة مقياس عامة (كانت المشكلة سابقاً:
                                  alert.message لا يظهر إطلاقاً متى وُجد alert.metrics). */}
                              <div className="bg-white border border-slate-200 rounded-xl p-3 shadow-sm text-sm font-bold text-[#061B40] leading-relaxed">
                                {alert.message}
                              </div>
                              {alert.metrics && (
                                <div className="bg-white border border-slate-200 rounded-xl p-3 shadow-sm flex flex-col gap-2 mt-2">
                                  <div className="flex justify-between items-center text-sm">
                                    <span className="text-slate-500 font-bold">{alert.metrics.label}:</span>
                                    <span className="font-black text-[#061B40] bg-slate-100 px-2 py-0.5 rounded">{alert.metrics.actual}</span>
                                  </div>
                                  <div className="h-px bg-slate-100 my-1"></div>
                                  <div className="flex justify-between items-center text-xs text-slate-400">
                                    <span>الحد المسموح للنشاط:</span>
                                    <span className="font-bold">{alert.metrics.threshold}</span>
                                  </div>
                                </div>
                              )}
                            </div>
                          </div>

                          <div className="space-y-4">
                            <div>
                              <h4 className="text-xs font-black text-slate-500 mb-2 flex items-center gap-1.5">
                                <AlertOctagon className="w-4 h-4 text-orange-500" /> الإجراء الموصى به
                              </h4>
                              <div className="bg-orange-50 border border-orange-100 rounded-xl p-3 shadow-sm text-sm font-bold text-orange-800 leading-relaxed">
                                {alert.recommendedAction}
                              </div>
                            </div>
                          </div>

                        </div>
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>

        </div>
      </div>
    </div>
  );
}
