"use client";
import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { apiClient } from '@/app/lib/apiClient';
import { alertKindToDecision, pickMostSevereAlert, type Decision } from '@/app/lib/decisionMeta';
import {
  Search,
  Filter,
  Plus,
  MapPin,
  Activity,
  Bell,
  ArrowLeft,
  CloudRain,
  Loader2,
  ChevronDown
} from 'lucide-react';

// ============================================================
// شكل بطاقة المشروع في القائمة
// ============================================================
// شكل صف مشروع خام كما يُرجعه GET /api/dashboard/projects-list (list.projects)
interface DashboardProjectRow {
  id: string;
  name: string;
  city: string;
  [key: string]: unknown;
}

// شكل صف تنبيه خام (list.alerts) — الحقول المقروءة فعلياً في هذه الصفحة فقط.
interface DashboardAlertRow {
  project_id: string;
  kind: string;
  action_taken?: string | null;
  message?: string | null;
}

// شكل صف نشاط غبار خام (list.dustActivities) — project_id فقط مطلوب هنا.
interface DashboardDustActivityRow {
  project_id: string;
}

interface ProjectCard {
  id: string;
  name: string;
  city: string;
  decision: Decision;
  totalActivitiesCount: number;
  alertsCount: number;
  lastDecisionText: string;
  originalData: DashboardProjectRow;
  createdAtMs: number;
}

type SortOption = 'newest' | 'oldest' | 'name';

const SORT_OPTIONS: { value: SortOption; label: string }[] = [
  { value: 'newest', label: 'الأحدث أولاً' },
  { value: 'oldest', label: 'الأقدم أولاً' },
  { value: 'name', label: 'الاسم (أ-ي)' },
];

export default function ProjectsPage() {
  const [searchQuery, setSearchQuery] = useState('');
  const [projects, setProjects] = useState<ProjectCard[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  // خطأ مكتشَف ومُصلَح (طلب صريح من المستخدم — "أخطاء الشبكة تتحول غالباً
  // إلى أرقام صفرية أو حالات فارغة مضللة"): فشل الجلب كان يعني شبكة بطاقات
  // فارغة + رسالة "لا توجد مشاريع مطابقة — حاول تغيير معايير البحث"، توحي
  // بخطأ من المستخدم بينما السبب فشل شبكة فعلي.
  const [error, setError] = useState<string | null>(null);
  const [retryTick, setRetryTick] = useState(0);
  const [sortOption, setSortOption] = useState<SortOption>('newest');
  const [isSortMenuOpen, setIsSortMenuOpen] = useState(false);

  useEffect(() => {
    const fetchProjectsData = async () => {
      setIsLoading(true);
      setError(null);
      try {
        const { data: list } = await apiClient.get('/dashboard/projects-list');
        const dbProjects: DashboardProjectRow[] = list?.projects || [];
        const alerts: DashboardAlertRow[] = list?.alerts || [];

        const allActivities: DashboardDustActivityRow[] = [...(list?.dustActivities || [])];

        const processedProjects: ProjectCard[] = (dbProjects || []).map((p) => {
          const projectAlerts: DashboardAlertRow[] = (alerts || []).filter((a) => a.project_id === p.id);
          const worstAlert = pickMostSevereAlert(projectAlerts);
          const decision = worstAlert ? alertKindToDecision(worstAlert.kind) : 'safe';
          const lastDecisionText = worstAlert
            ? (worstAlert.action_taken || worstAlert.message || 'يرجى مراجعة التنبيه')
            : 'لا يوجد قرار مسجل بعد';
          const totalActivitiesCount = allActivities.filter((a) => a.project_id === p.id).length;

          const createdAtRaw = p.created_at;
          const createdAtMs = typeof createdAtRaw === 'string' ? new Date(createdAtRaw).getTime() : 0;

          return {
            id: p.id,
            name: p.name,
            city: p.city,
            decision,
            totalActivitiesCount,
            alertsCount: projectAlerts.length,
            lastDecisionText,
            originalData: p,
            createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : 0,
          };
        });

        setProjects(processedProjects);
      } catch (err) {
        console.error("Error fetching projects:", err);
        const axiosErr = err as { response?: { data?: { error?: string } } };
        setError(axiosErr?.response?.data?.error || 'تعذّر جلب بيانات المشاريع — تحقّق من الاتصال وأعد المحاولة.');
      } finally {
        setIsLoading(false);
      }
    };

    fetchProjectsData();
  }, [retryTick]);

  // تصفية المشاريع بالبحث النصي، ثم الفرز حسب الخيار المختار
  const filteredProjects = projects
    .filter(p => p.name.includes(searchQuery) || p.city.includes(searchQuery))
    .sort((a, b) => {
      if (sortOption === 'name') return a.name.localeCompare(b.name, 'ar');
      if (sortOption === 'oldest') return a.createdAtMs - b.createdAtMs;
      return b.createdAtMs - a.createdAtMs; // newest
    });

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-[#F4F7FB] text-[#061B40]">
        <Loader2 className="w-10 h-10 animate-spin text-[#0176FB] mb-4" />
        <h2 className="font-bold text-lg">جاري تحميل بيانات المشاريع...</h2>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-[#F4F7FB] gap-4 text-center px-4">
        <h2 className="text-xl font-black text-red-600">تعذّر تحميل المشاريع</h2>
        <p className="text-slate-500 text-sm font-medium max-w-md">{error}</p>
        <button
          type="button"
          onClick={() => setRetryTick((t) => t + 1)}
          className="bg-[#0176FB] hover:bg-[#0176FB]/90 text-white text-sm font-bold px-5 py-2.5 rounded-xl transition-colors"
        >
          إعادة المحاولة
        </button>
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
          <div className="relative w-full sm:w-auto">
            <button
              type="button"
              onClick={() => setIsSortMenuOpen((v) => !v)}
              className="w-full sm:w-auto bg-white border border-slate-200 hover:bg-slate-50 text-slate-700 px-4 py-2.5 rounded-xl text-sm font-bold flex items-center justify-center gap-2 shadow-sm transition-colors"
            >
              <Filter className="w-4 h-4" /> فرز: {SORT_OPTIONS.find((o) => o.value === sortOption)?.label}
              <ChevronDown className="w-3.5 h-3.5" />
            </button>
            {isSortMenuOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setIsSortMenuOpen(false)} />
                <div className="absolute z-20 mt-2 w-full sm:w-48 bg-white border border-slate-200 rounded-xl shadow-lg overflow-hidden right-0">
                  {SORT_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => { setSortOption(opt.value); setIsSortMenuOpen(false); }}
                      className={`w-full text-right px-4 py-2.5 text-sm font-bold transition-colors ${
                        sortOption === opt.value ? 'bg-blue-50 text-[#0176FB]' : 'text-slate-700 hover:bg-slate-50'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
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