"use client";

import React, { useState, useMemo, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { apiClient } from '@/app/lib/apiClient';
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
  User,
  MessageCircle,
  PauseCircle,
  CheckCircle2
} from 'lucide-react';

// ============================================================
// أنواع البيانات والقواميس
// ============================================================
type AlertTiming = 'BEFORE' | 'DURING';
type AlertState = 'NEW' | 'REVIEWED' | 'ACTION_TAKEN' | 'CLOSED';
type AlertKind =
  | 'BEFORE_2H' | 'BEFORE_1H' | 'BEFORE_START'
  | 'LOW_VISIBILITY' | 'DUST' | 'SAFETY_BREACH'
  | 'NO_DECISION_YET';
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
  NO_DECISION_YET: AlertOctagon,
};

const alertKindLabel: Record<AlertKind, string> = {
  BEFORE_2H: 'استعداد للنشاط (ساعتين)',
  BEFORE_1H: 'استعداد للنشاط (ساعة)',
  BEFORE_START: 'بدء النشاط الآن',
  LOW_VISIBILITY: 'انعدام/انخفاض الرؤية',
  DUST: 'عاصفة غبارية محتملة',
  SAFETY_BREACH: 'تجاوز حدود السلامة',
  NO_DECISION_YET: 'نشاط جارٍ بلا قرار موثّق',
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
  assignee: string;
}

// ============================================================
// دوال الخطورة والتوصيات الاحتياطية
// ============================================================
function getSeverity(kind: AlertKind): Severity {
  if (['SAFETY_BREACH'].includes(kind)) return 'CRITICAL';
  if (['LOW_VISIBILITY', 'DUST', 'BEFORE_START', 'NO_DECISION_YET'].includes(kind)) return 'WARNING';
  return 'INFO';
}

function getFallbackRecommendedAction(kind: AlertKind): string {
  switch (kind) {
    case 'DUST':
    case 'LOW_VISIBILITY':
      return 'راجع مستوى الرؤية الفعلي، وأوقف تشغيل المعدات الثقيلة إذا انخفض عن الحد الآمن للنشاط.';
    case 'SAFETY_BREACH':
      return 'هذا تجاوز لحد سلامة صارم — أوقف النشاط فورًا وراجع تفاصيل الحد الذي تم تجاوزه.';
    case 'NO_DECISION_YET':
      return 'النشاط قيد التنفيذ ولم يُسجَّل له أي قرار بعد — راجعه في لوحة التحكم واتّخذ القرار المناسب (اعتماد/تقييد/تأجيل).';
    default:
      return 'راجع خطة النشاط والتأكد من تجهيزات السلامة قبل البدء أو الاستمرار.';
  }
}

// ============================================================
// قاموس الترجمة ودوال المعالجة
// ============================================================
const ACTIVITY_TRANSLATIONS: Record<string, string> = {
  'GENERAL_OUTDOOR_WORK': 'أعمال خارجية عامة',
  'INDOOR_WORK': 'أعمال داخلية وخارجية خفيفة',
  'EARTHWORKS': 'أعمال حفر وتربة',
  'CLEANING_WORK': 'أعمال تنظيف وموقع',
  'CONCRETE_POURING': 'صب وتجهيز الخرسانة',
  'ROAD_PAVING': 'رصف الطرق والأسفلت',
  'ASPHALT_PAVING': 'سفلتة',
  'HIGH_ALTITUDE_WORK': 'أعمال على ارتفاعات عالية',
  'WORK_AT_HEIGHT': 'أعمال على ارتفاع',
  'COATING': 'أعمال طلاء وعزل',
  'ROAD_WORKS': 'أعمال طرق ومسارات',
  'WELDING': 'أعمال لحام',
  'SCAFFOLDING': 'أعمال سقالات',
  'MATERIAL_TRANSPORT': 'نقل مواد',
  'HEAVY_EQUIPMENT_MOVEMENT': 'حركة معدات ثقيلة',
  'MEP_EXTERNAL_WORK': 'أعمال ميكانيكية/كهربائية',
  'EXTERNAL_PAINTING': 'دهانات وعزل خارجي',
  'GRADING': 'أعمال تسوية وترابية',
  'EXCAVATION': 'أعمال حفر'
};

function translateActivityType(code: string | null | undefined): string {
  if (!code) return 'نشاط غير مسمى';
  const normalized = String(code).trim().toUpperCase();

  if (ACTIVITY_TRANSLATIONS[normalized]) return ACTIVITY_TRANSLATIONS[normalized];

  const withUnderscores = normalized.replace(/ /g, '_');
  if (ACTIVITY_TRANSLATIONS[withUnderscores]) return ACTIVITY_TRANSLATIONS[withUnderscores];

  return String(code).replace(/_/g, ' ').trim();
}

function translateAlertMessage(msg: string | null | undefined): string {
  if (!msg) return '';
  let translatedMsg = String(msg);
  Object.entries(ACTIVITY_TRANSLATIONS).forEach(([key, val]) => {
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

  const fetchAlertsData = useCallback(async () => {
    setIsLoading(true);
    try {
      const { data: list } = await apiClient.get('/dashboard/alerts-list');
      const dbProjects = list?.projects || [];
      const dbAlerts = list?.alerts || [];
      const activityLabels = list?.activityLabels || {};

      const projectNameById = new Map<string, string>();
      (dbProjects as any[]).forEach((p) => projectNameById.set(p.id, p.name));

      const activityLabelMap = new Map<string, string>();
      Object.entries(activityLabels).forEach(([key, raw]: [string, any]) => {
        activityLabelMap.set(key, translateActivityType(raw.activity_type));
      });

      const formattedAlerts: AlertItem[] = (dbAlerts || []).map((a: any) => {
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
          time: new Date(a.created_at).toLocaleString('ar-SA', { weekday: 'long', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
          message: translateAlertMessage(a.message),
          created_at: a.created_at,
          metrics,
          recommendedAction: translateAlertMessage(a.recommended_action || getFallbackRecommendedAction(kind)),
          assignee: a.assignee || 'غير معيّن بعد',
        };
      });

      setAlertsData(formattedAlerts);

    } catch (error: any) {
      console.error('Error fetching alerts data:', error?.message || error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAlertsData();
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

  const toggleAlertState = async (alertId: string, newState: AlertState, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();

    try {
      setAlertsData(prev => prev.map(a => a.id === alertId ? { ...a, state: newState } : a));
      await apiClient.patch(`/alerts/${alertId}`, { state: newState });
    } catch (error) {
      console.error('Error updating alert state:', error);
      fetchAlertsData();
    }
  };

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
                                <Activity className="w-4 h-4 text-blue-500" /> تفاصيل القراءة الميدانية
                              </h4>
                              {alert.metrics ? (
                                <div className="bg-white border border-slate-200 rounded-xl p-3 shadow-sm flex flex-col gap-2">
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
                              ) : (
                                <div className="bg-white border border-slate-200 rounded-xl p-3 shadow-sm text-sm font-medium text-slate-700">
                                  {alert.message}
                                </div>
                              )}
                            </div>

                            <div>
                              <h4 className="text-xs font-black text-slate-500 mb-2 flex items-center gap-1.5">
                                <User className="w-4 h-4 text-emerald-500" /> المسؤول الميداني
                              </h4>
                              <div className="flex items-center justify-between bg-white border border-slate-200 rounded-xl p-3 shadow-sm">
                                <span className="text-sm font-bold text-slate-700">{alert.assignee}</span>
                                <button className="text-emerald-600 hover:text-emerald-700 bg-emerald-50 hover:bg-emerald-100 p-1.5 rounded-lg transition-colors" title="مراسلة عبر الواتساب">
                                  <MessageCircle className="w-4 h-4" />
                                </button>
                              </div>
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

                            <div>
                              <h4 className="text-xs font-black text-slate-500 mb-2 mt-4">الإجراءات السريعة</h4>
                              <div className="flex flex-wrap gap-2">
                                {alert.state === 'NEW' && (
                                  <button
                                    onClick={(e) => toggleAlertState(alert.id, 'REVIEWED', e)}
                                    className="flex-1 bg-[#061B40] hover:bg-[#0a275e] text-white px-4 py-2.5 rounded-xl text-xs font-bold transition-colors flex items-center justify-center gap-2"
                                  >
                                    <CheckCircle2 className="w-4 h-4" /> تحديد كـ قيد المراجعة
                                  </button>
                                )}

                                {alert.state === 'REVIEWED' && (
                                  <button
                                    onClick={(e) => toggleAlertState(alert.id, 'ACTION_TAKEN', e)}
                                    className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2.5 rounded-xl text-xs font-bold transition-colors flex items-center justify-center gap-2"
                                  >
                                    <CheckCircle2 className="w-4 h-4" /> تم تنفيذ الإجراء المطلوب
                                  </button>
                                )}

                                {alert.severity === 'CRITICAL' && alert.state !== 'CLOSED' && (
                                  <button
                                    onClick={(e) => toggleAlertState(alert.id, 'ACTION_TAKEN', e)}
                                    className="flex-1 bg-red-50 border border-red-200 text-red-600 hover:bg-red-100 px-4 py-2.5 rounded-xl text-xs font-bold transition-colors flex items-center justify-center gap-2"
                                  >
                                    <PauseCircle className="w-4 h-4" /> إيقاف النشاط مؤقتاً
                                  </button>
                                )}

                                {alert.state !== 'CLOSED' && (
                                  <button
                                    onClick={(e) => toggleAlertState(alert.id, 'CLOSED', e)}
                                    className="flex-none bg-white border border-slate-200 text-slate-600 hover:bg-slate-100 px-4 py-2.5 rounded-xl text-xs font-bold transition-colors"
                                  >
                                    إغلاق
                                  </button>
                                )}
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
