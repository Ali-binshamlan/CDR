-- =====================================================================
-- DCR — 202608110016_telemetry_queue_event_key.sql
-- =====================================================================
-- خطأ مكتشَف ومُصلَح (مراجعة كود خارجي — "مفتاح منع التكرار قابل
-- للتصادم"): idempotency_key الحالي (فهرس فريد idx_telemetry_ingestion_
-- queue_idempotency، 202608091004) يُبنى في provider-pull/route.ts كـ
-- `${provider}:${vendor_station_id}:${observedAtIso}` — بلا connection_id
-- وبلا أي أثر لمحتوى الحمولة نفسها. لو وصل تصحيح لاحق (المزوّد يُعيد إرسال
-- نفس اللحظة الزمنية بقيمة مصحَّحة) أو حقل جديد (مثال: أضاف المستخدم
-- pm25 لاحقاً لنفس telemetry key عند نفس ts) بنفس observedAtIso بالضبط،
-- ON CONFLICT (idempotency_key) DO NOTHING يرفض الصف الجديد بصمت — القيمة
-- المصحَّحة/الحقل الجديد يُفقَدان نهائياً رغم كونهما بيانات حقيقية مختلفة.
--
-- الإصلاح: عمود provider_event_key جديد، مبني في route.ts من (بالأولوية):
--   1) NormalizedReading.vendorEventId — معرّف حدث حقيقي من المصدر (اختياري
--      بالعقد، types.ts) إن وفّرته منصة المزوّد.
--   2) وإلا: `${observedAtIso}:${sha256(canonical(payload))}` — hash قانوني
--      (مفاتيح مرتَّبة أبجدياً، نفس أسلوب computeInputSnapshotHash في
--      dustEvaluation.ts) لكامل الحمولة. تصحيح/حقل جديد بنفس observedAtIso
--      يُنتج hash مختلفاً فيُقبَل كصف جديد بدل أن يُرفَض كتكرار.
--
-- الفريد الجديد (connection_id, provider_event_key) بدل idempotency_key
-- المستقل — يضمن أن نفس المفتاح مسموح بالتكرار عبر اتصالات مختلفة (لا
-- علاقة منطقية بينها أصلاً) بينما يظل صارماً ضمن نفس الاتصال. idempotency_key
-- نفسه يبقى (لا يُحذَف) — لا يزال يُمرَّر كـexternalEventId إلى
-- writeDeviceReading (telemetry-worker/route.ts) لأغراض توافقية أخرى غير
-- منع التكرار هنا؛ يُعاد بناؤه الآن كـ`${connection_id}:${provider_event_key}`
-- (فريد عالمياً بذاته، قابل للتتبع، بلا حاجة لفهرس فريد منفصل عليه بعد اليوم).
-- =====================================================================

alter table public.telemetry_ingestion_queue
  add column if not exists provider_event_key text;

-- Backfill للصفوف الموجودة فعلياً (نافذة عابرة قصيرة العمر عملياً — راجع
-- تعليق queue-cleanup-worker — لكن الأمان يقتضي عدم افتراض فراغ الجدول وقت
-- التطبيق). نشتق قيمة معقولة من idempotency_key الحالي (يحوي observedAtIso
-- كجزء أخير مفصول بـ':') حتى يمر الفهرس الفريد الجديد بلا تعارض فوري؛
-- الصفوف الجديدة بعد نشر كود route.ts المُحدَّث تستخدم القيمة الصحيحة الفعلية.
update public.telemetry_ingestion_queue
set provider_event_key = idempotency_key
where provider_event_key is null;

alter table public.telemetry_ingestion_queue
  alter column provider_event_key set not null;

-- الفهرس الفريد الجديد المطلوب صراحةً — يحل محل idx_telemetry_ingestion_
-- queue_idempotency كآلية منع التكرار الفعلية (ON CONFLICT في route.ts
-- يتحول لهذا الزوج). الفهرس القديم يُسقَط: idempotency_key يبقى عموداً
-- عادياً غير فريد بذاته بعد اليوم (فريد فقط بالاشتراك مع connection_id عبر
-- الفهرس الجديد، وحتى ذلك ضمنيّ فقط لأن الإنشاء الحالي يجعله يساوي
-- connection_id:provider_event_key دائماً — لا فرض قيد إضافي عليه مباشرة).
drop index if exists public.idx_telemetry_ingestion_queue_idempotency;

create unique index if not exists uq_telemetry_connection_event
  on public.telemetry_ingestion_queue (connection_id, provider_event_key);

comment on column public.telemetry_ingestion_queue.provider_event_key is
  'معرّف الحدث ضمن نطاق connection_id — vendorEventId الحقيقي من المزوّد إن توفر، وإلا observedAtIso:sha256(canonical(payload)). الفريد الفعلي لمنع التكرار هو (connection_id, provider_event_key) عبر uq_telemetry_connection_event، لا idempotency_key وحده.';
comment on column public.telemetry_ingestion_queue.idempotency_key is
  'يبقى لأغراض توافقية (يُمرَّر كـexternalEventId إلى writeDeviceReading في telemetry-worker) — لم يعد آلية منع التكرار الأساسية على هذا الجدول، راجع provider_event_key وuq_telemetry_connection_event.';
