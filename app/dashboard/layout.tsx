"use client";

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/app/lib/supabase';
import { apiClient } from '@/app/lib/apiClient';
import Sidebar from '../components/dashborad/Sidebar';

// كل كم دقيقة نعيد فحص التنبيهات (BEFORE_2H/1H/START تعتمد على الوقت
// المتبقي للنشاط، الذي يتغيّر باستمرار — توليد لمرة واحدة عند الدخول لا
// يكفي لالتقاطها في وقتها الصحيح إن بقي المستخدم بنفس الجلسة لفترة طويلة)
const ALERTS_POLL_INTERVAL_MS = 5 * 60 * 1000;

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [userData, setUserData] = useState<{ name: string; email: string } | undefined>(undefined);

  useEffect(() => {
    const fetchUserData = async () => {
      const { data: { session } } = await supabase.auth.getSession();

      if (!session) {
        router.push('/login');
        return;
      }

      const { data: profileResp } = await apiClient.get('/profile');
      const profile = profileResp?.data;

      // أعمدة profiles الفعلية: username/company_name (لا first_name/last_name)
      if (profile?.username) {
        setUserData({
          name: profile.username,
          email: profile.email || session.user.email || '',
        });
      } else {
        setUserData({
          name: session.user.email?.split('@')[0] || 'مستخدم',
          email: session.user.email || '',
        });
      }
    };

    fetchUserData();
  }, [router]);

  useEffect(() => {
    // توليد تنبيهات مشاريع المستخدم فور الدخول، ثم إعادة الفحص دورياً
    // طوال بقائه في الداشبورد (وليس مرة واحدة فقط) — حتى تظهر تنبيهات
    // "قبل التنفيذ بساعة/ساعتين" في وقتها الفعلي، ويُلتقط أي نشاط جديد
    // بلا قرار بشكل مستمر. منع التكرار داخل نفس النوع مضمون في المولّد
    // نفسه (alertExists)، فتكرار النداء هنا آمن تماماً.
    let cancelled = false;
    const runGenerate = () => {
      apiClient.post('/alerts/generate-mine').catch(() => {
        // فشل صامت — سيُعاد المحاولة في الدورة التالية
      });
    };

    runGenerate();
    const intervalId = window.setInterval(() => {
      if (!cancelled) runGenerate();
    }, ALERTS_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, []);

  const handleLogout = async () => {
    await supabase.auth.signOut();
    router.push('/login');
  };

  return (
    <div className="flex h-screen w-full bg-[#F4F7FB] overflow-hidden" dir="rtl">
      <Sidebar user={userData} onLogout={handleLogout} />
      <main className="flex-1 h-screen overflow-y-auto">
        {children}
      </main>
    </div>
  );
}
