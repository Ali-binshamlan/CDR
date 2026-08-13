import { test, expect } from '@playwright/test';

// اختبارات E2E للمسارات العامة (لا تتطلب جلسة مصادَقة) — القسم 19 من "دليل
// الإصلاح الجذري لمنظومة مرقاب". تثبت أن التطبيق يُبنى ويعمل فعلياً بمتصفح
// حقيقي (لا مجرد تجميع TypeScript ناجح)، وأن أبسط مسار مستخدم (فتح الصفحة
// الرئيسية → تسجيل الدخول) يعمل من طرف إلى طرف.

test.describe('الصفحة الرئيسية', () => {
  test('يُحوَّل تلقائياً إلى صفحة تسجيل الدخول', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/login$/);
  });
});

test.describe('صفحة تسجيل الدخول', () => {
  test('تعرض نموذج تسجيل الدخول بحقول البريد وكلمة المرور', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByPlaceholder('name@example.com')).toBeVisible();
    await expect(page.getByPlaceholder('••••••••')).toBeVisible();
    await expect(page.getByRole('button', { name: /دخول|تسجيل/ })).toBeVisible();
  });

  test('يرفض بريداً غير صالح برسالة تحقق واضحة (بلا استدعاء API)', async ({ page }) => {
    await page.goto('/login');
    await page.getByPlaceholder('name@example.com').fill('ليس-بريداً-صالحاً');
    await page.getByPlaceholder('••••••••').fill('كلمة-مرور-عشوائية');
    await page.getByRole('button', { name: /دخول|تسجيل/ }).click();
    await expect(page.getByText('البريد غير صالح')).toBeVisible();
  });

  test('رابط "إنشاء حساب" ينقل فعلياً لصفحة signup', async ({ page }) => {
    await page.goto('/login');
    await page.getByRole('link', { name: /إنشاء حساب|تسجيل جديد|حساب جديد/ }).click();
    await expect(page).toHaveURL(/\/signup$/);
  });
});

test.describe('صفحة إنشاء حساب', () => {
  test('تعرض نموذج التسجيل', async ({ page }) => {
    await page.goto('/signup');
    await expect(page.locator('input[type="email"]').first()).toBeVisible();
    await expect(page.locator('input[type="password"]').first()).toBeVisible();
  });
});

test.describe('حماية المسارات المصادَق عليها', () => {
  test('محاولة فتح لوحة التحكم بلا جلسة لا تعرض أي محتوى محمي', async ({ page }) => {
    // apiClient يرفق Authorization من جلسة supabase محلية — بلا جلسة، طلب
    // /profile يفشل (401)، وصفحة dashboard تتوقف عند شاشة "جاري التحميل"
    // بلا أي تحويل خادمي (لا middleware صريح لهذا المسار) — النطاق هنا
    // يثبت فقط أن المحتوى المحمي (بيانات مشروع حقيقية) لا يظهر إطلاقاً بلا
    // مصادقة، لا سلوك تحويل محدَّد.
    await page.goto('/dashboard');
    await expect(page.getByText('جاري التحميل')).toBeVisible();
    // لا يظهر أي محتوى لوحة تحكم فعلي (بطاقات مشاريع/خريطة) بلا مصادقة حقيقية.
    await expect(page.getByText('مؤشر قابلية التنفيذ')).toHaveCount(0);
  });
});
