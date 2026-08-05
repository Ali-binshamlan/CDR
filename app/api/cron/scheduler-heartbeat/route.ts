import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { timingSafeStringEqual } from '@/app/lib/timingSafe';

// القسم 10.3 من "دليل الإصلاح الجذري لمنظومة مرقاب" — الإثبات التشغيلي:
// لا تُقبل عبارة "الخدمة الخارجية ستستدعي الرابط" من دون إعداد منشور
// واختبار ومراقبة. هذا endpoint يُعيد المقاييس المطلوبة صراحةً:
//   scheduler_last_heartbeat_at, jobs_due, jobs_running, jobs_dead,
//   evaluation_lag_seconds, last_successful_project_evaluation_at
// إذا غاب Heartbeat أكثر من ثلاث دقائق يظهر إنذار تشغيلي (alert=true في
// الاستجابة) — يُستهلَك من أداة مراقبة خارجية (Uptime Robot/Healthchecks.io
// أو أي أداة تدعم فحص JSON دوري)، لا لتشغيل التقييم نفسه.
//
// القسم 17 (P1 — "مراقبة Queue وProvider وScheduler"): موسَّع هنا ليشمل
// الأنظمة الفرعية الثلاثة في استدعاء واحد (نفس مبدأ اقتصاد endpoints
// المراقبة الخارجية — راجع HEARTBEAT_STALE_SECONDS أعلاه)، لا Scheduler
// فقط:
//   - provider_pull: اتصالات provider_connections النشطة الفاشلة/المتأخرة
//     (last_pull_success=false أو last_pull_at أقدم من PROVIDER_PULL_STALE_
//     SECONDS) — provider-pull/route.ts يكتب هذه الحقول لكل اتصال في كل
//     دورة لكنه لا يملك أي endpoint تجميعي يعرض حالتها الكلية.
//   - alert_outbox: صفوف decision_alert_outbox المعلَّقة/الميتة وتأخر أقدم
//     صف PENDING — decision_alert_outbox/route.ts (alert-outbox-worker)
//     يعالج الصفوف لكن بلا مقياس تجميعي لعمق الطابور أو تعطّله.
//
// مصادقة عبر SCHEDULER_CRON_SECRET نفسه (قراءة حالة النظام الفرعي، لا
// تنفيذ عمل — لا يحتاج سراً منفصلاً).
const HEARTBEAT_STALE_SECONDS = 180;
const PROVIDER_PULL_STALE_SECONDS = 300;
const OUTBOX_LAG_ALERT_SECONDS = 300;

export async function GET(request: Request) {
  if (!process.env.SCHEDULER_CRON_SECRET) {
    return NextResponse.json({ ok: false, error: 'SCHEDULER_CRON_SECRET غير مُعرَّف بالخادم' }, { status: 503 });
  }
  const authHeader = request.headers.get('authorization') || '';
  if (!timingSafeStringEqual(authHeader, `Bearer ${process.env.SCHEDULER_CRON_SECRET}`)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const { data: heartbeat, error: heartbeatError } = await supabaseAdmin
    .from('scheduler_heartbeat')
    .select('last_heartbeat_at, last_successful_project_evaluation_at')
    .eq('id', true)
    .maybeSingle();

  if (heartbeatError) {
    return NextResponse.json({ ok: false, error: heartbeatError.message }, { status: 500 });
  }

  const { count: jobsDue } = await supabaseAdmin
    .from('project_evaluation_jobs')
    .select('id', { count: 'exact', head: true })
    .in('status', ['PENDING', 'RETRY'])
    .lte('run_after', new Date().toISOString());

  const { count: jobsRunning } = await supabaseAdmin
    .from('project_evaluation_jobs')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'RUNNING');

  const { count: jobsDead } = await supabaseAdmin
    .from('project_evaluation_jobs')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'DEAD');

  const nowMs = Date.now();
  const lastHeartbeatMs = heartbeat?.last_heartbeat_at ? new Date(heartbeat.last_heartbeat_at).getTime() : null;
  const evaluationLagSeconds = lastHeartbeatMs !== null ? Math.max(0, Math.round((nowMs - lastHeartbeatMs) / 1000)) : null;
  const schedulerAlert = evaluationLagSeconds === null || evaluationLagSeconds > HEARTBEAT_STALE_SECONDS;

  // provider_pull: عدد اتصالات provider_connections النشطة الفاشلة صراحةً
  // (last_pull_success=false) — يستثني الاتصالات التي لم تُسحَب بعد إطلاقاً
  // (last_pull_at=null، حالة "جديد" لا "فاشل").
  const { count: providerConnectionsFailing } = await supabaseAdmin
    .from('provider_connections')
    .select('id', { count: 'exact', head: true })
    .eq('is_active', true)
    .eq('last_pull_success', false);

  // اتصالات نشطة لم تُسحَب منذ أكثر من PROVIDER_PULL_STALE_SECONDS (سواء
  // كان آخر سحب فاشلاً أو ناجحاً) — يكشف provider-pull/route.ts نفسه إن
  // توقف عن العمل بالكامل (لا استدعاء cron خارجي واصل)، لا فقط فشل السحب
  // الفردي.
  const providerStaleThresholdIso = new Date(nowMs - PROVIDER_PULL_STALE_SECONDS * 1000).toISOString();
  const { count: providerConnectionsStale } = await supabaseAdmin
    .from('provider_connections')
    .select('id', { count: 'exact', head: true })
    .eq('is_active', true)
    .or(`last_pull_at.is.null,last_pull_at.lt.${providerStaleThresholdIso}`);

  const providerAlert = (providerConnectionsFailing ?? 0) > 0 || (providerConnectionsStale ?? 0) > 0;

  // alert_outbox: صفوف معلَّقة (PENDING/RUNNING لم تُعالَج بعد) وصفوف ميتة
  // نهائياً (DEAD بعد استنفاد MAX_ATTEMPTS في alert-outbox-worker/route.ts)،
  // وتأخر أقدم صف PENDING لم يُعالَج بعد — تنبيه فوري لو تعطّل الـworker
  // بالكامل رغم وجود عمل بالطابور.
  const { count: outboxPending } = await supabaseAdmin
    .from('decision_alert_outbox')
    .select('id', { count: 'exact', head: true })
    .in('status', ['PENDING', 'RUNNING']);

  const { count: outboxDead } = await supabaseAdmin
    .from('decision_alert_outbox')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'DEAD');

  const { data: oldestPendingOutboxRow } = await supabaseAdmin
    .from('decision_alert_outbox')
    .select('created_at')
    .in('status', ['PENDING', 'RUNNING'])
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  const oldestPendingMs = oldestPendingOutboxRow?.created_at ? new Date(oldestPendingOutboxRow.created_at).getTime() : null;
  const outboxLagSeconds = oldestPendingMs !== null ? Math.max(0, Math.round((nowMs - oldestPendingMs) / 1000)) : null;
  const outboxAlert = (outboxDead ?? 0) > 0 || (outboxLagSeconds !== null && outboxLagSeconds > OUTBOX_LAG_ALERT_SECONDS);

  const alert = schedulerAlert || providerAlert || outboxAlert;

  return NextResponse.json({
    ok: !alert,
    alert,
    scheduler: {
      alert: schedulerAlert,
      scheduler_last_heartbeat_at: heartbeat?.last_heartbeat_at ?? null,
      jobs_due: jobsDue ?? 0,
      jobs_running: jobsRunning ?? 0,
      jobs_dead: jobsDead ?? 0,
      evaluation_lag_seconds: evaluationLagSeconds,
      last_successful_project_evaluation_at: heartbeat?.last_successful_project_evaluation_at ?? null,
    },
    provider_pull: {
      alert: providerAlert,
      connections_failing: providerConnectionsFailing ?? 0,
      connections_stale: providerConnectionsStale ?? 0,
    },
    alert_outbox: {
      alert: outboxAlert,
      pending: outboxPending ?? 0,
      dead: outboxDead ?? 0,
      oldest_pending_lag_seconds: outboxLagSeconds,
    },
    // حقول مسطَّحة قديمة تبقى للتوافق مع أي إعداد مراقبة خارجي (Uptime
    // Robot/Healthchecks.io) موصول مسبقاً بصيغة القسم 10.3 الأصلية قبل هذا
    // التوسيع — القسم 17 يوسِّع لا يستبدل.
    scheduler_last_heartbeat_at: heartbeat?.last_heartbeat_at ?? null,
    jobs_due: jobsDue ?? 0,
    jobs_running: jobsRunning ?? 0,
    jobs_dead: jobsDead ?? 0,
    evaluation_lag_seconds: evaluationLagSeconds,
    last_successful_project_evaluation_at: heartbeat?.last_successful_project_evaluation_at ?? null,
  });
}
