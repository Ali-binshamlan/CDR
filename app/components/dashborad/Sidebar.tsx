"use client";

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { supabase } from '@/app/lib/supabase';
import { apiClient } from '@/app/lib/apiClient';
import {
  Home, FolderKanban, Bell,
  FileText, ChevronLeft, ChevronRight, Menu, X,
  LogOut
} from 'lucide-react';

// ==========================================
// 1. تعريف الواجهات (Types)
// ==========================================
export interface UserData {
  name: string;
  email: string;
  avatarUrl?: string; // اختياري إذا كان هناك صورة شخصية
}

export interface SidebarProps {
  user?: UserData; // بيانات المستخدم
  onLogout?: () => void; // دالة تسجيل الخروج
}

export interface MenuItem {
  id: string;
  name: string;
  href: string; // الرابط الفعلي للصفحة بدل id داخلي فقط
  icon: React.ElementType;
  badge?: number;
}

// ==========================================
// 2. مكون الشعار (SidebarLogo)
// ==========================================
const SidebarLogo = ({ isCollapsed }: { isCollapsed: boolean }) => (
  <Link href="/dashboard" className="pt-6 pb-4 flex flex-col items-center justify-center shrink-0 min-h-[80px]">
    {!isCollapsed ? (
      <span className="text-2xl font-black text-[#061B40] tracking-wide">DCR</span>
    ) : (
      <div className="w-10 h-10 bg-[#061B40] text-white rounded-xl flex items-center justify-center font-bold text-xl shadow-md">
        D
      </div>
    )}
  </Link>
);

// ==========================================
// 3. مكون عنصر القائمة (SidebarNavItem)
// ==========================================
const SidebarNavItem = ({
  item,
  isActive,
  onClick,
  isCollapsed
}: {
  item: MenuItem;
  isActive: boolean;
  onClick: () => void;
  isCollapsed: boolean;
}) => {
  return (
    <div className="relative group">
      <Link
        href={item.href}
        onClick={onClick}
        className={`w-full flex items-center py-2.5 px-4 rounded-xl transition-all duration-300 font-bold ${
          isCollapsed ? 'justify-center' : 'justify-between'
        } ${
          isActive
            ? 'bg-[#061B40] text-white shadow-md'
            : 'text-slate-600 hover:bg-slate-50 hover:text-[#061B40]'
        }`}
        title={isCollapsed ? item.name : undefined}
      >
        {!isCollapsed && (
          <div className="flex items-center gap-4">
            <span className="text-[13px] whitespace-nowrap">{item.name}</span>
          </div>
        )}

        <div className="flex items-center gap-2 relative">
          {!isCollapsed && !!item.badge && (
            <span className="bg-[#F97316] text-white text-[10px] font-bold px-2 py-0.5 rounded-full">
              {item.badge > 99 ? '99+' : item.badge}
            </span>
          )}

          {isCollapsed && !!item.badge && (
            <span className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-[#F97316] rounded-full"></span>
          )}

          <item.icon
            className={`w-5 h-5 transition-colors ${isActive ? 'text-white' : 'text-slate-400 group-hover:text-[#061B40]'}`}
            strokeWidth={isActive ? 2.5 : 2}
          />
        </div>
      </Link>

      {isActive && !isCollapsed && (
        <div className="absolute top-1/2 -left-1.5 w-3 h-3 bg-[#061B40] transform -translate-y-1/2 rotate-45 rounded-sm z-[-1]"></div>
      )}
    </div>
  );
};

// ==========================================
// 4. مكون الملف الشخصي للمستخدم (SidebarUserProfile)
// ==========================================
const SidebarUserProfile = ({ user, isCollapsed, onLogout }: { user?: UserData, isCollapsed: boolean, onLogout?: () => void }) => {
  if (!user) return null;

  // استخراج أول حرف من الاسم كصورة افتراضية
  const initial = user.name ? user.name.charAt(0).toUpperCase() : 'م';

  return (
    <div className="px-4 py-4 shrink-0 border-t border-slate-100 transition-all duration-300 bg-slate-50/50 mt-2">
      <div className={`flex items-center ${isCollapsed ? 'justify-center' : 'justify-between'}`}>

        <div className="flex items-center gap-3 overflow-hidden" title={isCollapsed ? user.name : undefined}>
          {/* الصورة الرمزية (Avatar) */}
          <div className="w-9 h-9 rounded-full bg-gradient-to-tr from-[#fb8801] to-[#ffb766] text-white flex items-center justify-center font-bold shrink-0 shadow-sm">
            {user.avatarUrl ? (
              <img src={user.avatarUrl} alt={user.name} className="w-full h-full rounded-full object-cover" />
            ) : (
              <span>{initial}</span>
            )}
          </div>

          {/* تفاصيل المستخدم (تختفي عند التصغير) */}
          {!isCollapsed && (
            <div className="flex flex-col truncate">
              <span className="text-[13px] font-extrabold text-[#061B40] truncate">{user.name}</span>
              <span className="text-[10px] font-semibold text-slate-500 truncate">{user.email}</span>
            </div>
          )}
        </div>

        {/* زر تسجيل الخروج */}
        {!isCollapsed && onLogout && (
          <button
            onClick={onLogout}
            className="text-slate-400 hover:text-red-500 hover:bg-red-50 p-2 rounded-lg transition-colors shrink-0"
            title="تسجيل الخروج"
          >
            <LogOut className="w-[18px] h-[18px]" strokeWidth={2.5} />
          </button>
        )}
      </div>
    </div>
  );
};

// ==========================================
// 5. المكون الرئيسي (Sidebar Main Container)
// ==========================================
export default function Sidebar({ user, onLogout }: SidebarProps) {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [isMobileOpen, setIsMobileOpen] = useState(false);
  const [alertsCount, setAlertsCount] = useState<number>(0);
  const pathname = usePathname();

  // -----------------------------------------------------------
  // رقم التنبيهات: نجلبه من جدول alerts (عدد التنبيهات غير المغلقة)،
  // ونشترك بتحديثات Realtime على نفس الجدول عشان الرقم يتحدث فورًا لحظة
  // ما يضيف مولّد التنبيهات (cron) صفًا جديدًا بالخلفية، بدون ما يحتاج
  // المستخدم يعمل تحديث للصفحة يدويًا.
  // -----------------------------------------------------------
  useEffect(() => {
    let isMounted = true;

    async function fetchAlertsCount() {
      try {
        const { data } = await apiClient.get('/alerts/count');
        if (isMounted) setAlertsCount(data?.count ?? 0);
      } catch (error: any) {
        console.error('fetchAlertsCount failed:', error?.response?.data?.error || error?.message);
      }
    }

    fetchAlertsCount();

    const channel = supabase
      .channel('sidebar-alerts-count')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'alerts' },
        () => {
          fetchAlertsCount();
        }
      )
      .subscribe();

    return () => {
      isMounted = false;
      supabase.removeChannel(channel);
    };
  }, []);

  const menuItems: MenuItem[] = [
    { id: 'home', name: 'لوحة التحكم', href: '/dashboard', icon: Home },
    { id: 'projects', name: 'المشاريع', href: '/dashboard/Projects', icon: FolderKanban },
    { id: 'alerts', name: 'التنبيهات', href: '/dashboard/alerts', icon: Bell, badge: alertsCount },
    { id: 'reports', name: 'التقارير', href: '/dashboard/reports', icon: FileText },
  ];

  // تحديد العنصر النشط بناءً على المسار الحالي (route) بدل state داخلي
  const isItemActive = (href: string) => {
    if (href === '/dashboard') {
      // الرئيسية تكون نشطة فقط عند التطابق التام، لتجنب تفعيلها مع كل المسارات الفرعية
      return pathname === '/dashboard';
    }
    return pathname === href || pathname?.startsWith(href + '/');
  };

  const handleNavigation = () => {
    setIsMobileOpen(false);
  };

  return (
    <>
      <button
        onClick={() => setIsMobileOpen(true)}
        className="md:hidden fixed top-4 right-4 z-40 bg-white p-2 rounded-lg shadow-md text-[#061B40]"
      >
        <Menu className="w-6 h-6" />
      </button>

      {isMobileOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 md:hidden transition-opacity"
          onClick={() => setIsMobileOpen(false)}
        />
      )}

      <aside
        className={`fixed md:relative top-0 bottom-0 right-0 z-50 bg-white border-l border-slate-100 flex flex-col font-sans overflow-visible shrink-0 transition-all duration-300 ease-in-out shadow-2xl md:shadow-[[-5px_0_15px_rgba(0,0,0,0.02)]]
          ${isCollapsed ? 'md:w-20' : 'md:w-72'}
          ${isMobileOpen ? 'w-72 translate-x-0' : 'translate-x-full md:translate-x-0'}
        `}
        dir="rtl"
      >
        <button
          onClick={() => setIsMobileOpen(false)}
          className="md:hidden absolute top-4 left-4 p-2 text-slate-400 hover:text-slate-600"
        >
          <X className="w-5 h-5" />
        </button>

        <button
          onClick={() => setIsCollapsed(!isCollapsed)}
          className="hidden md:flex absolute top-8 -left-3.5 w-7 h-7 bg-white border border-slate-200 rounded-full items-center justify-center text-slate-500 hover:text-[#061B40] hover:bg-slate-50 shadow-sm z-10 transition-transform"
        >
          {isCollapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
        </button>

        <SidebarLogo isCollapsed={isCollapsed} />

        <nav className="flex-1 px-3 flex flex-col justify-start pt-2 space-y-1.5 overflow-y-auto no-scrollbar">
          {menuItems.map((item) => (
            <SidebarNavItem
              key={item.id}
              item={item}
              isActive={isItemActive(item.href)}
              onClick={handleNavigation}
              isCollapsed={isCollapsed}
            />
          ))}
        </nav>

        {/* عرض بيانات المستخدم هنا في الأسفل */}
        <SidebarUserProfile user={user} isCollapsed={isCollapsed} onLogout={onLogout} />

        <div className="text-center py-3 shrink-0 transition-all bg-slate-50 border-t border-slate-100">
          <p className="text-[9px] font-bold text-slate-400 whitespace-nowrap">
            {isCollapsed ? '©' : 'DCR - جميع الحقوق محفوظة'}
          </p>
        </div>
      </aside>
    </>
  );
}
