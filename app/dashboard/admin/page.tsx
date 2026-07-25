"use client";

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { apiClient } from '@/app/lib/apiClient';
import { alertKindLabelAr, alertKindToDecision, decisionMeta } from '@/app/lib/decisionMeta';
import {
  Loader2,
  ShieldCheck,
  Users,
  FolderKanban,
  Bell,
  ClipboardList,
  ArrowLeft,
  ShieldAlert,
} from 'lucide-react';

const PROJECT_STATUS_LABEL_AR: Record<string, string> = {
  not_started: 'لم يبدأ',
  in_progress: 'جاري',
};

interface AdminStats {
  totalUsers: number;
  totalProjects: number;
  projectsByStatus: Record<string, number>;
  projectsByCity: Record<string, number>;
  totalActiveAlerts: number;
  alertsByKind: Record<string, number>;
  totalDecisions: number;
}

export default function AdminOverviewPage() {
  const router = useRouter();
  const [isSuperAdmin, setIsSuperAdmin] = useState<boolean | undefined>(undefined);
  const [stats, setStats] = useState<AdminStats | null>(null);
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
        const { data } = await apiClient.get('/admin/stats');
        setStats(data?.data || null);
      } catch (error: any) {
        if (error?.response?.status === 403) setAccessDenied(true);
      } finally {
        setIsLoading(false);
      }
    };
    check();
  }, [router]);

  if (isSuperAdmin === undefined || isLoading) {
    return (
      <div className="min-h-screen bg-[#F4F7FB] flex items-center justify-center" dir="rtl">
        <div className="flex flex-col items-center gap-4 text-[#061B40]">
          <Loader2 className="w-10 h-10 animate-spin text-[#0176FB]" />
          <h2 className="font-bold text-lg">جاري التحقق من الصلاحية...</h2>
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

  if (!stats) return null;

  const subPages = [
    { href: '/dashboard/admin/projects', label: 'المشاريع', icon: FolderKanban, count: stats.totalProjects },
    { href: '/dashboard/admin/users', label: 'المستخدمون', icon: Users, count: stats.totalUsers },
    { href: '/dashboard/admin/alerts', label: 'التنبيهات', icon: Bell, count: stats.totalActiveAlerts },
    { href: '/dashboard/admin/decisions', label: 'القرارات', icon: ClipboardList, count: stats.totalDecisions },
  ];

  return (
    <div className="min-h-screen bg-[#F4F7FB] p-6 lg:p-8 font-sans" dir="rtl">
      <div className="flex items-center gap-2 mb-8">
        <ShieldCheck className="w-6 h-6 text-[#0176FB]" />
        <h1 className="text-3xl font-black text-[#061B40]">الإدارة</h1>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        {subPages.map((s) => (
          <Link
            key={s.href}
            href={s.href}
            className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 hover:shadow-lg hover:-translate-y-1 transition-all flex flex-col justify-between"
          >
            <div className="flex justify-between items-start mb-3">
              <span className="text-slate-500 font-bold text-xs">{s.label}</span>
              <div className="bg-blue-50 p-2 rounded-lg text-[#0176FB]"><s.icon className="w-4 h-4" /></div>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-3xl font-black text-[#061B40]">{s.count}</span>
              <ArrowLeft className="w-4 h-4 text-slate-300" />
            </div>
          </Link>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5">
          <h2 className="font-extrabold text-[#061B40] text-base mb-4">المشاريع حسب الحالة</h2>
          <div className="space-y-2">
            {Object.entries(stats.projectsByStatus).map(([status, count]) => (
              <div key={status} className="flex items-center justify-between text-sm">
                <span className="text-slate-600 font-semibold">{PROJECT_STATUS_LABEL_AR[status] || status}</span>
                <span className="font-black text-[#061B40]">{count}</span>
              </div>
            ))}
            {Object.keys(stats.projectsByStatus).length === 0 && (
              <p className="text-slate-400 text-sm">لا بيانات بعد.</p>
            )}
          </div>
        </div>

        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5">
          <h2 className="font-extrabold text-[#061B40] text-base mb-4">المشاريع حسب المدينة</h2>
          <div className="space-y-2">
            {Object.entries(stats.projectsByCity).map(([city, count]) => (
              <div key={city} className="flex items-center justify-between text-sm">
                <span className="text-slate-600 font-semibold">{city}</span>
                <span className="font-black text-[#061B40]">{count}</span>
              </div>
            ))}
            {Object.keys(stats.projectsByCity).length === 0 && (
              <p className="text-slate-400 text-sm">لا بيانات بعد.</p>
            )}
          </div>
        </div>

        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5">
          <h2 className="font-extrabold text-[#061B40] text-base mb-4">التنبيهات حسب النوع</h2>
          <div className="space-y-2">
            {Object.entries(stats.alertsByKind).map(([kind, count]) => {
              const meta = decisionMeta[alertKindToDecision(kind)];
              return (
                <div key={kind} className="flex items-center justify-between text-sm">
                  <span className={`px-2.5 py-0.5 rounded-full text-xs font-bold ${meta.bg} ${meta.text} border ${meta.border}`}>
                    {alertKindLabelAr[kind] || kind}
                  </span>
                  <span className="font-black text-[#061B40]">{count}</span>
                </div>
              );
            })}
            {Object.keys(stats.alertsByKind).length === 0 && (
              <p className="text-slate-400 text-sm">لا تنبيهات نشطة حالياً.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
