import type { Metadata } from "next";
import { Readex_Pro } from "next/font/google";
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
        {children}
      </body>
    </html>
  );
}
