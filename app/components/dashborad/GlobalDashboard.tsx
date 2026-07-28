"use client";

import React, { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';
import { apiClient } from '@/app/lib/apiClient';
import type { ProjectPoint } from './ProjectsMap';
import { dviLevelToDecision } from '@/app/lib/decisionMeta';
import { Loader2, Map as MapIcon } from 'lucide-react';

// خريطة Leaflet تحتاج window، فلازم تُحمَّل داخل المتصفح فقط بدون SSR
const ProjectsMap = dynamic(() => import('./ProjectsMap'), {
  ssr: false,
  loading: () => (
    <div className="h-full flex items-center justify-center text-slate-400 font-bold text-sm bg-slate-50">
      جاري تحميل الخريطة...
    </div>
  ),
});

interface GlobalDashboardProps {
  // نقطة البيانات — افتراضياً بيانات المستخدم الحالي فقط. جهة المراقبة
  // (viewer) تمرر '/viewer/dashboard' (نفس شكل الاستجابة تماماً، بلا فلترة
  // user_id) لعرض كل المشاريع عبر كل المستخدمين بنفس منطق الخريطة والنقاط.
  apiEndpoint?: string;
  // طلب صريح من المستخدم: جهة الرصد لا تُعرض لها القراءات الحية الخام على
  // الخريطة (رياح/PM10/PM2.5) — راجع hideRawReadings في ProjectsMap.tsx.
  hideRawReadings?: boolean;
}

export default function GlobalDashboard({ apiEndpoint = '/dashboard/global', hideRawReadings = false }: GlobalDashboardProps) {
  const router = useRouter();

  const [projects, setProjects] = useState<any[]>([]);
  const [todayActivities, setTodayActivities] = useState<any[]>([]);
  const [liveActivityByProjectId, setLiveActivityByProjectId] = useState<Record<string, any>>({});
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const fetchDashboardData = async () => {
      try {
        setIsLoading(true);
        const { data: dash } = await apiClient.get(apiEndpoint);
        setProjects(dash?.projects || []);
        setTodayActivities(dash?.dustActivities || []);
        setLiveActivityByProjectId(dash?.liveActivityByProjectId || {});
      } catch (error) {
        console.error('Error fetching dashboard data:', error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchDashboardData();
  }, [apiEndpoint]);

  // نقاط الخريطة — القرار يأتي حصراً من النشاط الجاري فعلياً الآن (القرار
  // الموحد للنشاط: DVI + الامتثال التنظيمي، راجع computeUnifiedActivityDecision
  // في dustEvaluation.ts وliveActivityByProjectId في route.ts). لا يوجد أي
  // fallback لأخطر تنبيه — مشروع بلا نشاط جارٍ الآن تكون نقطته محايدة بلا
  // قرار إطلاقاً، بطلب صريح من المستخدم.
  const mapPoints: ProjectPoint[] = useMemo(() => {
    return projects
      .filter((p) => typeof p.latitude === 'number' && typeof p.longitude === 'number')
      .map((p) => {
        const liveActivity = liveActivityByProjectId[p.id];
        const todayActivitiesCount = todayActivities.filter((a) => a.project_id === p.id).length;
        return {
          id: p.id,
          name: p.name,
          city: p.city,
          latitude: p.latitude,
          longitude: p.longitude,
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
          <h2 className="font-bold text-lg">جاري جلب بيانات المشاريع...</h2>
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
          <ProjectsMap
            points={mapPoints}
            onSelect={(id) => router.push(`/dashboard/Projects/${id}`)}
            hideRawReadings={hideRawReadings}
          />
        )}
      </div>
    </div>
  );
}
