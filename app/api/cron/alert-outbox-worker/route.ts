import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { timingSafeStringEqual } from '@/app/lib/timingSafe';

// القسم 11.3/11.5 من "دليل الإصلاح الجذري لمنظومة مرقاب" — Outbox Worker:
// يستهلك decision_alert_outbox (يملؤه persist_activity_decision_atomic في
// نفس معاملة حفظ القرار، راجع 202608040013/202608040026) وينشئ/يغلق
// التنبيهات الفعلية عبر create_alert_atomic/close_alert_atomic (تقفل الصف،
// تقرأ الحالة، تكتب الحدث ذرياً — لا سباق alertExists/insertAlert
// المنفصلين). منفصل تماماً عن checkDustActivities (تذكيرات BEFORE_2H/1H/
// START التخطيطية تبقى في alerts/generate/route.ts كما هي — لا علاقة لها
// بالقرار الحي المحفوظ).
//
// خطأ مكتشَف ومُصلَح (مراجعة خبير خارجي — القسم 6: "Outbox: صف RUNNING لا
// يملك Lease Recovery فعّال، لا توجد نوايا CLOSE، alert_id لا يُحفظ فعلياً،
// العامل يهمل بعض أخطاء تحديث PROCESSED"): claim_alert_outbox_batch
// (202608040026) يستخدم FOR UPDATE SKIP LOCKED + Lease زمني حقيقي (نفس نمط
// claim_evaluation_jobs) بدل تحديث تفاؤلي بسيط بلا استرداد؛ complete_alert_
// outbox_row يحفظ alert_id فعلياً على الصف؛ action='CLOSE' يُعالَج عبر
// close_alert_atomic (تنوَى الآن فعلياً من persist_activity_decision_atomic
// عند تحسّن القرار، لا "يقارن العامل لاحقاً" كما كان موصوفاً بلا تنفيذ).
//
// deriveAlertMessage نقية بالكامل (بلا DB/fetch/إعادة حساب DVI) — تبني نص
// التنبيه من payload المخزَّن في صف الـOutbox نفسه فقط (القسم 11.4).
//
// مصادقة عبر ALERT_OUTBOX_CRON_SECRET — متغير بيئة منفصل عن باقي أسرار
// الـcron، بنفس مبدأ الفصل الموثَّق في provider-pull/scheduler-tick.
//
// يُستدعى خارجياً كل دقيقة أو دقيقتين عبر خدمة cron مجانية (cron-job.org) —
// لا إضافة لـvercel.json (خطة Vercel Hobby لا تدعم جدولة أقل من يومية).
//
// خطأ مكتشَف ومُصلَح (مراجعة كود خارجي — "ملكية Lease غير آمنة في
// العمال"، راجع migration 202608110018 الكامل): BATCH_SIZE خُفِّض من 50
// (نفس سبب telemetry-worker) — renew_alert_outbox_lease (استدعاء جديد
// أدناه، قبل معالجة كل صف) هو خط الدفاع الفعلي، ودفعة أصغر تقلّل عدد
// الصفوف المعرَّضة لخطر انتهاء المهلة قبل الوصول إليها.
const BATCH_SIZE = 20;
const LEASE_SECONDS = 60;
const MAX_ATTEMPTS = 5;

interface OutboxRow {
  id: string;
  final_decision_id: string;
  project_id: string;
  activity_group_id: string;
  activity_id: string;
  kind: 'SAFETY_BREACH' | 'COMPLIANCE_VIOLATION' | 'COMPLIANCE_RESTRICTION';
  action: 'OPEN' | 'CLOSE';
  payload: { shortReasonAr?: string; decisionLabelAr?: string; mandatoryStop?: string; level?: string };
  attempts: number;
}

// دالة نقية — القسم 11.4: لا DB، لا fetch، لا إعادة حساب DVI. تبني نص
// التنبيه حصراً من payload المخزَّن مسبقاً في صف الـOutbox.
function deriveAlertMessage(row: OutboxRow): {
  message: string;
  recommendedAction: string;
  metricLabel: string | null;
  metricThreshold: string | null;
} {
  const reason = row.payload?.shortReasonAr || row.payload?.decisionLabelAr || 'قرار تشغيلي يستوجب المراجعة';
  if (row.kind === 'SAFETY_BREACH') {
    return {
      message: `تجاوز حد صارم — إيقاف إلزامي: ${reason}`,
      recommendedAction: row.payload?.decisionLabelAr || 'إيقاف إلزامي نظامي',
      metricLabel: 'القرار التشغيلي',
      metricThreshold: 'إيقاف إلزامي',
    };
  }
  return {
    message: reason,
    recommendedAction: reason,
    metricLabel: null,
    metricThreshold: null,
  };
}

export async function GET(request: Request) {
  if (!process.env.ALERT_OUTBOX_CRON_SECRET) {
    return NextResponse.json({ ok: false, error: 'ALERT_OUTBOX_CRON_SECRET غير مُعرَّف بالخادم' }, { status: 503 });
  }
  const authHeader = request.headers.get('authorization') || '';
  if (!timingSafeStringEqual(authHeader, `Bearer ${process.env.ALERT_OUTBOX_CRON_SECRET}`)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const workerId = crypto.randomUUID();

  const { data: rows, error: claimError } = await supabaseAdmin.rpc('claim_alert_outbox_batch', {
    p_worker_id: workerId,
    p_batch_size: BATCH_SIZE,
    p_lease_seconds: LEASE_SECONDS,
  });

  if (claimError) {
    return NextResponse.json({ ok: false, error: claimError.message }, { status: 500 });
  }

  const results: Array<{ id: string; ok: boolean; alertId?: string | null; error?: string }> = [];

  // تسلسلي عمداً — نفس مبدأ باقي عمال الـcron في هذا المشروع.
  for (const row of (rows || []) as OutboxRow[]) {
    // خطأ مكتشَف ومُصلَح (مراجعة كود خارجي — "ملكية Lease غير آمنة في
    // العمال"): تجديد Lease قبل معالجة كل صف — راجع تعليق telemetry-
    // worker/route.ts المطابق تماماً لسبب التوقّف الفوري بلا fail عند false.
    const renewed = await supabaseAdmin.rpc('renew_alert_outbox_lease', {
      p_row_id: row.id,
      p_worker_id: workerId,
      p_lease_seconds: LEASE_SECONDS,
    });
    if (renewed.error || !renewed.data) {
      results.push({ id: row.id, ok: false, error: 'lease لم يعد يطابق (استرجعه عامل آخر) — تم التخطي بلا معالجة' });
      continue;
    }

    try {
      let alertId: string | null;

      if (row.action === 'CLOSE') {
        const { data, error: rpcError } = await supabaseAdmin.rpc('close_alert_atomic', {
          p_project_id: row.project_id,
          p_activity_id: row.activity_id,
          p_kind: row.kind,
        });
        if (rpcError) throw new Error(rpcError.message);
        alertId = (data as string | null) ?? null;
      } else {
        const { message, recommendedAction, metricLabel, metricThreshold } = deriveAlertMessage(row);
        const { data, error: rpcError } = await supabaseAdmin.rpc('create_alert_atomic', {
          p_project_id: row.project_id,
          p_activity_id: row.activity_id,
          p_timing: 'DURING',
          p_kind: row.kind,
          p_message: message,
          p_viewer_message: row.kind === 'COMPLIANCE_VIOLATION' ? message : null,
          p_metric_label: metricLabel,
          p_metric_actual: null,
          p_metric_threshold: metricThreshold,
          p_recommended_action: recommendedAction,
          p_opened_by_final_decision_id: row.final_decision_id,
        });
        if (rpcError) throw new Error(rpcError.message);
        alertId = data as string;
      }

      const { data: completed, error: completeError } = await supabaseAdmin.rpc('complete_alert_outbox_row', {
        p_row_id: row.id,
        p_worker_id: workerId,
        p_alert_id: alertId,
      });
      // خطأ مكتشَف ومُصلَح (مراجعة خبير خارجي — "العامل يهمل بعض أخطاء
      // تحديث PROCESSED"، ومراجعة كود خارجي لاحقة — "ملكية Lease غير آمنة
      // في العمال"): فشل/عدم تحقق complete_alert_outbox_row يعني عامل آخر
      // استرجع الصف بعد انتهاء Lease هذا العامل — لكن create_alert_atomic/
      // close_alert_atomic أعلاه نجحا فعلياً بالفعل (التنبيه أُنشئ/أُغلق في
      // قاعدة البيانات). استدعاء fail_alert_outbox_row هنا كان سيُعيد صفاً
      // بات مسؤولية عامل آخر إلى RETRY/DEAD زوراً رغم نجاح العملية الفعلية
      // — لا يجوز أن يمر عبر catch أدناه (الذي يستدعي fail لكل خطأ بلا
      // تمييز). يُبلَّغ فشلاً في results مباشرة هنا، بلا catch، وبلا fail.
      if (completeError || !completed) {
        results.push({
          id: row.id,
          ok: false,
          alertId,
          error: completeError?.message || 'complete_alert_outbox_row: lease لم يعد يطابق (استرجعه عامل آخر) رغم نجاح العملية',
        });
        continue;
      }

      results.push({ id: row.id, ok: true, alertId });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`alert-outbox-worker: failed to process outbox row ${row.id}:`, message);
      const { data: failed, error: failRpcError } = await supabaseAdmin.rpc('fail_alert_outbox_row', {
        p_row_id: row.id,
        p_worker_id: workerId,
        p_error: message,
        p_max_attempts: MAX_ATTEMPTS,
      });
      // خطأ مكتشَف ومُصلَح (مراجعة كود خارجي — "دوال fail_* لا تتحقق من
      // worker_id"): fail_alert_outbox_row تُرجع الآن boolean — false/خطأ
      // هنا يعني عامل آخر بات يملك الصف؛ لا إجراء إضافي مطلوب، فقط الإبلاغ
      // الصحيح في النتيجة (نفس مبدأ telemetry-worker/scheduler-worker).
      results.push({
        id: row.id,
        ok: false,
        error: failRpcError || !failed ? `${message} (lease لم يعد يطابق عند fail)` : message,
      });
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
