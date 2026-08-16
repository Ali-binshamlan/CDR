"use client";

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { apiClient } from '@/app/lib/apiClient';
import AllAlertsTable from '@/app/components/dashborad/AllAlertsTable';
import { Loader2, ShieldAlert } from 'lucide-react';

export default function ViewerAlertsPage() {
  const router = useRouter();
  const [isViewer, setIsViewer] = useState<boolean | undefined>(undefined);

  useEffect(() => {
    const check = async () => {
      const { data: profileResp } = await apiClient.get('/profile');
      const viewer = profileResp?.data?.account_role === 'viewer';
      setIsViewer(viewer);
      if (!viewer) {
        router.replace('/dashboard');
      }
    };
    check();
  }, [router]);

  if (isViewer === undefined) {
    return (
      <div className="min-h-screen bg-[#F4F7FB] flex items-center justify-center" dir="rtl">
        <div className="flex flex-col items-center gap-4 text-[#061B40]">
          <Loader2 className="w-10 h-10 animate-spin text-[#0176FB]" />
          <h2 className="font-bold text-lg">جاري التحقق من الصلاحية...</h2>
        </div>
      </div>
    );
  }

  if (!isViewer) {
    return (
      <div className="min-h-screen bg-[#F4F7FB] flex flex-col items-center justify-center text-slate-500" dir="rtl">
        <ShieldAlert className="w-16 h-16 mb-4 opacity-30" />
        <p className="font-bold text-lg text-slate-700">غير مصرح لك بالوصول لهذه الصفحة</p>
      </div>
    );
  }

  // خطأ مكتشَف ومُصلَح (طلب صريح من المستخدم — "رابط المشروع في جدول
  // تنبيهات المراقب يقوده إلى صفحة لا يملك صلاحيتها"): لا صفحة تفاصيل
  // مشروع للمراقب، ولا نريد بناء واحدة — راجع تعليق AllAlertsTable الكامل.
  return <AllAlertsTable projectLinksEnabled={false} />;
}
