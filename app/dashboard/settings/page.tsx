"use client";

import { useForm, FormProvider } from "react-hook-form";
import { yupResolver } from "@hookform/resolvers/yup";
import * as Yup from "yup";
import { useState, useEffect } from "react";
import { toast, Toaster } from "react-hot-toast";
import { apiClient } from "@/app/lib/apiClient";
import {
  User,
  Mail,
  ArrowRight,
  CheckCircle,
  Phone,
  Building2,
  Briefcase,
  Save,
  Camera,
} from "lucide-react";
import Link from "next/link";

// --- تعريف البيانات ---
interface ProfileFormData {
  companyName: string;
  username: string;
  phoneNumber: string;
  email: string;
  role: string;
}

// --- الأدوار الوظيفية ---
const roleOptions = [
  { value: "project_owner", label: "مالك مشروع" },
  { value: "project_manager", label: "مدير مشروع" },
  { value: "site_engineer", label: "مهندس موقع" },
  { value: "safety_officer", label: "مسؤول سلامة" },
  { value: "equipment_supervisor", label: "مشرف معدات" },
  { value: "consultant", label: "استشاري" },
  { value: "subcontractor", label: "مقاول فرعي" },
];

// --- Schema ---
const editProfileSchema = Yup.object({
  companyName: Yup.string().required("اسم الشركة مطلوب"),
  username: Yup.string().required("اسم المستخدم مطلوب"),
  phoneNumber: Yup.string()
    .matches(/^05\d{8}$/, "صيغة رقم الجوال غير صحيحة (مثال: 05xxxxxxxx)")
    .required("رقم الجوال مطلوب"),
  email: Yup.string().email("البريد غير صالح").required("البريد مطلوب"),
  role: Yup.string().required("الدور الوظيفي مطلوب"),
});

export default function SettingsProfilePage() {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isLoadingData, setIsLoadingData] = useState(true);

  const methods = useForm<ProfileFormData>({
    resolver: yupResolver(editProfileSchema),
    defaultValues: {
      companyName: "",
      username: "",
      phoneNumber: "",
      email: "",
      role: "",
    },
    mode: "onChange",
  });

  const {
    register,
    handleSubmit,
    formState: { errors, isDirty },
    reset,
    watch,
  } = methods;

  const watchedFields = watch();

  // جلب بيانات المستخدم الفعلية من profiles (+ البريد من نظام المصادقة)
  useEffect(() => {
    const fetchUserData = async () => {
      try {
        const { data: resp } = await apiClient.get('/profile');
        const p = resp?.data || {};
        reset({
          companyName: p.company_name || '',
          username: p.username || '',
          phoneNumber: p.phone_number || '',
          email: p.email || '',
          role: p.role || '',
        });
      } catch (error) {
        toast.error("فشل في جلب بيانات الحساب");
      } finally {
        setIsLoadingData(false);
      }
    };

    fetchUserData();
  }, [reset]);

  const onSubmit = async (data: ProfileFormData) => {
    setIsSubmitting(true);
    const loadingToast = toast.loading("جاري حفظ التعديلات...");

    try {
      await apiClient.patch('/profile', {
        companyName: data.companyName,
        username: data.username,
        phoneNumber: data.phoneNumber,
        role: data.role,
      });

      toast.success("تم تحديث بياناتك بنجاح!", {
        id: loadingToast,
        duration: 4000,
      });

      // إعادة ضبط حالة isDirty بعد الحفظ
      reset(data);

    } catch (error: any) {
      toast.error(error?.response?.data?.error || error.message || "حدث خطأ أثناء الحفظ", {
        id: loadingToast,
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isLoadingData) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50" dir="rtl">
        <div className="w-8 h-8 border-4 border-[#0176FB]/30 border-t-[#0176FB] rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F8FAFC] py-8 px-4 sm:px-6 lg:px-8 font-sans" dir="rtl">
      <Toaster position="top-center" />

      <div className="max-w-4xl mx-auto">
        {/* رأس الصفحة */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">إعدادات الحساب</h1>
            <p className="text-sm text-gray-500 mt-1">إدارة معلوماتك الشخصية وبيانات التواصل الخاصة بك.</p>
          </div>
          <Link
            href="/dashboard"
            className="flex items-center gap-2 text-sm font-medium text-gray-500 hover:text-gray-900 transition-colors bg-white px-4 py-2 rounded-lg border shadow-sm"
          >
            <ArrowRight className="w-4 h-4" />
            العودة للوحة التحكم
          </Link>
        </div>

        <FormProvider {...methods}>
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">

            {/* البطاقة 1: الصورة الشخصية */}
            <div className="bg-white p-6 md:p-8 rounded-2xl shadow-sm border border-gray-100 flex items-center gap-6">
              <div className="relative">
                <div className="w-24 h-24 rounded-full bg-gradient-to-tr from-[#0176FB] to-[#0337a7] flex items-center justify-center text-white text-3xl font-bold">
                  {watchedFields.username ? watchedFields.username.charAt(0).toUpperCase() : "D"}
                </div>
                <button type="button" className="absolute bottom-0 right-0 p-2 bg-white rounded-full border border-gray-200 shadow-sm text-gray-600 hover:text-[#0176FB] transition-colors">
                  <Camera className="w-4 h-4" />
                </button>
              </div>
              <div>
                <h3 className="text-lg font-bold text-gray-900">الصورة الشخصية</h3>
                <p className="text-sm text-gray-500 mt-1 mb-3">يفضل أن تكون الصورة بصيغة PNG أو JPG وبحجم لا يتجاوز 2MB.</p>
                <div className="flex gap-3">
                  <button type="button" className="text-sm font-medium px-4 py-2 bg-gray-50 border border-gray-200 rounded-lg hover:bg-gray-100 transition-colors">تغيير الصورة</button>
                  <button type="button" className="text-sm font-medium px-4 py-2 text-red-600 hover:bg-red-50 rounded-lg transition-colors">حذف</button>
                </div>
              </div>
            </div>

            {/* البطاقة 2: المعلومات الأساسية */}
            <div className="bg-white p-6 md:p-8 rounded-2xl shadow-sm border border-gray-100">
              <h3 className="text-lg font-bold text-gray-900 mb-6 border-b pb-4">المعلومات الأساسية</h3>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="space-y-2">
                  <label className="text-sm font-medium text-gray-700">اسم الشركة</label>
                  <div className="relative">
                    <Building2 className="absolute right-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                    <input
                      {...register("companyName")}
                      className="w-full pl-4 pr-10 py-2.5 rounded-xl border border-gray-200 bg-gray-50 focus:bg-white focus:border-[#0176FB] focus:ring-2 focus:ring-[#0176FB]/20 transition-all outline-none text-gray-900"
                    />
                  </div>
                  {errors.companyName && <p className="text-red-500 text-xs mt-1">{errors.companyName.message}</p>}
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium text-gray-700">اسم المستخدم</label>
                  <div className="relative">
                    <User className="absolute right-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                    <input
                      {...register("username")}
                      className="w-full pl-4 pr-10 py-2.5 rounded-xl border border-gray-200 bg-gray-50 focus:bg-white focus:border-[#0176FB] focus:ring-2 focus:ring-[#0176FB]/20 transition-all outline-none text-gray-900"
                    />
                  </div>
                  {errors.username && <p className="text-red-500 text-xs mt-1">{errors.username.message}</p>}
                </div>
              </div>
            </div>

            {/* البطاقة 3: معلومات التواصل */}
            <div className="bg-white p-6 md:p-8 rounded-2xl shadow-sm border border-gray-100">
              <h3 className="text-lg font-bold text-gray-900 mb-6 border-b pb-4">معلومات التواصل</h3>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="space-y-2">
                  <label className="text-sm font-medium text-gray-700">البريد الإلكتروني</label>
                  <div className="relative">
                    <Mail className="absolute right-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                    <input
                      {...register("email")}
                      type="email"
                      readOnly
                      className="w-full pl-4 pr-10 py-2.5 rounded-xl border border-gray-200 bg-gray-100 text-gray-500 cursor-not-allowed outline-none text-left"
                      dir="ltr"
                    />
                  </div>
                  <p className="text-gray-400 text-xs mt-1">لا يمكن تعديل البريد من هنا (يتطلب تأكيداً منفصلاً).</p>
                  {errors.email && <p className="text-red-500 text-xs mt-1">{errors.email.message}</p>}
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium text-gray-700">رقم الجوال</label>
                  <div className="relative">
                    <Phone className="absolute right-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                    <input
                      {...register("phoneNumber")}
                      type="tel"
                      className="w-full pl-4 pr-10 py-2.5 rounded-xl border border-gray-200 bg-gray-50 focus:bg-white focus:border-[#0176FB] focus:ring-2 focus:ring-[#0176FB]/20 transition-all outline-none text-gray-900 text-left"
                      dir="ltr"
                    />
                  </div>
                  {errors.phoneNumber && <p className="text-red-500 text-xs mt-1">{errors.phoneNumber.message}</p>}
                </div>
              </div>
            </div>

            {/* البطاقة 4: الدور الوظيفي */}
            <div className="bg-white p-6 md:p-8 rounded-2xl shadow-sm border border-gray-100">
              <h3 className="text-lg font-bold text-gray-900 mb-6 border-b pb-4">الدور الوظيفي</h3>

              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
                {roleOptions.map((option) => (
                  <label
                    key={option.value}
                    className={`relative flex flex-col items-center justify-center p-4 rounded-xl border cursor-pointer transition-all duration-200 text-center gap-2 ${
                      watchedFields.role === option.value
                        ? "border-[#0176FB] bg-[#0176FB]/5 text-[#0176FB]"
                        : "border-gray-200 bg-gray-50 text-gray-600 hover:bg-white hover:border-gray-300"
                    }`}
                  >
                    <input type="radio" {...register("role")} value={option.value} className="sr-only" />
                    <Briefcase className={`w-5 h-5 ${watchedFields.role === option.value ? "text-[#0176FB]" : "text-gray-400"}`} />
                    <span className="text-xs font-semibold">{option.label}</span>
                    {watchedFields.role === option.value && (
                      <CheckCircle className="absolute top-2 right-2 w-4 h-4 text-[#0176FB]" />
                    )}
                  </label>
                ))}
              </div>
              {errors.role && <p className="text-red-500 text-xs mt-2">{errors.role.message}</p>}
            </div>

            {/* شريط الإجراءات (حفظ / إلغاء) */}
            <div className="flex items-center justify-end gap-4 pt-4">
              <Link
                href="/dashboard"
                className="px-6 py-2.5 text-sm font-bold text-gray-600 bg-white border border-gray-200 rounded-xl hover:bg-gray-50 transition-colors"
              >
                إلغاء
              </Link>
              <button
                type="submit"
                disabled={!isDirty || isSubmitting}
                className="flex items-center gap-2 px-8 py-2.5 text-sm font-bold text-white bg-[#0176FB] rounded-xl hover:bg-[#0337a7] transition-colors disabled:opacity-50 disabled:cursor-not-allowed shadow-md shadow-[#0176FB]/20"
              >
                {isSubmitting ? (
                  <>
                    <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    جاري الحفظ...
                  </>
                ) : (
                  <>
                    <Save className="w-4 h-4" />
                    حفظ التعديلات
                  </>
                )}
              </button>
            </div>

          </form>
        </FormProvider>
      </div>
    </div>
  );
}
