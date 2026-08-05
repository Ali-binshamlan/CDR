"use client";

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { apiClient } from '@/app/lib/apiClient';
import { decisionMeta, type Decision } from '@/app/lib/decisionMeta';
import { translateActivityType } from '@/app/lib/activityLabels';
import { REGULATORY_ACTIVITY_LABEL_AR } from '@/app/utils/dust-compliance-engine/rulebook';
import { Loader2, ShieldAlert, CloudRain } from 'lucide-react';

interface AdminDecisionRow {
  id: string;
  project_id: string;
  status: string;
  reason: string | null;
  approved_by: string | null;
  created_at: string;
  projectName: string | null;
  ownerUsername: string | null;
  ownerCompany: string | null;
  activityType: string | null;
  regulatoryActivity: string | null;
}

export default function AdminDecisionsPage() {
  const router = useRouter();
  const [isSuperAdmin, setIsSuperAdmin] = useState<boolean | undefined>(undefined);
  const [decisions, setDecisions] = useState<AdminDecisionRow[]>([]);
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
        const { data } = await apiClient.get('/admin/decisions');
        setDecisions(data?.data || []);
      } catch (error: unknown) {
        if ((error as { response?: { status?: number } })?.response?.status === 403) setAccessDenied(true);
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
      <h1 className="text-3xl font-black text-[#061B40] mb-2">كل القرارات الموثّقة ({decisions.length})</h1>
      <p className="text-slate-500 text-sm mb-8">آخر 200 قرار عبر كل المشاريع، الأحدث أولاً.</p>

      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          {decisions.length === 0 ? (
            <div className="p-16 flex flex-col items-center text-slate-400">
              <CloudRain className="w-14 h-14 mb-3 opacity-20" />
              <p className="font-bold">لا توجد قرارات موثّقة</p>
            </div>
          ) : (
            <table className="w-full text-right text-sm whitespace-nowrap">
              <thead className="bg-slate-50/50 text-slate-500">
                <tr>
                  <th className="py-3 px-5 font-bold">المشروع</th>
                  <th className="py-3 px-5 font-bold">المالك</th>
                  <th className="py-3 px-5 font-bold">النشاط</th>
                  <th className="py-3 px-5 font-bold">الحالة</th>
                  <th className="py-3 px-5 font-bold">السبب</th>
                  <th className="py-3 px-5 font-bold">المعتمِد</th>
                  <th className="py-3 px-5 font-bold">التاريخ</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {decisions.map((d) => {
                  const decision = (d.status as Decision) in decisionMeta ? (d.status as Decision) : 'safe';
                  const meta = decisionMeta[decision];
                  return (
                    <tr key={d.id} className="hover:bg-slate-50/50 transition-colors">
                      <td className="py-3 px-5">
                        <Link href={`/dashboard/Projects/${d.project_id}`} className="font-bold text-[#0176FB] hover:underline">
                          {d.projectName || '—'}
                        </Link>
                      </td>
                      <td className="py-3 px-5 text-slate-600">{d.ownerUsername || d.ownerCompany || '—'}</td>
                      <td className="py-3 px-5 text-slate-600">
                        {d.regulatoryActivity && d.regulatoryActivity !== 'OTHER'
                          ? REGULATORY_ACTIVITY_LABEL_AR[d.regulatoryActivity] ?? translateActivityType(d.activityType)
                          : translateActivityType(d.activityType)}
                      </td>
                      <td className="py-3 px-5">
                        <span className={`px-2.5 py-0.5 rounded-full text-xs font-bold ${meta.bg} ${meta.text} border ${meta.border}`}>
                          {meta.label}
                        </span>
                      </td>
                      <td className="py-3 px-5 text-slate-600 max-w-xs truncate">{d.reason || '—'}</td>
                      <td className="py-3 px-5 text-slate-600">{d.approved_by || '—'}</td>
                      <td className="py-3 px-5 text-slate-500 text-xs">{d.created_at ? new Date(d.created_at).toLocaleString('ar-SA', { calendar: 'gregory' }) : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
