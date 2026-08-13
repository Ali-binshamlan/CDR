"use client";

import React, { useState, useEffect, useMemo } from 'react';
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
  // راجع تعليق IntegratedDashboard.tsx الكامل (نفس الإصلاح) — بلا هذا، فشل
  // شبكة كان يعني خريطة فارغة برسالة "لا تتوفر إحداثيات للمشاريع بعد" رغم
  // وجودها فعلياً، لجهة المراقبة الخارجية (viewer) أيضاً.
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
        const decision = liveActivity ? dviLevelToDecision(liveActivity.level, liveActivity.mandatoryStop) : null;
        // جهة المراقبة الخارجية (viewer) لا تُعرض لها صياغة القرار الداخلية
        // التفصيلية (مثال: "إيقاف إلزامي نظامي") عند حالة الإيقاف تحديدًا —
        // بطلب صريح من المستخدم تُستبدل بصياغة تنظيمية مبسطة، وباقي الحالات
        // تبقى بنصها الحالي (statusLabel/statusReason كما هما).
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
          // طلب صريح من المستخدم: جهة المراقبة (viewer) لا تملك صلاحية
          // الوصول لصفحة تفاصيل المشروع — لا onSelect يُمرَّر هنا إطلاقاً
          // (بالإضافة لدفاع minimal داخل ProjectsMap نفسه).
          <ProjectsMap points={mapPoints} hideRawReadings={hideRawReadings} minimal />
        )}
      </div>
    </div>
  );
}
