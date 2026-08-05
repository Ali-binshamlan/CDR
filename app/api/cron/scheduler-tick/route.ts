import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { timingSafeStringEqual } from '@/app/lib/timingSafe';

// خطأ تشغيلي مكتشَف (القسم 10.1 من "دليل الإصلاح الجذري لمنظومة مرقاب" —
// "لماذا الجدول الحالي غير كافٍ؟"): كان هذا المسار يستدعي evaluateProject
// مباشرة داخل حلقة تسلسلية بعد أخذ قفل بسيط (scheduler_locks) — لا Lease
// قابل للاسترداد (فشل عامل منتصف التنفيذ لا يُسترجَع أبداً)، لا إعادة
// محاولة بعد فشل، ويتضخم الجدول بلا تنظيف. الإصلاح: هذا المسار الآن ينشئ
// Job واحداً فقط لكل مشروع لكل نافذة دقيقتين (بدل تنفيذ التقييم مباشرة) —
// التنفيذ الفعلي انتقل إلى app/api/cron/scheduler-worker/route.ts الذي
// يطالب بدفعة عبر claim_evaluation_jobs (FOR UPDATE SKIP LOCKED) منفصلاً
// تماماً عن هذا المسار، فيمكن تشغيلهما بمعدلات مختلفة (tick كل دقيقتين
// لإنشاء المهام، worker كل دقيقة أو أقل لمعالجتها).
//
// مصادقة عبر SCHEDULER_CRON_SECRET — كما كانت (لا تغيير).
//
// يُستدعى خارجياً كل دقيقتين عبر خدمة cron مجانية (cron-job.org) — لا إضافة
// لـvercel.json (خطة Vercel Hobby لا تدعم جدولة أقل من يومية، نفس السبب
// الموثَّق في provider-pull/route.ts وforecast-refresh/route.ts). راجع
// scheduler-heartbeat/route.ts للتحقق من أن هذا الاستدعاء الخارجي فعلياً
// نشط (jobs_due/evaluation_lag_seconds) قبل افتراض أنه يعمل.
const SCHEDULER_BUCKET_MS = 2 * 60_000;

export async function GET(request: Request) {
  if (!process.env.SCHEDULER_CRON_SECRET) {
    return NextResponse.json({ ok: false, error: 'SCHEDULER_CRON_SECRET غير مُعرَّف بالخادم' }, { status: 503 });
  }
  const authHeader = request.headers.get('authorization') || '';
  if (!timingSafeStringEqual(authHeader, `Bearer ${process.env.SCHEDULER_CRON_SECRET}`)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const timeBucket = Math.floor(Date.now() / SCHEDULER_BUCKET_MS);
  const dedupeKey = `scheduled:${timeBucket}`;

  const { data: projects, error: fetchError } = await supabaseAdmin
    .from('projects')
    .select('id')
    .is('archived_at', null);

  if (fetchError) {
    return NextResponse.json({ ok: false, error: fetchError.message }, { status: 500 });
  }

  const results: Array<{ projectId: string; enqueued: boolean; skipped?: boolean; error?: string }> = [];

  // تسلسلي عمداً — نفس مبدأ provider-pull/forecast-refresh: يبسّط تتبع
  // الفشل الجزئي ويتفادى إغراق قاعدة البيانات بإدراجات متزامنة ضخمة.
  for (const project of projects || []) {
    // unique(project_id, dedupe_key) هو القفل نفسه — محاولة إدراج ثانية
    // لنفس (project_id, نافذة الدقيقتين) ترتطم بتعارض 23505 وتُتجاهَل بأمان
    // (دورة سابقة أنشأت المهمة بالفعل، أو استدعاء متزامن سبقنا للتو).
    const { error: insertError } = await supabaseAdmin.from('project_evaluation_jobs').insert({
      project_id: project.id,
      dedupe_key: dedupeKey,
      trigger_type: 'SCHEDULED',
    });

    if (insertError) {
      if (insertError.code === '23505') {
        results.push({ projectId: project.id, enqueued: false, skipped: true });
      } else {
        results.push({ projectId: project.id, enqueued: false, error: insertError.message });
      }
      continue;
    }

    results.push({ projectId: project.id, enqueued: true });
  }

  // Heartbeat — يُحدَّث هنا (نجاح إنشاء المهام)، لا انتظاراً لنجاح المعالجة
  // الفعلية (ذلك heartbeat منفصل عبر last_successful_project_evaluation_at
  // الذي يُحدِّثه scheduler-worker/route.ts فقط عند نجاح تقييم فعلي).
  await supabaseAdmin
    .from('scheduler_heartbeat')
    .update({ last_heartbeat_at: new Date().toISOString() })
    .eq('id', true);

  const failedCount = results.filter((r) => r.error).length;
  const status = results.length === 0 || failedCount === 0 ? 200 : failedCount === results.length ? 502 : 207;

  return NextResponse.json(
    {
      ok: failedCount === 0,
      checkedAt: new Date().toISOString(),
      timeBucket,
      total: results.length,
      failed: failedCount,
      results,
    },
    { status }
  );
}
