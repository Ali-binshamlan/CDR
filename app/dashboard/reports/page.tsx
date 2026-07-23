"use client";
import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { apiClient } from '@/app/lib/apiClient';
import {
  MapPin,
  Download,
  ChevronDown,
  Loader2,
  CalendarDays,
  BarChart3,
  TrendingUp,
  TrendingDown,
  AlertOctagon,
  ShieldCheck,
  CloudFog,
  Activity,
  Printer
} from 'lucide-react';

// ============================================================
// الواجهات وأنواع البيانات
// ============================================================
interface ReportMetrics {
  totalActivities: number;
  safeActivities: number;
  stoppedActivities: number;
  totalAlerts: number;
  criticalAlerts: number;
  mostAffectedProject: string | null;
  dominantWeatherFactor: string | null;
}

interface ProjectStat {
  projectId: string;
  projectName: string;
  total: number;
  safe: number;
  stopped: number;
  alerts: number;
  impactPercentage: number;
}

export default function ReportsPage() {
  const [isLoading, setIsLoading] = useState(true);

  // البيانات الخام التي سنجلبها ونحللها
  const [rawDecisions, setRawDecisions] = useState<any[]>([]);
  const [rawAlerts, setRawAlerts] = useState<any[]>([]);
  const [projectsMap, setProjectsMap] = useState<Map<string, string>>(new Map());

  // فلاتر التواريخ
  const defaultFromDate = new Date();
  defaultFromDate.setDate(defaultFromDate.getDate() - 30);

  const [fromDate, setFromDate] = useState<string>(defaultFromDate.toLocaleDateString('en-CA'));
  const [toDate, setToDate] = useState<string>(new Date().toLocaleDateString('en-CA'));
  const [projectFilter, setProjectFilter] = useState<string>('ALL');

  const fetchReportData = useCallback(async () => {
    setIsLoading(true);
    try {
      const { data: list } = await apiClient.get('/dashboard/reports', { params: { fromDate, toDate } });
      const dbProjects = list?.projects || [];

      const pMap = new Map<string, string>();
      (dbProjects as any[]).forEach((p) => pMap.set(p.id, p.name));
      setProjectsMap(pMap);

      setRawDecisions(list?.decisions || []);
      setRawAlerts(list?.alerts || []);

    } catch (error: any) {
      console.error('Error fetching report data:', error?.message || error);
    } finally {
      setIsLoading(false);
    }
  }, [fromDate, toDate]);

  useEffect(() => {
    fetchReportData();
  }, [fetchReportData]);

  // ============================================================
  // محرك التحليل (Analytics Engine) - تجميع البيانات للواجهة
  // ============================================================

  // تصفية البيانات حسب المشروع المختار (إذا لم يكن "الكل")
  const filteredDecisions = useMemo(() => {
    if (projectFilter === 'ALL') return rawDecisions;
    return rawDecisions.filter(d => d.project_id === projectFilter);
  }, [rawDecisions, projectFilter]);

  const filteredAlerts = useMemo(() => {
    if (projectFilter === 'ALL') return rawAlerts;
    return rawAlerts.filter(a => a.project_id === projectFilter);
  }, [rawAlerts, projectFilter]);

  // حساب المؤشرات العامة (KPIs)
  const metrics = useMemo<ReportMetrics>(() => {
    const totalActivities = filteredDecisions.length;
    const safeActivities = filteredDecisions.filter(d => d.status === 'safe' || d.status === 'caution').length;
    const stoppedActivities = filteredDecisions.filter(d => d.status === 'stopped' || d.status === 'postpone').length;

    const totalAlerts = filteredAlerts.length;
    // DCR: كل الأنشطة والتنبيهات مصدرها الغبار فقط — التنبيه الحرج الوحيد
    // هو تجاوز حد صارم (SAFETY_BREACH)
    const criticalAlerts = filteredAlerts.filter(a =>
      a.severity === 'CRITICAL' || ['SAFETY_BREACH'].includes(a.kind)
    ).length;

    // حساب المشروع الأكثر تضرراً
    const projectImpactCount: Record<string, number> = {};
    rawDecisions.filter(d => d.status === 'stopped' || d.status === 'postpone').forEach(d => {
      projectImpactCount[d.project_id] = (projectImpactCount[d.project_id] || 0) + 1;
    });
    let mostAffected = null;
    let maxImpact = 0;
    Object.entries(projectImpactCount).forEach(([pId, count]) => {
      if (count > maxImpact) {
        maxImpact = count;
        mostAffected = projectsMap.get(pId) || null;
      }
    });

    // العامل المناخي السائد — DCR لا يملك سوى مصدر الغبار
    const stoppedCount = rawDecisions.filter(d => d.status === 'stopped' || d.status === 'postpone').length;
    const dominantWeatherFactor = stoppedCount > 0 ? 'انعدام الرؤية/الغبار' : 'مستقر';

    return { totalActivities, safeActivities, stoppedActivities, totalAlerts, criticalAlerts, mostAffectedProject: mostAffected, dominantWeatherFactor };
  }, [filteredDecisions, filteredAlerts, rawDecisions, projectsMap]);

  // حساب إحصائيات كل مشروع للجدول
  const projectStats = useMemo<ProjectStat[]>(() => {
    const statsMap = new Map<string, ProjectStat>();

    projectsMap.forEach((name, id) => {
      statsMap.set(id, { projectId: id, projectName: name, total: 0, safe: 0, stopped: 0, alerts: 0, impactPercentage: 0 });
    });

    rawDecisions.forEach(d => {
      const stat = statsMap.get(d.project_id);
      if (stat) {
        stat.total++;
        if (d.status === 'safe' || d.status === 'caution') stat.safe++;
        if (d.status === 'stopped' || d.status === 'postpone') stat.stopped++;
      }
    });

    rawAlerts.forEach(a => {
      const stat = statsMap.get(a.project_id);
      if (stat) stat.alerts++;
    });

    return Array.from(statsMap.values()).map(stat => {
      stat.impactPercentage = stat.total === 0 ? 0 : Math.round((stat.stopped / stat.total) * 100);
      return stat;
    }).sort((a, b) => b.impactPercentage - a.impactPercentage); // ترتيب حسب الأكثر تضرراً
  }, [rawDecisions, rawAlerts, projectsMap]);

  const projectsList = Array.from(projectsMap.entries());

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-[#F4F7FB] text-[#061B40]">
        <Loader2 className="w-10 h-10 animate-spin text-[#0176FB] mb-4" />
        <h2 className="font-bold text-lg">جاري تجهيز التقارير التحليلية...</h2>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F4F7FB] p-6 lg:p-8 font-sans" dir="rtl">
      <div className="max-w-[1440px] mx-auto space-y-6">

        {/* الترويسة وأزرار التصدير */}
        <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center gap-4 bg-white p-6 rounded-2xl border border-slate-200 shadow-sm relative overflow-hidden">
          <div className="absolute top-0 right-0 w-2 h-full bg-[#0176FB]"></div>
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 bg-blue-50 text-blue-600 rounded-xl flex items-center justify-center border border-blue-100 shadow-inner">
              <BarChart3 className="w-6 h-6" />
            </div>
            <div>
              <h1 className="text-3xl font-black text-[#061B40] mb-1">التقارير والإحصائيات</h1>
              <p className="text-sm font-bold text-slate-500">
                لوحة تحكم إدارية لتحليل أثر الامتثال التنظيمي للغبار على كفاءة سير العمل
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3 w-full lg:w-auto">
            <button className="bg-white border border-slate-200 text-slate-700 px-4 py-2.5 rounded-xl text-sm font-bold hover:bg-slate-50 flex items-center gap-2 shadow-sm transition-all w-full lg:w-auto justify-center">
              <Printer className="w-4 h-4" /> طباعة التقرير
            </button>
            <button className="bg-[#061B40] border border-[#061B40] text-white px-4 py-2.5 rounded-xl text-sm font-bold hover:bg-[#0a275e] flex items-center gap-2 shadow-sm transition-all w-full lg:w-auto justify-center">
              <Download className="w-4 h-4" /> تصدير PDF تنفيذي
            </button>
          </div>
        </div>

        {/* شريط الفلاتر الموحد */}
        <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm flex flex-col md:flex-row gap-6 justify-between items-center">
          <div className="flex flex-wrap gap-4 items-center w-full md:w-auto">

            <div className="flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-xl p-1.5 shadow-sm">
              <div className="flex items-center gap-2 px-2">
                <CalendarDays className="w-4 h-4 text-slate-400" />
                <span className="text-xs font-black text-slate-500">من:</span>
                <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="text-xs font-bold bg-transparent focus:outline-none text-[#061B40] cursor-pointer" />
              </div>
              <div className="h-5 w-px bg-slate-200"></div>
              <div className="flex items-center gap-2 px-2">
                <span className="text-xs font-black text-slate-500">إلى:</span>
                <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className="text-xs font-bold bg-transparent focus:outline-none text-[#061B40] cursor-pointer" />
              </div>
            </div>

            <div className="flex items-center gap-2">
              <div className="relative">
                <select value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)} className="appearance-none bg-white border border-slate-200 rounded-xl text-xs font-bold px-4 py-2.5 pl-8 focus:outline-none focus:ring-2 focus:ring-blue-500/20 shadow-sm text-slate-700 min-w-[180px]">
                  <option value="ALL">نظرة عامة (جميع المشاريع)</option>
                  {projectsList.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
                </select>
                <ChevronDown className="w-4 h-4 text-slate-400 absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none" />
              </div>
            </div>

          </div>
        </div>

        {/* الملخص الذكي (Automated Insights) */}
        <div className="bg-indigo-50 border border-indigo-100 rounded-2xl p-6 shadow-sm flex gap-4 items-start">
          <div className="w-10 h-10 bg-indigo-100 text-indigo-600 rounded-full flex items-center justify-center shrink-0">
            <Activity className="w-5 h-5" />
          </div>
          <div>
            <h3 className="text-sm font-black text-indigo-900 mb-2">الملخص التحليلي للفترة</h3>
            <p className="text-sm text-indigo-800 leading-relaxed font-medium">
              خلال الفترة المحددة، تم تقييم <strong className="font-black">{metrics.totalActivities}</strong> نشاطاً ميدانياً.
              نجح النظام في تأمين <strong className="font-black">{metrics.safeActivities}</strong> نشاطاً لاستمرارية العمل،
              بينما تطلب الأمر التدخل وإيقاف/تأجيل <strong className="font-black">{metrics.stoppedActivities}</strong> نشاطاً لضمان الامتثال والسلامة.
              {metrics.mostAffectedProject && projectFilter === 'ALL' && (
                <span> المشروع الأكثر تضرراً هو <strong className="font-black">{metrics.mostAffectedProject}</strong>. </span>
              )}
              العامل ذو التأثير الأكبر على تعطل الأعمال كان <strong className="font-black">{metrics.dominantWeatherFactor}</strong>.
            </p>
          </div>
        </div>

        {/* المؤشرات السريعة (KPI Grid) */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm relative overflow-hidden group hover:border-emerald-200 transition-colors">
            <div className="flex justify-between items-start mb-4">
              <div className="w-10 h-10 bg-emerald-50 text-emerald-600 rounded-xl flex items-center justify-center">
                <ShieldCheck className="w-5 h-5" />
              </div>
              <span className="text-[10px] font-bold text-emerald-600 bg-emerald-50 px-2 py-1 rounded-full flex items-center gap-1">
                <TrendingUp className="w-3 h-3" /> استقرار
              </span>
            </div>
            <p className="text-3xl font-black text-[#061B40] mb-1">{metrics.safeActivities}</p>
            <p className="text-xs font-bold text-slate-500">الأنشطة المنفذة بأمان</p>
          </div>

          <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm relative overflow-hidden group hover:border-red-200 transition-colors">
            <div className="flex justify-between items-start mb-4">
              <div className="w-10 h-10 bg-red-50 text-red-500 rounded-xl flex items-center justify-center">
                <AlertOctagon className="w-5 h-5" />
              </div>
              <span className="text-[10px] font-bold text-red-500 bg-red-50 px-2 py-1 rounded-full flex items-center gap-1">
                <TrendingDown className="w-3 h-3" /> تأخير
              </span>
            </div>
            <p className="text-3xl font-black text-red-600 mb-1">{metrics.stoppedActivities}</p>
            <p className="text-xs font-bold text-slate-500">أنشطة تم إيقافها/تأجيلها</p>
          </div>

          <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm relative overflow-hidden group hover:border-orange-200 transition-colors">
            <div className="flex justify-between items-start mb-4">

            </div>
            <p className="text-3xl font-black text-[#061B40] mb-1">{metrics.totalAlerts}</p>
            <p className="text-xs font-bold text-slate-500">إجمالي التنبيهات الصادرة</p>
          </div>

          <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm relative overflow-hidden group hover:border-purple-200 transition-colors">
            <div className="flex justify-between items-start mb-4">
              <div className="w-10 h-10 bg-purple-50 text-purple-600 rounded-xl flex items-center justify-center">
                <CloudFog className="w-5 h-5" />
              </div>
            </div>
            <p className="text-3xl font-black text-[#061B40] mb-1">{metrics.criticalAlerts}</p>
            <p className="text-xs font-bold text-slate-500">تنبيهات عالية الخطورة (Critical)</p>
          </div>
        </div>

        {/* الجدول التحليلي للمشاريع */}
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="p-5 border-b border-slate-100 flex justify-between items-center">
            <div>
              <h2 className="text-lg font-black text-[#061B40]">مقارنة أداء المشاريع</h2>
              <p className="text-xs font-bold text-slate-500 mt-1">ترتيب المشاريع حسب نسبة الأنشطة المتعطلة بسبب الغبار</p>
            </div>
            <MapPin className="w-5 h-5 text-slate-300" />
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm text-right text-slate-600">
              <thead className="text-xs text-slate-500 bg-slate-50 border-b border-slate-200">
                <tr>
                  <th className="px-5 py-4 font-black">اسم المشروع</th>
                  <th className="px-5 py-4 font-black text-center">إجمالي الأنشطة</th>
                  <th className="px-5 py-4 font-black text-center text-emerald-600">آمنة</th>
                  <th className="px-5 py-4 font-black text-center text-red-500">متوقفة</th>
                  <th className="px-5 py-4 font-black text-center">التنبيهات</th>
                  <th className="px-5 py-4 font-black min-w-[200px]">نسبة التأثر (Impact)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {projectStats.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="text-center py-10 text-slate-400 font-bold">لا توجد بيانات للفترة المحددة</td>
                  </tr>
                ) : (
                  projectStats.map((stat) => (
                    <tr key={stat.projectId} className="hover:bg-slate-50 transition-colors">
                      <td className="px-5 py-4 font-black text-[#061B40]">{stat.projectName}</td>
                      <td className="px-5 py-4 font-bold text-center">{stat.total}</td>
                      <td className="px-5 py-4 font-bold text-center text-emerald-600">{stat.safe}</td>
                      <td className="px-5 py-4 font-bold text-center text-red-500">{stat.stopped}</td>
                      <td className="px-5 py-4 font-bold text-center text-orange-500">{stat.alerts}</td>
                      <td className="px-5 py-4">
                        <div className="flex items-center gap-3">
                          <span className={`text-xs font-black w-8 ${stat.impactPercentage > 30 ? 'text-red-500' : stat.impactPercentage > 10 ? 'text-amber-500' : 'text-emerald-500'}`}>
                            {stat.impactPercentage}%
                          </span>
                          <div className="flex-1 h-2 bg-slate-100 rounded-full overflow-hidden">
                            <div
                              className={`h-full rounded-full ${stat.impactPercentage > 30 ? 'bg-red-500' : stat.impactPercentage > 10 ? 'bg-amber-500' : 'bg-emerald-500'}`}
                              style={{ width: `${stat.impactPercentage}%` }}
                            ></div>
                          </div>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

      </div>
    </div>
  );
}
