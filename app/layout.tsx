import type { Metadata } from "next";
import { Readex_Pro } from "next/font/google";
import { Toaster } from "react-hot-toast";
import "./globals.css";

// استدعاء الخط وتحديده للغة العربية
const readexPro = Readex_Pro({
  subsets: ["arabic"],
  weight: ['300', '400', '500', '600', '700'],
  variable: '--font-readex'
});

export const metadata: Metadata = {
  title: "DCR | الامتثال التنظيمي للغبار",
  description: "منصة إدارة الامتثال التنظيمي للغبار ومؤشر قابلية تنفيذ الأنشطة.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    // تحديد اتجاه النص RTL
    <html lang="ar" dir="rtl">
      <body className={`${readexPro.className} bg-slate-50 text-slate-900 antialiased`}>
        {/* خطأ واجهة مكتشَف ومُصلَح (طلب صريح من المستخدم — "لا يوجد Toaster
            عام؛ بعض أسباب منع الحفظ لا تظهر للمستخدم"): كل صفحة كانت تركّب
            <Toaster /> بنفسها محلياً (signup/login/dashboard/settings فقط) —
            6 من أصل 9 مواضع toast.* في المشروع (AddActivityModal، Projects/
            create، dashboard/schedule، Projects/[id] عبر ProjectHeader،
            admin/rules، admin/provider-instances) لم تكن تملك أي Toaster في
            شجرتها إطلاقاً، فرسائل toast.error/success (بما فيها أسباب منع
            الحفظ التفصيلية — موقع غير محدَّد، وردية غير مختارة، فشل فحص
            مسافة كسارة/محطة خلط، إلخ) لا تظهر للمستخدم بصمت تام. Toaster
            واحد عام هنا يغطي كل صفحة حالية ومستقبلية — أُزيلت كل التركيبات
            المحلية الأربعة لتفادي عرض toast مضاعف. */}
        <Toaster position="top-center" reverseOrder={false} />
        {children}
      </body>
    </html>
  );
}
