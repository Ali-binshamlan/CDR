import { test, expect, type APIRequestContext } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createTestSupabaseAdmin } from '../supabase/tests/dbTestClient';
import { E2E_FIXTURE_PATH, E2E_AUTH_STATE_PATH } from './fixturePaths';

// طلب مستخدم صريح ("التحقق النهائي" — "اختبر بمحطة فعلية: PM10 يعمل، سرعة
// الرياح تعمل، اتجاه الرياح يظهر غير موثق، تحليل Downwind لا يعمل، بعد
// توثيق الشمال الحقيقي يعمل Downwind، قطع اتصال قاعدة البيانات لا ينتج
// 'لا تجاوز'"). لا محطة IoT فعلية متاحة لهذا التنفيذ — البديل الأقرب:
// محاكاة قراءات محطة حقيقية عبر service_role (نفس الأعمدة التي يكتبها
// جهاز حقيقي عبر POST /api/devices/ingest بالضبط)، ثم تشغيل دورة تقييم
// حقيقية عبر POST /api/projects/{id}/evaluate (لا mock لأي جزء من محرك
// القرار)، ثم فتح المتصفح فعلياً على /dashboard/Projects/{id} والتحقق
// بصرياً من النص المعروض — القراءة نفسها مصطنعة، لكن كل ما بعدها (نموذج
// PostgreSQL الحقيقي، محرك الامتثال، الواجهة المُصيَّرة) حقيقي بالكامل.
//
// يعتمد على e2e/auth.setup.ts (مشروع project "setup" في playwright.config.ts
// — غير مُضاف بعد هناك، راجع التعليق أعلى ذلك الملف) لإنشاء مستخدم/مشروع
// وتسجيل الدخول فعلياً؛ يقرأ e2eProjectId من E2E_FIXTURE_PATH. لم يُشغَّل
// هذا الملف فعلياً بعد في هذه الجلسة (Docker متوقف محلياً وقت الكتابة) —
// كود جاهز للتشغيل حين تتوفر بيئة Supabase محلية حقيقية (`supabase start`).
test.use({ storageState: E2E_AUTH_STATE_PATH });

let fixture: { e2eUserId: string; e2eProjectId: string };
let admin: ReturnType<typeof createTestSupabaseAdmin>;

test.beforeAll(() => {
  fixture = JSON.parse(readFileSync(E2E_FIXTURE_PATH, 'utf-8'));
  admin = createTestSupabaseAdmin();
});

async function createDevice(request: APIRequestContext, projectId: string, lat: number, lng: number): Promise<string> {
  const res = await request.post(`/api/projects/${projectId}/devices`, {
    data: { name: `محطة E2E ${randomUUID()}`, lat, lng },
  });
  expect(res.ok(), `فشل إنشاء الجهاز: ${res.status()} ${await res.text()}`).toBe(true);
  const body = await res.json();
  return body.device.id as string;
}

async function createCrusherActivity(request: APIRequestContext, projectId: string, lat: number, lng: number): Promise<string> {
  const activityGroupId = randomUUID();
  const res = await request.post('/api/dust-profiles', {
    data: {
      project_id: projectId,
      activity_group_id: activityGroupId,
      activity_type: 'HEAVY_EQUIPMENT_MOVEMENT',
      regulatory_activity: 'CRUSHER',
      activity_lat: lat,
      activity_lng: lng,
      crusher_lat: lat,
      crusher_lng: lng,
      planned_date: new Date().toISOString().slice(0, 10),
      planned_time: '08:00:00',
      duration_hours: 8,
    },
  });
  expect(res.ok(), `فشل إنشاء نشاط الكسارة: ${res.status()} ${await res.text()}`).toBe(true);
  return activityGroupId;
}

// يكتب قراءة محطة مباشرة إلى pm10_readings_history + project_devices.last_*
// (نفس الأعمدة التي يحدّثها /api/devices/ingest فعلياً لجهاز حقيقي) —
// service_role بدل مفتاح API الحقيقي للجهاز لتبسيط الإعداد فقط، القيم
// المكتوبة والجداول المستهدفة مطابقة تماماً لمسار الإنتاج الحقيقي.
async function seedStationReading(
  deviceId: string,
  projectId: string,
  activityGroupId: string,
  overrides: { pm10?: number; windSpeedKmh?: number; windDirectionDeg?: number | null }
): Promise<void> {
  const now = new Date().toISOString();
  await admin
    .from('project_devices')
    .update({
      last_reading_at: now,
      last_pm10: overrides.pm10 ?? 120,
      last_pm10_at: now,
      last_wind_speed_kmh: overrides.windSpeedKmh ?? 10,
      last_wind_direction_deg: overrides.windDirectionDeg ?? null,
    })
    .eq('id', deviceId);

  if (overrides.pm10 != null) {
    await admin.from('pm10_readings_history').insert({
      project_id: projectId,
      activity_group_id: activityGroupId,
      device_id: deviceId,
      pm10_ug_m3: overrides.pm10,
      recorded_at: now,
      source: 'device',
    });
  }
}

async function triggerEvaluation(request: APIRequestContext, projectId: string): Promise<void> {
  const res = await request.post(`/api/projects/${projectId}/evaluate`);
  expect(res.ok(), `فشل تشغيل دورة تقييم: ${res.status()} ${await res.text()}`).toBe(true);
}

test.describe('محطة فعلية (محاكاة قراءات حقيقية + محرك قرار حقيقي) — PM10/الرياح/اتجاه/Downwind', () => {
  test('PM10 وسرعة الرياح يظهران في بطاقة الجهاز بلوحة الإعدادات', async ({ page, request }) => {
    const deviceId = await createDevice(request, fixture.e2eProjectId, 24.7, 46.7);
    await createCrusherActivity(request, fixture.e2eProjectId, 24.7, 46.7);
    await seedStationReading(deviceId, fixture.e2eProjectId, randomUUID(), { pm10: 180, windSpeedKmh: 22 });

    await page.goto(`/dashboard/Projects/${fixture.e2eProjectId}/settings`);
    await expect(page.getByText('PM10: 180')).toBeVisible();
    await expect(page.getByText('رياح: 22 كم/س')).toBeVisible();
  });

  test('اتجاه الرياح يظهر "غير موثق" حين لا يوجد توثيق شمال حقيقي، رغم وجود قراءة اتجاه فعلية', async ({ page, request }) => {
    const deviceId = await createDevice(request, fixture.e2eProjectId, 24.71, 46.71);
    await seedStationReading(deviceId, fixture.e2eProjectId, randomUUID(), { windDirectionDeg: 270 });

    await page.goto(`/dashboard/Projects/${fixture.e2eProjectId}/settings`);
    await expect(page.getByText('⚠ غير موثق — لن يُستخدم اتجاه الرياح في تحليل الانتشار')).toBeVisible();
  });

  test('تحليل Downwind (MRQ-RECEPTOR-DOWNWIND-120) لا يظهر قبل توثيق الشمال الحقيقي، رغم وجود مستقبل حساس قريب باتجاه الرياح المُبلَّغ', async ({
    page,
    request,
  }) => {
    const crusherLat = 24.72;
    const crusherLng = 46.72;
    const deviceId = await createDevice(request, fixture.e2eProjectId, crusherLat, crusherLng);
    const activityGroupId = await createCrusherActivity(request, fixture.e2eProjectId, crusherLat, crusherLng);

    // مستقبل حساس على بُعد ~100م شمال الكسارة (ضمن حد MRQ-RECEPTOR-DOWNWIND-120).
    await admin.from('sensitive_receptors').insert({
      name: 'مدرسة اختبار E2E',
      receptor_type: 'HOSPITAL_SCHOOL_NURSERY_RESIDENTIAL_ADJACENT',
      lat: crusherLat + 0.0009,
      lng: crusherLng,
    });

    await seedStationReading(deviceId, fixture.e2eProjectId, activityGroupId, {
      pm10: 100,
      windSpeedKmh: 10,
      windDirectionDeg: 0, // شمالاً — نحو المستقبل تماماً — لكن غير موثَّق بعد.
    });
    await triggerEvaluation(request, fixture.e2eProjectId);

    await page.goto(`/dashboard/Projects/${fixture.e2eProjectId}`);
    await expect(page.getByText(/مستقبِل حساس.*يقع فعلياً باتجاه هبوب الرياح/)).toHaveCount(0);
  });

  test('بعد توثيق الشمال الحقيقي لنفس الجهاز، تحليل Downwind يعمل ويظهر تنبيه MRQ-RECEPTOR-DOWNWIND-120', async ({ page, request }) => {
    const crusherLat = 24.73;
    const crusherLng = 46.73;
    const deviceId = await createDevice(request, fixture.e2eProjectId, crusherLat, crusherLng);
    const activityGroupId = await createCrusherActivity(request, fixture.e2eProjectId, crusherLat, crusherLng);

    await admin.from('sensitive_receptors').insert({
      name: 'مستشفى اختبار E2E',
      receptor_type: 'HOSPITAL_SCHOOL_NURSERY_RESIDENTIAL_ADJACENT',
      lat: crusherLat + 0.0009,
      lng: crusherLng,
    });

    // توثيق الشمال الحقيقي عبر واجهة الإعدادات فعلياً (لا استدعاء API مباشر)
    // — يثبت أن النموذج الحقيقي (openTrueNorthModal/handleSaveTrueNorth في
    // settings/page.tsx) يعمل من طرف إلى طرف، لا فقط أن الحقل يقبل القيمة.
    await page.goto(`/dashboard/Projects/${fixture.e2eProjectId}/settings`);
    await page.getByRole('button', { name: 'توثيق الشمال الحقيقي' }).first().click();
    await page.getByLabel('موثَّق للشمال الحقيقي').check();
    await page.getByPlaceholder('مثال: مساحة GPS، بوصلة معايَرة').fill('مساحة GPS — اختبار E2E');
    await page.locator('input[type="text"]').nth(1).fill('مساح الاختبار');
    await page.locator('input[type="date"]').fill(new Date().toISOString().slice(0, 10));
    await page.getByRole('button', { name: /^حفظ/ }).click();
    await expect(page.getByText('✓ موثق للشمال الحقيقي')).toBeVisible();

    await seedStationReading(deviceId, fixture.e2eProjectId, activityGroupId, {
      pm10: 100,
      windSpeedKmh: 10,
      windDirectionDeg: 0,
    });
    await triggerEvaluation(request, fixture.e2eProjectId);

    await page.goto(`/dashboard/Projects/${fixture.e2eProjectId}`);
    await expect(page.getByText(/مستقبِل حساس.*يقع فعلياً باتجاه هبوب الرياح/)).toBeVisible();
  });

  test('قطع اتصال قاعدة البيانات أثناء استعلام سلسلة PM10 لا يُنتج "لا تجاوز" — يظهر النص الفعلي المطلوب (يتطلب تحقق ميداني)', async ({
    page,
    request,
  }) => {
    const deviceId = await createDevice(request, fixture.e2eProjectId, 24.74, 46.74);
    const activityGroupId = await createCrusherActivity(request, fixture.e2eProjectId, 24.74, 46.74);
    await seedStationReading(deviceId, fixture.e2eProjectId, activityGroupId, { pm10: 100 });

    // لا قدرة فعلية من هذا الاختبار على قطع اتصال شبكة/قاعدة بيانات فعلياً
    // (يتطلب صلاحيات بنية تحتية خارج نطاق Playwright) — البديل الموثَّق في
    // الاختبار الوحدوي المكافئ (fetchPm10SustainedStatus — تسجيل حدث Telemetry
    // عند فشل الاستعلام، app/lib/dustEvaluation.pm10Sustained.test.ts) يحاكي
    // الفشل حقاً عبر mock على مستوى الشبكة/الاستجابة. هذا الاختبار يبقى معطَّلاً
    // (test.fixme) بدل الادّعاء بتغطيته فعلياً بلا الوسيلة الحقيقية لقطع
    // الاتصال من بيئة Playwright.
    test.fixme(true, 'يتطلب قدرة فعلية على قطع اتصال قاعدة البيانات من بنية تحتية خارج Playwright — مغطّى بديلاً بمحاكاة على مستوى الوحدة');

    await triggerEvaluation(request, fixture.e2eProjectId);
    await page.goto(`/dashboard/Projects/${fixture.e2eProjectId}`);
    await expect(page.getByText('لا توجد مخالفات تنظيمية ظاهرة على النشاط الحالي')).toHaveCount(0);
    await expect(page.getByText(/تعذر التحقق من استمرارية PM10/)).toBeVisible();
  });
});
