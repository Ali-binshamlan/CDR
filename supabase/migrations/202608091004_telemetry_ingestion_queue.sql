-- =====================================================================
-- DCR — 202608091004_telemetry_ingestion_queue.sql
-- =====================================================================
-- المرحلة 1 من إعادة تصميم مسار استقبال Telemetry — فصل الاستقبال عن
-- المعالجة. راجع الخطة المعتمدة (طُبِّقت بموافقة صريحة) للسياق الكامل.
--
-- المشكلة: provider-pull يكتب كل قراءة مباشرة عبر RPC ثقيلة
-- (ingest_device_reading_and_event_atomic، حتى ~20 عملية DB لكل قراءة)
-- ثم يستدعي evaluateProject inline — كل هذا داخل نفس طلب HTTP، متزامناً
-- مع عدة مصادر أخرى تكتب لنفس الصفوف (retry jobs، push مباشر). هذا سبب
-- تصادم الأقفال وارتفاع CPU الموثَّق تكراراً هذه الجلسة.
--
-- الحل: هذا الملف يُنشئ طابور استقبال مؤقت بحت (Ingestion Queue) —
-- provider-pull يكتب فيه فقط (INSERT خفيف بلا FK/قفل صف)، ومعالجة فعلية
-- (writeDeviceReading + Evaluation Coalescing) تنتقل لاحقاً إلى
-- telemetry-worker منفصل زمنياً (مرحلة لاحقة). هذا الملف وحده لا يغيّر أي
-- سلوك تشغيلي فعلي بعد — الجدول والـRPCs إضافيان بحتان، provider-pull لم
-- يُعدَّل بعد (يحدث في نفس الدفعة، ملف تطبيق كود منفصل).
--
-- نمط المطالبة (Claim → Commit → Process) مُستنسَخ حرفياً من
-- claim_evaluation_jobs (202608040028_claim_evaluation_jobs_lease_recovery.sql)
-- — نفس بنية union_ids/candidates/FOR UPDATE SKIP LOCKED، فقط مطبَّقة على
-- جدول جديد. complete/fail مُستنسَخان حرفياً من complete_evaluation_job/
-- fail_evaluation_job (202608040005_claim_evaluation_jobs.sql) — نفس
-- Backoff الأُسّي (حد أقصى 10 دقائق) وDead-letter بعد p_max_attempts.
-- =====================================================================

-- ---------------------------------------------------------------------
-- الجدول: append-oriented قدر الإمكان، بأقل قيود ممكنة على المسار الساخن.
-- ---------------------------------------------------------------------
-- بلا Foreign Keys على connection_id/project_id/device_id عمداً — التحقق
-- من صحتها يحدث عند المعالجة (claim time) في telemetry-worker، لا عند
-- الإدخال، تفادياً لأي قفل/فحص إضافي على المسار الساخن لـprovider-pull
-- (نفس مبدأ "لا تفترض أن INSERT بلا Locks" — الفهارس/القيود هنا مقصودة
-- بأقل عدد كافٍ فقط، لا صفر).
create table if not exists public.telemetry_ingestion_queue (
  id uuid primary key default gen_random_uuid(),

  -- idempotency_key = نفس المفتاح الموجود بالفعل في provider-pull/route.ts:
  -- `${provider}:${vendor_station_id}:${observedAtIso}` — راجع تحليل
  -- Idempotency الكامل في الخطة المعتمدة (خاص بـThingsBoard، لا يُفترض
  -- عاماً لأي مزود مستقبلي بلا تحليل مماثل).
  idempotency_key text not null,

  connection_id uuid not null,
  project_id uuid not null,
  device_id uuid not null,
  provider text not null,

  -- الحمولة الخام كما أعادها الـConnector (NormalizedReading كاملة، بما
  -- فيها fields المستقلة لكل حقل قياس) — لا تحويل/تلخيص هنا.
  payload jsonb not null,

  -- الفصل بين وقت المصدر ووقت الاستقبال، بنفس الانضباط المعمول به في كل
  -- مكان آخر بالنظام (observed_at/received_at).
  observed_at timestamptz not null,
  received_at timestamptz not null default clock_timestamp(),

  -- دورة الحياة: PENDING → PROCESSING → PROCESSED
  --              PENDING → PROCESSING → FAILED/DEAD (بعد استنفاد المحاولات)
  status text not null default 'PENDING' check (status in ('PENDING', 'PROCESSING', 'PROCESSED', 'FAILED', 'DEAD')),
  attempts integer not null default 0,
  worker_id uuid,
  lease_until timestamptz,
  last_error text,

  created_at timestamptz not null default clock_timestamp(),
  processed_at timestamptz
);

-- فهرس فريد للـidempotency — هذا هو آلية منع التكرار نفسها عبر
-- ON CONFLICT (idempotency_key) DO NOTHING عند الإدخال من provider-pull.
-- فريد بلا شرط جزئي (WHERE) لأن هذا الجدول يُغذَّى حصراً من مسار pull —
-- كل صف يملك idempotency_key دائماً (بخلاف external_event_id على
-- device_readings_history الذي يمكن أن يكون null لمصادر push قديمة).
create unique index if not exists idx_telemetry_ingestion_queue_idempotency
  on public.telemetry_ingestion_queue (idempotency_key);

-- فهرس مطالبة واحد فقط — يطابق idx_project_evaluation_jobs_claim تماماً.
-- بلا فهرس إضافي على project_id عمداً: هذا الجدول عابر (الصفوف تُعالَج
-- خلال ثوانٍ لدقائق ثم تُحذَف عبر queue-cleanup-worker)، فأي استعلام
-- تاريخي بحاجة project_id ينتمي لـdevice_readings_history، لا هنا.
create index if not exists idx_telemetry_ingestion_queue_claim
  on public.telemetry_ingestion_queue (status, lease_until, created_at);

-- بلا triggers لحماية الأدلة (forbid_evidence_mutation/forbid_evidence_truncate)
-- عمداً — هذا حالة معالجة عابرة (Processing State)، لا دليل قانوني دائم؛
-- الدليل الحقيقي يبقى في device_readings_history/pm10_readings_history
-- بعد أن يكتبها telemetry-worker عبر writeDeviceReading دون أي تغيير.

alter table public.telemetry_ingestion_queue enable row level security;
revoke all on public.telemetry_ingestion_queue from public, anon, authenticated;
grant select, insert, update on public.telemetry_ingestion_queue to service_role;

-- ---------------------------------------------------------------------
-- claim_telemetry_queue — مطالبة بدفعة، نفس بنية claim_evaluation_jobs
-- (union_ids: PENDING جاهزة ∪ PROCESSING منتهية الـlease) بالضبط.
-- ---------------------------------------------------------------------
create or replace function public.claim_telemetry_queue(
  p_worker_id uuid,
  p_batch_size integer default 50,
  p_lease_seconds integer default 60
)
returns setof public.telemetry_ingestion_queue
language sql
security invoker
set search_path = pg_catalog, public
as $$
  with union_ids as (
    select id
    from public.telemetry_ingestion_queue
    where status = 'PENDING'
      and (lease_until is null or lease_until < clock_timestamp())
    union all
    -- عامل تعطّل منتصف المعالجة (Vercel timeout، إعادة نشر، Crash) بلا
    -- استدعاء complete/fail — يعود الصف متاحاً للمطالبة تلقائياً بمجرد
    -- انتهاء الـlease، بلا تدخل يدوي. نفس الإصلاح المُطبَّق على
    -- claim_evaluation_jobs في 202608040028 منذ أول نسخة هنا (لا تكرار
    -- لنفس الخطأ التاريخي).
    select id
    from public.telemetry_ingestion_queue
    where status = 'PROCESSING'
      and lease_until is not null
      and lease_until < clock_timestamp()
  ),
  candidates as (
    select id
    from public.telemetry_ingestion_queue
    where id in (select id from union_ids)
    order by created_at
    for update skip locked
    limit greatest(1, p_batch_size)
  )
  update public.telemetry_ingestion_queue q
  set status = 'PROCESSING',
      worker_id = p_worker_id,
      lease_until = clock_timestamp() + make_interval(secs => greatest(1, p_lease_seconds)),
      attempts = attempts + 1
  from candidates c
  where q.id = c.id
  returning q.*;
$$;

revoke all on function public.claim_telemetry_queue(uuid, integer, integer)
  from public, anon, authenticated;
grant execute on function public.claim_telemetry_queue(uuid, integer, integer) to service_role;

-- ---------------------------------------------------------------------
-- complete_telemetry_queue_row — إنهاء ناجح، ذرّي، يتحقق من worker_id
-- (لا يُنهي صفاً استرجعه عامل آخر بعد انتهاء lease هذا العامل تحديداً).
-- ---------------------------------------------------------------------
create or replace function public.complete_telemetry_queue_row(
  p_row_id uuid,
  p_worker_id uuid
)
returns boolean
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_updated boolean;
begin
  update public.telemetry_ingestion_queue
  set status = 'PROCESSED',
      processed_at = clock_timestamp(),
      lease_until = null,
      last_error = null
  where id = p_row_id and worker_id = p_worker_id
  returning true into v_updated;

  return coalesce(v_updated, false);
end;
$$;

revoke all on function public.complete_telemetry_queue_row(uuid, uuid) from public, anon, authenticated;
grant execute on function public.complete_telemetry_queue_row(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------
-- fail_telemetry_queue_row — فشل، RETRY ضمني عبر إعادة PENDING مع Backoff
-- أُسّي (نفس حدود fail_evaluation_job: حد أقصى 10 دقائق)، DEAD بعد
-- p_max_attempts. لا يشترط worker_id (فشل قد يُسجَّل بعد انتهاء lease هذا
-- العامل فعلياً — لا يزال يجب تسجيل الخطأ ودفع الجدولة قدماً بأمان).
-- ---------------------------------------------------------------------
create or replace function public.fail_telemetry_queue_row(
  p_row_id uuid,
  p_error text,
  p_max_attempts integer default 5
)
returns void
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_attempts integer;
begin
  select attempts into v_attempts from public.telemetry_ingestion_queue where id = p_row_id;
  if not found then
    return;
  end if;

  if v_attempts >= p_max_attempts then
    update public.telemetry_ingestion_queue
    set status = 'DEAD',
        last_error = p_error,
        lease_until = null,
        processed_at = clock_timestamp()
    where id = p_row_id;
  else
    update public.telemetry_ingestion_queue
    set status = 'PENDING',
        last_error = p_error,
        lease_until = clock_timestamp() + make_interval(secs => least(600, power(2, v_attempts) * 5))
    where id = p_row_id;
  end if;
end;
$$;

revoke all on function public.fail_telemetry_queue_row(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.fail_telemetry_queue_row(uuid, text, integer) to service_role;
