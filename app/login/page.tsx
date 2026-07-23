"use client";

import { useForm, FormProvider } from "react-hook-form";
import { yupResolver } from "@hookform/resolvers/yup";
import * as Yup from "yup";
import { motion } from "framer-motion";
import { useRouter } from "next/navigation";
import { useState, useEffect } from "react";
import { toast, Toaster } from "react-hot-toast";
import { supabase } from '@/app/lib/supabase';
import {
  Mail,
  Lock,
  TrendingUp,
  ArrowRight,
  ShieldCheck,
  CloudSun,
  LogIn,
} from "lucide-react";
import Image from "next/image";
import Link from "next/link";

// --- تعريف البيانات ---
interface LoginFormData {
  email: string;
  password: string;
}

// --- Schema ---
const loginSchema = Yup.object({
  email: Yup.string().email("البريد غير صالح").required("البريد مطلوب"),
  password: Yup.string().required("كلمة المرور مطلوبة"),
});

export default function LoginPage() {
  const router = useRouter();
  const [isClient, setIsClient] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    setIsClient(true);
  }, []);

  const methods = useForm<LoginFormData>({
    resolver: yupResolver(loginSchema),
    defaultValues: {
      email: "",
      password: "",
    },
    mode: "onChange",
  });

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = methods;

const onSubmit = async (data: LoginFormData) => {
  setIsSubmitting(true);
  const loadingToast = toast.loading("جاري تسجيل الدخول...");

  try {
    // تسجيل الدخول مباشرة من المتصفح لضمان حفظ الجلسة
    const { data: authData, error } = await supabase.auth.signInWithPassword({
      email: data.email,
      password: data.password,
    });

    if (error) {
      const errorMessage = error.message.includes('Invalid login credentials')
        ? 'بيانات الدخول غير صحيحة، تأكد من البريد وكلمة المرور'
        : error.message;
      throw new Error(errorMessage);
    }

    // حالة النجاح
    toast.success("مرحباً بك مجدداً! جاري التوجيه...", {
      id: loadingToast,
      duration: 2000,
    });

    // توجيه المستخدم للداشبورد
    setTimeout(() => router.push("/dashboard"), 1000);

  } catch (error: any) {
    // إظهار رسالة الخطأ
    toast.error(error.message || "حدث خطأ غير متوقع", {
      id: loadingToast,
    });
  } finally {
    setIsSubmitting(false);
  }
};
  if (!isClient) return null;

  return (
    <div
      className="min-h-screen flex items-center justify-center py-4 px-4 relative overflow-hidden bg-gray-50"
      dir="rtl"
    >
      <Toaster position="top-center" reverseOrder={false} />

      {/* الخلفية العامة */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 1 }}
          className="absolute -top-40 -left-40 w-96 h-96 bg-[#fb8801]/10 rounded-full blur-3xl"
        />
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 1, delay: 0.2 }}
          className="absolute -bottom-40 -right-40 w-96 h-96 bg-[#0337a7]/10 rounded-full blur-3xl"
        />
      </div>

      <FormProvider {...methods}>
        <motion.form
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
          onSubmit={handleSubmit(onSubmit)}
          className="w-full max-w-5xl flex relative z-10 h-auto my-8"
        >
          <div className="w-full bg-white rounded-[2.5rem] shadow-2xl shadow-gray-200/50 overflow-hidden flex flex-col md:flex-row border border-white">

            {/* ================================================= */}
            {/* 1. القسم الأيمن: نموذج تسجيل الدخول */}
            {/* ================================================= */}
            <div className="w-full md:w-1/2 px-8 py-10 md:px-16 md:py-16 bg-white relative flex flex-col justify-center">

              <div className="relative mb-10">
                <div className="text-center mt-4">
                  <div className="flex items-center justify-center gap-3 mb-3">
                    <h2 className="text-3xl font-black text-gray-900">مرحباً بعودتك</h2>
                  </div>
                  <p className="text-gray-500 text-sm">
                    سجل دخولك لمتابعة الامتثال التنظيمي لمشروعك
                  </p>
                </div>
              </div>

              {/* حقول الإدخال */}
              <div className="space-y-6 flex-1">
                {/* حقل البريد الإلكتروني */}
                <div className="space-y-2">
                  <label className="text-sm font-bold text-gray-700">
                    البريد الإلكتروني
                  </label>
                  <div className="relative group">
                    <input
                      {...register("email")}
                      type="email"
                      className="w-full px-5 py-4 pr-12 rounded-2xl bg-gray-50 border-2 border-transparent focus:bg-white focus:border-[#fb8801] transition-all outline-none font-medium text-gray-900"
                      placeholder="name@example.com"
                    />
                    <Mail className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-400 group-focus-within:text-[#fb8801] transition-colors w-5 h-5" />
                  </div>
                  {errors.email && (
                    <p className="text-red-500 text-xs font-bold px-1 mt-1">
                      {errors.email.message}
                    </p>
                  )}
                </div>

                {/* حقل كلمة المرور */}
                <div className="space-y-2">
                  <div className="flex justify-between items-center">
                    <label className="text-sm font-bold text-gray-700">
                      كلمة المرور
                    </label>
                  </div>
                  <div className="relative group">
                    <input
                      {...register("password")}
                      type="password"
                      className="w-full px-5 py-4 pr-12 rounded-2xl bg-gray-50 border-2 border-transparent focus:bg-white focus:border-[#fb8801] transition-all outline-none font-medium text-gray-900"
                      placeholder="••••••••"
                    />
                    <Lock className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-400 group-focus-within:text-[#fb8801] transition-colors w-5 h-5" />
                  </div>
                  {errors.password && (
                    <p className="text-red-500 text-xs font-bold px-1 mt-1">
                      {errors.password.message}
                    </p>
                  )}
                </div>
              </div>

              {/* أزرار الإرسال */}
              <div className="mt-10">
                <motion.button
                  type="submit"
                  disabled={isSubmitting}
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  className="w-full py-4 rounded-2xl bg-gradient-to-r from-[#0165FB] to-[#0337a7] text-white font-bold shadow-xl shadow-[#EEE2D4]/20 hover:shadow-[#DAD3CC]/30 flex items-center justify-center gap-2 transition-all disabled:opacity-70"
                >
                  {isSubmitting ? (
                    <>
                      جاري الدخول...{" "}
                      <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    </>
                  ) : (
                    <>
                      تسجيل الدخول <LogIn className="w-5 h-5 mr-1" />
                    </>
                  )}
                </motion.button>

                <div className="mt-8 text-center text-sm text-gray-500">
                  ليس لديك حساب؟{" "}
                  <Link
                    href="/signup"
                    className="text-[#0176FB] font-bold hover:text-[#0176FB] hover:underline"
                  >
                    إنشاء حساب جديد
                  </Link>
                </div>
              </div>
            </div>

            {/* ================================================= */}
            {/* 2. القسم الأيسر: الصورة والجماليات */}
            {/* ================================================= */}
            <div className="hidden md:flex w-1/2 relative overflow-hidden items-center justify-center">
              {/* صورة الخلفية */}
              <div className="absolute inset-0 w-full h-full bg-blue-900">
                <Image
                  src="/images/Mirqab_bak.png"
                  alt="Login Background"
                  fill
                  className="object-cover opacity-80"
                  priority
                />
              </div>

              {/* الطبقة اللونية المتدرجة (Overlay) */}
              <div className="absolute inset-0 bg-gradient-to-t from-[#0337a7]/90 via-[#0337a7]/60 to-transparent mix-blend-multiply"></div>
              <div className="absolute inset-0 bg-gradient-to-b from-transparent to-black/70"></div>

              {/* النصوص (Floating Content) */}
              <div className="relative z-10 p-12 text-center text-white max-w-lg">
                <motion.div
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.4, duration: 0.8 }}
                >
                  <div className="w-16 h-16 mx-auto bg-white/10 backdrop-blur-md rounded-2xl flex items-center justify-center mb-6 border border-white/20 shadow-xl">
                    <CloudSun className="w-8 h-8 text-[#fb8801]" />
                  </div>

                  <h2 className="text-4xl sm:text-5xl font-black mb-2 leading-tight drop-shadow-lg">
                    الامتثال التنظيمي <br />
                    <span className="text-transparent bg-clip-text bg-gradient-to-r from-[#fb8801] to-[#ffb766]">
                      للغبار
                    </span>
                  </h2>

                  <h3 className="text-xl font-bold text-blue-100 mb-6 drop-shadow-md">
                    قرارات دقيقة لقابلية تنفيذ أنشطتك
                  </h3>

                  <p className="text-blue-50 text-lg leading-relaxed font-medium drop-shadow-md mb-8">
                    تحلل DCR مؤشرات الغبار والامتثال التنظيمي في موقع مشروعك وتحولها إلى توصيات وتنبيهات تساعد على رفع الامتثال والسلامة وتقليل التوقفات.
                  </p>

                  <div className="flex justify-center gap-4 text-sm font-semibold text-blue-100">
                    <div className="flex items-center gap-2 bg-white/10 px-4 py-2 rounded-full backdrop-blur-sm border border-white/10">
                      <ShieldCheck className="w-4 h-4" />{" "}
                      <span>امتثال أعلى</span>
                    </div>

                    <div className="flex items-center gap-2 bg-white/10 px-4 py-2 rounded-full backdrop-blur-sm border border-white/10">
                      <TrendingUp className="w-4 h-4" /> <span>كفاءة أفضل</span>
                    </div>
                  </div>
                </motion.div>
              </div>
            </div>
          </div>
        </motion.form>
      </FormProvider>
    </div>
  );
}
