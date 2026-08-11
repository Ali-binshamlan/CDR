import { describe, it, expect, vi, beforeEach } from 'vitest';

// خطأ مكتشَف ومُصلَح (مراجعة خبير خارجي — "إن نجح حفظ القراءة لكن فشل
// التقييم بعدها، يُسجَّل خطأ فقط وتبقى الاستجابة للجهاز ناجحة — لا مهمة
// إعادة محاولة مضمونة تربط القراءة بالتقييم الفاشل"): هذا الملف يختبر
// enqueueEvaluationRetryJob فقط — الدالة التي تُدرج مهمة في طابور
// project_evaluation_jobs (نفس الطابور الذي يعالجه scheduler-worker عبر
// claim_evaluation_jobs) عند فشل استدعاء evaluateProject المباشر من
// ingest/route.ts أو provider-pull/route.ts.

const insertCalls: Array<Record<string, unknown>> = [];
let insertShouldThrow = false;

vi.mock('./supabaseAdmin', () => ({
  supabaseAdmin: {
    from: (table: string) => ({
      insert: async (values: Record<string, unknown>) => {
        insertCalls.push({ table, ...values });
        if (insertShouldThrow) throw new Error('insert failed');
        return { data: null, error: null };
      },
    }),
  },
}));

// evaluateProject.ts يستورد checkDustActivities من route.ts الذي يُنشئ
// عميل Supabase حقيقياً عند تحميل الوحدة (top-level createClient) — تُموَّه
// هنا لتفادي فشل "supabaseUrl is required" في بيئة الاختبار؛ enqueueEvaluationRetryJob
// لا تستدعي هذه الدالة إطلاقاً، فالتمويه هنا فقط لمنع كسر استيراد الوحدة.
vi.mock('@/app/api/alerts/generate/route', () => ({
  checkDustActivities: vi.fn(async () => {}),
}));

describe('isDustProfileWindowActive', () => {
  // 2026-08-11T10:00:00Z كمرجع ثابت — التوقيت المحلي بالرياض UTC+3، فـ
  // planned_time='10:00' يعني 07:00 UTC نفس اليوم.
  const NOW_MS = new Date('2026-08-11T10:00:00.000Z').getTime();

  it('يستبعد نشاطاً انقضت نافذته المخطَّطة بالكامل (بداية + مدة أقدم من الآن)', async () => {
    const { isDustProfileWindowActive } = await import('./evaluateProject');
    // planned 07:00 + 1 ساعة = ينتهي 08:00 UTC — قبل NOW_MS بساعتين.
    const row = { planned_date: '2026-08-11', planned_time: '10:00', duration_hours: 1 };
    expect(isDustProfileWindowActive(row, NOW_MS)).toBe(false);
  });

  it('يُبقي نشاطاً لا تزال نافذته المخطَّطة جارية', async () => {
    const { isDustProfileWindowActive } = await import('./evaluateProject');
    // planned 07:00 + 5 ساعات = ينتهي 12:00 UTC — بعد NOW_MS بساعتين.
    const row = { planned_date: '2026-08-11', planned_time: '10:00', duration_hours: 5 };
    expect(isDustProfileWindowActive(row, NOW_MS)).toBe(true);
  });

  it('لا يستبعد صفاً بلا duration_hours (نافذة زمنية غير معروفة — فشل آمن نحو التقييم)', async () => {
    const { isDustProfileWindowActive } = await import('./evaluateProject');
    const row = { planned_date: '2026-08-11', planned_time: '10:00', duration_hours: null };
    expect(isDustProfileWindowActive(row, NOW_MS)).toBe(true);
  });

  it('لا يستبعد صفاً بلا planned_date/planned_time (نافذة زمنية غير معروفة)', async () => {
    const { isDustProfileWindowActive } = await import('./evaluateProject');
    const row = { planned_date: null, planned_time: null, duration_hours: 4 };
    expect(isDustProfileWindowActive(row, NOW_MS)).toBe(true);
  });

  it('نافذة تنتهي بعد NOW_MS بدقيقة واحدة فقط تبقى نشطة (حد فاصل قريب)', async () => {
    const { isDustProfileWindowActive } = await import('./evaluateProject');
    // planned_time بتوقيت الرياض (UTC+3): '12:59' محلي = 09:59 UTC، +1h =
    // 10:59 UTC — بعد NOW_MS (10:00 UTC) بدقيقة واحدة فقط.
    const row = { planned_date: '2026-08-11', planned_time: '12:59', duration_hours: 1 };
    expect(isDustProfileWindowActive(row, NOW_MS)).toBe(true);
  });
});

describe('enqueueEvaluationRetryJob', () => {
  beforeEach(() => {
    insertCalls.length = 0;
    insertShouldThrow = false;
  });

  it('يُدرج صفاً في project_evaluation_jobs بـtrigger_type وlast_error الصحيحين', async () => {
    const { enqueueEvaluationRetryJob } = await import('./evaluateProject');
    await enqueueEvaluationRetryJob('project-1', 'DEVICE_EVENT', 'فشل التقييم');

    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0].table).toBe('project_evaluation_jobs');
    expect(insertCalls[0].project_id).toBe('project-1');
    expect(insertCalls[0].trigger_type).toBe('DEVICE_EVENT');
    expect(insertCalls[0].last_error).toBe('فشل التقييم');
  });

  it('dedupe_key مستقر لكل دقيقة — فشلان متتاليان لنفس المشروع/triggerType ضمن نفس الدقيقة يتشاركان نفس المفتاح (يمنع تراكم مهام retry تحت تزاحم مستمر)', async () => {
    const { enqueueEvaluationRetryJob } = await import('./evaluateProject');
    await enqueueEvaluationRetryJob('project-1', 'PROVIDER_PULL', 'err-1');
    await enqueueEvaluationRetryJob('project-1', 'PROVIDER_PULL', 'err-2');

    expect(insertCalls).toHaveLength(2);
    expect(insertCalls[0].dedupe_key).toBe(insertCalls[1].dedupe_key);
  });

  it('dedupe_key يختلف بين triggerType مختلفين لنفس المشروع في نفس اللحظة', async () => {
    const { enqueueEvaluationRetryJob } = await import('./evaluateProject');
    await enqueueEvaluationRetryJob('project-1', 'PROVIDER_PULL', 'err-1');
    await enqueueEvaluationRetryJob('project-1', 'DEVICE_EVENT', 'err-2');

    expect(insertCalls[0].dedupe_key).not.toBe(insertCalls[1].dedupe_key);
  });

  it('فشل الإدراج نفسه لا يرمي (يُبتلَع بأمان — القراءة الأصلية محفوظة بغض النظر)', async () => {
    insertShouldThrow = true;
    const { enqueueEvaluationRetryJob } = await import('./evaluateProject');
    await expect(enqueueEvaluationRetryJob('project-1', 'DEVICE_EVENT', 'err')).resolves.toBeUndefined();
  });
});
