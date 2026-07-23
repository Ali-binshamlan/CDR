"use client";

import React, { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { apiClient } from '@/app/lib/apiClient';
import type { ProjectPoint } from './ProjectsMap';

// خريطة Leaflet تحتاج window، فلازم تُحمَّل داخل المتصفح فقط بدون SSR
const ProjectsMap = dynamic(() => import('./ProjectsMap'), {
  ssr: false,
  loading: () => (
    <div className="h-80 flex items-center justify-center text-slate-400 font-bold text-sm bg-slate-50 rounded-xl">
      جاري تحميل الخريطة...
    </div>
  ),
});

import {
  Building2,
  CheckCircle2,
  AlertTriangle,
  ShieldAlert,
  CloudFog,
  Activity,
  Plus,
  Clock,
  Loader2,
  PauseCircle,
  CalendarClock,
  Map as MapIcon,
} from 'lucide-react';
import { formatDistanceToNow, format } from 'date-fns';
import { ar } from 'date-fns/locale';

// ============================================================
// ترجمة وتعيين أنواع الأنشطة والقرارات
// ============================================================
const ACTIVITY_TRANSLATIONS: Record<string, string> = {
  'GENERAL_OUTDOOR_WORK': 'أعمال خارجية عامة',
  'INDOOR_WORK': 'أعمال داخلية وخارجية خفيفة',
  'EARTHWORKS': 'أعمال حفر وتربة',
  'CLEANING_WORK': 'أعمال تنظيف وموقع',
  'CONCRETE_POURING': 'صب وتجهيز الخرسانة',
  'ROAD_PAVING': 'رصف الطرق والأسفلت',
  'HIGH_ALTITUDE_WORK': 'أعمال على ارتفاعات عالية',
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

// 1. دالة لترجمة الكلمة المفردة (تُستخدم في الجدول)
function translateActivityType(code: string | null | undefined): string {
  if (!code) return 'نشاط غير مسمى';
  const normalized = String(code).trim().toUpperCase();

  if (ACTIVITY_TRANSLATIONS[normalized]) return ACTIVITY_TRANSLATIONS[normalized];

  const withUnderscores = normalized.replace(/ /g, '_');
  if (ACTIVITY_TRANSLATIONS[withUnderscores]) return ACTIVITY_TRANSLATIONS[withUnderscores];

  return String(code).replace(/_/g, ' ').trim();
}

// 2. دالة لترجمة الكلمات الإنجليزية داخل نص التنبيه الطويل (تُستخدم في التنبيهات)
function translateAlertMessage(msg: string | null | undefined): string {
  if (!msg) return '';
  let translatedMsg = String(msg);
  Object.entries(ACTIVITY_TRANSLATIONS).forEach(([key, val]) => {
    // نبحث عن الكلمة سواء كانت بشرطة سفلية أو مسافة
    const regex1 = new RegExp(key, 'gi');
    const regex2 = new RegExp(key.replace(/_/g, ' '), 'gi');
    translatedMsg = translatedMsg.replace(regex1, val).replace(regex2, val);
  });
  return translatedMsg;
}

type Decision = 'safe' | 'caution' | 'restricted' | 'postpone' | 'stopped';

const decisionMeta: Record<
  Decision,
  { label: string; text: string; bg: string; border: string; dot: string; ring: string }
> = {
  safe: { label: 'آمن', text: 'text-emerald-700', bg: 'bg-emerald-50', border: 'border-emerald-200', dot: 'bg-emerald-500', ring: 'ring-emerald-500' },
  caution: { label: 'مناسب بحذر', text: 'text-amber-700', bg: 'bg-amber-50', border: 'border-amber-200', dot: 'bg-amber-500', ring: 'ring-amber-500' },
  restricted: { label: 'مقيد', text: 'text-orange-700', bg: 'bg-orange-50', border: 'border-orange-200', dot: 'bg-orange-500', ring: 'ring-orange-500' },
  postpone: { label: 'يفضل التأجيل', text: 'text-rose-700', bg: 'bg-rose-50', border: 'border-rose-200', dot: 'bg-rose-500', ring: 'ring-rose-500' },
  stopped: { label: 'إيقاف', text: 'text-red-700', bg: 'bg-red-50', border: 'border-red-200', dot: 'bg-red-700', ring: 'ring-red-700' },
};

// تحويل نصوص التقييم من الجداول إلى الـ Decision Enum
function mapAeiStatusToDecision(status: string | null | undefined): Decision {
  const s = (status || '').toString().trim().toUpperCase();
  if (['SAFE', 'ALLOW', 'NORMAL', 'LOW', 'آمن', 'مناسب', 'SAFE'].includes(s)) return 'safe';
  if (['CAUTION', 'MODERATE', 'MEDIUM', 'WARNING', 'مناسب بحذر', 'CAUTION'].includes(s)) return 'caution';
  if (['RESTRICT', 'RESTRICTED', 'مقيد', 'RESTRICTED'].includes(s)) return 'restricted';
  if (['POSTPONE', 'DELAY', 'يفضل التأجيل', 'POSTPONE'].includes(s)) return 'postpone';
  if (['STOP', 'STOPPED', 'CRITICAL', 'EXTREME', 'HIGH', 'إيقاف', 'STOPPED'].includes(s)) return 'stopped';
  return 'caution'; // Default
}

// خرائط قيمة "risk_level" (كما تُخزَّن في alerts) إلى القرار الخماسي
const riskLevelToDecision = (risk?: string | null): Decision => {
  switch (risk) {
    case 'أسود': return 'stopped';
    case 'أحمر': return 'postpone';
    case 'برتقالي': return 'restricted';
    case 'أصفر': return 'caution';
    default: return 'safe';
  }
};

export default function GlobalDashboard() {
  const router = useRouter();

  // ---- حالات البيانات ----
  const [projects, setProjects] = useState<any[]>([]);
  const [todayActivities, setTodayActivities] = useState<any[]>([]);
  const [executionWindows, setExecutionWindows] = useState<any[]>([]);
  const [recentAlerts, setRecentAlerts] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const fetchDashboardData = async () => {
      try {
        setIsLoading(true);

        const { data: dash } = await apiClient.get('/dashboard/global');
        const projectsData = dash?.projects || [];
        const alerts = dash?.alerts || [];
        const dustRes = { data: dash?.dustActivities || [] };
        const decisionsRes = { data: dash?.decisions || [] };
        const windows = dash?.executionWindows || [];

        const projectIds = projectsData.map((p: any) => p.id);

        // أنشطة اليوم وقراراتها
        let allActivities: any[] = [];
        if (projectIds.length > 0) {
          const getProjectName = (pid: string) => projectsData?.find((p: any) => p.id === pid)?.name || '—';

          // دالة مساعدة لجلب قرار المستخدم للنشاط المحدد
          const getUserDecision = (activityId: string, source: string) => {
            const dec = (decisionsRes.data || []).find((d: any) => d.activity_id === activityId && d.activity_source === source);
            return dec ? (dec.status as Decision) : null;
          };

          const dustActs = (dustRes.data || []).map((d: any) => ({
            id: `dust_${d.id}`,
            name: translateActivityType(d.activity_type),
            projects: { name: getProjectName(d.project_id) },
            time_str: d.planned_time,
            system_recommendation: mapAeiStatusToDecision(d.aei_status),
            user_decision: getUserDecision(d.id, 'dust'),
            widget_type: 'Dust',
            required_action: 'تطبيق ضوابط الغبار'
          }));

          allActivities = [...dustActs];

          // ترتيب الأنشطة تصاعدياً حسب الوقت
          allActivities.sort((a, b) => {
            const timeA = a.time_str || '23:59';
            const timeB = b.time_str || '23:59';
            return timeA.localeCompare(timeB);
          });
        }

        setProjects(projectsData || []);
        setTodayActivities(allActivities);
        setExecutionWindows((windows || []).slice(0, 4));
        setRecentAlerts((alerts || []).slice(0, 4));
      } catch (error) {
        console.error('Error fetching dynamic data:', error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchDashboardData();
  }, []);

  // ============================================================
  // حالة كل مشروع
  // ============================================================
  const projectsWithStatus = useMemo(() => {
    return projects.map((project) => {
      const projectAlerts = recentAlerts.filter((a) => a.project_id === project.id);
      const latest = projectAlerts[0];
      const decision = latest ? riskLevelToDecision(latest.risk_level) : 'safe';
      return { ...project, decision };
    });
  }, [projects, recentAlerts]);

  // ملخص اليوم (يُبنى على توصية النظام ليعكس المخاطر المحتملة)
  const todaySummary = useMemo(() => {
    const counts: Record<Decision, number> = { safe: 0, caution: 0, restricted: 0, postpone: 0, stopped: 0 };
    todayActivities.forEach((act) => {
      const d: Decision = counts.hasOwnProperty(act.system_recommendation) ? act.system_recommendation : 'safe';
      counts[d]++;
    });
    return { totalProjects: projects.length, ...counts };
  }, [todayActivities, projects]);

  // نقاط الخريطة
  const mapPoints: ProjectPoint[] = useMemo(() => {
    return projectsWithStatus
      .filter((p) => typeof p.latitude === 'number' && typeof p.longitude === 'number')
      .map((p) => ({
        id: p.id,
        name: p.name,
        city: p.city,
        latitude: p.latitude,
        longitude: p.longitude,
        decision: p.decision,
      }));
  }, [projectsWithStatus]);

  const getWidgetIcon = (type: string, decision: Decision) => {
    const className = `w-4 h-4 ${decisionMeta[decision].text}`;
    if (type?.includes('Dust')) return <CloudFog className={className} />;
    if (decision === 'safe') return <CheckCircle2 className={className} />;
    return <ShieldAlert className={className} />;
  };

  const getAlertIcon = (type: string) => {
    if (type?.includes('Dust')) return <CloudFog className="w-4 h-4 text-blue-600" />;
    return <AlertTriangle className="w-4 h-4 text-amber-600" />;
  };

  const DecisionBadge = ({ decision }: { decision: Decision }) => {
    const meta = decisionMeta[decision];
    return (
      <span className={`flex w-fit items-center gap-1.5 px-3 py-1 rounded-full ${meta.bg} ${meta.text} text-xs font-bold border ${meta.border}`}>
        <span className={`w-2 h-2 rounded-full ${meta.dot} ${decision === 'stopped' || decision === 'postpone' ? 'animate-pulse' : ''}`}></span>
        {meta.label}
      </span>
    );
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-[#F4F7FB] p-6 lg:p-8 flex items-center justify-center" dir="rtl">
        <div className="flex flex-col items-center gap-4 text-[#061B40]">
          <Loader2 className="w-10 h-10 animate-spin text-[#0176FB]" />
          <h2 className="font-bold text-lg">جاري جلب البيانات التشغيلية...</h2>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F4F7FB] p-6 lg:p-8 font-sans overflow-x-hidden" dir="rtl">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-end gap-4 mb-8">
        <div>
          <h1 className="text-3xl font-black text-[#061B40] mb-1">الرئيسية</h1>
          <p className="text-slate-500 text-sm font-medium">
            نظرة عامة على حالة الامتثال التنظيمي لجميع المشاريع النشطة
          </p>
        </div>
        <Link
          href="/dashboard/Projects/create"
          className="bg-[#0176FB] hover:bg-[#0337a7] text-white px-5 py-2.5 rounded-xl text-sm font-bold flex items-center gap-2 shadow-sm transition-colors"
        >
          <Plus className="w-4 h-4" strokeWidth={3} /> إضافة مشروع
        </Link>
      </div>

      {/* ============================================================ */}
      {/* 1. ملخص اليوم */}
      {/* ============================================================ */}
      <div className="mb-4">
        <h2 className="font-extrabold text-[#061B40] text-lg mb-3">ملخص توصيات اليوم</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
          <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm flex flex-col justify-between">
            <div className="flex justify-between items-start mb-3">
              <span className="text-slate-500 font-bold text-xs">عدد المشاريع</span>
              <div className="bg-blue-50 p-2 rounded-lg text-[#0176FB]"><Building2 className="w-4 h-4" /></div>
            </div>
            <span className="text-3xl font-black text-[#061B40]">{todaySummary.totalProjects}</span>
          </div>

          <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm flex flex-col justify-between">
            <div className="flex justify-between items-start mb-3">
              <span className="text-slate-500 font-bold text-xs">أنشطة مناسبة</span>
              <div className={`${decisionMeta.safe.bg} p-2 rounded-lg ${decisionMeta.safe.text}`}><CheckCircle2 className="w-4 h-4" /></div>
            </div>
            <span className="text-3xl font-black text-[#061B40]">{todaySummary.safe}</span>
          </div>

          <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm flex flex-col justify-between">
            <div className="flex justify-between items-start mb-3">
              <span className="text-slate-500 font-bold text-xs">تحتاج حذر</span>
              <div className={`${decisionMeta.caution.bg} p-2 rounded-lg ${decisionMeta.caution.text}`}><AlertTriangle className="w-4 h-4" /></div>
            </div>
            <span className="text-3xl font-black text-[#061B40]">{todaySummary.caution}</span>
          </div>

          <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm flex flex-col justify-between">
            <div className="flex justify-between items-start mb-3">
              <span className="text-slate-500 font-bold text-xs">مقيدة</span>
              <div className={`${decisionMeta.restricted.bg} p-2 rounded-lg ${decisionMeta.restricted.text}`}><ShieldAlert className="w-4 h-4" /></div>
            </div>
            <span className="text-3xl font-black text-[#061B40]">{todaySummary.restricted}</span>
          </div>

          <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm flex flex-col justify-between">
            <div className="flex justify-between items-start mb-3">
              <span className="text-slate-500 font-bold text-xs">يُقترح تأجيلها</span>
              <div className={`${decisionMeta.postpone.bg} p-2 rounded-lg ${decisionMeta.postpone.text}`}><CalendarClock className="w-4 h-4" /></div>
            </div>
            <span className="text-3xl font-black text-[#061B40]">{todaySummary.postpone}</span>
          </div>

          <div className="bg-white p-4 rounded-2xl border border-red-200 shadow-sm flex flex-col justify-between relative overflow-hidden">
            <div className="absolute top-0 left-0 w-full h-1 bg-red-700"></div>
            <div className="flex justify-between items-start mb-3 pt-1">
              <span className="text-red-700 font-bold text-xs">توصيات إيقاف</span>
              <div className="bg-red-50 p-2 rounded-lg text-red-700"><PauseCircle className="w-4 h-4" /></div>
            </div>
            <span className="text-3xl font-black text-red-700">{todaySummary.stopped}</span>
          </div>
        </div>
      </div>

      {/* ============================================================ */}
      {/* 3. أنشطة اليوم */}
      {/* ============================================================ */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden flex flex-col mb-8">
        <div className="p-5 border-b border-slate-100 flex justify-between items-center bg-white">
          <h2 className="font-extrabold text-[#061B40] text-lg flex items-center gap-2">
            <Activity className="w-5 h-5 text-[#0176FB]" />
            أنشطة اليوم
          </h2>
        </div>

        <div className="overflow-x-auto flex-1">
          {todayActivities.length === 0 ? (
            <div className="p-8 text-center text-slate-400 font-bold">
              لا توجد أنشطة مجدولة اليوم.
            </div>
          ) : (
            <table className="w-full text-right text-sm whitespace-nowrap">
              <thead className="bg-slate-50/50 text-slate-500">
                <tr>
                  <th className="py-4 px-5 font-bold">اسم النشاط</th>
                  <th className="py-4 px-5 font-bold">المشروع</th>
                  <th className="py-4 px-5 font-bold">الوقت</th>
                  <th className="py-4 px-5 font-bold">توصية النظام</th>
                  <th className="py-4 px-5 font-bold">القرار النهائي</th>
                  <th className="py-4 px-5 font-bold">الإجراء المطلوب</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {todayActivities.map((activity) => {
                  const sysRec: Decision = decisionMeta.hasOwnProperty(activity.system_recommendation) ? activity.system_recommendation : 'safe';
                  return (
                    <tr key={activity.id} className="hover:bg-slate-50/50 transition-colors group">
                      <td className="py-4 px-5">
                        <div className="flex items-center gap-2 font-bold text-slate-800">
                          {getWidgetIcon(activity.widget_type, sysRec)}
                          {activity.name}
                        </div>
                      </td>
                      <td className="py-4 px-5 text-slate-600 font-medium">{activity.projects?.name}</td>
                      <td className="py-4 px-5 text-slate-600 font-medium">
                        {activity.time_str ? activity.time_str.slice(0, 5) : '—'}
                      </td>
                      <td className="py-4 px-5"><DecisionBadge decision={sysRec} /></td>
                      <td className="py-4 px-5">
                        {activity.user_decision ? (
                          <DecisionBadge decision={activity.user_decision} />
                        ) : (
                          <span className="text-[10px] font-bold text-slate-500 bg-slate-100 border border-slate-200 px-3 py-1.5 rounded-full">
                            بانتظار القرار
                          </span>
                        )}
                      </td>
                      <td className="py-4 px-5">
                        <span className={`font-bold text-xs ${decisionMeta[sysRec].text}`}>
                          {activity.required_action || '—'}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* ============================================================ */}
      {/* 4. تنبيهات مهمة + 5. أفضل نوافذ التنفيذ اليوم */}
      {/* ============================================================ */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 mb-8">
        {/* تنبيهات مهمة */}
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm flex flex-col h-full">
          <div className="p-5 border-b border-slate-100">
            <h2 className="font-extrabold text-[#061B40] text-lg">تنبيهات مهمة</h2>
          </div>

          <div className="p-5 flex-1 flex flex-col">
            {recentAlerts.length === 0 ? (
              <div className="flex-1 flex items-center justify-center text-slate-400 font-bold text-sm">
                لا توجد تنبيهات نشطة حالياً.
              </div>
            ) : (
              <div className="space-y-4">
                {recentAlerts.map((alert) => (
                  <div key={alert.id} className="flex gap-3 items-start relative pb-4 border-b border-slate-100 last:border-0 last:pb-0">
                    <div className={`p-2 rounded-full border shrink-0 mt-1 ${
                      alert.risk_level === 'أسود' || alert.risk_level === 'أحمر' ? 'bg-red-50 border-red-100' :
                      alert.risk_level === 'برتقالي' ? 'bg-orange-50 border-orange-100' : 'bg-amber-50 border-amber-100'
                    }`}>
                      {getAlertIcon(alert.widget_type)}
                    </div>
                    <div>
<p className="text-sm font-bold text-slate-800 mb-1">{translateAlertMessage(alert.message)}</p>                      <p className="text-xs text-slate-500 mb-2">
                        في مشروع <span className="font-bold text-slate-700">{alert.projects?.name}</span>
                      </p>
                      <div className="text-[10px] font-bold text-slate-400 flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        {formatDistanceToNow(new Date(alert.created_at), { addSuffix: true, locale: ar })}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="p-3 border-t border-slate-100 text-center bg-slate-50/50 rounded-b-2xl mt-auto">
            <button className="text-xs font-bold text-[#0176FB] hover:text-[#0337a7]">
              عرض سجل التنبيهات بالكامل
            </button>
          </div>
        </div>

        {/* أفضل نوافذ التنفيذ اليوم */}
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm flex flex-col h-full">
          <div className="p-5 border-b border-slate-100">
            <h2 className="font-extrabold text-[#061B40] text-lg flex items-center gap-2">
              <CalendarClock className="w-5 h-5 text-[#0176FB]" />
              أفضل نوافذ التنفيذ اليوم
            </h2>
          </div>

          <div className="p-5 flex-1 flex flex-col">
            {executionWindows.length === 0 ? (
              <div className="flex-1 flex items-center justify-center text-slate-400 font-bold text-sm">
                لا توجد نوافذ تنفيذ مقترحة اليوم.
              </div>
            ) : (
              <div className="space-y-4">
                {executionWindows.map((win) => (
                  <div key={win.id} className="flex gap-3 items-start pb-4 border-b border-slate-100 last:border-0 last:pb-0">
                    <div className="p-2 rounded-full border shrink-0 mt-1 bg-emerald-50 border-emerald-100">
                      <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                    </div>
                    <div>
                      <p className="text-sm font-bold text-slate-800 mb-1">
                        {win.start_time && format(new Date(win.start_time), 'HH:mm')} — {win.end_time && format(new Date(win.end_time), 'HH:mm')}
                      </p>
                      <p className="text-xs text-slate-500 mb-1">
                        في مشروع <span className="font-bold text-slate-700">{win.projects?.name}</span>
                      </p>
                      {win.note && <p className="text-xs text-slate-400">{win.note}</p>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ============================================================ */}
      {/* 6. خريطة المشاريع */}
      {/* ============================================================ */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5">
        <h2 className="font-extrabold text-[#061B40] text-lg flex items-center gap-2 mb-4">
          <MapIcon className="w-5 h-5 text-[#0176FB]" />
          خريطة المشاريع
        </h2>

        {mapPoints.length === 0 ? (
          <div className="h-64 flex items-center justify-center text-slate-400 font-bold text-sm bg-slate-50 rounded-xl">
            لا تتوفر إحداثيات (latitude / longitude) للمشاريع بعد.
          </div>
        ) : (
          <div className="h-80 rounded-xl border border-slate-100 overflow-hidden">
            <ProjectsMap points={mapPoints} onSelect={(id) => router.push(`/dashboard/Projects/${id}`)} />
          </div>
        )}
      </div>
    </div>
  );
}
