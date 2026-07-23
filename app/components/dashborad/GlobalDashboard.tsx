"use client";

import React, { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';
import { apiClient } from '@/app/lib/apiClient';
import type { ProjectPoint } from './ProjectsMap';
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

type Decision = 'safe' | 'caution' | 'restricted' | 'postpone' | 'stopped';

// خرائط قيمة "risk_level" (كما تُخزَّن في alerts) إلى القرار الخماسي —
// تحدد لون نقطة المشروع على الخريطة
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

  const [projects, setProjects] = useState<any[]>([]);
  const [todayActivities, setTodayActivities] = useState<any[]>([]);
  const [recentAlerts, setRecentAlerts] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const fetchDashboardData = async () => {
      try {
        setIsLoading(true);
        const { data: dash } = await apiClient.get('/dashboard/global');
        setProjects(dash?.projects || []);
        setTodayActivities(dash?.dustActivities || []);
        setRecentAlerts(dash?.alerts || []);
      } catch (error) {
        console.error('Error fetching dashboard data:', error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchDashboardData();
  }, []);

  // نقاط الخريطة — كل مشروع بموقعه وحالة قراره (من آخر تنبيه)، حالته
  // الإدارية (project_status)، وعدد الأنشطة المجدولة/النشطة اليوم
  const mapPoints: ProjectPoint[] = useMemo(() => {
    return projects
      .filter((p) => typeof p.latitude === 'number' && typeof p.longitude === 'number')
      .map((p) => {
        const projectAlerts = recentAlerts.filter((a) => a.project_id === p.id);
        const latest = projectAlerts[0];
        const decision = latest ? riskLevelToDecision(latest.risk_level) : 'safe';
        const todayActivitiesCount = todayActivities.filter((a) => a.project_id === p.id).length;
        return {
          id: p.id,
          name: p.name,
          city: p.city,
          latitude: p.latitude,
          longitude: p.longitude,
          decision,
          projectStatus: p.project_status,
          todayActivitiesCount,
        };
      });
  }, [projects, recentAlerts, todayActivities]);

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
          <ProjectsMap points={mapPoints} onSelect={(id) => router.push(`/dashboard/Projects/${id}`)} />
        )}
      </div>
    </div>
  );
}
