"use client";

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { apiClient } from '@/app/lib/apiClient';
import { Loader2, Search, ArrowRight, MapPin, Bell, ClipboardList, ShieldAlert, CloudRain } from 'lucide-react';

const PROJECT_STATUS_LABEL_AR: Record<string, string> = {
  not_started: 'لم يبدأ',
  in_progress: 'جاري',
};

interface AdminProjectRow {
  id: string;
  name: string;
  city: string | null;
  project_status: string | null;
  created_at: string;
  ownerUsername: string | null;
  ownerCompany: string | null;
  activeAlertsCount: number;
  decisionsCount: number;
}

export default function AdminProjectsPage() {
  const router = useRouter();
  const [isSuperAdmin, setIsSuperAdmin] = useState<boolean | undefined>(undefined);
  const [projects, setProjects] = useState<AdminProjectRow[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [accessDenied, setAccessDenied] = useState(false);

  useEffect(() => {
    const check = async () => {
      const { data: profileResp } = await apiClient.get('/profile');
      const admin = !!profileResp?.data?.is_super_admin;
      setIsSuperAdmin(admin);
      if (!admin) {
        router.replace('/dashboard');
        return;
      }
      try {
        const { data } = await apiClient.get('/admin/projects');
        setProjects(data?.data || []);
      } catch (error: unknown) {
        if ((error as { response?: { status?: number } })?.response?.status === 403) setAccessDenied(true);
      } finally {
        setIsLoading(false);
      }
    };
    check();
  }, [router]);

  const filtered = projects.filter((p) =>
    (p.name || '').includes(searchQuery) ||
    (p.city || '').includes(searchQuery) ||
    (p.ownerUsername || '').includes(searchQuery) ||
    (p.ownerCompany || '').includes(searchQuery)
  );

  if (isSuperAdmin === undefined || isLoading) {
    return (
      <div className="min-h-screen bg-[#F4F7FB] flex items-center justify-center" dir="rtl">
        <div className="flex flex-col items-center gap-4 text-[#061B40]">
          <Loader2 className="w-10 h-10 animate-spin text-[#0176FB]" />
          <h2 className="font-bold text-lg">جاري التحميل...</h2>
        </div>
      </div>
    );
  }

  if (accessDenied) {
    return (
      <div className="min-h-screen bg-[#F4F7FB] flex flex-col items-center justify-center text-slate-500" dir="rtl">
        <ShieldAlert className="w-16 h-16 mb-4 opacity-30" />
        <p className="font-bold text-lg text-slate-700">غير مصرح لك بالوصول لهذه الصفحة</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F4F7FB] p-6 lg:p-8 font-sans" dir="rtl">
      <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center gap-4 mb-8">
        <h1 className="text-3xl font-black text-[#061B40]">كل المشاريع ({projects.length})</h1>
        <div className="relative w-full lg:w-72">
          <div className="absolute inset-y-0 right-0 pr-3 flex items-center pointer-events-none text-slate-400">
            <Search className="w-4 h-4" />
          </div>
          <input
            type="text"
            placeholder="ابحث باسم المشروع/المدينة/المالك..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pr-10 pl-4 py-2.5 bg-white border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 shadow-sm"
          />
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          {filtered.length === 0 ? (
            <div className="p-16 flex flex-col items-center text-slate-400">
              <CloudRain className="w-14 h-14 mb-3 opacity-20" />
              <p className="font-bold">لا توجد مشاريع مطابقة</p>
            </div>
          ) : (
            <table className="w-full text-right text-sm whitespace-nowrap">
              <thead className="bg-slate-50/50 text-slate-500">
                <tr>
                  <th className="py-3 px-5 font-bold">الاسم</th>
                  <th className="py-3 px-5 font-bold">المدينة</th>
                  <th className="py-3 px-5 font-bold">المالك</th>
                  <th className="py-3 px-5 font-bold">الحالة</th>
                  <th className="py-3 px-5 font-bold">تنبيهات نشطة</th>
                  <th className="py-3 px-5 font-bold">قرارات</th>
                  <th className="py-3 px-5 font-bold">تاريخ الإنشاء</th>
                  <th className="py-3 px-5 font-bold"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filtered.map((p) => (
                  <tr key={p.id} className="hover:bg-slate-50/50 transition-colors">
                    <td className="py-3 px-5 font-bold text-slate-800">{p.name}</td>
                    <td className="py-3 px-5 text-slate-600">
                      <span className="flex items-center gap-1"><MapPin className="w-3.5 h-3.5 text-slate-400" /> {p.city || '—'}</span>
                    </td>
                    <td className="py-3 px-5 text-slate-600">{p.ownerUsername || p.ownerCompany || '—'}</td>
                    <td className="py-3 px-5 text-slate-600">{(p.project_status && PROJECT_STATUS_LABEL_AR[p.project_status]) || p.project_status || '—'}</td>
                    <td className="py-3 px-5 text-slate-600">
                      <span className="flex items-center gap-1"><Bell className="w-3.5 h-3.5 text-orange-400" /> {p.activeAlertsCount}</span>
                    </td>
                    <td className="py-3 px-5 text-slate-600">
                      <span className="flex items-center gap-1"><ClipboardList className="w-3.5 h-3.5 text-blue-400" /> {p.decisionsCount}</span>
                    </td>
                    <td className="py-3 px-5 text-slate-500 text-xs">{p.created_at ? new Date(p.created_at).toLocaleDateString('ar-SA', { calendar: 'gregory' }) : '—'}</td>
                    <td className="py-3 px-5">
                      <Link
                        href={`/dashboard/Projects/${p.id}`}
                        className="bg-white border-2 border-slate-100 hover:border-blue-500 hover:bg-blue-50 text-blue-600 px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1.5 transition-all w-fit"
                      >
                        فتح <ArrowRight className="w-3.5 h-3.5" />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
