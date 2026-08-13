import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { timingSafeStringEqual } from '@/app/lib/timingSafe';
import { writeDeviceReading } from '@/app/lib/deviceReadingWriter';
import { recordWorkerHeartbeat } from '@/app/lib/workerHeartbeat';
import type { NormalizedReading } from '@/app/lib/providers/types';

const WORKER_NAME = 'telemetry-worker';

// المرحلتان 3+4 من إعادة تصميم مسار استقبال Telemetry (طُبِّقت بموافقة
// صريحة 2026-08-09) — معالجة القراءات المتراكمة في telemetry_ingestion_queue،
// منفصلة زمنياً تماماً عن provider-pull (الذي أصبح Ingestion فقط).
//
// نمط Claim → Commit → Process — نفس بنية scheduler-worker/route.ts
// حرفياً: claim_telemetry_queue (RPC مستقلة، معاملتها الخاصة تنتهي فور
// إرجاع الدفعة — لا قفل يبقى مفتوحاً أثناء المعالجة الفعلية أدناه)، ثم
// معالجة كل صف عبر writeDeviceReading (بلا أي تعديل على الدالة نفسها —
// فقط مكان استدعائها تغيّر)، ثم complete+enqueue-evaluation-job ذرّياً معاً
// (أو fail) لكل صف — راجع تعليق complete_telemetry_queue_row_and_enqueue_job
// أدناه (migration 202608120007).
//
// الكتابة الفعلية في pm10_readings_history صف واحد لكل عينة مصدر حقيقية،
// بلا أي تجميع/تلخيص لمحتوى القراءات (حفاظاً على منطق استمرارية PM10 الذي
// يعتمد على فجوات بين صفوف مخزَّنة فعلياً) — Evaluation Coalescing (مهمة
// تقييم واحدة لكل (مشروع، دقيقة رصد)) يحدث فقط على مستوى project_evaluation_jobs
// عبر القيد الفريد unique(project_id, dedupe_key)، لا على صفوف الأدلة نفسها.
//
// لا Promise.race/withTimeout هنا — writeDeviceReading نفسها لا تستدعي
// شبكة خارجية (كل عملها DB بحتة عبر RPC واحدة تحمل SET LOCAL lock_timeout/
// statement_timeout من الداخل)، فلا حاجة لغلاف مهلة جانب العميل.
//
// خطأ مكتشَف ومُصلَح (مراجعة كود خارجي — "ملكية Lease غير آمنة في
// العمال"، راجع migration 202608110018 الكامل): BATCH_SIZE خُفِّض من 50 —
// دفعة كبيرة تُعالَج تسلسلياً بلا أي تجديد Lease كانت تخاطر بانتهاء مهلة
// صفوف لاحقة في الدفعة قبل الوصول إليها (كل صف بطيء واحد يستهلك من نفس
// مهلة الـ60 ثانية المشتركة لكل الدفعة). renew_telemetry_queue_lease
// (استدعاء جديد أدناه، قبل معالجة كل صف) يبقى خط الدفاع الأساسي بصرف
// النظر عن حجم الدفعة — لكن دفعة أصغر تقلّل عدد الصفوف المعرَّضة لخطر
// انتهاء المهلة بين المطالبة وبدء معالجة صف بعيد في الدفعة.
const BATCH_SIZE = 20;
const LEASE_SECONDS = 60;
const MAX_ATTEMPTS = 5;

export async function GET(request: Request) {
  if (!process.env.TELEMETRY_WORKER_CRON_SECRET) {
    return NextResponse.json({ ok: false, error: 'TELEMETRY_WORKER_CRON_SECRET غير مُعرَّف بالخادم' }, { status: 503 });
  }
  const authHeader = request.headers.get('authorization') || '';
  if (!timingSafeStringEqual(authHeader, `Bearer ${process.env.TELEMETRY_WORKER_CRON_SECRET}`)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const workerId = crypto.randomUUID();
  await recordWorkerHeartbeat(WORKER_NAME, 'started');

  const { data: rows, error: claimError } = await supabaseAdmin.rpc('claim_telemetry_queue', {
    p_worker_id: workerId,
    p_batch_size: BATCH_SIZE,
    p_lease_seconds: LEASE_SECONDS,
  });

  if (claimError) {
    await recordWorkerHeartbeat(WORKER_NAME, 'failed', claimError.message);
    return NextResponse.json({ ok: false, error: claimError.message }, { status: 500 });
  }

  const claimedRows = (rows || []) as Array<{
    id: string;
    idempotency_key: string;
    project_id: string;
    device_id: string;
    payload: NormalizedReading;
  }>;

  const results: Array<{ rowId: string; projectId: string; ok: boolean; error?: string }> = [];
  // خطأ مكتشَف ومُصلَح (مراجعة كود خارجي — "التقييم بحسب وقت المعالجة قد
  // يفوّت مخالفة كاملة"، راجع migration 202608110019 الكامل): مهمة تقييم
  // منفصلة لكل (مشروع، دقيقة رصد فعلية) — dedupe_key يتضمن دقيقة الرصد نفسها
  // (لا دقيقة معالجة الدفعة)، فدفعة تحوي قراءات من عدة دقائق رصد مختلفة
  // لنفس المشروع تُنتج مهام تقييم منفصلة تلقائياً (القيد الفريد unique
  // (project_id, dedupe_key) يمنع التكرار داخل نفس الدقيقة فقط).
  //
  // خطأ مكتشَف ومُصلَح (طلب صريح من المستخدم — "يتم ACK للقراءة قبل ضمان
  // إنشاء مهمة تقييم"): كل صف يُنشئ مهمته الخاصة ذرّياً مع تحويله PROCESSED
  // (عبر complete_telemetry_queue_row_and_enqueue_job أدناه) — لا حلقة دفعية
  // منفصلة بعد انتهاء المعالجة كما كان سابقاً؛ enqueuedProjectIds هنا للتقرير
  // النهائي فقط (أي مشروع أنشأ مهمة تقييم فعلية واحدة على الأقل هذه الدورة).
  const enqueuedProjectIds = new Set<string>();

  // تسلسلي عمداً — نفس مبدأ scheduler-worker/provider-pull: يبسّط تتبع
  // الفشل الجزئي، ويحافظ على ترتيب observedAt التصاعدي داخل نفس الجهاز
  // (writeDeviceReading يعتمد على هذا الترتيب لتحديث last_*_at بأمان).
  for (const row of claimedRows) {
    // خطأ مكتشَف ومُصلَح (مراجعة كود خارجي — "ملكية Lease غير آمنة في
    // العمال"): تجديد Lease *قبل* معالجة كل صف (لا دفعة كاملة بلا تجديد) —
    // false يعني فقدان الملكية فعلياً قبل حتى البدء (عامل آخر استرجع الصف
    // بعد انتهاء lease هذا العامل، سيناريو نادر لكن ممكن مع دفعات بطيئة) —
    // يُتخطَّى الصف فوراً بلا أي معالجة أو استدعاء fail (لا داعي: العامل
    // الآخر مسؤول عنه الآن، أي تدخّل هنا قد يتصادم مع معالجته الفعلية).
    const renewed = await supabaseAdmin.rpc('renew_telemetry_queue_lease', {
      p_row_id: row.id,
      p_worker_id: workerId,
      p_lease_seconds: LEASE_SECONDS,
    });
    if (renewed.error || !renewed.data) {
      results.push({ rowId: row.id, projectId: row.project_id, ok: false, error: 'lease لم يعد يطابق (استرجعه عامل آخر) — تم التخطي بلا معالجة' });
      continue;
    }

    try {
      const writeResult = await writeDeviceReading({
        deviceId: row.device_id,
        projectId: row.project_id,
        reading: row.payload,
        externalEventId: row.idempotency_key,
      });

      if (writeResult.success) {
        // خطأ مكتشَف ومُصلَح (طلب صريح من المستخدم — مراجعة كود خارجي: "يتم
        // ACK للقراءة قبل ضمان إنشاء مهمة تقييم"): complete_telemetry_queue_row
        // وإدراج project_evaluation_jobs كانا استدعاءين منفصلين تماماً (هذا
        // الأخير في حلقة لاحقة بعد انتهاء معالجة الدفعة بالكامل) — فشل
        // الإدراج (لأي سبب غير تعارض 23505 المتوقَّع) كان يُبتلَع بصمت بعد أن
        // أصبح الصف PROCESSED بالفعل: القراءة مكتوبة كدليل، لكن لا مهمة
        // تقييم تُنشأ أبداً لتلك الدقيقة. complete_telemetry_queue_row_and_
        // enqueue_job (migration 202608120007) تدمج الثلاثة (تحقق الملكية +
        // إدراج المهمة أو اكتشاف تعارض 23505 + تحويل الصف PROCESSED) في
        // معاملة SQL واحدة — تنجح معاً أو تفشل معاً؛ أي خطأ غير 23505 يُلغي
        // المعاملة بأكملها فيعود الصف PROCESSING كما كان (لا PROCESSED بلا
        // مهمة مقابلة).
        //
        // دقيقة الرصد الفعلية (observedAtIso القراءة نفسها) لا دقيقة معالجة
        // الدفعة — راجع تعليق migration 202608110019 الكامل لسبب هذا التمييز.
        const observedMs = row.payload.observedAtIso ? new Date(row.payload.observedAtIso).getTime() : Date.now();
        const observedMinuteBucket = Math.floor(observedMs / 60_000);
        const evaluationAtIso = new Date((observedMinuteBucket + 1) * 60_000 - 1).toISOString();

        const { data: completeData, error: completeError } = await supabaseAdmin.rpc(
          'complete_telemetry_queue_row_and_enqueue_job',
          {
            p_row_id: row.id,
            p_worker_id: workerId,
            p_project_id: row.project_id,
            p_dedupe_key: `ingest:${observedMinuteBucket}`,
            p_trigger_type: 'DEVICE_EVENT',
            p_evaluation_at: evaluationAtIso,
          }
        );
        const completeResult = completeData?.[0] as { row_completed?: boolean; job_enqueued?: boolean } | undefined;

        if (completeError || !completeResult?.row_completed) {
          results.push({
            rowId: row.id,
            projectId: row.project_id,
            ok: false,
            error: completeError?.message || 'complete_telemetry_queue_row_and_enqueue_job: lease لم يعد يطابق (استرجعه عامل آخر) رغم نجاح الكتابة',
          });
        } else {
          results.push({ rowId: row.id, projectId: row.project_id, ok: true });
          if (completeResult.job_enqueued) {
            enqueuedProjectIds.add(row.project_id);
          }
        }
      } else {
        const { data: failed, error: failRpcError } = await supabaseAdmin.rpc('fail_telemetry_queue_row', {
          p_row_id: row.id,
          p_worker_id: workerId,
          p_error: writeResult.error,
          p_max_attempts: MAX_ATTEMPTS,
        });
        // خطأ مكتشَف ومُصلَح (مراجعة كود خارجي — "دوال fail_* لا تتحقق من
        // worker_id"): fail_telemetry_queue_row تُرجع الآن boolean —
        // failRpcError/!failed لا يعني بالضرورة خطأً تقنياً، بل قد يعني
        // أن عامل آخر بات يملك الصف (استرجعه بعد انتهاء lease هذا العامل)
        // — لا حاجة لأي إجراء إضافي هنا، فقط الإبلاغ الصحيح في النتيجة.
        results.push({
          rowId: row.id,
          projectId: row.project_id,
          ok: false,
          error: failRpcError || !failed ? `${writeResult.error} (lease لم يعد يطابق عند fail)` : writeResult.error,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`telemetry-worker: writeDeviceReading threw for row ${row.id}:`, message);
      await supabaseAdmin.rpc('fail_telemetry_queue_row', {
        p_row_id: row.id,
        p_worker_id: workerId,
        p_error: message,
        p_max_attempts: MAX_ATTEMPTS,
      });
      results.push({ rowId: row.id, projectId: row.project_id, ok: false, error: message });
    }
  }

  const failedCount = results.filter((r) => !r.ok).length;
  const status = results.length === 0 || failedCount === 0 ? 200 : failedCount === results.length ? 502 : 207;

  // خطأ مكتشَف ومُصلَح (طلب صريح من المستخدم — مراجعة كود خارجي: "Health
  // endpoint قد يظهر أخضر رغم تعطل النظام"): "نجاح" هنا يعني "الدورة نفسها
  // اكتملت بلا استثناء غير متوقَّع" (نفس معنى status<502 أعلاه) — فشل جزئي
  // لصف واحد ضمن دفعة أكبر (207) لا يزال دورة عاملة، فيُسجَّل succeeded لا
  // failed؛ فقط فشل الدورة بأكملها (claimError أعلاه، أو كل الصفوف فشلت
  // معاً) يُسجَّل failed.
  if (status === 502) {
    await recordWorkerHeartbeat(WORKER_NAME, 'failed', `${failedCount}/${results.length} صفوف فشلت`);
  } else {
    await recordWorkerHeartbeat(WORKER_NAME, 'succeeded');
  }

  return NextResponse.json(
    {
      ok: failedCount === 0,
      checkedAt: new Date().toISOString(),
      workerId,
      claimed: results.length,
      failed: failedCount,
      results,
      evaluationJobsEnqueued: enqueuedProjectIds.size,
    },
    { status }
  );
}
