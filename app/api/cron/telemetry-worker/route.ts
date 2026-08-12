import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { timingSafeStringEqual } from '@/app/lib/timingSafe';
import { writeDeviceReading } from '@/app/lib/deviceReadingWriter';
import type { NormalizedReading } from '@/app/lib/providers/types';

// المرحلتان 3+4 من إعادة تصميم مسار استقبال Telemetry (طُبِّقت بموافقة
// صريحة 2026-08-09) — معالجة القراءات المتراكمة في telemetry_ingestion_queue،
// منفصلة زمنياً تماماً عن provider-pull (الذي أصبح Ingestion فقط).
//
// نمط Claim → Commit → Process — نفس بنية scheduler-worker/route.ts
// حرفياً: claim_telemetry_queue (RPC مستقلة، معاملتها الخاصة تنتهي فور
// إرجاع الدفعة — لا قفل يبقى مفتوحاً أثناء المعالجة الفعلية أدناه)، ثم
// معالجة كل صف عبر writeDeviceReading (بلا أي تعديل على الدالة نفسها —
// فقط مكان استدعائها تغيّر)، ثم complete/fail عبر RPC منفصل لكل صف.
//
// Batch/Grouping: الصفوف المُطالَب بها تُجمَّع حسب (project_id, device_id)
// فقط لغرض تتبّع المشاريع المتأثرة إجمالاً (Evaluation Coalescing، مرحلة
// لاحقة) — الكتابة الفعلية في pm10_readings_history تبقى صفاً واحداً لكل
// عينة مصدر حقيقية، بلا أي تجميع/تلخيص لمحتوى القراءات (حفاظاً على منطق
// استمرارية PM10 الذي يعتمد على فجوات بين صفوف مخزَّنة فعلياً).
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

  const { data: rows, error: claimError } = await supabaseAdmin.rpc('claim_telemetry_queue', {
    p_worker_id: workerId,
    p_batch_size: BATCH_SIZE,
    p_lease_seconds: LEASE_SECONDS,
  });

  if (claimError) {
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
  // يفوّت مخالفة كاملة"، راجع migration 202608110019 الكامل): كانت مجموعة
  // (Set<string>) بسيطة لمعرّفات المشاريع فقط — كافية لإنشاء مهمة واحدة لكل
  // مشروع، لكنها تفقد أي تمييز بين دقائق الرصد المختلفة داخل نفس الدفعة.
  // الآن Map<projectId, Set<observedMinuteBucket>> — لكل قراءة نُجحت
  // كتابتها فعلياً، نُسجِّل دقيقة observedAt الفعلية (لا دقيقة معالجة
  // الدفعة) ضمن مجموعة دقائق ذلك المشروع. دفعة تحوي 350←355←360 (دقيقة
  // observed=12:03) ثم 100 (دقيقة observed=12:05) لنفس المشروع تُنتج الآن
  // مهمتَي تقييم منفصلتين — كل واحدة evaluation_at الخاص بها — بدل مهمة
  // واحدة تفقد رؤية التجاوز خلف القراءة الأحدث.
  const affectedMinutesByProject = new Map<string, Set<number>>();

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
        const { data: completed, error: completeError } = await supabaseAdmin.rpc('complete_telemetry_queue_row', {
          p_row_id: row.id,
          p_worker_id: workerId,
        });
        // خطأ مكتشَف ومُصلَح (مراجعة كود خارجي — "نتائج complete لا تُفحص
        // في Scheduler/Telemetry"): الاستدعاء القديم كان يتجاهل النتيجة
        // كلياً — لو لم يعد worker_id يطابق (عامل آخر استرجع الصف بين
        // renew أعلاه وcomplete هنا، نافذة ضيقة لكن ممكنة)، كانت النتيجة
        // تُبلَّغ "نجاح" رغم أن الصف نفسه قد لا يعكس ذلك فعلياً. الآن:
        // false/خطأ يُبلَّغ صراحة، ولا يُستدعى fail بعده (نفس مبدأ renew
        // أعلاه — القراءة نُجحت وكُتبت فعلياً في device_readings_history
        // عبر writeDeviceReading، فاستدعاء fail هنا كان سيُعيد صفاً بات
        // مسؤولية عامل آخر إلى RETRY/DEAD زوراً، رغم نجاح الكتابة الفعلية).
        if (completeError || !completed) {
          results.push({
            rowId: row.id,
            projectId: row.project_id,
            ok: false,
            error: completeError?.message || 'complete_telemetry_queue_row: lease لم يعد يطابق (استرجعه عامل آخر) رغم نجاح الكتابة',
          });
        } else {
          results.push({ rowId: row.id, projectId: row.project_id, ok: true });
          // خطأ مكتشَف ومُصلَح (مراجعة كود خارجي — "التقييم بحسب وقت
          // المعالجة قد يفوّت مخالفة كاملة"): دقيقة الرصد الفعلية
          // (observedAtIso القراءة نفسها) لا دقيقة معالجة الدفعة —
          // غياب observedAtIso (نظرياً فقط، provider-pull يُرسله دائماً)
          // يسقط لوقت المعالجة الحالي كفشل آمن، لا كسر.
          const observedMs = row.payload.observedAtIso ? new Date(row.payload.observedAtIso).getTime() : Date.now();
          const observedMinuteBucket = Math.floor(observedMs / 60_000);
          const minutes = affectedMinutesByProject.get(row.project_id) ?? new Set<number>();
          minutes.add(observedMinuteBucket);
          affectedMinutesByProject.set(row.project_id, minutes);
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

  // ===================================================================
  // Evaluation Coalescing — إلزامي من أول تنفيذ (لا استدعاء evaluateProject
  // مباشر هنا إطلاقاً). نفس نمط enqueueEvaluationRetryJob المُصلَح سابقاً
  // (evaluateProject.ts): مفتاح مستقر لكل (مشروع، دقيقة رصد)، القيد الفريد
  // unique(project_id, dedupe_key) الموجود بالفعل على project_evaluation_jobs
  // يضمن بنيوياً أن عدة قراءات لنفس المشروع خلال نفس دقيقة الرصد تُنتج
  // مهمة تقييم واحدة فقط.
  //
  // خطأ مكتشَف ومُصلَح (مراجعة كود خارجي — "التقييم بحسب وقت المعالجة قد
  // يفوّت مخالفة كاملة"، راجع migration 202608110019 الكامل): dedupe_key
  // كان `ingest:${minuteBucket}` مبنياً من دقيقة *معالجة* الدفعة (وقت
  // تشغيل هذا العامل تحديداً) — دفعة واحدة تحوي قراءات من عدة دقائق رصد
  // مختلفة (350←355←360 ثم 100، كل الأربعة عولجت في نفس التشغيلة) كانت
  // تُنتج مهمة تقييم واحدة فقط، فيرى evaluateProject لاحقاً آخر حالة فقط
  // (100، الآمنة) ويفوّت حلقة التجاوز كاملة. الآن: مهمة منفصلة لكل (مشروع،
  // دقيقة رصد فعلية) — dedupe_key يتضمن دقيقة الرصد نفسها، وevaluation_at
  // (عمود جديد) يحمل نهاية تلك الدقيقة بالضبط، ليعيد evaluateProject/
  // computeDustComplianceResults/fetchPm10SustainedStatus بناء الحالة "كما
  // كانت" عند تلك اللحظة تحديداً (راجع تعديلات dustEvaluation.ts/
  // evaluateProject.ts المرافقة) بدل "الآن الفعلي" وقت تنفيذ scheduler-worker.
  // scheduler-worker (بلا تعديل في هذا القسم) يستهلك كل مهمة كالمعتاد.
  // ===================================================================
  const enqueuedProjectIds: string[] = [];
  for (const [projectId, minuteBuckets] of affectedMinutesByProject) {
    let enqueuedForProject = false;
    for (const minuteBucket of minuteBuckets) {
      // نهاية دقيقة الرصد (لا بدايتها) — يضمن أن كل قراءة وقعت فعلياً ضمن
      // تلك الدقيقة تكون "ماضية" بالنسبة لـevaluation_at، فتدخل أي نافذة
      // استمرار تُحسَب انتهاءً بهذه اللحظة (fetchPm10SustainedStatus).
      const evaluationAtIso = new Date((minuteBucket + 1) * 60_000 - 1).toISOString();
      const { error: enqueueError } = await supabaseAdmin.from('project_evaluation_jobs').insert({
        project_id: projectId,
        dedupe_key: `ingest:${minuteBucket}`,
        trigger_type: 'DEVICE_EVENT',
        evaluation_at: evaluationAtIso,
      });
      // تعارض 23505 (نفس المشروع، نفس دقيقة الرصد) يعني مهمة موحَّدة موجودة
      // بالفعل — فشل آمن متوقَّع، لا يُسجَّل كخطأ حقيقي.
      if (!enqueueError) {
        enqueuedForProject = true;
      }
    }
    if (enqueuedForProject) {
      enqueuedProjectIds.push(projectId);
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
      affectedProjects: affectedMinutesByProject.size,
      evaluationJobsEnqueued: enqueuedProjectIds.length,
    },
    { status }
  );
}
