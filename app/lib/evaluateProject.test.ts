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

  it('dedupe_key فريد لكل استدعاء — لا يشارك نافذة زمنية ثابتة مع مهام scheduled', async () => {
    const { enqueueEvaluationRetryJob } = await import('./evaluateProject');
    await enqueueEvaluationRetryJob('project-1', 'PROVIDER_PULL', 'err-1');
    await enqueueEvaluationRetryJob('project-1', 'PROVIDER_PULL', 'err-2');

    expect(insertCalls).toHaveLength(2);
    expect(insertCalls[0].dedupe_key).not.toBe(insertCalls[1].dedupe_key);
  });

  it('فشل الإدراج نفسه لا يرمي (يُبتلَع بأمان — القراءة الأصلية محفوظة بغض النظر)', async () => {
    insertShouldThrow = true;
    const { enqueueEvaluationRetryJob } = await import('./evaluateProject');
    await expect(enqueueEvaluationRetryJob('project-1', 'DEVICE_EVENT', 'err')).resolves.toBeUndefined();
  });
});
