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

// Security Vulnerability Discovered & Fixed (explicit user request — "Exporting report places project name
// inside document.write without HTML sanitization"): Project name is free-text chosen by the project owner
// without any schema validation at creation (POST /api/projects applies no schema to name at all) or update
// (PATCH limits length to 200 chars only, does not prevent HTML tags). It arrived raw at handleExportPdf below
// and was merged directly into a single HTML template passed entirely to document.write without sanitization.
// A malicious project owner (or compromised account) could set <script>/<img onerror=...> as their project name,
// executing it in the export window of any other user (different project owner exporting a report covering all projects,
// or auditor/admin via /viewer/reports) who opens that report — Stored XSS. escapeHtml is applied to every
// free-text value (project name) before merging into the template; numeric/computed values and static labels
// do not require sanitization as they cannot carry HTML.
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ============================================================
// Interfaces and Data Types
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

interface ReportsViewProps {
  // Data endpoint — defaults to current user reports only. Observer entity
  // (viewer) passes '/viewer/reports' (exact same shape of {projects, decisions, alerts},
  // without user_id filtering) to display an aggregated report for all projects.
  apiEndpoint?: string;
}

// status derived from final_decisions (operational_decision + mandatory_stop)
// via app/lib/finalDecisionStatus.ts on server — see fetchReportData comment
// below for details on transition from decision_records (removed feature).
interface RawDecisionRow {
  id: string;
  project_id: string;
  status: 'safe' | 'caution' | 'restricted' | 'stopped';
}

interface RawAlertRow {
  id: string;
  project_id: string;
  kind: string;
}

export default function ReportsView({ apiEndpoint = '/dashboard/reports' }: ReportsViewProps) {
  const [isLoading, setIsLoading] = useState(true);

  // Raw data to fetch and analyze
  const [rawDecisions, setRawDecisions] = useState<RawDecisionRow[]>([]);
  const [rawAlerts, setRawAlerts] = useState<RawAlertRow[]>([]);
  const [projectsMap, setProjectsMap] = useState<Map<string, string>>(new Map());

  // Date filters
  const defaultFromDate = new Date();
  defaultFromDate.setDate(defaultFromDate.getDate() - 30);

  const [fromDate, setFromDate] = useState<string>(defaultFromDate.toLocaleDateString('en-CA'));
  const [toDate, setToDate] = useState<string>(new Date().toLocaleDateString('en-CA'));
  const [projectFilter, setProjectFilter] = useState<string>('ALL');
  
  // Discovered & Fixed Bug (explicit user request — "Network errors often turn into misleading zero values or empty states"):
  // Fetch failure meant all KPI indicators reset to zero (0 safe/stopped/alert activities) and a table showing
  // "No data for selected period" — an executive report that could be misread as "everything is perfect" or "no activity".
  //
  // Discovered & Fixed Architectural Flaw ("Component saving decision_records is hidden while reports depend on it;
  // thus reports may show zero despite existing automated decisions"): decision_records was a table for manually documented decisions only
  // (direct field decision button in DustWidgetCard — component now completely removed, was disabled behind {false && ...} in project page).
  // Actual automated decisions from evaluation engine are written exclusively to final_decisions, so system could be fully running automated
  // while this report rendered complete zeros. The API (dashboard/reports and viewer/reports) now builds decisions directly from final_decisions —
  // this component requires no extra modifications since status shape remains identical.
  const [error, setError] = useState<string | null>(null);

  const fetchReportData = useCallback(async () => {
    // Instant await (microtask) before first setState — separates function execution itself
    // (direct from Effect body) from first synchronous state update without noticeable delay
    // (microtask executes before layout/paint). See https://react.dev/learn/you-might-not-need-an-effect.
    await Promise.resolve();
    setIsLoading(true);
    setError(null);
    try {
      const { data: list } = await apiClient.get(apiEndpoint, { params: { fromDate, toDate } });
      const dbProjects = list?.projects || [];

      const pMap = new Map<string, string>();
      (dbProjects as { id: string; name: string }[]).forEach((p) => pMap.set(p.id, p.name));
      setProjectsMap(pMap);

      setRawDecisions(list?.decisions || []);
      setRawAlerts(list?.alerts || []);

    } catch (err: unknown) {
      console.error('Error fetching report data:', (err as { message?: string })?.message || err);
      const axiosErr = err as { response?: { data?: { error?: string } } };
      setError(axiosErr?.response?.data?.error || 'تعذّر جلب بيانات التقرير — تحقّق من الاتصال وأعد المحاولة.');
    } finally {
      setIsLoading(false);
    }
  }, [apiEndpoint, fromDate, toDate]);

  useEffect(() => {
    // Schedule via microtask instead of calling fetchReportData directly from Effect body —
    // same reason documented above the function (synchronous state update inside Effect).
    let cancelled = false;
    void Promise.resolve().then(() => { if (!cancelled) fetchReportData(); });
    return () => { cancelled = true; };
  }, [fetchReportData]);

  // ============================================================
  // Analytics Engine - Data aggregation for UI
  // ============================================================

  // Filter data by selected project (if not "ALL")
  const filteredDecisions = useMemo(() => {
    if (projectFilter === 'ALL') return rawDecisions;
    return rawDecisions.filter(d => d.project_id === projectFilter);
  }, [rawDecisions, projectFilter]);

  const filteredAlerts = useMemo(() => {
    if (projectFilter === 'ALL') return rawAlerts;
    return rawAlerts.filter(a => a.project_id === projectFilter);
  }, [rawAlerts, projectFilter]);

  // Calculate Key Performance Indicators (KPIs)
  const metrics = useMemo<ReportMetrics>(() => {
    const totalActivities = filteredDecisions.length;
    const safeActivities = filteredDecisions.filter(d => d.status === 'safe' || d.status === 'caution').length;
    const stoppedActivities = filteredDecisions.filter(d => d.status === 'stopped').length;

    const totalAlerts = filteredAlerts.length;
    // DCR: All activities and alerts originate from dust only — critical alerts are strict
    // physical breaches (SAFETY_BREACH) or actual regulatory violations stopping work
    // (COMPLIANCE_VIOLATION, from compliance engine).
    //
    // Discovered & Fixed Bug (external code review — "Outbox mixes mandatory and precautionary stop",
    // see migration 202608110020): PROTECTIVE_STOP is a new standalone kind — activity is currently stopped
    // (same operational impact as SAFETY_BREACH) despite status not yet admin-confirmed, so it is counted
    // under critical alerts here as well — counting it under "medium warning" only falsely lowered displayed critical count.
    const criticalAlerts = filteredAlerts.filter(a =>
      ['SAFETY_BREACH', 'PROTECTIVE_STOP', 'COMPLIANCE_VIOLATION'].includes(a.kind)
    ).length;

    // Calculate most affected project
    const projectImpactCount: Record<string, number> = {};
    rawDecisions.filter(d => d.status === 'stopped').forEach(d => {
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

    // Dominant weather factor — DCR only monitors dust sources
    const stoppedCount = rawDecisions.filter(d => d.status === 'stopped').length;
    const dominantWeatherFactor = stoppedCount > 0 ? 'انعدام الرؤية/الغبار' : 'مستقر';

    return { totalActivities, safeActivities, stoppedActivities, totalAlerts, criticalAlerts, mostAffectedProject: mostAffected, dominantWeatherFactor };
  }, [filteredDecisions, filteredAlerts, rawDecisions, projectsMap]);

  // Calculate per-project statistics for table
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
        if (d.status === 'stopped') stat.stopped++;
      }
    });

    rawAlerts.forEach(a => {
      const stat = statsMap.get(a.project_id);
      if (stat) stat.alerts++;
    });

    return Array.from(statsMap.values()).map(stat => {
      stat.impactPercentage = stat.total === 0 ? 0 : Math.round((stat.stopped / stat.total) * 100);
      return stat;
    }).sort((a, b) => b.impactPercentage - a.impactPercentage); // Sort by most affected
  }, [rawDecisions, rawAlerts, projectsMap]);

  const projectsList = Array.from(projectsMap.entries());

  // Executive PDF Export: No client-side PDF library (jsPDF lacks Arabic/RTL support in default built-in fonts) —
  // custom print window styled independently from current page, user selects "Save as PDF" from browser print dialog,
  // which natively supports Arabic and RTL via CSS.
  const handleExportPdf = useCallback(() => {
    const printWindow = window.open('', '_blank');
    if (!printWindow) return;

    const generatedAt = new Date().toLocaleString('ar-SA', { calendar: 'gregory', dateStyle: 'long', timeStyle: 'short' });
    const projectFilterLabel = escapeHtml(projectFilter === 'ALL' ? 'جميع المشاريع' : (projectsMap.get(projectFilter) || projectFilter));

    const rowsHtml = projectStats.length === 0
      ? `<tr><td colspan="6" style="text-align:center;padding:24px;color:#94a3b8;">لا توجد بيانات للفترة المحددة</td></tr>`
      : projectStats.map((s) => `
        <tr>
          <td>${escapeHtml(s.projectName)}</td>
          <td style="text-align:center;">${s.total}</td>
          <td style="text-align:center;color:#059669;">${s.safe}</td>
          <td style="text-align:center;color:#dc2626;">${s.stopped}</td>
          <td style="text-align:center;">${s.alerts}</td>
          <td style="text-align:center;">${s.impactPercentage}%</td>
        </tr>`).join('');

    printWindow.document.write(`<!doctype html>
<html dir="rtl" lang="ar">
<head>
<meta charset="utf-8" />
<title>التقرير التنفيذي — DCR</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: "Segoe UI", Tahoma, Arial, sans-serif; color: #061B40; padding: 32px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .meta { color: #64748b; font-size: 12px; margin-bottom: 24px; }
  .meta div { margin-bottom: 2px; }
  .summary { background: #eef2ff; border: 1px solid #e0e7ff; border-radius: 12px; padding: 16px; font-size: 13px; line-height: 1.8; margin-bottom: 24px; }
  .kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 24px; }
  .kpi { border: 1px solid #e2e8f0; border-radius: 10px; padding: 12px; text-align: center; }
  .kpi .value { font-size: 22px; font-weight: 900; }
  .kpi .label { font-size: 11px; color: #64748b; margin-top: 4px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { border: 1px solid #e2e8f0; padding: 8px 10px; text-align: right; }
  th { background: #f8fafc; font-weight: 800; }
  @media print { body { padding: 0; } }
</style>
</head>
<body>
  <h1>التقرير التنفيذي — الامتثال التنظيمي للغبار</h1>
  <div class="meta">
    <div>الفترة: من ${fromDate} إلى ${toDate}</div>
    <div>النطاق: ${projectFilterLabel}</div>
    <div>تاريخ الإصدار: ${generatedAt}</div>
  </div>
  <div class="summary">
    خلال الفترة المحددة، تم تقييم <strong>${metrics.totalActivities}</strong> نشاطاً ميدانياً.
    نجح النظام في تأمين <strong>${metrics.safeActivities}</strong> نشاطاً لاستمرارية العمل،
    بينما تطلب الأمر التدخل وإيقاف/تأجيل <strong>${metrics.stoppedActivities}</strong> نشاطاً لضمان الامتثال والسلامة.
    ${metrics.mostAffectedProject && projectFilter === 'ALL' ? `المشروع الأكثر تضرراً هو <strong>${escapeHtml(metrics.mostAffectedProject)}</strong>. ` : ''}
    العامل ذو التأثير الأكبر على تعطل الأعمال كان <strong>${metrics.dominantWeatherFactor}</strong>.
  </div>
  <div class="kpis">
    <div class="kpi"><div class="value">${metrics.safeActivities}</div><div class="label">الأنشطة المنفذة بأمان</div></div>
    <div class="kpi"><div class="value" style="color:#dc2626;">${metrics.stoppedActivities}</div><div class="label">أنشطة تم إيقافها/تأجيلها</div></div>
    <div class="kpi"><div class="value">${metrics.totalAlerts}</div><div class="label">إجمالي التنبيهات الصادرة</div></div>
    <div class="kpi"><div class="value">${metrics.criticalAlerts}</div><div class="label">تنبيهات عالية الخطورة</div></div>
  </div>
  <table>
    <thead>
      <tr>
        <th>اسم المشروع</th>
        <th style="text-align:center;">إجمالي الأنشطة</th>
        <th style="text-align:center;">آمنة</th>
        <th style="text-align:center;">متوقفة</th>
        <th style="text-align:center;">التنبيهات</th>
        <th style="text-align:center;">نسبة التأثر</th>
      </tr>
    </thead>
    <tbody>${rowsHtml}</tbody>
  </table>
</body>
</html>`);
    printWindow.document.close();
    printWindow.focus();
    // Delay print action until window document finishes loading
    printWindow.onload = () => {
      printWindow.print();
    };
  }, [projectStats, metrics, fromDate, toDate, projectFilter, projectsMap]);

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-[#F4F7FB] text-[#061B40]">
        <Loader2 className="w-10 h-10 animate-spin text-[#0176FB] mb-4" />
        <h2 className="font-bold text-lg">جاري تجهيز التقارير التحليلية...</h2>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-[#F4F7FB] gap-4 text-center px-4">
        <h2 className="text-xl font-black text-red-600">تعذّر تحميل التقارير</h2>
        <p className="text-slate-500 text-sm font-medium max-w-md">{error}</p>
        <button
          type="button"
          onClick={() => { void fetchReportData(); }}
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

        {/* Header and Export Buttons */}
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
            <button
              type="button"
              onClick={() => window.print()}
              className="bg-white border border-slate-200 text-slate-700 px-4 py-2.5 rounded-xl text-sm font-bold hover:bg-slate-50 flex items-center gap-2 shadow-sm transition-all w-full lg:w-auto justify-center"
            >
              <Printer className="w-4 h-4" /> طباعة التقرير
            </button>
            <button
              type="button"
              onClick={handleExportPdf}
              className="bg-[#061B40] border border-[#061B40] text-white px-4 py-2.5 rounded-xl text-sm font-bold hover:bg-[#0a275e] flex items-center gap-2 shadow-sm transition-all w-full lg:w-auto justify-center"
            >
              <Download className="w-4 h-4" /> تصدير PDF تنفيذي
            </button>
          </div>
        </div>

        {/* Unified Filter Bar */}
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

        {/* Automated Insights */}
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

        {/* KPI Grid */}
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

        {/* Project Performance Analytical Table */}
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