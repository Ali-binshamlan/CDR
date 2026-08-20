"use client";

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { AxiosError } from 'axios';
import { supabase } from '@/app/lib/supabase';
import { apiClient } from '@/app/lib/apiClient';
import {
  Home, FolderKanban, Bell,
  FileText, ChevronLeft, ChevronRight, Menu, X,
  LogOut, ShieldCheck, CalendarDays, Settings, Users, Scale, Wifi
} from 'lucide-react';

// ==========================================
// 1. Types Definitions
// ==========================================
export interface UserData {
  name: string;
  email: string;
  avatarUrl?: string; // Optional profile picture
}

export interface SidebarProps {
  user?: UserData; // User data
  onLogout?: () => void; // Logout callback function
  // 'user' | 'super_admin' | 'viewer' | undefined (during loading) — Determines
  // the entire sidebar menu items. Viewer is an entirely separate list
  // (3 items: dashboard/alerts/reports only, no projects or admin),
  // not a filtered version of the regular user menu.
  accountRole?: 'user' | 'super_admin' | 'viewer';
}

export interface MenuItem {
  id: string;
  name: string;
  href: string; // The actual page link instead of an internal ID only
  icon: React.ElementType;
  badge?: number;
  // See the full alertsCountFetchFailed comment in Sidebar — true means "failed
  // to fetch actual count", not "actual count is zero".
  badgeFetchFailed?: boolean;
}

// ==========================================
// 2. Sidebar Logo Component (SidebarLogo)
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
// 3. Navigation Item Component (SidebarNavItem)
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

          {/* Do not display misleading "0" on fetch failure — a small gray dot indicates
              "count currently unknown", instead of hiding any indication as if there are no alerts. */}
          {!item.badge && item.badgeFetchFailed && (
            <span
              className="w-2 h-2 rounded-full bg-slate-300 border border-slate-400"
              title="Failed to fetch actual count — check connection"
            ></span>
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
// 4. User Profile Component (SidebarUserProfile)
// ==========================================
const SidebarUserProfile = ({ user, isCollapsed, onLogout }: { user?: UserData, isCollapsed: boolean, onLogout?: () => void }) => {
  if (!user) return null;

  // Extract the first letter of the name as a fallback avatar
  const initial = user.name ? user.name.charAt(0).toUpperCase() : 'M';

  return (
    <div className="px-4 py-4 shrink-0 border-t border-slate-100 transition-all duration-300 bg-slate-50/50 mt-2">
      <div className={`flex items-center ${isCollapsed ? 'justify-center' : 'justify-between'}`}>

        <div className="flex items-center gap-3 overflow-hidden" title={isCollapsed ? user.name : undefined}>
          {/* Avatar */}
          <div className="w-9 h-9 rounded-full bg-gradient-to-tr from-[#fb8801] to-[#ffb766] text-white flex items-center justify-center font-bold shrink-0 shadow-sm">
            {user.avatarUrl ? (
              // next/image requires prior registration of remotePatterns in
              // next.config — avatarUrl has no actual source populating it currently in any
              // query in the project (field defined in anticipation of a future feature), so
              // no known domain to register today. Standard <img> is acceptable for a small
              // avatar image (36x36) with no noticeable LCP cost.
              // eslint-disable-next-line @next/next/no-img-element
              <img src={user.avatarUrl} alt={user.name} className="w-full h-full rounded-full object-cover" />
            ) : (
              <span>{initial}</span>
            )}
          </div>

          {/* User Details (hidden when collapsed) */}
          {!isCollapsed && (
            <div className="flex flex-col truncate">
              <span className="text-[13px] font-extrabold text-[#061B40] truncate">{user.name}</span>
              <span className="text-[10px] font-semibold text-slate-500 truncate">{user.email}</span>
            </div>
          )}
        </div>

        {/* Logout Button */}
        {!isCollapsed && onLogout && (
          <button
            onClick={onLogout}
            className="text-slate-400 hover:text-red-500 hover:bg-red-50 p-2 rounded-lg transition-colors shrink-0"
            title="Log Out"
          >
            <LogOut className="w-[18px] h-[18px]" strokeWidth={2.5} />
          </button>
        )}
      </div>
    </div>
  );
};

// ==========================================
// 5. Sidebar Main Container
// ==========================================
export default function Sidebar({ user, onLogout, accountRole }: SidebarProps) {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [isMobileOpen, setIsMobileOpen] = useState(false);
  const [alertsCount, setAlertsCount] = useState<number>(0);
  // Detected and fixed bug (explicit user request — "network errors often turn into
  // misleading zeros or empty states"): fetchAlertsCount failures were only logged
  // in console.error while alertsCount remained 0 — the orange badge next to
  // "Alerts" vanished completely (badge is rendered only when !!count), so a user
  // with unclosed critical alerts saw a "clean" sidebar with no indication.
  // alertsCountFetchFailed displays a small warning dot instead of silent disappearance — without
  // repeating toasts (this fetch runs on every Realtime event; toast on each failure would
  // annoy the user).
  const [alertsCountFetchFailed, setAlertsCountFetchFailed] = useState(false);
  const pathname = usePathname();

  // -----------------------------------------------------------
  // Alerts Count: Fetched from the alerts table (unclosed alerts count),
  // and subscribes to Realtime updates on the same table so the count updates instantly
  // whenever the alert generator (cron) inserts a new row in the background.
  //
  // Fundamental performance issue detected and fixed (Context: Supabase alert regarding
  // Disk IO Budget consumption, 2026-08-13 — see migration 202608130001/202608130002 for
  // similar fixes on cron jobs, and migration 202608130003 for full details of this fix):
  // Actual measurement via pg_stat_statements revealed that realtime.list_changes alone
  // consumed ~131 million I/O blocks — over 100x more than any other query in the entire
  // database, despite only 1-5 concurrent users. Root cause: this channel subscribed to
  // event:'*' without any filter on the entire alerts table (no project_id nor user_id),
  // with RLS containing a subquery on projects for each row — re-evaluated for every WAL event
  // by each subscribed session, regardless of row relevance. Since this Sidebar is shared
  // across all pages (permanent subscription open throughout the session), the cumulative impact was huge.
  //
  // Root fix (no polling — permanent solution): alerts.user_id is a new direct column
  // (denormalized from projects.user_id, migration 202608130003) allowing the subscription
  // itself to be filtered at the Realtime protocol level (filter: user_id=eq.<uid>) instead
  // of subscribing to the whole table — each session receives only its own events from the start,
  // without sacrificing real-time updates.
  // -----------------------------------------------------------
  useEffect(() => {
    let isMounted = true;

    async function fetchAlertsCount() {
      try {
        const { data } = await apiClient.get('/alerts/count');
        if (!isMounted) return;
        setAlertsCount(data?.count ?? 0);
        setAlertsCountFetchFailed(false);
      } catch (error) {
        if (!isMounted) return;
        const err = error as AxiosError<{ error?: string }>;
        console.error('fetchAlertsCount failed:', err?.response?.data?.error || err?.message);
        setAlertsCountFetchFailed(true);
      }
    }

    fetchAlertsCount();

    let channel: ReturnType<typeof supabase.channel> | null = null;

    // setAuth(access_token) is necessary before subscribing: Realtime WebSocket connection
    // is separate from apiClient (axios); without it, the channel opens unauthenticated
    // and silently fails if the table policy requires "to authenticated".
    //
    // onAuthStateChange is also required: getSession() token is valid for one hour only;
    // after that, the previously opened channel remains authenticated with an expired token
    // (does not auto-renew with axios token refresh), so events are silently rejected despite
    // the channel appearing SUBSCRIBED — see detailed explanation in
    // app/dashboard/Projects/[id]/page.tsx.
    (async () => {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      const uid = data.session?.user?.id;
      if (!token || !uid || !isMounted) return;
      await supabase.realtime.setAuth(token);
      if (!isMounted) return;

      channel = supabase
        .channel('sidebar-alerts-count')
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'alerts', filter: `user_id=eq.${uid}` },
          () => {
            fetchAlertsCount();
          }
        )
        // Explicit user request: "Enable read/unread feature so the count decreases" —
        // The count is now built on alert_reads as well (see alerts/count/route.ts),
        // so marking an alert as read from the alerts page (another window/tab for the same
        // user, or same page) must update the badge instantly — same user_id filter
        // (alert_reads.user_id, not alert_id) following the exact alerts channel logic above.
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'alert_reads', filter: `user_id=eq.${uid}` },
          () => {
            fetchAlertsCount();
          }
        )
        .subscribe();
    })();

    const { data: authListener } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (!session?.access_token) return;
      await supabase.realtime.setAuth(session.access_token);
    });

    return () => {
      isMounted = false;
      authListener.subscription.unsubscribe();
      if (channel) supabase.removeChannel(channel);
    };
  }, []);

  // Explicit user request — "Separate the admin account into a distinct sidebar displaying
  // only what exists under /admin": super_admin account was sharing the complete primary list
  // (dashboard/projects/alerts/schedule/settings) with an "Admin" link appended at the end —
  // now it is a completely separate list, exact same principle as isolating viewer role:
  // renders only the /dashboard/admin/** pages that actually exist (the same 5 subpages listed in
  // admin/page.tsx — Projects/Users/Alerts/Compliance Rules/Data Source Platforms),
  // without any item from the regular user menu.
  //
  // Detected and fixed bug (explicit user request — direct report: "Why does the regular user sidebar
  // show up then disappear and the other one appears"): accountRole always starts as undefined
  // (not yet fetched from dashboard/layout.tsx, asynchronous fetch) — the condition chain silently fell through
  // to the final "else" branch (regular user list) as long as accountRole !== 'viewer' && !== 'super_admin',
  // including the undefined state itself. So every user (even admin/viewer) saw the regular user menu
  // briefly before accountRole arrived and corrected the menu — "disappears then appears" was exactly this visual shift.
  // Now undefined is an explicit standalone branch (empty menu, no default role assumption) instead of
  // implicitly falling back to regular user list.
  const menuItems: MenuItem[] = accountRole === undefined
    ? []
    : accountRole === 'viewer'
    ? [
        { id: 'home', name: 'لوحة التحكم', href: '/dashboard/viewer', icon: Home },
        { id: 'alerts', name: 'التنبيهات', href: '/dashboard/viewer/alerts', icon: Bell, badge: alertsCount, badgeFetchFailed: alertsCountFetchFailed },
        { id: 'reports', name: 'التقارير', href: '/dashboard/viewer/reports', icon: FileText },
      ]
    : accountRole === 'super_admin'
    ? [
        { id: 'admin-home', name: 'لوحة الإدارة', href: '/dashboard/admin', icon: ShieldCheck },
        { id: 'admin-projects', name: 'المشاريع', href: '/dashboard/admin/projects', icon: FolderKanban },
        { id: 'admin-users', name: 'المستخدمون', href: '/dashboard/admin/users', icon: Users },
        { id: 'admin-alerts', name: 'التنبيهات', href: '/dashboard/admin/alerts', icon: Bell },
        { id: 'admin-rules', name: 'قواعد الامتثال', href: '/dashboard/admin/rules', icon: Scale },
        { id: 'admin-providers', name: 'منصات مصادر البيانات', href: '/dashboard/admin/provider-instances', icon: Wifi },
      ]
    : [
        { id: 'home', name: 'لوحة التحكم', href: '/dashboard', icon: Home },
        { id: 'projects', name: 'المشاريع', href: '/dashboard/Projects', icon: FolderKanban },
        { id: 'alerts', name: 'التنبيهات', href: '/dashboard/alerts', icon: Bell, badge: alertsCount, badgeFetchFailed: alertsCountFetchFailed },
        { id: 'schedule', name: 'جدول الأسبوع', href: '/dashboard/schedule', icon: CalendarDays },
        { id: 'settings', name: 'الإعدادات', href: '/dashboard/settings', icon: Settings },
      ];

  // Determine active item based on current route instead of internal state
  //
  // Detected and fixed bug (explicit user request — direct report: "The first item stays blue even after navigating to another item"):
  // The exception below was limited to '/dashboard' only ("Dashboard" link for regular user menu) —
  // it did not cover "Admin Dashboard" (/dashboard/admin) and viewer "Dashboard" (/dashboard/viewer),
  // both of which had the exact same issue: their paths are literal prefixes for all their subpages
  // (/dashboard/admin/users starts with /dashboard/admin/), so startsWith(href + '/') kept the first item
  // active permanently regardless of the actual active subpage. Now any of the 3 "root" links
  // (/dashboard, /dashboard/admin, /dashboard/viewer) requires an exact match, not just a prefix.
  const ROOT_HREFS = new Set(['/dashboard', '/dashboard/admin', '/dashboard/viewer']);
  const isItemActive = (href: string) => {
    if (ROOT_HREFS.has(href)) {
      return pathname === href;
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

        {/* Render user profile data here at the bottom */}
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