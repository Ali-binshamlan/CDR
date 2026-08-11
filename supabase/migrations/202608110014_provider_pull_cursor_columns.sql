-- =====================================================================
-- DCR — 202608110014_provider_pull_cursor_columns.sql
-- =====================================================================
-- خطأ مكتشَف ومُصلَح (مراجعة كود خارجي — "مؤشر السحب يتقدم حتى عند فشل
-- Queue"): provider-pull/route.ts كان يستخدم provider_connections.
-- last_pull_at كمؤشر سحب (cursor — fetchReadingsSince(..., sinceMs) حيث
-- sinceMs مشتقة من last_pull_at) وكوقت آخر محاولة معاً، ويُحدَّث
-- last_pull_at = now() في كل مسار خروج من processConnection بلا استثناء:
--   1) لا قراءات جديدة من المزود (مصفوفة فارغة) — غير ضار فعلياً (لا شيء
--      لفقده)، لكنه يخلط الدلالتين.
--   2) فشل إدراج الدفعة في telemetry_ingestion_queue (upsert لجدول
--      الطابور يُعيد خطأ) — last_pull_at يتقدم رغم فشل الإدخال بالكامل.
--   3) استثناء داخل catch (خطأ شبكة/فك تشفير/إلخ) — نفس الأثر.
--
-- الأثر: الدورة التالية تحسب sinceMs من last_pull_at الجديد (= وقت
-- المحاولة الفاشلة تقريباً)، فتبدأ نافذة fetchReadingsSince من تلك اللحظة
-- فصاعداً — كل قراءة وقعت فعلياً بين last_pull_at القديم (الصحيح) ووقت
-- المحاولة الفاشلة تُفقَد نهائياً، بلا أي فرصة لاسترجاعها لاحقاً (لا يوجد
-- "إعادة محاولة" تلقائية لتلك النافذة الزمنية المحدَّدة — الدورة التالية
-- تنظر للأمام فقط من المؤشر الجديد الخاطئ).
--
-- الإصلاح: فصل الدلالتين إلى عمودين مستقلين:
--   - last_pull_at (تبقى كما هي، بلا تغيير — تُستخدَم فعلياً في
--     scheduler-heartbeat/route.ts كمقياس "متى آخر محاولة سحب فعلية؟" لكشف
--     توقّف الدورة بالكامل، بصرف النظر عن نجاحها. هذه الدلالة صحيحة أصلاً
--     ويجب أن تبقى تتقدم في كل محاولة — لا خطأ في last_pull_at نفسها، الخطأ
--     كان في استخدامها الإضافي كمؤشر سحب أيضاً).
--   - pull_cursor_at (جديد): مؤشر السحب الفعلي المستخدَم في حساب sinceMs —
--     يتقدم فقط عند نجاح إدراج الدفعة كاملة في telemetry_ingestion_queue
--     بلا خطأ (بما في ذلك حالة "لا قراءات جديدة"، وهي نجاح فعلي بمعنى
--     "تحقّقنا حتى هذه اللحظة ولا شيء جديد"). فشل الإدراج أو استثناء غير
--     متوقَّع يترك pull_cursor_at كما هو — الدورة التالية تُعيد محاولة نفس
--     النافذة الزمنية بالضبط (idempotency عبر idempotency_key الفريد على
--     telemetry_ingestion_queue يمنع أي تكرار فعلي لو نجحت قراءات سابقة
--     ضمن نفس الدفعة الفاشلة جزئياً).
--   - last_pull_success_at (جديد): آخر وقت نجحت فيه محاولة سحب فعلياً
--     (نفس شرط تقدّم pull_cursor_at) — يميّز "آخر نجاح" عن last_pull_success
--     (Boolean يعكس فقط نتيجة *آخر محاولة*، فيفقد معنى "متى" بمجرد فشل
--     محاولة واحدة تالية لسلسلة نجاحات طويلة).
-- =====================================================================

alter table public.provider_connections
  add column if not exists pull_cursor_at timestamptz,
  add column if not exists last_pull_success_at timestamptz;

comment on column public.provider_connections.last_pull_at is
  'وقت آخر محاولة سحب فعلية (تتقدم في كل محاولة بصرف النظر عن النجاح) — تُستخدَم لكشف توقّف دورة provider-pull بالكامل (scheduler-heartbeat/route.ts). لا تُستخدَم كمؤشر سحب — راجع pull_cursor_at.';
comment on column public.provider_connections.pull_cursor_at is
  'مؤشر السحب الفعلي (sinceMs في provider-pull/route.ts) — يتقدم فقط عند نجاح إدراج دفعة القراءات كاملة في telemetry_ingestion_queue بلا خطأ. فشل الإدراج/استثناء غير متوقَّع يُبقيه كما هو، فتُعاد محاولة نفس النافذة الزمنية في الدورة التالية بدل فقدها نهائياً.';
comment on column public.provider_connections.last_pull_success_at is
  'آخر وقت نجحت فيه محاولة سحب فعلياً (نفس شرط تقدّم pull_cursor_at) — بخلاف last_pull_success (Boolean يعكس فقط نتيجة آخر محاولة).';

-- Backfill: قيمة ابتدائية معقولة لكل اتصال موجود بالفعل — last_pull_at
-- الحالية أفضل تقدير متاح لـ"آخر نقطة نعرف أننا تحققنا حتى عندها" (كل
-- الاتصالات الحالية نجحت في محاولات سابقة قبل هذا الإصلاح، وإلا لما وصلت
-- last_pull_at لقيمتها الحالية أصلاً في أغلب الحالات العملية). صف بلا
-- last_pull_at إطلاقاً (لم يُسحَب منه قط) يبقى pull_cursor_at=null — نفس
-- سلوك route.ts الحالي عند last_pull_at=null (fallback لحد النظر للخلف
-- الأقصى MAX_LOOKBACK_MS).
update public.provider_connections
set pull_cursor_at = last_pull_at,
    last_pull_success_at = last_pull_at
where pull_cursor_at is null and last_pull_at is not null and last_pull_success is true;
