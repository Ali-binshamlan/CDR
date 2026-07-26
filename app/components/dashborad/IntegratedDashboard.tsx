"use client";

import React, { useState, useEffect, useMemo } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';
import { apiClient } from '@/app/lib/apiClient';
import type { ProjectPoint } from './ProjectsMap';
import { decisionMeta, alertKindToDecision, dviLevelToDecision } from '@/app/lib/decisionMeta';
import { displayActivityLabel } from '@/app/lib/activityLabels';
import {
  Loader2, Map as MapIcon, FolderKanban, Activity, Bell,
  ArrowLeft, MapPin, Clock,
} from 'lucide-react';

const ProjectsMap = dynamic(() => import('./ProjectsMap'), {
  ssr: false,
  loading: () => (
    <div className="h-full flex items-center justify-center text-slate-400 font-bold text-sm bg-slate-50">
      جاري تحميل الخريطة...
    </div>
  ),
});

// لوحة التحكم المتكاملة للمستخدم العادي — تستبدل GlobalDashboard (خريطة فقط)
// كصفحة رئيسية له، مع بطاقات إحصائية وقوائم مختصرة أعلى نفس الخريطة. تستهلك
// نفس /dashboard/global دون أي تعديل عليه — كل الحقول المطلوبة (projects،
// alerts مفلترة state != CLOSED، dustActivities مفلترة planned_date=اليوم،
// liveActivityByProjectId) موجودة فيه فعلاً. GlobalDashboard.tsx يبقى بلا
// تغيير لأنه يُستخدم أيضاً في /dashboard/viewer (خريطة فقط بتصميم مقصود).
export default function IntegratedDashboard() {
  const router = useRouter();

  const [projects, setProjects] = useState<any[]>([]);
  const [todayActivities, setTodayActivities] = useState<any[]>([]);
  const [alerts, setAlerts] = useState<any[]>([]);
  const [liveActivityByProjectId, setLiveActivityByProjectId] = useState<Record<string, any>>({});
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const fetchDashboardData = async () => {
      try {
        setIsLoading(true);
        const { data: dash } = await apiClient.get('/dashboard/global');
        setProjects(dash?.projects || []);
        setTodayActivities(dash?.dustActivities || []);
        setAlerts(dash?.alerts || []);
        setLiveActivityByProjectId(dash?.liveActivityByProjectId || {});
      } catch (error) {
        console.error('Error fetching dashboard data:', error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchDashboardData();
  }, []);

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

  // نفس منطق mapPoints في GlobalDashboard.tsx — القرار حصراً من النشاط
  // الجاري فعلياً الآن (القرار الموحد للنشاط)، بلا أي fallback لأخطر تنبيه.
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
          <h2 className="font-bold text-lg">جاري جلب بيانات لوحة التحكم...</h2>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-full bg-[#F4F7FB] p-6 lg:p-8 font-sans" dir="rtl">
      <div className="max-w-[1440px] mx-auto space-y-6">
        <div>
          <h1 className="text-3xl font-black text-[#061B40] mb-1">لوحة التحكم</h1>
          <p className="text-slate-500 text-sm font-medium">نظرة شاملة على مشاريعك وأنشطة اليوم والتنبيهات النشطة</p>
        </div>

        {/* بطاقات إحصائية */}
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
          {/* أنشطة اليوم */}
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

          {/* أحدث التنبيهات */}
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
                        {meta.label}
                      </span>
                    </Link>
                  );
                })
              )}
            </div>
          </div>
        </div>

        {/* الخريطة */}
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
              <ProjectsMap points={mapPoints} onSelect={(id) => router.push(`/dashboard/Projects/${id}`)} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
