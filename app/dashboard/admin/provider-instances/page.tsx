"use client";

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'react-hot-toast';
import { apiClient } from '@/app/lib/apiClient';
import { Loader2, ShieldAlert, CloudRain, CheckCircle2, XCircle, Plus } from 'lucide-react';

interface ProviderInstance {
  id: string;
  provider: string;
  origin: string;
  hostname: string;
  is_approved: boolean;
  is_active: boolean;
  created_at: string;
}

// إدارة provider_instances (القسم 15.1 من "دليل الإصلاح الجذري لمنظومة
// مرقاب") — سجل منصات معتمدة من مسؤول النظام فقط؛ المستخدم العادي يختار من
// هذه القائمة بدل كتابة رابط منصة حر (ConnectProviderModal.tsx).
export default function AdminProviderInstancesPage() {
  const router = useRouter();
  const [isSuperAdmin, setIsSuperAdmin] = useState<boolean | undefined>(undefined);
  const [instances, setInstances] = useState<ProviderInstance[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [accessDenied, setAccessDenied] = useState(false);

  const [provider, setProvider] = useState('thingsboard');
  const [origin, setOrigin] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const load = async () => {
    try {
      const { data } = await apiClient.get('/admin/provider-instances');
      setInstances(data?.instances || []);
    } catch (error: unknown) {
      if ((error as { response?: { status?: number } })?.response?.status === 403) setAccessDenied(true);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    const check = async () => {
      const { data: profileResp } = await apiClient.get('/profile');
      const admin = !!profileResp?.data?.is_super_admin;
      setIsSuperAdmin(admin);
      if (!admin) {
        router.replace('/dashboard');
        return;
      }
      await load();
    };
    check();
  }, [router]);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      await apiClient.post('/admin/provider-instances', { provider, origin });
      toast.success('تمت إضافة المنصة (بانتظار الاعتماد)');
      setOrigin('');
      await load();
    } catch (error: unknown) {
      toast.error((error as { response?: { data?: { error?: string } } })?.response?.data?.error || 'فشل إضافة المنصة');
    } finally {
      setSubmitting(false);
    }
  };

  const handleToggleApproved = async (inst: ProviderInstance) => {
    try {
      await apiClient.patch('/admin/provider-instances', { id: inst.id, isApproved: !inst.is_approved });
      await load();
    } catch {
      toast.error('فشل تحديث حالة الاعتماد');
    }
  };

  const handleToggleActive = async (inst: ProviderInstance) => {
    try {
      await apiClient.patch('/admin/provider-instances', { id: inst.id, isActive: !inst.is_active });
      await load();
    } catch {
      toast.error('فشل تحديث حالة التفعيل');
    }
  };

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
      <h1 className="text-3xl font-black text-[#061B40] mb-2">منصات مصادر البيانات المعتمدة</h1>
      <p className="text-sm text-slate-500 mb-8">
        سجل المنصات الخارجية (مثال: ThingsBoard) المسموح للمستخدمين ربط أجهزتهم بها. لا يمكن لأي مستخدم إدخال رابط منصة حر — الاختيار فقط من هذه القائمة بعد اعتمادها.
      </p>

      <form onSubmit={handleAdd} className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 mb-6 flex flex-wrap gap-3 items-end">
        <div>
          <label className="block text-[11px] font-bold text-slate-500 mb-1">المزوّد</label>
          <input
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            className="px-3 py-2 rounded-lg border border-slate-200 text-sm"
            dir="ltr"
            required
          />
        </div>
        <div className="flex-1 min-w-[240px]">
          <label className="block text-[11px] font-bold text-slate-500 mb-1">origin (https:// فقط، بلا مسار)</label>
          <input
            value={origin}
            onChange={(e) => setOrigin(e.target.value)}
            placeholder="https://example.thingsboard.cloud"
            className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm"
            dir="ltr"
            required
          />
        </div>
        <button
          type="submit"
          disabled={submitting}
          className="bg-[#0176FB] hover:bg-[#0176FB]/90 disabled:bg-gray-300 text-white text-xs font-bold py-2.5 px-4 rounded-lg transition-all flex items-center gap-2"
        >
          {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
          إضافة
        </button>
      </form>

      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          {instances.length === 0 ? (
            <div className="p-16 flex flex-col items-center text-slate-400">
              <CloudRain className="w-14 h-14 mb-3 opacity-20" />
              <p className="font-bold">لا توجد منصات مسجَّلة بعد</p>
            </div>
          ) : (
            <table className="w-full text-right text-sm whitespace-nowrap">
              <thead className="bg-slate-50/50 text-slate-500">
                <tr>
                  <th className="py-3 px-5 font-bold">المزوّد</th>
                  <th className="py-3 px-5 font-bold">origin</th>
                  <th className="py-3 px-5 font-bold">الاعتماد</th>
                  <th className="py-3 px-5 font-bold">التفعيل</th>
                  <th className="py-3 px-5 font-bold">أُضيفت</th>
                  <th className="py-3 px-5 font-bold">إجراءات</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {instances.map((inst) => (
                  <tr key={inst.id} className="hover:bg-slate-50/50 transition-colors">
                    <td className="py-3 px-5 font-bold text-slate-800">{inst.provider}</td>
                    <td className="py-3 px-5 text-slate-600" dir="ltr">{inst.origin}</td>
                    <td className="py-3 px-5">
                      {inst.is_approved ? (
                        <span className="flex items-center gap-1 text-[11px] font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full w-fit">
                          <CheckCircle2 className="w-3 h-3" /> معتمدة
                        </span>
                      ) : (
                        <span className="flex items-center gap-1 text-[11px] font-bold text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full w-fit">
                          <XCircle className="w-3 h-3" /> بانتظار الاعتماد
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-5 text-slate-600">{inst.is_active ? 'نشطة' : 'معطَّلة'}</td>
                    <td className="py-3 px-5 text-slate-500 text-xs">
                      {inst.created_at ? new Date(inst.created_at).toLocaleDateString('ar-SA', { calendar: 'gregory' }) : '—'}
                    </td>
                    <td className="py-3 px-5">
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => handleToggleApproved(inst)}
                          className="text-[11px] font-bold text-[#0176FB] hover:underline"
                        >
                          {inst.is_approved ? 'إلغاء الاعتماد' : 'اعتماد'}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleToggleActive(inst)}
                          className="text-[11px] font-bold text-slate-500 hover:underline"
                        >
                          {inst.is_active ? 'تعطيل' : 'تفعيل'}
                        </button>
                      </div>
                    </td>
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
