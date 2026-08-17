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
//
// خطأ مكتشَف ومُصلَح (طلب صريح من المستخدم — بلاغ مباشر بلقطتي شاشة:
// "اول ما تسجل دخول تطلع كذا [لوحة تحكم فارغة بلا معنى للأدمن] ثم اذا
// ضغطت على لوحه التحكم تطلع كذا [لوحة الإدارة الفعلية]"): تسجيل الدخول
// يُحوِّل الجميع دائماً إلى /dashboard بصرف النظر عن الدور (login/page.tsx)
// — Sidebar.tsx (commit سابق: فصل قائمة super_admin بالكامل) لم يعد يعرض
// أي رابط لـ/dashboard الأصلي لحساب الأدمن أصلاً، فيبقى هذا المسار وجهة
// ميتة له (كل الأرقام صفر، خريطة مشاريع فارغة لا صلة لها بحساب إداري بحت)
// حتى يضغط يدوياً على "لوحة الإدارة". نفس فحص is_super_admin المستخدَم
// فعلياً في admin/page.tsx (سطر check أعلاه هناك) يُطبَّق هنا بنفس الأسلوب.
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
      if (profileResp?.data?.is_super_admin) {
        router.replace('/dashboard/admin');
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
