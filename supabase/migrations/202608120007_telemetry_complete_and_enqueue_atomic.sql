-- =====================================================================
-- DCR — 202608120007_telemetry_complete_and_enqueue_atomic.sql
-- =====================================================================
-- خطأ مكتشَف ومُصلَح (طلب صريح من المستخدم — مراجعة كود خارجي: "يتم ACK
-- للقراءة قبل ضمان إنشاء مهمة تقييم"): telemetry-worker/route.ts كان
-- يستدعي complete_telemetry_queue_row (يضبط الصف PROCESSED) في حلقة معالجة
-- الصفوف، ثم — بعد انتهاء تلك الحلقة بالكامل، في حلقة منفصلة تماماً بلا أي
-- رابط معاملاتي — يُدرج صفوف project_evaluation_jobs (Evaluation Coalescing).
-- إن نجح complete لكن فشل إدراج مهمة التقييم لاحقاً (لأي سبب غير تعارض
-- الفرادة 23505 المتوقَّع)، كان الكود يتعامل مع الخطأ بصمت تماماً
-- (`if (!enqueueError) enqueuedForProject = true` — لا console.error، لا
-- تمييز بين "مهمة موحَّدة موجودة بالفعل" و"فشل DB حقيقي"): القراءة تُكتَب
-- بنجاح في device_readings_history/pm10_readings_history، الصف يُصبح
-- PROCESSED نهائياً (لا فرصة استرجاع لاحقة عبر lease/retry — الحالة النهائية
-- الوحيدة غير القابلة للتراجع في دورة حياة هذا الجدول)، لكن لا مهمة تقييم
-- تُنشأ أبداً لتلك الدقيقة — القراءة موجودة كدليل لكن لن تُقيَّم القرار
-- بناءً عليها أبداً، بلا أي أثر خطأ يكتشفه أحد لاحقاً.
--
-- الإصلاح: RPC ذرّية واحدة (complete_telemetry_queue_row_and_enqueue_job)
-- تنفّذ الثلاثة معاً داخل نفس المعاملة:
--   1) التحقق من ملكية الصف (id + worker_id، نفس شرط complete_telemetry_
--      queue_row الحالية) — false إن لم يعد العامل يملكه (عامل آخر استرجعه
--      بعد انتهاء lease هذا العامل).
--   2) إدراج project_evaluation_jobs (أو اكتشاف تعارض 23505 المتوقَّع —
--      مهمة موحَّدة لنفس (project_id, dedupe_key) موجودة بالفعل من قراءة
--      أخرى بنفس دقيقة الرصد؛ فشل آمن متوقَّع، لا خطأ حقيقي). أي استثناء
--      آخر غير 23505 (فشل DB حقيقي: قيد آخر، شبكة، إلخ) يُعاد رفعه صراحة —
--      لا ابتلاع صامت.
--   3) تحويل صف telemetry_ingestion_queue إلى PROCESSED.
-- الثلاثة تنجح معاً أو تفشل معاً (Rollback كامل لأي خطأ غير 23505 في
-- الخطوة 2، أو ملكية غير مطابقة في الخطوة 1) — لا حالة وسيطة ممكنة بعد
-- اليوم (صف PROCESSED بلا مهمة تقييم مقابلة).
-- =====================================================================

create or replace function public.complete_telemetry_queue_row_and_enqueue_job(
  p_row_id uuid,
  p_worker_id uuid,
  p_project_id uuid,
  p_dedupe_key text,
  p_trigger_type text,
  p_evaluation_at timestamptz
)
returns table (row_completed boolean, job_enqueued boolean)
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_row_completed boolean;
  v_job_enqueued boolean := false;
begin
  -- الخطوة 1: التحقق من الملكية + تحويل الصف إلى PROCESSED — نفس شرط
  -- complete_telemetry_queue_row الحالية بالضبط (id + worker_id).
  update public.telemetry_ingestion_queue
  set status = 'PROCESSED',
      processed_at = clock_timestamp(),
      lease_until = null,
      last_error = null
  where id = p_row_id and worker_id = p_worker_id
  returning true into v_row_completed;

  if not coalesce(v_row_completed, false) then
    -- لم يعد العامل يملك الصف — لا شيء آخر يُنفَّذ (لا مهمة تقييم تُنشأ
    -- باسم عامل لم يعد يملك القراءة). نفس فشل آمن renew/fail الحالي: توقّف
    -- صامت، لا خطأ يُرفَع (المستدعي يتعامل مع row_completed=false).
    return query select false, false;
    return;
  end if;

  -- الخطوة 2: محاولة إدراج مهمة التقييم. استثناء 23505 (تعارض unique
  -- (project_id, dedupe_key) — مهمة موحَّدة موجودة بالفعل لنفس دقيقة الرصد)
  -- يُلتقَط ويُعامَل كنجاح ضمني (job_enqueued=false، لكن لا rollback — القراءة
  -- ستُقيَّم فعلياً عبر تلك المهمة الموجودة أصلاً). أي استثناء آخر (قيد آخر،
  -- عمود غير موجود، فشل شبكة/قفل) يُعاد رفعه صراحة — يُسقِط المعاملة بأكملها
  -- (بما فيها تحويل الصف PROCESSED في الخطوة 1 أعلاه)، فيعود الصف كما كان
  -- (PROCESSING، قابلاً لإعادة المحاولة عبر fail_telemetry_queue_row من
  -- المستدعي بعد التقاط الاستثناء).
  begin
    insert into public.project_evaluation_jobs (
      project_id, dedupe_key, trigger_type, evaluation_at
    ) values (
      p_project_id, p_dedupe_key, p_trigger_type, p_evaluation_at
    );
    v_job_enqueued := true;
  exception
    when unique_violation then
      v_job_enqueued := false;
  end;

  return query select true, v_job_enqueued;
end;
$$;

revoke all on function public.complete_telemetry_queue_row_and_enqueue_job(
  uuid, uuid, uuid, text, text, timestamptz
) from public, anon, authenticated;

grant execute on function public.complete_telemetry_queue_row_and_enqueue_job(
  uuid, uuid, uuid, text, text, timestamptz
) to service_role;
