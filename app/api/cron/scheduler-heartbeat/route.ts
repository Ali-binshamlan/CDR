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
const HEARTBEAT_STALE_SECONDS = 180;
const PROVIDER_PULL_STALE_SECONDS = 300;
const OUTBOX_LAG_ALERT_SECONDS = 300;
const TELEMETRY_QUEUE_LAG_ALERT_SECONDS = 300;

// خطة الاحتفاظ طويلة المدى (معتمدة 2026-08-10) — قسمان إضافيان:
//   - db_cleanup: صحة عامل db-cleanup-worker نفسه (آخر تشغيلة ناجحة عبر
//     db_cleanup_run_lock) — يكشف تعطّل التنظيف نفسه، لا فقط تعطّل مسارات
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

  // telemetry_queue: عمق الطابور حسب الحالة + عمر أقدم صف PENDING/PROCESSING
  // معلَّق + عدد DEAD — نفس مبدأ alert_outbox أعلاه بالضبط، مطبَّق على
  // telemetry_ingestion_queue (المرحلة 1-4 من خطة إعادة تصميم Telemetry).
  const { count: telemetryQueuePending } = await supabaseAdmin
    .from('telemetry_ingestion_queue')
    .select('id', { count: 'exact', head: true })
    .in('status', ['PENDING', 'PROCESSING']);

  const { count: telemetryQueueDead } = await supabaseAdmin
    .from('telemetry_ingestion_queue')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'DEAD');

  const { count: telemetryQueueProcessedLastHour } = await supabaseAdmin
    .from('telemetry_ingestion_queue')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'PROCESSED')
    .gte('processed_at', new Date(nowMs - 3600_000).toISOString());

  const { data: oldestPendingTelemetryRow } = await supabaseAdmin
    .from('telemetry_ingestion_queue')
    .select('created_at')
    .in('status', ['PENDING', 'PROCESSING'])
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  const oldestTelemetryPendingMs = oldestPendingTelemetryRow?.created_at
    ? new Date(oldestPendingTelemetryRow.created_at).getTime()
    : null;
  const telemetryQueueLagSeconds =
    oldestTelemetryPendingMs !== null ? Math.max(0, Math.round((nowMs - oldestTelemetryPendingMs) / 1000)) : null;
  const telemetryQueueAlert =
    (telemetryQueueDead ?? 0) > 0 ||
    (telemetryQueueLagSeconds !== null && telemetryQueueLagSeconds > TELEMETRY_QUEUE_LAG_ALERT_SECONDS);

  // db_cleanup: آخر وقت تشغيل ناجح لـdb-cleanup-worker (من db_cleanup_run_lock،
  // أحدث started_at) — يكشف مبكراً تعطّل التنظيف نفسه (لا فقط تعطّل مسارات
  // الاستقبال/المعالجة). نفس منطق evaluationLagSeconds/schedulerAlert أعلاه،
  // مطبَّق على جدول القفل بدل scheduler_heartbeat.
  const { data: lastCleanupRun } = await supabaseAdmin
    .from('db_cleanup_run_lock')
    .select('started_at')
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const lastCleanupMs = lastCleanupRun?.started_at ? new Date(lastCleanupRun.started_at).getTime() : null;
  const dbCleanupLagSeconds = lastCleanupMs !== null ? Math.max(0, Math.round((nowMs - lastCleanupMs) / 1000)) : null;
  const dbCleanupAlert = dbCleanupLagSeconds === null || dbCleanupLagSeconds > DB_CLEANUP_STALE_SECONDS;

  // evidence_growth: حجم القاعدة الكلي + أكبر 4 جداول أدلة (الأسرع نمواً
  // حسب القياس الفعلي 2026-08-10) — عتبات رقمية صريحة، لا "مراقبة صامتة
  // بلا نقطة قرار". get_database_and_table_sizes() قراءة فقط، لا تُنشئ أو
  // تحذف أي شيء.
  const { data: tableSizes } = await supabaseAdmin.rpc('get_database_and_table_sizes');
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
  const { data: chainVerifyRows } = await supabaseAdmin.rpc('verify_evidence_chain_tail', {
    p_window: EVIDENCE_CHAIN_VERIFY_WINDOW,
  });
  const chainRows = (chainVerifyRows ?? []) as Array<{ seq: number; is_valid: boolean }>;
  const chainBroken = chainRows.some((r) => !r.is_valid);

  const { data: triggerIntegrityRows } = await supabaseAdmin.rpc('check_evidence_trigger_integrity');
  const triggerRows = (triggerIntegrityRows ?? []) as Array<{ table_name: string; trigger_name: string; is_enabled: boolean }>;
  const disabledTriggers = triggerRows.filter((r) => !r.is_enabled);

  const { data: lastAnchorRun } = await supabaseAdmin
    .from('evidence_anchor_runs')
    .select('anchored_at, error')
    .is('error', null)
    .order('anchored_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const lastAnchorMs = lastAnchorRun?.anchored_at ? new Date(lastAnchorRun.anchored_at).getTime() : null;
  const evidenceAnchorLagSeconds = lastAnchorMs !== null ? Math.max(0, Math.round((nowMs - lastAnchorMs) / 1000)) : null;
  const evidenceAnchorStale = evidenceAnchorLagSeconds === null || evidenceAnchorLagSeconds > EVIDENCE_ANCHOR_STALE_SECONDS;

  const evidenceIntegrityAlert = chainBroken || disabledTriggers.length > 0 || evidenceAnchorStale;

  const alert =
    schedulerAlert ||
    providerAlert ||
    outboxAlert ||
    telemetryQueueAlert ||
    dbCleanupAlert ||
    evidenceGrowthAlert ||
    evidenceIntegrityAlert;

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
    telemetry_queue: {
      alert: telemetryQueueAlert,
      pending_or_processing: telemetryQueuePending ?? 0,
      dead: telemetryQueueDead ?? 0,
      processed_last_hour: telemetryQueueProcessedLastHour ?? 0,
      oldest_pending_lag_seconds: telemetryQueueLagSeconds,
    },
    db_cleanup: {
      alert: dbCleanupAlert,
      last_run_at: lastCleanupRun?.started_at ?? null,
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
      disabled_triggers: disabledTriggers.map((r) => ({ table: r.table_name, trigger: r.trigger_name })),
      last_successful_anchor_at: lastAnchorRun?.anchored_at ?? null,
      anchor_lag_seconds: evidenceAnchorLagSeconds,
      anchor_stale: evidenceAnchorStale,
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
