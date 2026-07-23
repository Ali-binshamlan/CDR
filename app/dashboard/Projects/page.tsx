"use client";
import React, { useState, useEffect, useMemo } from 'react';
import Link from 'next/link';
import { apiClient } from '@/app/lib/apiClient';
import { 
  Search, 
  Filter, 
  Plus, 
  MapPin, 
  Activity,
  Bell,
  ArrowLeft,
  CloudRain,
  Loader2
} from 'lucide-react';

// ============================================================
// القرار الخماسي (نفس منطق لوحة التحكم — يُفضّل نقله لملف مشترك لاحقاً)
// ============================================================
type Decision = 'safe' | 'caution' | 'restricted' | 'postpone' | 'stopped';

const decisionMeta: Record<Decision, { label: string; text: string; bg: string; border: string; dot: string }> = {
  safe: { label: 'آمن', text: 'text-emerald-700', bg: 'bg-emerald-50', border: 'border-emerald-200', dot: 'bg-emerald-500' },
  caution: { label: 'مناسب بحذر', text: 'text-amber-700', bg: 'bg-amber-50', border: 'border-amber-200', dot: 'bg-amber-500' },
  restricted: { label: 'مقيد', text: 'text-orange-700', bg: 'bg-orange-50', border: 'border-orange-200', dot: 'bg-orange-500' },
  postpone: { label: 'يفضل التأجيل', text: 'text-rose-700', bg: 'bg-rose-50', border: 'border-rose-200', dot: 'bg-rose-500' },
  stopped: { label: 'إيقاف', text: 'text-red-700', bg: 'bg-red-50', border: 'border-red-200', dot: 'bg-red-700' },
};

const riskLevelToDecision = (risk?: string | null): Decision => {
  switch (risk) {
    case 'أسود': return 'stopped';
    case 'أحمر': return 'postpone';
    case 'برتقالي': return 'restricted';
    case 'أصفر': return 'caution';
    default: return 'safe';
  }
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

// ============================================================
// شكل بطاقة المشروع في القائمة
// ============================================================
interface ProjectCard {
  id: string;
  name: string;
  city: string;
  decision: Decision;
  totalActivitiesCount: number;
  alertsCount: number;
  lastDecisionText: string;
  originalData: any;
}

export default function ProjectsPage() {
  const [searchQuery, setSearchQuery] = useState('');
  const [projects, setProjects] = useState<ProjectCard[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const fetchProjectsData = async () => {
      setIsLoading(true);
      try {
        const { data: list } = await apiClient.get('/dashboard/projects-list');
        const dbProjects = list?.projects || [];
        const alerts = list?.alerts || [];

        const allActivities = [...(list?.dustActivities || [])];

        const processedProjects: ProjectCard[] = (dbProjects || []).map((p: any) => {
          const projectAlerts = (alerts || []).filter((a: any) => a.project_id === p.id);
          const latestAlert = projectAlerts[0];
          const decision = latestAlert ? riskLevelToDecision(latestAlert.risk_level) : 'safe';
          const lastDecisionText = latestAlert
            ? (latestAlert.action_taken || latestAlert.message || 'يرجى مراجعة التنبيه')
            : 'لا يوجد قرار مسجل بعد';
          const totalActivitiesCount = allActivities.filter((a) => a.project_id === p.id).length;

          return {
            id: p.id,
            name: p.name,
            city: p.city,
            decision,
            totalActivitiesCount,
            alertsCount: projectAlerts.length,
            lastDecisionText,
            originalData: p,
          };
        });

        setProjects(processedProjects);
      } catch (error) {
        console.error("Error fetching projects:", error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchProjectsData();
  }, []);

  // تصفية المشاريع بالبحث النصي فقط
  const filteredProjects = projects.filter(p => 
    p.name.includes(searchQuery) || p.city.includes(searchQuery)
  );

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-[#F4F7FB] text-[#061B40]">
        <Loader2 className="w-10 h-10 animate-spin text-[#0176FB] mb-4" />
        <h2 className="font-bold text-lg">جاري تحميل بيانات المشاريع...</h2>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F4F7FB] p-6 lg:p-8 font-sans" dir="rtl">
      <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center gap-6 mb-8">
        <div>
          <h1 className="text-3xl font-black text-[#061B40] mb-1">إدارة المشاريع</h1>
          <p className="text-slate-500 text-sm font-medium">استعرض حالة المخاطر وإجمالي الأنشطة لجميع مشاريعك النشطة</p>
        </div>

        <div className="flex flex-col sm:flex-row items-center gap-3 w-full lg:w-auto">
          <div className="relative w-full sm:w-64">
            <div className="absolute inset-y-0 right-0 pr-3 flex items-center pointer-events-none text-slate-400">
              <Search className="w-4 h-4" />
            </div>
            <input 
              type="text" 
              placeholder="ابحث عن مشروع أو مدينة..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pr-10 pl-4 py-2.5 bg-white border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all shadow-sm"
            />
          </div>
          <button className="w-full sm:w-auto bg-white border border-slate-200 hover:bg-slate-50 text-slate-700 px-4 py-2.5 rounded-xl text-sm font-bold flex items-center justify-center gap-2 shadow-sm transition-colors">
            <Filter className="w-4 h-4" /> فرز
          </button>
          <Link
            href="/dashboard/Projects/create"
            className="w-full sm:w-auto bg-[#3995FF] hover:bg-blue-600 text-white px-5 py-2.5 rounded-xl text-sm font-bold flex items-center justify-center gap-2 shadow-sm transition-colors"
          >
            <Plus className="w-4 h-4" strokeWidth={3} /> إضافة مشروع
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
        {filteredProjects.map((project) => (
          <div key={project.id} className="bg-white rounded-2xl border border-slate-200 shadow-sm hover:shadow-lg hover:-translate-y-1 transition-all duration-300 flex flex-col overflow-hidden">
            <div className="p-5 border-b border-slate-100 flex justify-between items-start bg-gradient-to-b from-white to-slate-50/50">
              <div>
                <h3 className="font-extrabold text-[#061B40] text-lg mb-1">{project.name}</h3>
                <div className="flex items-center gap-1.5 text-xs font-bold text-slate-500">
                  <MapPin className="w-3.5 h-3.5 text-slate-400" /> {project.city}
                </div>
              </div>
            </div>

            <div className="p-5 grid grid-cols-2 gap-3">
              <div className="flex flex-col items-center justify-center p-3 rounded-xl bg-slate-50 border border-slate-100">
                <Activity className="w-5 h-5 text-[#0176FB] mb-2" />
                <span className="text-lg font-black text-slate-800">{project.totalActivitiesCount}</span>
                <span className="text-[10px] font-bold text-slate-400">إجمالي الأنشطة</span>
              </div>
              <div className="flex flex-col items-center justify-center p-3 rounded-xl bg-slate-50 border border-slate-100">
                <Bell className="w-5 h-5 text-orange-500 mb-2" />
                <span className="text-lg font-black text-slate-800">{project.alertsCount}</span>
                <span className="text-[10px] font-bold text-slate-400">التنبيهات</span>
              </div>
            </div>

            {/* <div className="px-5 pb-3">
              <div className="text-[11px] font-bold text-slate-400 mb-1">آخر قرار</div>
              <p className="text-xs font-semibold text-slate-700 leading-relaxed line-clamp-2">{project.lastDecisionText}</p>
            </div> */}

            <div className="p-5 pt-3 mt-auto border-t border-slate-100 flex items-center justify-end">
              <Link
                href={`/dashboard/Projects/${project.id}`}
                className="bg-white border-2 border-slate-100 hover:border-blue-500 hover:bg-blue-50 text-blue-600 px-4 py-2 rounded-xl text-xs font-bold flex items-center gap-2 transition-all"
              >
                لوحة المشروع <ArrowLeft className="w-3.5 h-3.5" />
              </Link>
            </div>
          </div>
        ))}

        {filteredProjects.length === 0 && !isLoading && (
          <div className="col-span-1 md:col-span-2 xl:col-span-3 flex flex-col items-center justify-center py-20 text-slate-400">
            <CloudRain className="w-16 h-16 mb-4 opacity-20" />
            <p className="font-bold text-lg text-slate-600 mb-2">لا توجد مشاريع مطابقة</p>
            <p className="text-sm">حاول إضافة مشروع جديد أو تغيير معايير البحث.</p>
          </div>
        )}
      </div>
    </div>
  );
}