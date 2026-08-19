import { test as setup, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { createTestSupabaseAdmin } from '../supabase/tests/dbTestClient';
import { E2E_FIXTURE_PATH, E2E_AUTH_STATE_PATH } from './fixturePaths';

// طلب مستخدم صريح ("التحقق النهائي"): إعداد جلسة مصادَقة حقيقية لاختبارات
// E2E التي تحتاج لوحة تحكم (PM10/الأجهزة/Downwind — كلها خلف /dashboard/
// Projects/[id])، غير موجود مسبقاً في هذا المشروع (public-pages.spec.ts
// وحده لا يحتاج جلسة إطلاقاً). ينشئ مستخدم اختبار حقيقياً عبر عميل
// service_role (نفس نمط supabase/tests/concurrency.dbtest.ts:createUser)
// على نفس مكدّس Supabase المحلي (supabase start)، لا حساب سحابي حقيقي —
// يتطلب Docker/`supabase start` قيد التشغيل فعلياً وقت تنفيذ هذا الملف،
// تماماً كما تتطلبه اختبارات DB (npm run test:db). غير مُشغَّل بعد في هذه
// الجلسة (Docker متوقف وقت الكتابة) — راجع e2e/pm10-downwind.spec.ts
// للسيناريوهات التي تستهلك هذه الجلسة.
//
// يكتب بيانات الاعتماد + معرّف المشروع المُنشأ لملف JSON محلي (خارج git،
// راجع .gitignore) تقرأه specs أخرى عبر E2E_FIXTURE_PATH — بديل عن متغيرات
// بيئة E2E_TEST_EMAIL/E2E_TEST_PASSWORD الثابتة (غير مناسبة هنا: كل تشغيلة
// تحتاج مشروعاً/أجهزة جديدة نظيفة لا تتراكم عبر التشغيلات).
setup('إنشاء مستخدم ومشروع اختبار حقيقيان وتسجيل الدخول عبر واجهة تسجيل الدخول الفعلية', async ({ page }) => {
  const admin = createTestSupabaseAdmin();
  const email = `e2e-${randomUUID()}@example.test`;
  const password = randomUUID();

  const { data: userData, error: userError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (userError || !userData.user) {
    throw new Error(`فشل إنشاء مستخدم اختبار E2E: ${userError?.message}`);
  }

  const { data: projectData, error: projectError } = await admin
    .from('projects')
    .insert({ user_id: userData.user.id, name: `مشروع E2E ${randomUUID()}` })
    .select('id')
    .single();
  if (projectError || !projectData) {
    throw new Error(`فشل إنشاء مشروع اختبار E2E: ${projectError?.message}`);
  }

  // تسجيل الدخول عبر نموذج تسجيل الدخول الفعلي (لا حقن جلسة مباشر) — يثبت
  // أن مسار تسجيل الدخول الحقيقي يعمل، لا فقط أن الصفحات المحمية تعمل بجلسة
  // مصطنعة.
  await page.goto('/login');
  await page.getByPlaceholder('name@example.com').fill(email);
  await page.getByPlaceholder('••••••••').fill(password);
  await page.getByRole('button', { name: /دخول|تسجيل/ }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 15000 });

  await page.context().storageState({ path: E2E_AUTH_STATE_PATH });

  // يُكتَب لملف بدل الاعتماد على قراءة stdout بين specs مستقلة — pm10-
  // downwind.spec.ts يقرأ e2eProjectId/e2eUserId من هنا مباشرة (نفس مبدأ
  // storageState أعلاه: تمرير حالة بين مرحلة setup ومراحل الاختبار الفعلية
  // عبر ملف، الطريقة القياسية في Playwright لمشاريع setup منفصلة).
  mkdirSync('.playwright', { recursive: true });
  writeFileSync(
    E2E_FIXTURE_PATH,
    JSON.stringify({ e2eUserId: userData.user.id, e2eProjectId: projectData.id }, null, 2),
    'utf-8'
  );
});
