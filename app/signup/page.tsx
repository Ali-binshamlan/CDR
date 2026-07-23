"use client";

import { useForm, FormProvider } from "react-hook-form";

import { yupResolver } from "@hookform/resolvers/yup";

import * as Yup from "yup";

import { motion, AnimatePresence } from "framer-motion";

import { useRouter } from "next/navigation";

import { useState, useEffect } from "react";
import { toast, Toaster } from "react-hot-toast";
import {
  User,
  Mail,
  Lock,
  TrendingUp,
  ArrowRight,
  ShieldCheck,
  CheckCircle,
  Hand,
  CloudSun,
  ChevronLeft,
  ChevronRight,
  Phone,
  Building2,
  Briefcase,
} from "lucide-react";

import Image from "next/image";

import Link from "next/link";

// --- تعريف البيانات ---

interface FormData {
  companyName: string;

  username: string;

  phoneNumber: string;

  email: string;

  password: string;

  confirmPassword: string;

  role: string;
}

// --- عناوين الخطوات ---

const stepsInfo = [
  { id: 1, title: "بيانات الشركة", subtitle: "عرفنا بمنشأتك" },

  { id: 2, title: "معلومات الحساب", subtitle: "تأمين حسابك" },

  { id: 3, title: "الدور الوظيفي", subtitle: "لمسات أخيرة" },
];

// --- الأدوار عند التسجيل ---

const roleOptions = [
  { value: "project_owner", label: "مالك مشروع" },
  { value: "project_manager", label: "مدير مشروع" },
  { value: "site_engineer", label: "مهندس موقع" },
  { value: "safety_officer", label: "مسؤول سلامة" },
  { value: "equipment_supervisor", label: "مشرف معدات" },
  { value: "consultant", label: "استشاري" },
  { value: "subcontractor", label: "مقاول فرعي" },
];

// --- Schemas ---

const step1Schema = Yup.object({
  companyName: Yup.string().required("اسم الشركة مطلوب"),

  username: Yup.string().required("اسم المستخدم مطلوب"),

  // (يجب أن يبدأ بـ 05 ويتكون من 10 أرقام)

  phoneNumber: Yup.string()

    .matches(/^05\d{8}$/, "صيغة رقم الجوال غير صحيحة (مثال: 05xxxxxxxx)")

    .required("رقم الجوال مطلوب"),
});

const step2Schema = Yup.object({
  email: Yup.string().email("البريد غير صالح").required("البريد مطلوب"),

  password: Yup.string()

    .min(8, "8 أحرف على الأقل")

    .required("كلمة المرور مطلوبة"),

  confirmPassword: Yup.string()

    .oneOf([Yup.ref("password")], "كلمات المرور غير متطابقة")

    .required("تأكيد كلمة المرور مطلوب"),
});

const step3Schema = Yup.object({
  role: Yup.string().required("الدور الوظيفي مطلوب"),
});

const combinedSchema = step1Schema.concat(step2Schema).concat(step3Schema);

export default function RegisterPage() {
  const router = useRouter();

  const [isClient, setIsClient] = useState(false);

  const [step, setStep] = useState(1);

  const [isSubmitting, setIsSubmitting] = useState(false);

  const totalSteps = 3;

  useEffect(() => {
    setIsClient(true);
  }, []);

  const methods = useForm<FormData>({
    resolver: yupResolver(combinedSchema),

    defaultValues: {
      companyName: "",

      username: "",

      phoneNumber: "",

      email: "",

      password: "",

      confirmPassword: "",

      role: "",
    },

    mode: "onChange",
  });

  const {
    register,

    handleSubmit,

    formState: { errors },

    trigger,

    watch,
  } = methods;

  const watchedFields = watch();

  const nextStep = async () => {
    let valid = false;

    if (step === 1)
      valid = await trigger(["companyName", "username", "phoneNumber"]);

    if (step === 2)
      valid = await trigger(["email", "password", "confirmPassword"]);

    if (step === 3) valid = await trigger(["role"]);

    if (valid) setStep((prev) => Math.min(prev + 1, totalSteps));
  };

  const prevStep = () => setStep((prev) => Math.max(prev - 1, 1));

 const onSubmit = async (data: FormData) => {
  setIsSubmitting(true);
  const loadingToast = toast.loading("جاري إنشاء حسابك...");

  try {
    const response = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || "فشل إنشاء الحساب");
    }

    toast.success(result.message || "تم إنشاء الحساب بنجاح!", {
      id: loadingToast,
      duration: 6000,
    });

    // التوجيه لصفحة تسجيل الدخول بعد ثانيتين بشكل طبيعي
    setTimeout(() => router.push("/login"), 2000);
  } catch (error: any) {
    // حالة الفشل
    toast.error(error.message || "حدث خطأ غير متوقع", {
      id: loadingToast,
    });
  } finally {
    setIsSubmitting(false);
  }
};

  return (
    <div
      className="min-h-screen flex items-center justify-center py-4 px-4 relative overflow-hidden bg-gray-50"
      dir="rtl"
    >
      {/* الخلفية العامة */}

      <Toaster position="top-center" reverseOrder={false} />
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 1 }}
          className="absolute -top-40 -left-40 w-96 h-96 bg-teal-500/10 rounded-full blur-3xl"
        />

        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 1, delay: 0.2 }}
          className="absolute -bottom-40 -right-40 w-96 h-96 bg-blue-500/10 rounded-full blur-3xl"
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

            {/* 1. القسم الأيمن: النموذج (متعدد الخطوات) */}

            {/* ================================================= */}

            <div className="w-full md:w-1/2 px-8 py-8 md:px-16 md:py-10 bg-white relative flex flex-col justify-between">
              {/* Header & Stepper */}

             <div className="relative">
  <div className="text-center mb-8 mt-6">
    <div className="flex items-center justify-center gap-3 mb-2">
      <h2 className="text-3xl font-black text-gray-900">حساب جديد</h2>
      <Hand className="w-6 h-6 text-yellow-500 fill-yellow-100" />
    </div>

    <p className="text-gray-500 text-sm">
        DCR — الامتثال التنظيمي للغبار بقرارات دقيقة
    </p>
  </div>

  {/* === شريط التقدم المطور (Beautiful Stepper) === */}
 <div className="mb-10">
  <div className="flex justify-between items-end mb-2 px-1">
    <motion.div
      key={step}
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      className="flex flex-col items-start"
    >
      <span className="text-xs font-bold text-[#0176FB] bg-[#fb8801]/10 px-2 py-1 rounded-md mb-1">
        الخطوة {step} من {totalSteps}
      </span>

      <span className="text-lg font-bold text-gray-800">
        {stepsInfo[step - 1].title}
      </span>
    </motion.div>

    <span className="text-xs text-gray-400 font-medium pb-1">
      {stepsInfo[step - 1].subtitle}
    </span>
  </div>

  {/* خلفية الشريط */}
  <div className="h-2 w-full bg-gray-100 rounded-full overflow-hidden flex">
    <motion.div
      className="h-full bg-gradient-to-r from-[#0176FB] to-[#0337a7]"
      initial={{ width: `${((step - 1) / totalSteps) * 100}%` }}
      animate={{ width: `${(step / totalSteps) * 100}%` }}
      transition={{ duration: 0.6, ease: "easeInOut" }}
    />
  </div>

  {/* النقاط السفلية (Dots) */}
  <div className="flex gap-2 mt-2 justify-end">
    {[1, 2, 3].map((i) => (
      <div
        key={i}
        className={`h-1.5 rounded-full transition-all duration-300 ${
          i <= step ? "w-6 bg-[#0176FB]" : "w-1.5 bg-gray-200"
        }`}
      ></div>
    ))}
  </div>
</div>
</div>

              {/* Form Content */}

              <div className="flex-1 flex flex-col justify-start">
                <AnimatePresence mode="wait">
                  {/* === الخطوة 1: بيانات الشركة === */}

                  {step === 1 && (
                    <motion.div
                      key="step1"
                      initial={{ opacity: 0, x: 20 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: -20 }}
                      transition={{ duration: 0.3 }}
                      className="space-y-5"
                    >
                      <div className="space-y-2">
                        <label className="text-sm font-bold text-gray-700">
                          اسم الشركة
                        </label>

                        <div className="relative group">
                          <input
                            {...register("companyName")}
                      className="w-full px-5 py-4 pr-12 rounded-2xl bg-gray-50 border-2 border-transparent focus:bg-white focus:border-[#fb8801] transition-all outline-none font-medium text-gray-900"
                            placeholder="مثال: شركة المقاولات المتحدة"
                          />

                          <Building2 className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-400 group-focus-within:text-teal-500 transition-colors w-5 h-5" />
                        </div>

                        {errors.companyName && (
                          <p className="text-red-500 text-xs font-bold px-1 mt-1">
                            {errors.companyName.message}
                          </p>
                        )}
                      </div>

                      <div className="space-y-2">
                        <label className="text-sm font-bold text-gray-700">
                          اسم المستخدم
                        </label>

                        <div className="relative group">
                          <input
                            {...register("username")}
                      className="w-full px-5 py-4 pr-12 rounded-2xl bg-gray-50 border-2 border-transparent focus:bg-white focus:border-[#fb8801] transition-all outline-none font-medium text-gray-900"
                            placeholder="مثال: mohammed.alharbi"
                          />

                          <User className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-400 group-focus-within:text-teal-500 transition-colors w-5 h-5" />
                        </div>

                        {errors.username && (
                          <p className="text-red-500 text-xs font-bold px-1 mt-1">
                            {errors.username.message}
                          </p>
                        )}
                      </div>

                      <div className="space-y-2">
                        <label className="text-sm font-bold text-gray-700">
                          رقم الجوال
                        </label>

                        <div className="relative group">
                          <input
                            {...register("phoneNumber")}
                            type="tel"
                      className="w-full px-5 py-4 pr-12 rounded-2xl bg-gray-50 border-2 border-transparent focus:bg-white focus:border-[#fb8801] transition-all outline-none font-medium text-gray-900"
                            placeholder="مثال: 0501234567"
                          />

                          <Phone className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-400 group-focus-within:text-teal-500 transition-colors w-5 h-5" />
                        </div>

                        {errors.phoneNumber && (
                          <p className="text-red-500 text-xs font-bold px-1 mt-1">
                            {errors.phoneNumber.message}
                          </p>
                        )}
                      </div>
                    </motion.div>
                  )}

                  {/* === الخطوة 2: الحساب === */}

                  {step === 2 && (
                    <motion.div
                      key="step2"
                      initial={{ opacity: 0, x: 20 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: -20 }}
                      transition={{ duration: 0.3 }}
                      className="space-y-5"
                    >
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

                          <Mail className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-400 group-focus-within:text-teal-500 transition-colors w-5 h-5" />
                        </div>

                        {errors.email && (
                          <p className="text-red-500 text-xs font-bold px-1 mt-1">
                            {errors.email.message}
                          </p>
                        )}
                      </div>

                      <div className="space-y-2">
                        <label className="text-sm font-bold text-gray-700">
                          كلمة المرور
                        </label>

                        <div className="relative group">
                          <input
                            {...register("password")}
                            type="password"
                      className="w-full px-5 py-4 pr-12 rounded-2xl bg-gray-50 border-2 border-transparent focus:bg-white focus:border-[#fb8801] transition-all outline-none font-medium text-gray-900"
                            placeholder="••••••••"
                          />

                          <Lock className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-400 group-focus-within:text-teal-500 transition-colors w-5 h-5" />
                        </div>

                        {errors.password && (
                          <p className="text-red-500 text-xs font-bold px-1 mt-1">
                            {errors.password.message}
                          </p>
                        )}
                      </div>

                      <div className="space-y-2">
                        <label className="text-sm font-bold text-gray-700">
                          تأكيد كلمة المرور
                        </label>

                        <div className="relative group">
                          <input
                            {...register("confirmPassword")}
                            type="password"
                      className="w-full px-5 py-4 pr-12 rounded-2xl bg-gray-50 border-2 border-transparent focus:bg-white focus:border-[#fb8801] transition-all outline-none font-medium text-gray-900"
                            placeholder="••••••••"
                          />

                          <Lock className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-400 group-focus-within:text-teal-500 transition-colors w-5 h-5" />
                        </div>

                        {errors.confirmPassword && (
                          <p className="text-red-500 text-xs font-bold px-1 mt-1">
                            {errors.confirmPassword.message}
                          </p>
                        )}
                      </div>
                    </motion.div>
                  )}

                  {/* === الخطوة 3: الدور الوظيفي === */}

                  {step === 3 && (
                    <motion.div
                      key="step3"
                      initial={{ opacity: 0, x: 20 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: -20 }}
                      transition={{ duration: 0.3 }}
                      className="space-y-5"
                    >
                      <div className="space-y-2">
                        <label className="text-sm font-bold text-gray-700">
                          الدور الوظيفي
                        </label>

                        <div className="grid grid-cols-2 gap-3">
                          {roleOptions.map((option) => (
                            <label
                              key={option.value}
                              className={`relative flex items-center gap-2 p-4 rounded-2xl border-2 cursor-pointer transition-all duration-200 ${
                                watchedFields.role === option.value
                                  ? "border-teal-500 bg-teal-50/50 text-teal-700 shadow-sm"
                                  : "border-gray-100 bg-gray-50 text-gray-500 hover:bg-white hover:border-gray-200"
                              }`}
                            >
                              <input
                                type="radio"
                                {...register("role")}
                                value={option.value}
                                className="sr-only"
                              />

                              <Briefcase className="w-4 h-4 shrink-0" />

                              <span className="text-xs font-bold">
                                {option.label}
                              </span>

                              {watchedFields.role === option.value && (
                                <motion.div
                                  layoutId="check"
                                  className="absolute top-2 left-2"
                                >
                                  <CheckCircle className="w-4 h-4 text-teal-500" />
                                </motion.div>
                              )}
                            </label>
                          ))}
                        </div>

                        {errors.role && (
                          <p className="text-red-500 text-xs font-bold px-1 mt-1">
                            {errors.role.message}
                          </p>
                        )}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              {/* Navigation Buttons */}

              <div className="mt-auto pt-8">
                <div className="flex justify-between gap-4">
                  {/* زر الرجوع */}

                  <button
                    type="button"
                    onClick={prevStep}
                    disabled={step === 1}
                    className={`flex-1 py-4 rounded-2xl border-2 font-bold transition-all flex items-center justify-center gap-2

                        ${
                          step === 1
                            ? "border-transparent text-gray-300 cursor-not-allowed"
                            : "border-gray-100 text-gray-600 hover:bg-gray-50 hover:border-gray-200"
                        }`}
                  >
                    <ChevronRight className="w-5 h-5" /> رجوع
                  </button>

                  {/* زر التالي / الإرسال */}

                  <motion.button
                    type={step === totalSteps ? "submit" : "button"}
                    onClick={step === totalSteps ? undefined : nextStep}
                    disabled={isSubmitting}
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.98 }}
                   className="flex-[2] py-4 rounded-2xl bg-gradient-to-r from-[#0197FB] to-[#0337a7] text-white font-bold shadow-xl shadow-[#0176FB]/20 hover:shadow-[#0176FB]/30 flex items-center justify-center gap-2 transition-all disabled:opacity-70"
                  >
                    {step === totalSteps ? (
                      isSubmitting ? (
                        <>
                          جاري الإنشاء...{" "}
                          <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                        </>
                      ) : (
                        <>
                          إتمام التسجيل <CheckCircle className="w-5 h-5" />
                        </>
                      )
                    ) : (
                      <>
                        التالي <ChevronLeft className="w-5 h-5" />
                      </>
                    )}
                  </motion.button>
                </div>

                <div className="mt-6 text-center text-sm text-gray-500">
                  لديك حساب بالفعل؟{" "}
                  <Link
                    href="/login"
                    className="text-[#0176FB] font-bold hover:text-[#0176FB] hover:underline"
                  >
                    تسجيل الدخول
                  </Link>
                </div>
              </div>
            </div>

            {/* ================================================= */}

            {/* 2. القسم الأيسر: الصورة والجماليات (مطابق لصفحة الدخول) */}

            {/* ================================================= */}

            <div className="hidden md:flex w-1/2 relative overflow-hidden items-center justify-center">
                          {/* صورة الخلفية */}
                          <div className="absolute inset-0 w-full h-full">
                            <Image
                              src="/images/Mirqab_bak.png"
                              alt="Login Background"
                              fill
                              className="object-cover"
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
