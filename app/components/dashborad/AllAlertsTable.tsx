"use client";

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { apiClient } from '@/app/lib/apiClient';
import { alertKindLabelAr, alertKindToDecision, decisionMeta } from '@/app/lib/decisionMeta';
import { translateActivityType } from '@/app/lib/activityLabels';
import { REGULATORY_ACTIVITY_LABEL_AR } from '@/app/utils/dust-compliance-engine/rulebook';
import { Loader2, CloudRain, MapPin } from 'lucide-react';

const STATE_LABEL_AR: Record<string, string> = {
  NEW: 'جديد',
  REVIEWED: 'قيد المراجعة',
  ACTION_TAKEN: 'تم الإجراء',
  CLOSED: 'مغلق',
};

// جدول قراءة فقط لكل التنبيهات عبر كل المشاريع — مستخدَم من صفحتي الأدمن
// والمراقب معاً (كلتاهما تستهلك /api/admin/alerts المُوسَّع، راجع
// app/api/admin/alerts/route.ts). لا props ولا أزرار إجراء — الشكل مطابق
// تماماً للطرفين، الاختلاف الوحيد بينهما هو منطق التحقق من الصلاحية نفسه
// (is_super_admin مقابل account_role='viewer')، المتروك لكل صفحة wrapper.
export default function AllAlertsTable() {
  const [alerts, setAlerts] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const fetchAlerts = async () => {
      try {
        const { data } = await apiClient.get('/admin/alerts');
        setAlerts(data?.data || []);
      } catch (error) {
        console.error('Error fetching alerts:', error);
      } finally {
        setIsLoading(false);
      }
    };
    fetchAlerts();
  }, []);

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
                    <tr key={a.id} className="hover:bg-slate-50/50 transition-colors">
                      <td className="py-3 px-5 text-slate-400">{idx + 1}</td>
                      <td className="py-3 px-5">
                        <Link href={`/dashboard/Projects/${a.project_id}`} className="font-bold text-[#0176FB] hover:underline">
                          {a.projectName || '—'}
                        </Link>
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
                        {a.regulatoryActivity && a.regulatoryActivity !== 'OTHER'
                          ? REGULATORY_ACTIVITY_LABEL_AR[a.regulatoryActivity] ?? translateActivityType(a.activityType)
                          : translateActivityType(a.activityType)}
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
