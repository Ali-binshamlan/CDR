import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { timingSafeStringEqual } from '@/app/lib/timingSafe';

// خطة الاحتفاظ طويلة المدى (معتمدة 2026-08-10) — القسم 1: تنظيف الجداول
// العابرة الستة (بلا حماية append-only، بلا دليل قانوني):
// telemetry_ingestion_queue, decision_alert_outbox, project_evaluation_jobs
// (عمود status)، provider_pull_run_lock, scheduler_locks, forecast_snapshots
// (بلا عمود status، تنظيف بعمر بحت). db-cleanup-worker واحد يغطي الستة بدل
// ست routes/أسرار منفصلة — نفس مبدأ اقتصاد endpoints المراقبة الخارجية
// المُستخدَم في scheduler-heartbeat، مطبَّق هنا على عمّال الحذف الدوري.
//
// لا تُمس أي جداول أدلة هنا إطلاقاً — الحماية على 3 طبقات مستقلة: (1) هذه
// المصفوفات الثابتة لا تسمّي إلا الجداول الستة، (2) القائمة البيضاء داخل
// دوال SQL نفسها (cleanup_transient_table_batch[_by_age]) ترفض أي اسم آخر،
// (3) triggers forbid_evidence_mutation/forbid_evidence_truncate على جداول
// الأدلة نفسها ترفض أي DELETE بصرف النظر عن المستدعي.
//
// خطأ حرج مكتشَف ومُصلَح (مراجعة كود خارجي — "صفوف Telemetry الميتة تُحذف
// بعد سبعة أيام"): telemetry_ingestion_queue/DEAD هو الاستثناء الوحيد من
// "حذف مباشر بحت" ضمن الستة أعلاه — صف DEAD قد يكون النسخة الوحيدة
// الموجودة لقراءة جهاز حقيقية لم تُحفظ بنجاح بعد. راجع تعليق
// archive_dead_telemetry_batch أسفل هذا الملف وmigration 202608120002
// للتفصيل الكامل: يُنقَل الآن إلى telemetry_dead_letter الدائم (Replay أو
// اعتماد بشري موثَّق فقط يُخرجه من هناك لاحقاً)، لا حذف نهائي مباشر.
//
// نمط قفل تداخل الدورة: نفس provider_pull_run_lock/scheduler_locks حرفياً
// (PRIMARY KEY على نافذة زمنية 5 دقائق — أطول من نافذة provider-pull لأن
// هذه الدورة تنفّذ حتى 7 حذوفات دفعية متتالية، لا عملية واحدة خفيفة).
const RUN_BUCKET_SECONDS = 300;
const BATCH_LIMIT = 500;
// حد أقصى 20×500=10,000 صف محذوف لكل جدول لكل تشغيلة — يمنع تشغيلة واحدة
// من الاستحواذ على وقت غير محدود إذا تراكم Backlog ضخم.
const MAX_BATCHES_PER_TABLE = 20;

type StatusCleanupTarget = {
  table: string;
  timestampColumn: string;
  statusValues: string[];
  olderThan: string;
};

type AgeCleanupTarget = {
  table: string;
  timestampColumn: string;
  olderThan: string;
};

// نوافذ الاستبقاء — راجع خطة الاحتفاظ طويلة المدى للمبررات الكاملة لكل
// جدول. PENDING/RUNNING/RETRY (أي حالة نشطة) لا تُحذف أبداً في أي جدول.
// خطأ حرج مكتشَف ومُصلَح (مراجعة كود خارجي — "صفوف Telemetry الميتة تُحذف
// بعد سبعة أيام"): telemetry_ingestion_queue/DEAD كان ضمن STATUS_TARGETS
// أدناه — حذف مباشر نهائي عبر cleanup_transient_table_batch. صف DEAD يعني
// أن writeDeviceReading فشلت نهائياً (استنفدت MAX_ATTEMPTS في telemetry-
// worker)، وpayload هذا الصف هو النسخة الوحيدة الموجودة في كل النظام لتلك
// القراءة (لا نسخة أخرى في device_readings_history/pm10_readings_history —
// الكتابة هناك هي بالضبط ما فشل). حذفه = فقدان نهائي لدليل ميداني حقيقي
// بلا أي فرصة Replay أو مراجعة بشرية. أُزيل من هذه القائمة نهائياً — راجع
// archiveDeadTelemetryLetters أدناه: الآن يُنقَل (لا يُحذف) إلى
// telemetry_dead_letter الدائم (migration 202608120002)، ولا يُحذف من هناك
// إطلاقاً إلا بعد Replay ناجح أو اعتماد بشري موثَّق صراحةً (سبب إلزامي).
const STATUS_TARGETS: StatusCleanupTarget[] = [
  { table: 'telemetry_ingestion_queue', timestampColumn: 'processed_at', statusValues: ['PROCESSED'], olderThan: '24 hours' },
  { table: 'decision_alert_outbox', timestampColumn: 'processed_at', statusValues: ['PROCESSED'], olderThan: '7 days' },
  { table: 'decision_alert_outbox', timestampColumn: 'created_at', statusValues: ['DEAD'], olderThan: '30 days' },
  { table: 'project_evaluation_jobs', timestampColumn: 'completed_at', statusValues: ['SUCCEEDED'], olderThan: '7 days' },
  { table: 'project_evaluation_jobs', timestampColumn: 'created_at', statusValues: ['DEAD'], olderThan: '30 days' },
];

const AGE_TARGETS: AgeCleanupTarget[] = [
  { table: 'provider_pull_run_lock', timestampColumn: 'started_at', olderThan: '24 hours' },
  { table: 'scheduler_locks', timestampColumn: 'locked_at', olderThan: '24 hours' },
  { table: 'forecast_snapshots', timestampColumn: 'updated_at', olderThan: '14 days' },
  { table: 'db_cleanup_run_lock', timestampColumn: 'started_at', olderThan: '24 hours' },
];

// نفس نافذة 7 أيام السابقة قبل الأرشفة (لا حذف) — راجع تعليق STATUS_TARGETS
// أعلاه. archive_dead_telemetry_batch (migration 202608120002) تنقل الصف
// ذرّياً إلى telemetry_dead_letter الدائم ثم تحذفه من الطابور العابر فقط —
// لا حذف نهائي لأي بيانات، فقط انتقال من جدول عابر إلى جدول دائم.
const DEAD_TELEMETRY_ARCHIVE_OLDER_THAN = '7 days';

type CleanupResult = {
  table: string;
  column: string;
  status?: string[];
  deleted: number;
  batches: number;
  error?: string;
};

export async function GET(request: Request) {
  if (!process.env.DB_CLEANUP_CRON_SECRET) {
    return NextResponse.json({ ok: false, error: 'DB_CLEANUP_CRON_SECRET غير مُعرَّف بالخادم' }, { status: 503 });
  }
  const authHeader = request.headers.get('authorization') || '';
  if (!timingSafeStringEqual(authHeader, `Bearer ${process.env.DB_CLEANUP_CRON_SECRET}`)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const runBucket = Math.floor(Date.now() / (RUN_BUCKET_SECONDS * 1000));
  const { error: lockError } = await supabaseAdmin.from('db_cleanup_run_lock').insert({ run_bucket: runBucket });
  if (lockError) {
    // 23505 = دورة سابقة لا تزال قيد التنفيذ ضمن نفس النافذة — تخطَّ بأمان.
    return NextResponse.json({ ok: true, skipped: true, reason: 'previous cleanup run still in window' }, { status: 200 });
  }

  const results: CleanupResult[] = [];

  for (const target of STATUS_TARGETS) {
    let totalDeleted = 0;
    let batches = 0;
    let lastError: string | undefined;
    for (; batches < MAX_BATCHES_PER_TABLE; batches++) {
      const { data, error } = await supabaseAdmin.rpc('cleanup_transient_table_batch', {
        p_table_name: target.table,
        p_timestamp_column: target.timestampColumn,
        p_status_column: 'status',
        p_status_values: target.statusValues,
        p_older_than: target.olderThan,
        p_limit: BATCH_LIMIT,
      });
      if (error) {
        lastError = error.message;
        break;
      }
      const deleted = (data as number) ?? 0;
      totalDeleted += deleted;
      if (deleted < BATCH_LIMIT) break; // استُنفدت الدفعات المستحقة
    }
    results.push({ table: target.table, column: target.timestampColumn, status: target.statusValues, deleted: totalDeleted, batches: batches + 1, error: lastError });
  }

  for (const target of AGE_TARGETS) {
    let totalDeleted = 0;
    let batches = 0;
    let lastError: string | undefined;
    for (; batches < MAX_BATCHES_PER_TABLE; batches++) {
      const { data, error } = await supabaseAdmin.rpc('cleanup_transient_table_batch_by_age', {
        p_table_name: target.table,
        p_timestamp_column: target.timestampColumn,
        p_older_than: target.olderThan,
        p_limit: BATCH_LIMIT,
      });
      if (error) {
        lastError = error.message;
        break;
      }
      const deleted = (data as number) ?? 0;
      totalDeleted += deleted;
      if (deleted < BATCH_LIMIT) break;
    }
    results.push({ table: target.table, column: target.timestampColumn, deleted: totalDeleted, batches: batches + 1, error: lastError });
  }

  // أرشفة DEAD telemetry — لا حذف مباشر (راجع تعليق STATUS_TARGETS أعلاه).
  // "deleted" هنا تعني "نُقل من telemetry_ingestion_queue إلى telemetry_
  // dead_letter"، لا فقدان فعلي — نفس اسم الحقل في CleanupResult لبقاء شكل
  // استجابة موحَّد عبر كل الأهداف، القيمة نفسها تمثّل عدد الصفوف المؤرشَفة.
  {
    let totalArchived = 0;
    let batches = 0;
    let lastError: string | undefined;
    for (; batches < MAX_BATCHES_PER_TABLE; batches++) {
      const { data, error } = await supabaseAdmin.rpc('archive_dead_telemetry_batch', {
        p_older_than: DEAD_TELEMETRY_ARCHIVE_OLDER_THAN,
        p_limit: BATCH_LIMIT,
      });
      if (error) {
        lastError = error.message;
        break;
      }
      const archived = (data as number) ?? 0;
      totalArchived += archived;
      if (archived < BATCH_LIMIT) break;
    }
    results.push({
      table: 'telemetry_ingestion_queue→telemetry_dead_letter',
      column: 'created_at',
      status: ['DEAD'],
      deleted: totalArchived,
      batches: batches + 1,
      error: lastError,
    });
  }

  const failedCount = results.filter((r) => r.error).length;
  const totalDeleted = results.reduce((sum, r) => sum + r.deleted, 0);

  return NextResponse.json(
    {
      ok: failedCount === 0,
      checkedAt: new Date().toISOString(),
      runBucket,
      totalDeleted,
      results,
    },
    { status: failedCount === 0 ? 200 : 207 }
  );
}
