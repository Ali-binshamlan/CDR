"use client";

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { apiClient } from '@/app/lib/apiClient';
import { Loader2, ShieldAlert, ShieldCheck, CloudRain } from 'lucide-react';

interface AdminUserRow {
  id: string;
  username: string | null;
  companyName: string | null;
  phoneNumber: string | null;
  role: string | null;
  isSuperAdmin: boolean;
  createdAt: string;
  email: string | null;
  projectCount: number;
}

export default function AdminUsersPage() {
  const router = useRouter();
  const [isSuperAdmin, setIsSuperAdmin] = useState<boolean | undefined>(undefined);
  const [users, setUsers] = useState<AdminUserRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [accessDenied, setAccessDenied] = useState(false);
  // خطأ مكتشَف ومُصلَح (طلب صريح من المستخدم — "أخطاء الشبكة تتحول غالباً
  // إلى أرقام صفرية أو حالات فارغة مضللة") — نفس نمط admin/projects/page.tsx.
  const [error, setError] = useState<string | null>(null);

  const fetchUsers = React.useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const { data } = await apiClient.get('/admin/users');
      setUsers(data?.data || []);
    } catch (err: unknown) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status === 403) {
        setAccessDenied(true);
      } else {
        console.error('Error fetching admin users:', err);
        const axiosErr = err as { response?: { data?: { error?: string } } };
        setError(axiosErr?.response?.data?.error || 'تعذّر جلب المستخدمين — تحقّق من الاتصال وأعد المحاولة.');
      }
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    const check = async () => {
      const { data: profileResp } = await apiClient.get('/profile');
      const admin = !!profileResp?.data?.is_super_admin;
      setIsSuperAdmin(admin);
      if (!admin) {
        router.replace('/dashboard');
        return;
      }
      await fetchUsers();
    };
    check();
  }, [router, fetchUsers]);

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

  if (error) {
    return (
      <div className="min-h-screen bg-[#F4F7FB] flex flex-col items-center justify-center gap-4 text-center px-4" dir="rtl">
        <h2 className="text-xl font-black text-red-600">تعذّر تحميل المستخدمين</h2>
        <p className="text-slate-500 text-sm font-medium max-w-md">{error}</p>
        <button
          type="button"
          onClick={() => { void fetchUsers(); }}
          className="bg-[#0176FB] hover:bg-[#0176FB]/90 text-white text-sm font-bold px-5 py-2.5 rounded-xl transition-colors"
        >
          إعادة المحاولة
        </button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F4F7FB] p-6 lg:p-8 font-sans" dir="rtl">
      <h1 className="text-3xl font-black text-[#061B40] mb-8">كل المستخدمين ({users.length})</h1>

      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          {users.length === 0 ? (
            <div className="p-16 flex flex-col items-center text-slate-400">
              <CloudRain className="w-14 h-14 mb-3 opacity-20" />
              <p className="font-bold">لا يوجد مستخدمون</p>
            </div>
          ) : (
            <table className="w-full text-right text-sm whitespace-nowrap">
              <thead className="bg-slate-50/50 text-slate-500">
                <tr>
                  <th className="py-3 px-5 font-bold">اسم المستخدم</th>
                  <th className="py-3 px-5 font-bold">الشركة</th>
                  <th className="py-3 px-5 font-bold">البريد</th>
                  <th className="py-3 px-5 font-bold">الهاتف</th>
                  <th className="py-3 px-5 font-bold">الدور</th>
                  <th className="py-3 px-5 font-bold">عدد المشاريع</th>
                  <th className="py-3 px-5 font-bold">تاريخ التسجيل</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {users.map((u) => (
                  <tr key={u.id} className="hover:bg-slate-50/50 transition-colors">
                    <td className="py-3 px-5 font-bold text-slate-800">
                      <span className="flex items-center gap-1.5">
                        {u.username || '—'}
                        {u.isSuperAdmin && (
                          <span className="flex items-center gap-1 text-[10px] font-bold text-[#0176FB] bg-blue-50 border border-blue-200 px-2 py-0.5 rounded-full">
                            <ShieldCheck className="w-3 h-3" /> سوبر أدمن
                          </span>
                        )}
                      </span>
                    </td>
                    <td className="py-3 px-5 text-slate-600">{u.companyName || '—'}</td>
                    <td className="py-3 px-5 text-slate-600" dir="ltr">{u.email || '—'}</td>
                    <td className="py-3 px-5 text-slate-600" dir="ltr">{u.phoneNumber || '—'}</td>
                    <td className="py-3 px-5 text-slate-600">{u.role || '—'}</td>
                    <td className="py-3 px-5 text-slate-600 font-bold">{u.projectCount}</td>
                    <td className="py-3 px-5 text-slate-500 text-xs">{u.createdAt ? new Date(u.createdAt).toLocaleDateString('ar-SA', { calendar: 'gregory' }) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
