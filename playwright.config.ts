import { defineConfig, devices } from '@playwright/test';

// اختبارات E2E — القسم 19 من "دليل الإصلاح الجذري لمنظومة مرقاب"
// (package.json script "test:e2e"). تشغّل خادم Next.js حقيقياً (build+start
// عبر webServer أدناه) وتتصفّح صفحات فعلية بمتصفح حقيقي (Chromium)، لا
// mock DOM. تُغطّى هنا المسارات العامة القابلة للاختبار بلا حساب مستخدم
// حقيقي مُعدّ مسبقاً (تسجيل الدخول/التسجيل/التنقّل العام).
//
// مشروع 'setup' (طلب مستخدم صريح — "التحقق النهائي": اختبار PM10/الأجهزة/
// Downwind الفعلي، كلها خلف لوحة تحكم محمية): auth.setup.ts ينشئ مستخدماً
// ومشروعاً حقيقيين عبر service_role (يتطلب Supabase محلياً — `supabase
// start`) ويسجّل الدخول فعلياً، فتعتمد عليه specs الأخرى (pm10-downwind.
// spec.ts) عبر dependencies — لا تُشغَّل بمعزل عنه أبداً.
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://127.0.0.1:3100',
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    { name: 'chromium', use: { ...devices['Desktop Chrome'] }, dependencies: ['setup'], testIgnore: /auth\.setup\.ts/ },
  ],
  // خادم حقيقي (production build) — لا `next dev` (أبطأ، وسلوك مختلف طفيفاً
  // عن الإنتاج الفعلي). يفترض `npm run build` نُفِّذ مسبقاً في نفس تشغيلة
  // CI (راجع "verify" script — يُشغَّل بعد test:e2e حالياً، فهذا webServer
  // يبني نسخته الخاصة أولاً عبر أمر start المسبوق بـbuild ضمنياً هنا).
  webServer: {
    command: 'npm run build && npm run start -- -p 3100',
    url: 'http://127.0.0.1:3100',
    reuseExistingServer: !process.env.CI,
    timeout: 180000,
  },
});
