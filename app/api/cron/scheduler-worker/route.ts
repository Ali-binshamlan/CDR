import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { timingSafeStringEqual } from '@/app/lib/timingSafe';
import { evaluateProject } from '@/app/lib/evaluateProject';

// القسم 10.2 من "دليل الإصلاح الجذري لمنظومة مرقاب" — Worker يطالب بدفعة
// من project_evaluation_jobs عبر claim_evaluation_jobs (FOR UPDATE SKIP
// LOCKED + Lease زمني)، ينفّذ evaluateProject لكل مهمة، ثم يُنهيها بنجاح
// (complete_evaluation_job) أو يُعيدها لـRETRY مع Backoff أو DEAD نهائياً
// عند تجاوز حد المحاولات (fail_evaluation_job). منفصل تماماً عن scheduler-
// tick/route.ts (الذي يُنشئ المهام فقط) — يمكن تشغيلهما بمعدلات مختلفة.
//
// Lease منتهية (90 ثانية افتراضياً) تسمح لعامل آخر باسترداد المهمة تلقائياً
// إن تعطّل هذا العامل منتصف التنفيذ (Vercel timeout، إعادة نشر، إلخ) — فلا
// حاجة لتنظيف يدوي؛ الصف يعود متاحاً للمطالبة فور انتهاء مهلته فقط.
//
// خطأ حرج مكتشَف ومُصلَح (مراجعة خبير خارجي — "Claim لا تستعيد مهمة RUNNING
// بعد انتهاء Lease؛ تبقى عالقة إلى الأبد"): هذا التعليق كان صحيحاً بالنية
// فقط — claim_evaluation_jobs الأصلية (202608040005) كانت تفحص status in
// ('PENDING','RETRY') حصراً، لا RUNNING بانتهاء lease_until، فمهمة تعطّل
// عاملها فعلياً (بلا استدعاء complete/fail) كانت تبقى RUNNING للأبد بلا أي
// استرداد تلقائي. مُصلَح في 202608040028 (union مع فرع RUNNING+lease_until
// منتهٍ، نفس نمط claim_alert_outbox_batch).
//
// مصادقة عبر SCHEDULER_CRON_SECRET نفسه المستخدَم في scheduler-tick (كلاهما
// جزء من نفس النظام الفرعي، لا حاجة لسر منفصل لكل مسار فيه).
//
// يُستدعى خارجياً كل دقيقة (أو أقل) عبر خدمة cron مجانية (cron-job.org) —
// لا إضافة لـvercel.json (خطة Vercel Hobby لا تدعم جدولة أقل من يومية).
//
// خطأ مكتشَف ومُصلَح (مراجعة كود خارجي — "ملكية Lease غير آمنة في
// العمال"، راجع migration 202608110018 الكامل): BATCH_SIZE يبقى 20 (كان
// أصلاً أصغر من telemetry-worker) — renew_evaluation_job_lease (استدعاء
// جديد أدناه، قبل معالجة كل مهمة) هو خط الدفاع الفعلي ضد انتهاء المهلة
// منتصف دفعة تحوي تقييماً بطيئاً واحداً على الأقل.
const BATCH_SIZE = 20;
const LEASE_SECONDS = 90;
const MAX_ATTEMPTS = 5;

export async function GET(request: Request) {
  if (!process.env.SCHEDULER_CRON_SECRET) {
    return NextResponse.json({ ok: false, error: 'SCHEDULER_CRON_SECRET غير مُعرَّف بالخادم' }, { status: 503 });
  }
  const authHeader = request.headers.get('authorization') || '';
  if (!timingSafeStringEqual(authHeader, `Bearer ${process.env.SCHEDULER_CRON_SECRET}`)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const workerId = crypto.randomUUID();

  const { data: jobs, error: claimError } = await supabaseAdmin.rpc('claim_evaluation_jobs', {
    p_worker_id: workerId,
    p_batch_size: BATCH_SIZE,
    p_lease_seconds: LEASE_SECONDS,
  });

  if (claimError) {
    return NextResponse.json({ ok: false, error: claimError.message }, { status: 500 });
  }

  const results: Array<{ jobId: string; projectId: string; ok: boolean; error?: string }> = [];

  // تسلسلي عمداً — نفس مبدأ provider-pull/scheduler-tick: يبسّط تتبع الفشل
  // الجزئي ويتفادى إغراق قاعدة البيانات بتقييمات متزامنة ضخمة لكل دفعة.
  for (const job of jobs || []) {
    // خطأ مكتشَف ومُصلَح (مراجعة كود خارجي — "ملكية Lease غير آمنة في
    // العمال"): تجديد Lease قبل معالجة كل مهمة — راجع تعليق telemetry-
    // worker/route.ts المطابق تماماً لسبب التوقّف الفوري بلا fail عند false.
    const renewed = await supabaseAdmin.rpc('renew_evaluation_job_lease', {
      p_job_id: job.id,
      p_worker_id: workerId,
      p_lease_seconds: LEASE_SECONDS,
    });
    if (renewed.error || !renewed.data) {
      results.push({ jobId: job.id, projectId: job.project_id, ok: false, error: 'lease لم يعد يطابق (استرجعه عامل آخر) — تم التخطي بلا معالجة' });
      continue;
    }

    try {
      const evalResult = await evaluateProject(job.project_id, 'scheduler');
      if (evalResult.success) {
        const { data: completed, error: completeError } = await supabaseAdmin.rpc('complete_evaluation_job', {
          p_job_id: job.id,
          p_worker_id: workerId,
        });
        // خطأ مكتشَف ومُصلَح (مراجعة كود خارجي — "نتائج complete لا تُفحص
        // في Scheduler/Telemetry"): راجع تعليق telemetry-worker/route.ts
        // المطابق — التقييم نجح وكُتب فعلياً بصرف النظر عن نتيجة complete،
        // فلا يُستدعى fail هنا حتى لو لم يعد worker_id يطابق.
        if (completeError || !completed) {
          results.push({
            jobId: job.id,
            projectId: job.project_id,
            ok: false,
            error: completeError?.message || 'complete_evaluation_job: lease لم يعد يطابق (استرجعه عامل آخر) رغم نجاح التقييم',
          });
        } else {
          results.push({ jobId: job.id, projectId: job.project_id, ok: true });
        }
      } else {
        const { data: failed, error: failRpcError } = await supabaseAdmin.rpc('fail_evaluation_job', {
          p_job_id: job.id,
          p_worker_id: workerId,
          p_error: evalResult.error ?? 'فشل تقييم غير محدَّد',
          p_max_attempts: MAX_ATTEMPTS,
        });
        results.push({
          jobId: job.id,
          projectId: job.project_id,
          ok: false,
          error: failRpcError || !failed ? `${evalResult.error} (lease لم يعد يطابق عند fail)` : evalResult.error,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`scheduler-worker: evaluateProject threw for project ${job.project_id}:`, message);
      await supabaseAdmin.rpc('fail_evaluation_job', {
        p_job_id: job.id,
        p_worker_id: workerId,
        p_error: message,
        p_max_attempts: MAX_ATTEMPTS,
      });
      results.push({ jobId: job.id, projectId: job.project_id, ok: false, error: message });
    }
  }

  const failedCount = results.filter((r) => !r.ok).length;
  const status = results.length === 0 || failedCount === 0 ? 200 : failedCount === results.length ? 502 : 207;

  return NextResponse.json(
    {
      ok: failedCount === 0,
      checkedAt: new Date().toISOString(),
      workerId,
      claimed: results.length,
      failed: failedCount,
      results,
    },
    { status }
  );
}
