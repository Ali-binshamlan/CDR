import { defineConfig } from 'vitest/config';
import path from 'path';

// اختبارات DB الحقيقية (القسم 16/18.5 من "دليل الإصلاح الجذري لمنظومة
// مرقاب") — منفصلة تماماً عن vitest.config.ts (اختبارات الوحدة النقية بلا
// شبكة/قاعدة بيانات، تعمل دائماً بلا أي بنية تحتية). هذا الملف يتطلب مكدّس
// Supabase محلياً يعمل فعلياً (`supabase start`، يحتاج Docker) — راجع
// package.json script "test:db" الذي يشغّل `supabase db reset` (قاعدة
// فارغة، كل الـmigrations من الصفر) قبل استدعاء هذا الملف.
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
  test: {
    include: ['supabase/tests/**/*.dbtest.ts'],
    environment: 'node',
    // اختبارات DB حقيقية أبطأ من اختبارات الوحدة (شبكة محلية فعلية،
    // معاملات PostgreSQL) — مهلة أطول من الافتراضي.
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
