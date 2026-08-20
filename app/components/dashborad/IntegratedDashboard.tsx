"use client";

import React, { useState, useEffect, useMemo } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';
import { apiClient } from '@/app/lib/apiClient';
import type { ProjectPoint } from './ProjectsMap';
import { decisionMeta, alertKindToDecision, alertKindLabelAr, dviLevelToDecision } from '@/app/lib/decisionMeta';
import { displayActivityLabel } from '@/app/lib/activityLabels';
import {
  Loader2, Map as MapIcon, FolderKanban, Activity, Bell,
  ArrowLeft, MapPin, Clock, Plus,
} from 'lucide-react';

const ProjectsMap = dynamic(() => import('./ProjectsMap'), {
  ssr: false,
  loading: () => (
    <div className="h-full flex items-center justify-center text-slate-400 font-bold text-sm bg-slate-50">
      جاري تحميل الخريطة...
    </div>
  ),
});

// Integrated dashboard for standard users — replaces GlobalDashboard (map-only)
// as their main page, featuring stat cards and quick lists above the same map. It consumes
// the same /dashboard/global without any modification — all required fields (projects,
// alerts filtered by state != CLOSED, dustActivities filtered by planned_date=today,
// liveActivityByProjectId) are already present in it. GlobalDashboard.tsx remains unchanged
// as it is also used in /dashboard/viewer (a intentionally map-only design).
interface DashboardProjectRow {
  id: string;
  name: string;
  city?: string | null;
  latitude: number | null;
  longitude: number | null;
  project_status?: string | null;
  [key: string]: unknown;
}

interface DashboardActivityRow {
  id: string;
  project_id: string;
  planned_time?: string | null;
  regulatory_activity?: string | null;
  [key: string]: unknown;
}

interface DashboardAlertRow {
  id: string;
  project_id: string;
  kind: string;
  created_at: string;
  [key: string]: unknown;
}

interface LiveActivitySummary {
  decisionLabelAr: string;
  shortReason: string;
  level: string;
  mandatoryStop: boolean;
}

export default function IntegratedDashboard() {
  const router = useRouter();

  const [projects, setProjects] = useState<DashboardProjectRow[]>([]);
  const [todayActivities, setTodayActivities] = useState<DashboardActivityRow[]>([]);
  const [alerts, setAlerts] = useState<DashboardAlertRow[]>([]);
  const [liveActivityByProjectId, setLiveActivityByProjectId] = useState<Record<string, LiveActivitySummary>>({});
  const [isLoading, setIsLoading] = useState(true);
  // Detected and fixed bug (explicit user request — "Network errors often turn into
  // misleading zero numbers or empty states"): the catch block only logged console.error
  // without setting an error state — a network failure resulted in "0 projects / 0 activities / 0
  // alerts" cards and "No data available" lists, visually identical to an actual successful response
  // with no data. The error state renders an explicit error screen instead (same pattern as
  // Projects/[id]/page.tsx).
  const [error, setError] = useState<string | null>(null);
  const [retryTick, setRetryTick] = useState(0);

  useEffect(() => {
    const fetchDashboardData = async () => {
      try {
        setIsLoading(true);
        setError(null);
        const { data: dash } = await apiClient.get('/dashboard/global');
        setProjects(dash?.projects || []);
        setTodayActivities(dash?.dustActivities || []);
        setAlerts(dash?.alerts || []);
        setLiveActivityByProjectId(dash?.liveActivityByProjectId || {});
      } catch (err) {
        console.error('Error fetching dashboard data:', err);
        const axiosErr = err as { response?: { data?: { error?: string } } };
        setError(axiosErr?.response?.data?.error || 'تعذّر جلب بيانات لوحة التحكم — تحقّق من الاتصال وأعد المحاولة.');
      } finally {
        setIsLoading(false);
      }
    };

    fetchDashboardData();
  }, [retryTick]);

  const projectNameById = useMemo(
    () => new Map(projects.map((p) => [p.id, p.name])),
    [projects]
  );

  const recentAlerts = useMemo(
    () =>
      [...alerts]
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
        .slice(0, 5),
    [alerts]
  );

  const todayActivitiesSorted = useMemo(
    () => [...todayActivities].sort((a, b) => String(a.planned_time).localeCompare(String(b.planned_time))),
    [todayActivities]
  );

  // Same mapPoints logic as in GlobalDashboard.tsx — decision is derived exclusively from the
  // currently active ongoing activity (unified activity decision), with no fallback to the critical alert level.
  const mapPoints: ProjectPoint[] = useMemo(() => {
    return projects
      .filter((p) => typeof p.latitude === 'number' && typeof p.longitude === 'number')
      .map((p) => {
        const liveActivity = liveActivityByProjectId[p.id];
        const todayActivitiesCount = todayActivities.filter((a) => a.project_id === p.id).length;
        return {
          id: p.id,
          name: p.name,
          city: p.city ?? undefined,
          latitude: p.latitude as number,
          longitude: p.longitude as number,
          decision: liveActivity ? dviLevelToDecision(liveActivity.level, liveActivity.mandatoryStop) : null,
          projectStatus: p.project_status,
          todayActivitiesCount,
          hasLiveActivity: !!liveActivity,
          statusLabel: liveActivity?.decisionLabelAr,
          statusReason: liveActivity?.shortReason,
        };
      });
  }, [projects, todayActivities, liveActivityByProjectId]);

  if (isLoading) {
    return (
      <div className="h-full bg-[#F4F7FB] flex items-center justify-center" dir="rtl">
        <div className="flex flex-col items-center gap-4 text-[#061B40]">
          <Loader2 className="w-10 h-10 animate-spin text-[#0176FB]" />
          <h2 className="font-bold text-lg">جاري جلب بيانات لوحة التحكم...</h2>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-full bg-[#F4F7FB] flex items-center justify-center" dir="rtl">
        <div className="flex flex-col items-center gap-4 text-center max-w-md px-4">
          <h2 className="text-xl font-black text-red-600">تعذّر تحميل لوحة التحكم</h2>
          <p className="text-slate-500 text-sm font-medium">{error}</p>
          <button
            type="button"
            onClick={() => setRetryTick((t) => t + 1)}
            className="bg-[#0176FB] hover:bg-[#0176FB]/90 text-white text-sm font-bold px-5 py-2.5 rounded-xl transition-colors"
          >
            إعادة المحاولة
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-full bg-[#F4F7FB] p-6 lg:p-8 font-sans" dir="rtl">
      <div className="max-w-[1440px] mx-auto space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h1 className="text-3xl font-black text-[#061B40] mb-1">لوحة التحكم</h1>
            <p className="text-slate-500 text-sm font-medium">نظرة شاملة على مشاريعك وأنشطة اليوم والتنبيهات النشطة</p>
          </div>
          <Link
            href="/dashboard/Projects/create"
            className="w-full sm:w-auto bg-[#3995FF] hover:bg-blue-600 text-white px-5 py-2.5 rounded-xl text-sm font-bold flex items-center justify-center gap-2 shadow-sm transition-colors shrink-0"
          >
            <Plus className="w-4 h-4" strokeWidth={3} /> إضافة مشروع
          </Link>
        </div>

        {/* Stat Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-blue-50 text-[#0176FB] flex items-center justify-center shrink-0">
              <FolderKanban className="w-6 h-6" />
            </div>
            <div>
              <div className="text-2xl font-black text-[#061B40]">{projects.length}</div>
              <div className="text-xs font-bold text-slate-400">عدد المشاريع</div>
            </div>
          </div>

          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center shrink-0">
              <Activity className="w-6 h-6" />
            </div>
            <div>
              <div className="text-2xl font-black text-[#061B40]">{todayActivities.length}</div>
              <div className="text-xs font-bold text-slate-400">أنشطة اليوم</div>
            </div>
          </div>

          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-orange-50 text-orange-600 flex items-center justify-center shrink-0">
              <Bell className="w-6 h-6" />
            </div>
            <div>
              <div className="text-2xl font-black text-[#061B40]">{alerts.length}</div>
              <div className="text-xs font-bold text-slate-400">التنبيهات النشطة</div>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Today's Activities */}
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden flex flex-col">
            <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
              <h2 className="font-extrabold text-[#061B40] text-base flex items-center gap-2">
                <Activity className="w-4 h-4 text-emerald-600" /> أنشطة اليوم
              </h2>
            </div>
            <div className="divide-y divide-slate-100 max-h-[360px] overflow-y-auto">
              {todayActivitiesSorted.length === 0 ? (
                <div className="p-8 text-center text-sm font-bold text-slate-400">لا توجد أنشطة مجدولة اليوم</div>
              ) : (
                todayActivitiesSorted.map((a) => (
                  <Link
                    key={a.id}
                    href={`/dashboard/Projects/${a.project_id}`}
                    className="flex items-center justify-between gap-3 px-5 py-3 hover:bg-slate-50 transition-colors"
                  >
                    <div className="min-w-0">
                      <div className="font-bold text-sm text-[#061B40] truncate">{displayActivityLabel(a)}</div>
                      <div className="flex items-center gap-1.5 text-xs text-slate-400 font-semibold mt-0.5">
                        <MapPin className="w-3 h-3 shrink-0" />
                        <span className="truncate">{projectNameById.get(a.project_id) || '—'}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 text-xs font-bold text-slate-500 shrink-0">
                      <Clock className="w-3.5 h-3.5" />
                      {String(a.planned_time || '').slice(0, 5) || '—'}
                    </div>
                  </Link>
                ))
              )}
            </div>
          </div>

          {/* Latest Alerts */}
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden flex flex-col">
            <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
              <h2 className="font-extrabold text-[#061B40] text-base flex items-center gap-2">
                <Bell className="w-4 h-4 text-orange-600" /> أحدث التنبيهات
              </h2>
              <Link href="/dashboard/alerts" className="text-xs font-bold text-[#0176FB] hover:underline flex items-center gap-1">
                عرض الكل <ArrowLeft className="w-3 h-3" />
              </Link>
            </div>
            <div className="divide-y divide-slate-100 max-h-[360px] overflow-y-auto">
              {recentAlerts.length === 0 ? (
                <div className="p-8 text-center text-sm font-bold text-slate-400">لا توجد تنبيهات نشطة حالياً</div>
              ) : (
                recentAlerts.map((a) => {
                  const meta = decisionMeta[alertKindToDecision(a.kind)];
                  return (
                    <Link
                      key={a.id}
                      href={`/dashboard/Projects/${a.project_id}`}
                      className="flex items-center justify-between gap-3 px-5 py-3 hover:bg-slate-50 transition-colors"
                    >
                      <div className="min-w-0 flex items-center gap-2">
                        <span className={`w-2 h-2 rounded-full shrink-0 ${meta.dot}`} />
                        <span className="font-bold text-sm text-[#061B40] truncate">{projectNameById.get(a.project_id) || '—'}</span>
                      </div>
                      <span className={`px-2.5 py-1 rounded-full text-[11px] font-black shrink-0 ${meta.bg} ${meta.text} border ${meta.border}`}>
                        {alertKindLabelAr[a.kind] || meta.label}
                      </span>
                    </Link>
                  );
                })
              )}
            </div>
          </div>
        </div>

        {/* Map */}
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden flex flex-col">
          <div className="px-5 py-4 border-b border-slate-100 flex items-center gap-2">
            <MapIcon className="w-4 h-4 text-[#0176FB]" />
            <h2 className="font-extrabold text-[#061B40] text-base">خريطة المشاريع</h2>
          </div>
          <div className="h-[500px]">
            {mapPoints.length === 0 ? (
              <div className="h-full flex items-center justify-center text-slate-400 font-bold text-sm">
                لا تتوفر إحداثيات (latitude / longitude) للمشاريع بعد.
              </div>
            ) : (
              // Detected and fixed bug (User feedback: "In the standard user map,
              // readings appear... they are not from the IoT device"): Weather readings section in
              // HoverCard (ProjectsMap.tsx) fetches from /api/weather — Open-Meteo general
              // estimate for the geographic location, without checking for an actual linked IoT monitoring
              // device or its real live readings. A user assuming it's their physical device reading is misled.
              // hideRawReadings suppresses this section entirely (and the /api/weather call itself) —
              // same mechanism originally used for the viewer dashboard map (GlobalDashboard.tsx).
              <ProjectsMap points={mapPoints} onSelect={(id) => router.push(`/dashboard/Projects/${id}`)} hideRawReadings />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}