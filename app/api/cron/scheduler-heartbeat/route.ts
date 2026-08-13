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
// المرحلة 7 من خطة إعادة تصميم مسار Telemetry (طُبِّقت بموافقة صريحة
// 2026-08-09/10) — قسم telemetry_queue إضافي: عمق telemetry_ingestion_queue
// حسب الحالة + عمر أقدم صف PENDING + عدد DEAD — يكشف مبكراً حالة
// "Ingestion Rate > Processing Rate" (القسم 9/13 من خطة التصميم) قبل أن
// تتحول لمشكلة أداء فعلية، بنفس منطق التنبيه المستخدَم أعلاه لبقية
// الأنظمة الفرعية (لا بنية جديدة، توسيع للنمط الموجود).
//
// مصادقة عبر SCHEDULER_CRON_SECRET نفسه (قراءة حالة النظام الفرعي، لا
// تنفيذ عمل — لا يحتاج سراً منفصلاً).
//
// =====================================================================
// خطأ مكتشَف ومُصلَح بالكامل (طلب صريح من المستخدم — مراجعة كود خارجي:
// "Health endpoint قد يظهر أخضر رغم تعطل النظام") — ستة إصلاحات مستقلة:
//
// (1) schedulerAlert كان يقيس last_heartbeat_at (يُحدِّثه scheduler-tick
//     عند نجاح *إنشاء* المهام فقط — راجع تعليقه: "لا انتظاراً لنجاح
//     المعالجة الفعلية") بدل last_successful_project_evaluation_at (يُحدِّثه
//     evaluateProject.ts فقط عند نجاح تقييم فعلي كامل). لو تعطّل scheduler-
//     worker بالكامل (كل تقييم يفشل) بينما scheduler-tick استمر بإنشاء
//     المهام بنجاح، evaluationLagSeconds كان يبقى صفراً زوراً. الآن يُستخدَم
//     last_successful_project_evaluation_at + نبضة worker_heartbeats الجديدة
//     لعامل scheduler-worker معاً — أي منهما متأخر يكفي لإطلاق التنبيه.
//
// (2) jobsDue/jobsDead كانا يُحسَبان ويُعرَضان لكن لا يدخلان alert إطلاقاً —
//     باكلوغ ضخم (آلاف مهمة PENDING متراكمة، أو مئات DEAD) لم يكن يُنتج
//     alert=true أبداً طالما last_heartbeat_at حديثاً. عتبتان صريحتان
//     جديدتان (JOBS_DUE_ALERT_COUNT/JOBS_DEAD_ALERT_COUNT) تدخلان
//     schedulerAlert الآن.
//
// (3) استعلامات alert_outbox (outboxPending/oldestPendingOutboxRow) كانت
//     .in('status', ['PENDING', 'RUNNING']) — لا تشمل RETRY (الحالة التي
//     يُعيد إليها fail_alert_outbox_row الصف بعد فشل مع محاولات متبقية،
//     migration 202608110018). صف فشل مرة واحدة (RETRY، ينتظر backoff)
//     كان يختفي تماماً من outboxPending/outboxAlert. أُضيف RETRY لكل
//     استعلامات alert_outbox (نفس نمط jobsDue الذي كان يشمله بالفعل).
//
// (4) 20 من أصل 21 استعلام/استدعاء RPC كانت تُهمل حقل error تماماً — فشل
//     استعلام (شبكة/صلاحيات/مهلة) كان يتحول بصمت إلى count=null/data=null
//     ثم ?? 0 يُظهره "صفراً صحياً" بدل "فشل فحص". كل استعلام الآن يستخرج
//     error صراحة؛ queryErrors (مصفوفة تراكمية) تُضاف كسبب تنبيه مستقل
//     (queryErrorsAlert) يُسقِط الصحة العامة بصرف النظر عن بقية الفحوص.
//
// (5) db_cleanup كان يقيس db_cleanup_run_lock.started_at (يُدرَج عند *بداية*
//     الدورة) كأنه "آخر تشغيلة ناجحة" — فشل الدورة في منتصفها (بعد نجاح
//     الـinsert) كان لا يزال يُظهر started_at حديثاً. الآن يُستخدَم
//     worker_heartbeats لعامل db-cleanup-worker (started/succeeded/failed
//     مستقلة فعلياً) بدل started_at وحدها.
//
// (6) لا نبضة مستقلة لكل عامل — استدلال غير مباشر فقط (عمق طابور/عمر صف).
//     جدول worker_heartbeats جديد (migration 202608120013) + دالة
//     upsert_worker_heartbeat يكتبها كل عامل (telemetry-worker،
//     alert-outbox-worker، provider-pull، scheduler-worker، db-cleanup-worker)
//     عند البدء/النجاح/الفشل. workerHealthAlert أدناه يفحص تأخر أي عامل عن
//     WORKER_HEARTBEAT_STALE_SECONDS أو last_run_failed_at أحدث من
//     last_run_succeeded_at (يعني آخر محاولة فشلت، لم يُصلَح بعد).
// =====================================================================
const HEARTBEAT_STALE_SECONDS = 180;
const PROVIDER_PULL_STALE_SECONDS = 300;
const OUTBOX_LAG_ALERT_SECONDS = 300;
const TELEMETRY_QUEUE_LAG_ALERT_SECONDS = 300;

// خطة الاحتفاظ طويلة المدى (معتمدة 2026-08-10) — قسمان إضافيان:
//   - db_cleanup: صحة عامل db-cleanup-worker نفسه (worker_heartbeats الآن،
//     راجع البند (5) أعلاه) — يكشف تعطّل التنظيف نفسه، لا فقط تعطّل مسارات
//     الاستقبال/المعالجة.
//   - evidence_growth: حجم القاعدة الكلي + أكبر الجداول، مقابل عتبات رقمية
//     صريحة (لا مراقبة صامتة). لا يمس أي جدول أدلة بالكتابة — قراءة فقط عبر
//     get_database_and_table_sizes().
const DB_CLEANUP_STALE_SECONDS = 3 * 3600; // 3 ساعات = تخطي دورتين متتاليتين على الأقل (كل ساعة)
const DB_SIZE_WARN_BYTES = 350 * 1024 * 1024; // 70% من حد Free ~500MB التقديري
const DB_SIZE_ALERT_BYTES = 425 * 1024 * 1024; // 85%
const EVIDENCE_TABLE_WARN_BYTES = 200 * 1024 * 1024;
const EVIDENCE_TABLE_ALERT_BYTES = 500 * 1024 * 1024;

// بنية Tamper-Evidence (معتمدة 2026-08-10) — قسم evidence_integrity: ثلاثة
// فحوصات مستقلة عبر verify_evidence_chain_tail/check_evidence_trigger_
// integrity (202608110010/202608110011) وجدول evidence_anchor_runs
// (202608110009) — استمرارية سلسلة التجزئة، سلامة triggers الحماية على
// جداول الأدلة، وحداثة آخر تثبيت خارجي على GitHub (evidence-anchor/route.ts،
// يعمل كل ساعة — عتبة التنبيه ضعف فترة الجدولة، بنفس منطق dbCleanupAlert).
const EVIDENCE_CHAIN_VERIFY_WINDOW = 50;
const EVIDENCE_ANCHOR_STALE_SECONDS = 2 * 3600; // ضعف فترة جدولة evidence-anchor (كل ساعة)

// خطأ مكتشَف ومُصلَح (طلب صريح من المستخدم — مراجعة كود خارجي: "فحص Hash لا
// يقارن السجل بالمصدر الأصلي"): verify_evidence_chain_tail أعلاه يكتشف فقط
// تلاعباً بالدفتر evidence_hash_ledger نفسه — لا تعديلاً/حذفاً للصف المصدر
// الفعلي (final_decisions/pm10_readings_history/إلخ) الذي لا يترك أي أثر في
// الدفتر إطلاقاً (راجع تعليق migration 202608120010 الكامل). verify_evidence_
// source_integrity (نفس الهجرة) تُعيد حساب row_hash من الصف المصدر الحالي
// فعلياً وتقارنه بالمخزَّن — نافذة أضيق (10 لا 50) لأنها أثقل: استعلام
// ديناميكي منفصل لكل صف (بحث في جدول مصدر مختلف محتمل لكل صف)، لا استعلام
// واحد على الدفتر نفسه فقط.
const EVIDENCE_SOURCE_VERIFY_WINDOW = 10;

// راجع البندين (2) و(6) أعلى الملف.
const JOBS_DUE_ALERT_COUNT = 100;
const JOBS_DEAD_ALERT_COUNT = 10;
const WORKER_HEARTBEAT_STALE_SECONDS = 300;
const MONITORED_WORKER_NAMES = [
  'telemetry-worker',
  'alert-outbox-worker',
  'provider-pull',
  'scheduler-worker',
  'db-cleanup-worker',
] as const;

export async function GET(request: Request) {
  if (!process.env.SCHEDULER_CRON_SECRET) {
    return NextResponse.json({ ok: false, error: 'SCHEDULER_CRON_SECRET غير مُعرَّف بالخادم' }, { status: 503 });
  }
  const authHeader = request.headers.get('authorization') || '';
  if (!timingSafeStringEqual(authHeader, `Bearer ${process.env.SCHEDULER_CRON_SECRET}`)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  // راجع البند (4) أعلى الملف — كل استعلام أدناه يُضيف رسالته هنا عند فشله
  // (لا يتوقف الفحص عند أول فشل؛ كل الأنظمة الفرعية تُفحَص رغم فشل استعلام
  // واحد لنظام آخر — فشل استعلام واحد لا يجوز أن يُخفي حالة بقية الأنظمة).
  const queryErrors: string[] = [];
  function trackError(label: string, error: { message: string } | null | undefined): void {
    if (error) queryErrors.push(`${label}: ${error.message}`);
  }

  const { data: heartbeat, error: heartbeatError } = await supabaseAdmin
    .from('scheduler_heartbeat')
    .select('last_heartbeat_at, last_successful_project_evaluation_at')
    .eq('id', true)
    .maybeSingle();
  trackError('scheduler_heartbeat', heartbeatError);

  const { count: jobsDue, error: jobsDueError } = await supabaseAdmin
    .from('project_evaluation_jobs')
    .select('id', { count: 'exact', head: true })
    .in('status', ['PENDING', 'RETRY'])
    .lte('run_after', new Date().toISOString());
  trackError('jobs_due', jobsDueError);

  const { count: jobsRunning, error: jobsRunningError } = await supabaseAdmin
    .from('project_evaluation_jobs')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'RUNNING');
  trackError('jobs_running', jobsRunningError);

  const { count: jobsDead, error: jobsDeadError } = await supabaseAdmin
    .from('project_evaluation_jobs')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'DEAD');
  trackError('jobs_dead', jobsDeadError);

  const nowMs = Date.now();

  // راجع البند (6) أعلى الملف — نبضة صريحة لكل عامل، مصدر مستقل عن أي
  // استدلال غير مباشر. استعلام واحد لكل العمال الخمسة معاً (in، لا خمسة
  // استعلامات منفصلة).
  const { data: workerHeartbeatRows, error: workerHeartbeatsError } = await supabaseAdmin
    .from('worker_heartbeats')
    .select('worker_name, last_run_started_at, last_run_succeeded_at, last_run_failed_at, last_error')
    .in('worker_name', MONITORED_WORKER_NAMES as unknown as string[]);
  trackError('worker_heartbeats', workerHeartbeatsError);

  const workerHeartbeatByName = new Map(
    ((workerHeartbeatRows ?? []) as Array<{
      worker_name: string;
      last_run_started_at: string | null;
      last_run_succeeded_at: string | null;
      last_run_failed_at: string | null;
      last_error: string | null;
    }>).map((r) => [r.worker_name, r])
  );

  // عامل بلا أي نبضة مسجَّلة بعد (نبضته الأولى لم تصل، أو غاب تماماً عن
  // التشغيل) يُعامَل كمتأخر — فشل آمن نحو التنبيه، لا افتراض "لا شيء ليقلقك".
  function workerLagSeconds(workerName: string): number | null {
    const row = workerHeartbeatByName.get(workerName);
    const latestMs = row
      ? Math.max(
          row.last_run_succeeded_at ? new Date(row.last_run_succeeded_at).getTime() : 0,
          row.last_run_started_at ? new Date(row.last_run_started_at).getTime() : 0
        )
      : 0;
    if (latestMs === 0) return null;
    return Math.max(0, Math.round((nowMs - latestMs) / 1000));
  }
  function workerLastAttemptFailed(workerName: string): boolean {
    const row = workerHeartbeatByName.get(workerName);
    if (!row || !row.last_run_failed_at) return false;
    const failedMs = new Date(row.last_run_failed_at).getTime();
    const succeededMs = row.last_run_succeeded_at ? new Date(row.last_run_succeeded_at).getTime() : 0;
    return failedMs > succeededMs;
  }
  const workerStatuses = MONITORED_WORKER_NAMES.map((name) => {
    const row = workerHeartbeatByName.get(name);
    const lagSeconds = workerLagSeconds(name);
    const stale = lagSeconds === null || lagSeconds > WORKER_HEARTBEAT_STALE_SECONDS;
    const lastAttemptFailed = workerLastAttemptFailed(name);
    return {
      worker: name,
      alert: stale || lastAttemptFailed,
      last_run_started_at: row?.last_run_started_at ?? null,
      last_run_succeeded_at: row?.last_run_succeeded_at ?? null,
      last_run_failed_at: row?.last_run_failed_at ?? null,
      last_error: row?.last_error ?? null,
      lag_seconds: lagSeconds,
    };
  });
  const workerHealthAlert = workerStatuses.some((w) => w.alert);

  // راجع البند (1) أعلى الملف — last_successful_project_evaluation_at
  // (تقييم ناجح فعلياً) هو المقياس الأساسي الآن، لا last_heartbeat_at
  // (إنشاء المهام فقط). evaluation_lag_seconds المعروضة تعكس هذا المصدر.
  const lastSuccessfulEvalMs = heartbeat?.last_successful_project_evaluation_at
    ? new Date(heartbeat.last_successful_project_evaluation_at).getTime()
    : null;
  const evaluationLagSeconds = lastSuccessfulEvalMs !== null ? Math.max(0, Math.round((nowMs - lastSuccessfulEvalMs) / 1000)) : null;
  const schedulerHeartbeatAlert = evaluationLagSeconds === null || evaluationLagSeconds > HEARTBEAT_STALE_SECONDS;
  // راجع البند (2) أعلى الملف — باكلوغ ضخم يُطلِق التنبيه بصرف النظر عن
  // حداثة آخر نبضة (قد تكون المهام تُنشأ وتُطالَب بها لكن تتراكم أسرع من
  // معالجتها الفعلية).
  const jobsBacklogAlert = (jobsDue ?? 0) >= JOBS_DUE_ALERT_COUNT || (jobsDead ?? 0) >= JOBS_DEAD_ALERT_COUNT;
  const schedulerAlert = schedulerHeartbeatAlert || jobsBacklogAlert || workerLagSeconds('scheduler-worker') === null || workerLastAttemptFailed('scheduler-worker');

  // provider_pull: عدد اتصالات provider_connections النشطة الفاشلة صراحةً
  // (last_pull_success=false) — يستثني الاتصالات التي لم تُسحَب بعد إطلاقاً
  // (last_pull_at=null، حالة "جديد" لا "فاشل").
  const { count: providerConnectionsFailing, error: providerFailingError } = await supabaseAdmin
    .from('provider_connections')
    .select('id', { count: 'exact', head: true })
    .eq('is_active', true)
    .eq('last_pull_success', false);
  trackError('provider_connections_failing', providerFailingError);

  // اتصالات نشطة لم تُسحَب منذ أكثر من PROVIDER_PULL_STALE_SECONDS (سواء
  // كان آخر سحب فاشلاً أو ناجحاً) — يكشف provider-pull/route.ts نفسه إن
  // توقف عن العمل بالكامل (لا استدعاء cron خارجي واصل)، لا فقط فشل السحب
  // الفردي.
  const providerStaleThresholdIso = new Date(nowMs - PROVIDER_PULL_STALE_SECONDS * 1000).toISOString();
  const { count: providerConnectionsStale, error: providerStaleError } = await supabaseAdmin
    .from('provider_connections')
    .select('id', { count: 'exact', head: true })
    .eq('is_active', true)
    .or(`last_pull_at.is.null,last_pull_at.lt.${providerStaleThresholdIso}`);
  trackError('provider_connections_stale', providerStaleError);

  const providerAlert = (providerConnectionsFailing ?? 0) > 0 || (providerConnectionsStale ?? 0) > 0;

  // alert_outbox: صفوف معلَّقة (PENDING/RUNNING/RETRY لم تُعالَج بعد بنجاح
  // نهائي) وصفوف ميتة نهائياً (DEAD بعد استنفاد MAX_ATTEMPTS)، وتأخر أقدم
  // صف معلَّق — تنبيه فوري لو تعطّل الـworker بالكامل رغم وجود عمل بالطابور.
  // راجع البند (3) أعلى الملف — RETRY مُضافة الآن (لم تكن مشمولة سابقاً).
  const { count: outboxPending, error: outboxPendingError } = await supabaseAdmin
    .from('decision_alert_outbox')
    .select('id', { count: 'exact', head: true })
    .in('status', ['PENDING', 'RUNNING', 'RETRY']);
  trackError('outbox_pending', outboxPendingError);

  const { count: outboxDead, error: outboxDeadError } = await supabaseAdmin
    .from('decision_alert_outbox')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'DEAD');
  trackError('outbox_dead', outboxDeadError);

  const { data: oldestPendingOutboxRow, error: outboxOldestError } = await supabaseAdmin
    .from('decision_alert_outbox')
    .select('created_at')
    .in('status', ['PENDING', 'RUNNING', 'RETRY'])
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  trackError('outbox_oldest_pending', outboxOldestError);

  const oldestPendingMs = oldestPendingOutboxRow?.created_at ? new Date(oldestPendingOutboxRow.created_at).getTime() : null;
  const outboxLagSeconds = oldestPendingMs !== null ? Math.max(0, Math.round((nowMs - oldestPendingMs) / 1000)) : null;
  const outboxAlert = (outboxDead ?? 0) > 0 || (outboxLagSeconds !== null && outboxLagSeconds > OUTBOX_LAG_ALERT_SECONDS);

  // telemetry_queue: عمق الطابور حسب الحالة + عمر أقدم صف PENDING/PROCESSING
  // معلَّق + عدد DEAD — نفس مبدأ alert_outbox أعلاه بالضبط، مطبَّق على
  // telemetry_ingestion_queue (المرحلة 1-4 من خطة إعادة تصميم Telemetry).
  const { count: telemetryQueuePending, error: telemetryPendingError } = await supabaseAdmin
    .from('telemetry_ingestion_queue')
    .select('id', { count: 'exact', head: true })
    .in('status', ['PENDING', 'PROCESSING']);
  trackError('telemetry_queue_pending', telemetryPendingError);

  const { count: telemetryQueueDead, error: telemetryDeadError } = await supabaseAdmin
    .from('telemetry_ingestion_queue')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'DEAD');
  trackError('telemetry_queue_dead', telemetryDeadError);

  const { count: telemetryQueueProcessedLastHour, error: telemetryProcessedError } = await supabaseAdmin
    .from('telemetry_ingestion_queue')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'PROCESSED')
    .gte('processed_at', new Date(nowMs - 3600_000).toISOString());
  trackError('telemetry_queue_processed_last_hour', telemetryProcessedError);

  const { data: oldestPendingTelemetryRow, error: telemetryOldestError } = await supabaseAdmin
    .from('telemetry_ingestion_queue')
    .select('created_at')
    .in('status', ['PENDING', 'PROCESSING'])
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  trackError('telemetry_queue_oldest_pending', telemetryOldestError);

  const oldestTelemetryPendingMs = oldestPendingTelemetryRow?.created_at
    ? new Date(oldestPendingTelemetryRow.created_at).getTime()
    : null;
  const telemetryQueueLagSeconds =
    oldestTelemetryPendingMs !== null ? Math.max(0, Math.round((nowMs - oldestTelemetryPendingMs) / 1000)) : null;
  const telemetryQueueAlert =
    (telemetryQueueDead ?? 0) > 0 ||
    (telemetryQueueLagSeconds !== null && telemetryQueueLagSeconds > TELEMETRY_QUEUE_LAG_ALERT_SECONDS);

  // راجع البند (5) أعلى الملف — worker_heartbeats لعامل db-cleanup-worker
  // بدل db_cleanup_run_lock.started_at (كانت تُقاس كنجاح لمجرد بداية الدورة).
  const dbCleanupLagSeconds = workerLagSeconds('db-cleanup-worker');
  const dbCleanupWorkerRow = workerHeartbeatByName.get('db-cleanup-worker');
  const dbCleanupAlert =
    dbCleanupLagSeconds === null ||
    dbCleanupLagSeconds > DB_CLEANUP_STALE_SECONDS ||
    workerLastAttemptFailed('db-cleanup-worker');

  // evidence_growth: حجم القاعدة الكلي + أكبر 4 جداول أدلة (الأسرع نمواً
  // حسب القياس الفعلي 2026-08-10) — عتبات رقمية صريحة، لا "مراقبة صامتة
  // بلا نقطة قرار". get_database_and_table_sizes() قراءة فقط، لا تُنشئ أو
  // تحذف أي شيء.
  const { data: tableSizes, error: tableSizesError } = await supabaseAdmin.rpc('get_database_and_table_sizes');
  trackError('evidence_growth_sizes', tableSizesError);
  const sizesRows = (tableSizes ?? []) as Array<{ table_name: string; total_bytes: number; row_estimate: number | null }>;
  const totalDatabaseBytes = sizesRows.reduce((sum, row) => sum + (row.total_bytes ?? 0), 0);
  const largestEvidenceTables = sizesRows
    .filter((row) =>
      [
        'decision_records', 'dust_evaluations', 'dust_compliance_evaluations',
        'pm10_readings_history', 'alert_state_events', 'device_readings_history',
        'final_decisions', 'admin_audit_log', 'device_events', 'device_measurements',
      ].includes(row.table_name)
    )
    .sort((a, b) => b.total_bytes - a.total_bytes)
    .slice(0, 4);

  const dbSizeWarn = totalDatabaseBytes >= DB_SIZE_WARN_BYTES;
  const dbSizeAlert = totalDatabaseBytes >= DB_SIZE_ALERT_BYTES;
  const evidenceTableWarn = largestEvidenceTables.some((t) => t.total_bytes >= EVIDENCE_TABLE_WARN_BYTES);
  const evidenceTableAlert = largestEvidenceTables.some((t) => t.total_bytes >= EVIDENCE_TABLE_ALERT_BYTES);
  const evidenceGrowthAlert = dbSizeAlert || evidenceTableAlert;

  // evidence_integrity: استمرارية سلسلة التجزئة (آخر EVIDENCE_CHAIN_VERIFY_
  // WINDOW صفاً)، سلامة triggers الحماية على جداول الأدلة، وحداثة آخر
  // تثبيت خارجي ناجح على GitHub (من evidence_anchor_runs، أحدث صف بلا
  // error). أي انحراف في أي من الثلاثة = تلاعب محتمل أو تعطّل تشغيلي —
  // كلاهما يستحق التنبيه فوراً.
  const { data: chainVerifyRows, error: chainVerifyError } = await supabaseAdmin.rpc('verify_evidence_chain_tail', {
    p_window: EVIDENCE_CHAIN_VERIFY_WINDOW,
  });
  trackError('evidence_chain_verify', chainVerifyError);
  const chainRows = (chainVerifyRows ?? []) as Array<{ seq: number; is_valid: boolean }>;
  const chainBroken = chainRows.some((r) => !r.is_valid);

  // راجع تعليق EVIDENCE_SOURCE_VERIFY_WINDOW الكامل أعلاه — فحص منفصل عن
  // chainBroken: يكتشف تلاعباً بالصف المصدر نفسه، لا فقط بالدفتر.
  const { data: sourceVerifyRows, error: sourceVerifyError } = await supabaseAdmin.rpc('verify_evidence_source_integrity', {
    p_window: EVIDENCE_SOURCE_VERIFY_WINDOW,
  });
  trackError('evidence_source_verify', sourceVerifyError);
  const sourceRows = (sourceVerifyRows ?? []) as Array<{ seq: number; is_valid: boolean; source_row_missing: boolean }>;
  const sourceIntegrityBroken = sourceRows.some((r) => !r.is_valid || r.source_row_missing);

  const { data: triggerIntegrityRows, error: triggerIntegrityError } = await supabaseAdmin.rpc('check_evidence_trigger_integrity');
  trackError('evidence_trigger_integrity', triggerIntegrityError);
  const triggerRows = (triggerIntegrityRows ?? []) as Array<{ table_name: string; trigger_name: string; is_enabled: boolean }>;
  const disabledTriggers = triggerRows.filter((r) => !r.is_enabled);

  // خطأ مكتشَف (طلب صريح من المستخدم — مراجعة كود خارجي: "لا Backfill للأدلة
  // القديمة"): سلسلة التجزئة (append_evidence_hash_link، AFTER INSERT) تغطي
  // فقط الصفوف المُدرَجة بعد تركيبها — لا backfill حتمي بأثر رجعي (قرار
  // مستخدم صريح، راجع تعليق migration 202608120011 الكامل). قيمة معلوماتية
  // بحتة هنا (لا تُضاف لـevidenceIntegrityAlert — لا تتغيّر بمرور الوقت، فلا
  // معنى لتنبيه متكرر عليها)، تُعرَض صراحة حتى يعرف أي مراجع لاحق أن أي دليل
  // أقدم من هذا التاريخ غير مُغطّى بالسلسلة إطلاقاً.
  const { data: coverageStartedAt, error: coverageStartedAtError } = await supabaseAdmin.rpc('get_evidence_chain_coverage_started_at');
  trackError('evidence_chain_coverage_started_at', coverageStartedAtError);

  const { data: lastAnchorRun, error: lastAnchorError } = await supabaseAdmin
    .from('evidence_anchor_runs')
    .select('anchored_at, error')
    .is('error', null)
    .order('anchored_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  trackError('evidence_anchor_runs', lastAnchorError);

  // فهارس غير مستخدَمة (202608130004) — قراءة عدادات إحصائية داخلية بحتة
  // (pg_stat_user_indexes)، لا تُنفّذ أي I/O على الجداول نفسها. معلوماتي
  // بحت (لا يدخل alert): فهرس ميت اليوم قد يصبح مفيداً لاحقاً مع تغيّر
  // أنماط الاستعلام، فلا يستحق تنبيهاً صارماً — فقط ظهوراً دورياً هنا حتى
  // يراجعه مراجع بشري ويقرر الحذف يدوياً إن استمر بلا استخدام.
  const { data: unusedIndexRows, error: unusedIndexesError } = await supabaseAdmin.rpc('list_unused_indexes');
  trackError('unused_indexes', unusedIndexesError);
  const unusedIndexes = (unusedIndexRows ?? []) as Array<{
    table_name: string; index_name: string; index_bytes: number; times_used: number;
  }>;

  const lastAnchorMs = lastAnchorRun?.anchored_at ? new Date(lastAnchorRun.anchored_at).getTime() : null;
  const evidenceAnchorLagSeconds = lastAnchorMs !== null ? Math.max(0, Math.round((nowMs - lastAnchorMs) / 1000)) : null;
  const evidenceAnchorStale = evidenceAnchorLagSeconds === null || evidenceAnchorLagSeconds > EVIDENCE_ANCHOR_STALE_SECONDS;

  const evidenceIntegrityAlert = chainBroken || sourceIntegrityBroken || disabledTriggers.length > 0 || evidenceAnchorStale;

  // راجع البند (4) أعلى الملف — فشل أي استعلام قياس (بصرف النظر عن أي فحص
  // آخر) يُسقِط الصحة العامة صراحة، لا يتحول لصفر صحي بصمت.
  const queryErrorsAlert = queryErrors.length > 0;

  const alert =
    schedulerAlert ||
    providerAlert ||
    outboxAlert ||
    telemetryQueueAlert ||
    dbCleanupAlert ||
    evidenceGrowthAlert ||
    evidenceIntegrityAlert ||
    workerHealthAlert ||
    queryErrorsAlert;

  // خطأ مكتشَف ومُصلَح (طلب صريح من المستخدم — ربط هذا الـendpoint بمراقبة
  // خارجية فعلية UptimeRobot): كان يُرجع status 200 دائماً حتى مع alert=true
  // (فقط الحقل الداخلي يتغيّر) — أدوات المراقبة القياسية (UptimeRobot
  // Keyword/HTTP monitor) تكتشف فقط رمز HTTP فاشل، لا تقرأ حقول JSON
  // داخلية. الآن يُرجع 503 صراحةً عند alert=true فيُسجَّله UptimeRobot
  // كـ"Down" ويرسل التنبيه الفعلي (بريد/تطبيق) — لا تغيير على منطق الكشف
  // نفسه (schedulerAlert/providerAlert/outboxAlert)، فقط رمز الاستجابة.
  return NextResponse.json({
    ok: !alert,
    alert,
    query_errors: queryErrors,
    workers: workerStatuses,
    scheduler: {
      alert: schedulerAlert,
      scheduler_last_heartbeat_at: heartbeat?.last_heartbeat_at ?? null,
      jobs_due: jobsDue ?? 0,
      jobs_running: jobsRunning ?? 0,
      jobs_dead: jobsDead ?? 0,
      jobs_backlog_alert: jobsBacklogAlert,
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
    telemetry_queue: {
      alert: telemetryQueueAlert,
      pending_or_processing: telemetryQueuePending ?? 0,
      dead: telemetryQueueDead ?? 0,
      processed_last_hour: telemetryQueueProcessedLastHour ?? 0,
      oldest_pending_lag_seconds: telemetryQueueLagSeconds,
    },
    db_cleanup: {
      alert: dbCleanupAlert,
      last_run_succeeded_at: dbCleanupWorkerRow?.last_run_succeeded_at ?? null,
      last_run_failed_at: dbCleanupWorkerRow?.last_run_failed_at ?? null,
      lag_seconds: dbCleanupLagSeconds,
    },
    evidence_growth: {
      alert: evidenceGrowthAlert,
      warn: dbSizeWarn || evidenceTableWarn,
      total_database_bytes: totalDatabaseBytes,
      largest_evidence_tables: largestEvidenceTables.map((t) => ({
        table: t.table_name,
        bytes: t.total_bytes,
        approx_row_count: t.row_estimate ?? 0,
      })),
    },
    evidence_integrity: {
      alert: evidenceIntegrityAlert,
      chain_broken: chainBroken,
      chain_window_checked: chainRows.length,
      // راجع تعليق EVIDENCE_SOURCE_VERIFY_WINDOW أعلاه — منفصل عن chain_broken:
      // يكتشف تعديل/حذف الصف المصدر الفعلي، لا الدفتر فقط.
      source_integrity_broken: sourceIntegrityBroken,
      source_integrity_window_checked: sourceRows.length,
      source_rows_missing: sourceRows.filter((r) => r.source_row_missing).map((r) => r.seq),
      disabled_triggers: disabledTriggers.map((r) => ({ table: r.table_name, trigger: r.trigger_name })),
      last_successful_anchor_at: lastAnchorRun?.anchored_at ?? null,
      anchor_lag_seconds: evidenceAnchorLagSeconds,
      anchor_stale: evidenceAnchorStale,
      // راجع تعليق coverageStartedAt أعلاه — معلوماتي بحت، لا يدخل alert.
      // أي دليل بتاريخ أقدم من هذه القيمة غير مُغطّى بسلسلة التجزئة إطلاقاً.
      chain_coverage_started_at: coverageStartedAt ?? null,
    },
    db_maintenance: {
      // معلوماتي بحت — راجع تعليق unusedIndexRows أعلاه. لا alert هنا عمداً.
      unused_indexes: unusedIndexes.map((r) => ({
        table: r.table_name,
        index: r.index_name,
        bytes: r.index_bytes,
        times_used: r.times_used,
      })),
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
  }, { status: alert ? 503 : 200 });
}
