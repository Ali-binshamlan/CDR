"use client";

import React, { useState, useEffect, useMemo } from 'react';
import dynamic from 'next/dynamic';
import { apiClient } from '@/app/lib/apiClient';
import type { ProjectPoint } from './ProjectsMap';
import { dviLevelToDecision } from '@/app/lib/decisionMeta';
import { Loader2, Map as MapIcon } from 'lucide-react';

// Leaflet map requires `window`, so it must be loaded in the browser only without SSR
const ProjectsMap = dynamic(() => import('./ProjectsMap'), {
  ssr: false,
  loading: () => (
    <div className="h-full flex items-center justify-center text-slate-400 font-bold text-sm bg-slate-50">
      جاري تحميل الخريطة...
    </div>
  ),
});

interface GlobalDashboardProps {
  // Data endpoint — defaults to current user data only. The monitoring entity
  // (viewer) passes '/viewer/dashboard' (exact same response shape, without filtering
  // user_id) to display all projects across all users with the same map & point logic.
  apiEndpoint?: string;
  // Explicit user request: Monitoring entity is not shown raw live readings on
  // the map (wind/PM10/PM2.5) — see hideRawReadings in ProjectsMap.tsx.
  hideRawReadings?: boolean;
}

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
  project_id: string;
  [key: string]: unknown;
}

interface LiveActivitySummary {
  decisionLabelAr: string;
  shortReason: string;
  level: string;
  mandatoryStop: boolean;
  evaluatedAt?: string | null;
  readingPm10UgM3?: number | null;
  readingWindSpeedKmh?: number | null;
}

export default function GlobalDashboard({ apiEndpoint = '/dashboard/global', hideRawReadings = false }: GlobalDashboardProps) {
  const [projects, setProjects] = useState<DashboardProjectRow[]>([]);
  const [todayActivities, setTodayActivities] = useState<DashboardActivityRow[]>([]);
  const [liveActivityByProjectId, setLiveActivityByProjectId] = useState<Record<string, LiveActivitySummary>>({});
  const [isLoading, setIsLoading] = useState(true);
  // See full comment in IntegratedDashboard.tsx (same fix) — without this, a network
  // failure meant an empty map with "No project coordinates available yet" message despite
  // them actually existing, for external monitoring entity (viewer) as well.
  const [error, setError] = useState<string | null>(null);
  const [retryTick, setRetryTick] = useState(0);

  useEffect(() => {
    const fetchDashboardData = async () => {
      try {
        setIsLoading(true);
        setError(null);
        const { data: dash } = await apiClient.get(apiEndpoint);
        setProjects(dash?.projects || []);
        setTodayActivities(dash?.dustActivities || []);
        setLiveActivityByProjectId(dash?.liveActivityByProjectId || {});
      } catch (err) {
        console.error('Error fetching dashboard data:', err);
        const axiosErr = err as { response?: { data?: { error?: string } } };
        setError(axiosErr?.response?.data?.error || 'تعذّر جلب بيانات المشاريع — تحقّق من الاتصال وأعد المحاولة.');
      } finally {
        setIsLoading(false);
      }
    };

    fetchDashboardData();
  }, [apiEndpoint, retryTick]);

  // Map points — decision comes exclusively from the activity currently in progress (the
  // unified activity decision: DVI + regulatory compliance, see computeUnifiedActivityDecision
  // in dustEvaluation.ts and liveActivityByProjectId in route.ts). There is no
  // fallback for the most critical alert — a project without active ongoing activity will have a neutral point
  // without any decision, by explicit user request.
  const mapPoints: ProjectPoint[] = useMemo(() => {
    return projects
      .filter((p) => typeof p.latitude === 'number' && typeof p.longitude === 'number')
      .map((p) => {
        const liveActivity = liveActivityByProjectId[p.id];
        const todayActivitiesCount = todayActivities.filter((a) => a.project_id === p.id).length;
        const decision = liveActivity ? dviLevelToDecision(liveActivity.level, liveActivity.mandatoryStop) : null;
        // External monitoring entity (viewer) is not shown detailed internal decision wording
        // (example: "Regulatory Mandatory Stop") specifically upon stop status —
        // by explicit user request, it is replaced with simplified regulatory wording, while other statuses
        // remain with their current text (statusLabel/statusReason as is).
        const isStopped = decision === 'stopped';
        return {
          id: p.id,
          name: p.name,
          city: p.city ?? undefined,
          latitude: p.latitude as number,
          longitude: p.longitude as number,
          decision,
          projectStatus: p.project_status,
          todayActivitiesCount,
          hasLiveActivity: !!liveActivity,
          statusLabel: isStopped ? 'تم تسجيل مخالفة' : liveActivity?.decisionLabelAr,
          statusReason: isStopped ? undefined : liveActivity?.shortReason,
          decisionEvaluatedAt: liveActivity?.evaluatedAt ?? null,
          decisionReadingPm10UgM3: liveActivity?.readingPm10UgM3 ?? null,
          decisionReadingWindSpeedKmh: liveActivity?.readingWindSpeedKmh ?? null,
        };
      });
  }, [projects, todayActivities, liveActivityByProjectId]);

  if (isLoading) {
    return (
      <div className="h-full bg-[#F4F7FB] flex items-center justify-center" dir="rtl">
        <div className="flex flex-col items-center gap-4 text-[#061B40]">
          <Loader2 className="w-10 h-10 animate-spin text-[#0176FB]" />
          <h2 className="font-bold text-lg">جاري جلب بيانات المشاريع...</h2>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-full bg-[#F4F7FB] flex items-center justify-center" dir="rtl">
        <div className="flex flex-col items-center gap-4 text-center max-w-md px-4">
          <h2 className="text-xl font-black text-red-600">تعذّر تحميل الخريطة</h2>
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
    <div className="h-full flex flex-col bg-[#F4F7FB]" dir="rtl">
      <div className="px-6 py-4 border-b border-slate-200 bg-white flex items-center gap-2 shrink-0">
        <MapIcon className="w-5 h-5 text-[#0176FB]" />
        <h1 className="font-extrabold text-[#061B40] text-lg">خريطة المشاريع</h1>
      </div>

      <div className="flex-1 min-h-0">
        {mapPoints.length === 0 ? (
          <div className="h-full flex items-center justify-center text-slate-400 font-bold text-sm">
            لا تتوفر إحداثيات (latitude / longitude) للمشاريع بعد.
          </div>
        ) : (
          // Explicit user request: Monitoring entity (viewer) does not have access permission
          // to project details page — no onSelect is passed here at all
          // (in addition to minimal defense inside ProjectsMap itself).
          <ProjectsMap points={mapPoints} hideRawReadings={hideRawReadings} minimal />
        )}
      </div>
    </div>
  );
}