"use client";

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { apiClient } from '@/app/lib/apiClient';
import IntegratedDashboard from '../components/dashborad/IntegratedDashboard';
import { Loader2 } from 'lucide-react';

// جهة المراقبة (account_role='viewer') لا تشوف لوحة التحكم المقيَّدة
// بمشاريع مستخدم عادي — تُحوَّل فوراً لنسختها غير المقيَّدة على
// /dashboard/viewer (نفس مبدأ إعادة توجيه غير-الأدمن بعيداً عن
// /dashboard/admin، بالاتجاه المعاكس).
export default function DashboardHomePage() {
  const router = useRouter();
  const [shouldRender, setShouldRender] = useState<boolean | undefined>(undefined);

  useEffect(() => {
    const check = async () => {
      const { data: profileResp } = await apiClient.get('/profile');
      if (profileResp?.data?.account_role === 'viewer') {
        router.replace('/dashboard/viewer');
        return;
      }
      setShouldRender(true);
    };
    check();
  }, [router]);

  if (!shouldRender) {
    return (
      <div className="min-h-screen bg-[#F4F7FB] flex items-center justify-center" dir="rtl">
        <div className="flex flex-col items-center gap-4 text-[#061B40]">
          <Loader2 className="w-10 h-10 animate-spin text-[#0176FB]" />
          <h2 className="font-bold text-lg">جاري التحميل...</h2>
        </div>
      </div>
    );
  }

  return <IntegratedDashboard />;
}
