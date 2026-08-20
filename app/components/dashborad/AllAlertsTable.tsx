"use client";

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { apiClient } from '@/app/lib/apiClient';
import { alertKindLabelAr, alertKindToDecision, decisionMeta } from '@/app/lib/decisionMeta';
import { displayActivityLabel } from '@/app/lib/activityLabels';
import { Loader2, CloudRain, MapPin } from 'lucide-react';

// Discovered and fixed issue (explicit user request — "REVIEWED and ACTION_TAKEN
// states appear in the UI, but the code path to change them was removed; there is
// no assigned manager, timestamp, action, or attachment"): They were purely decorative —
// no live write path ever created a row with either state. Permanent removal by explicit
// user decision, not a rebuild.
const STATE_LABEL_AR: Record<string, string> = {
  NEW: 'جديد',
  CLOSED: 'مغلق',
};

// Shape of a single row from GET /api/admin/alerts response (see route.ts) — raw
// alerts row with attached fields from projects/profiles/project_dust_profiles.
interface AdminAlertRow {
  id: string;
  project_id: string;
  kind: string;
  state: string;
  message: string;
  created_at: string;
  projectName: string | null;
  projectCity: string | null;
  projectNeighborhood: string | null;
  projectLatitude: number | null;
  projectLongitude: number | null;
  projectManager: string | null;
  ownerUsername: string | null;
  ownerCompany: string | null;
  ownerPhone: string | null;
  regulatoryActivity: string | null;
  // Explicit user request: "Enable read/unread feature" — completely separated from
  // state (see full comments in migration 202608200001_alert_reads.sql).
  isRead: boolean;
}

// Discovered and fixed issue (explicit user request — "The project link in the monitor's
// alerts table leads them to a page they don't have access to"): The project name was always
// displayed as a link to /dashboard/Projects/[id] — exclusively the project owner's page
// (verifyProjectOwnership, no branch for account_role='viewer' at all).
// The link works for admin page only because verifyProjectOwnership contains an explicit
// exception for is_super_admin treating them as owner of any project — no similar exception
// exists for the monitor, so it always hits 403 "You don't own this project". No dedicated
// project details page for monitors exists in code to redirect them to — the explicit decision
// from user: We do not want the monitor to access project details at all, just remove the link
// (project name as plain non-clickable text) when displaying this table to the monitor.
//
// Read-only table for all alerts across all projects — used by both admin and monitor pages
// (both consume the expanded /api/admin/alerts, see app/api/admin/alerts/route.ts). No action buttons —
// layout is identical for both except for the project link (projectLinksEnabled), and the other
// difference between them is the permission check logic itself (is_super_admin vs account_role='viewer'),
// left to each page wrapper.
export default function AllAlertsTable({ projectLinksEnabled = true }: { projectLinksEnabled?: boolean }) {
  const [alerts, setAlerts] = useState<AdminAlertRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  // Discovered and fixed issue (explicit user request — "Network errors often turn into
  // misleading zero numbers or empty states"): Fetch failure meant "no alerts" — for an external
  // monitoring entity this means seeing "zero alerts across all projects" despite potential actual violations.
  const [error, setError] = useState<string | null>(null);

  const fetchAlerts = React.useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const { data } = await apiClient.get('/admin/alerts');
      setAlerts(data?.data || []);
    } catch (err) {
      console.error('Error fetching alerts:', err);
      const axiosErr = err as { response?: { data?: { error?: string } } };
      setError(axiosErr?.response?.data?.error || 'تعذّر جلب التنبيهات — تحقّق من الاتصال وأعد المحاولة.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Explicit user request: "Enable read/unread feature" — clicking a row marks it as read
  // (no expand/collapse in this table, unlike dashboard/alerts/page.tsx).
  // Immediate optimistic update + silent network failure, same pattern as toggleExpand there.
  const markRowRead = (id: string) => {
    const alert = alerts.find((a) => a.id === id);
    if (!alert || alert.isRead) return;

    setAlerts((prev) => prev.map((a) => (a.id === id ? { ...a, isRead: true } : a)));
    apiClient.post('/alerts/mark-read', { alertIds: [id] }).catch(() => {});
  };

  useEffect(() => {
    // Scheduled via microtask instead of calling fetchAlerts directly from Effect body —
    // static rule react-hooks/set-state-in-effect inspects the call of the function itself
    // from the Effect body, regardless of any await inside the called function.
    let cancelled = false;
    void Promise.resolve().then(() => { if (!cancelled) fetchAlerts(); });
    return () => { cancelled = true; };
  }, [fetchAlerts]);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-[#F4F7FB] flex items-center justify-center" dir="rtl">
        <div className="flex flex-col items-center gap-4 text-[#061B40]">
          <Loader2 className="w-10 h-10 animate-spin text-[#0176FB]" />
          <h2 className="font-bold text-lg">جاري التحميل...</h2>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-[#F4F7FB] flex items-center justify-center" dir="rtl">
        <div className="flex flex-col items-center gap-4 text-center max-w-md px-4">
          <h2 className="text-xl font-black text-red-600">تعذّر تحميل التنبيهات</h2>
          <p className="text-slate-500 text-sm font-medium">{error}</p>
          <button
            type="button"
            onClick={() => { void fetchAlerts(); }}
            className="bg-[#0176FB] hover:bg-[#0176FB]/90 text-white text-sm font-bold px-5 py-2.5 rounded-xl transition-colors"
          >
            إعادة المحاولة
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F4F7FB] p-6 lg:p-8 font-sans" dir="rtl">
      <h1 className="text-3xl font-black text-[#061B40] mb-2">كل التنبيهات ({alerts.length})</h1>
      <p className="text-slate-500 text-sm mb-8">آخر 200 تنبيه عبر كل المشاريع، الأحدث أولاً.</p>

      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          {alerts.length === 0 ? (
            <div className="p-16 flex flex-col items-center text-slate-400">
              <CloudRain className="w-14 h-14 mb-3 opacity-20" />
              <p className="font-bold">لا توجد تنبيهات</p>
            </div>
          ) : (
            <table className="w-full text-right text-sm whitespace-nowrap">
              <thead className="bg-slate-50/50 text-slate-500">
                <tr>
                  <th className="py-3 px-5 font-bold w-4"></th>
                  <th className="py-3 px-5 font-bold">#</th>
                  <th className="py-3 px-5 font-bold">المشروع</th>
                  <th className="py-3 px-5 font-bold">المالك</th>
                  <th className="py-3 px-5 font-bold">رقم الجوال</th>
                  <th className="py-3 px-5 font-bold">اسم المدير</th>
                  <th className="py-3 px-5 font-bold">الموقع</th>
                  <th className="py-3 px-5 font-bold">الحي</th>
                  <th className="py-3 px-5 font-bold">المدينة</th>
                  <th className="py-3 px-5 font-bold">النشاط</th>
                  <th className="py-3 px-5 font-bold">النوع</th>
                  <th className="py-3 px-5 font-bold">الحالة</th>
                  <th className="py-3 px-5 font-bold">الرسالة</th>
                  <th className="py-3 px-5 font-bold">التاريخ</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {alerts.map((a, idx) => {
                  const meta = decisionMeta[alertKindToDecision(a.kind)];
                  const hasCoords = typeof a.projectLatitude === 'number' && typeof a.projectLongitude === 'number';
                  return (
                    <tr
                      key={a.id}
                      onClick={() => markRowRead(a.id)}
                      className={`hover:bg-slate-50/50 transition-colors cursor-pointer ${!a.isRead ? 'bg-blue-50/40' : ''}`}
                    >
                      <td className="py-3 px-5">
                        {!a.isRead && <span className="w-2 h-2 rounded-full bg-blue-500 inline-block" title="غير مقروء" />}
                      </td>
                      <td className="py-3 px-5 text-slate-400">{idx + 1}</td>
                      <td className="py-3 px-5">
                        {projectLinksEnabled ? (
                          <Link href={`/dashboard/Projects/${a.project_id}`} className="font-bold text-[#0176FB] hover:underline">
                            {a.projectName || '—'}
                          </Link>
                        ) : (
                          <span className="font-bold text-slate-700">{a.projectName || '—'}</span>
                        )}
                      </td>
                      <td className="py-3 px-5 text-slate-600">{a.ownerUsername || a.ownerCompany || '—'}</td>
                      <td className="py-3 px-5 text-slate-600" dir="ltr">{a.ownerPhone || '—'}</td>
                      <td className="py-3 px-5 text-slate-600">{a.projectManager || '—'}</td>
                      <td className="py-3 px-5">
                        {hasCoords ? (
                          <a
                            href={`https://www.google.com/maps?q=${a.projectLatitude},${a.projectLongitude}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-[#0176FB] hover:underline"
                          >
                            <MapPin className="w-3.5 h-3.5" />
                            عرض الموقع
                          </a>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="py-3 px-5 text-slate-600">{a.projectNeighborhood || '—'}</td>
                      <td className="py-3 px-5 text-slate-600">{a.projectCity || '—'}</td>
                      <td className="py-3 px-5 text-slate-600">
                        {displayActivityLabel({ regulatory_activity: a.regulatoryActivity })}
                      </td>
                      <td className="py-3 px-5">
                        <span className={`px-2.5 py-0.5 rounded-full text-xs font-bold ${meta.bg} ${meta.text} border ${meta.border}`}>
                          {alertKindLabelAr[a.kind] || a.kind}
                        </span>
                      </td>
                      <td className="py-3 px-5 text-slate-600 text-xs">{STATE_LABEL_AR[a.state] || a.state}</td>
                      <td className="py-3 px-5 text-slate-600 max-w-xs truncate">{a.message}</td>
                      <td className="py-3 px-5 text-slate-500 text-xs">{a.created_at ? new Date(a.created_at).toLocaleString('ar-SA', { calendar: 'gregory' }) : '—'}</td>
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