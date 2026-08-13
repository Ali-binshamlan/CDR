-- =====================================================================
-- DCR — 202608120011_evidence_chain_coverage_marker.sql
-- =====================================================================
-- خطأ مكتشَف (طلب صريح من المستخدم — مراجعة كود خارجي: "لا يوجد تثبيت
-- خارجي فعلي ولا Backfill للأدلة القديمة"):
--
-- تحقُّق من الجزء الأول من هذه الملاحظة ("لا Worker يكتب لمخزن خارجي"):
-- غير دقيق فعلياً — app/api/cron/evidence-anchor/route.ts موجود ويعمل
-- (يقرأ آخر seq من evidence_hash_ledger ويكتبه في مستودع GitHub منفصل عن
-- مالك Supabase، ويُسجِّل كل تشغيلة — ناجحة أو فاشلة — في evidence_anchor_runs)،
-- وscheduler-heartbeat/route.ts (202608110009 وما بعدها) ينذر فعلياً
-- إن غاب تثبيت ناجح لأكثر من ساعتين (anchor_stale) — راجع evidence_integrity
-- في تلك الدالة.
--
-- الجزء الثاني صحيح فعلاً: append_evidence_hash_link (202608110008) هو
-- trigger AFTER INSERT — يُغذّي evidence_hash_ledger فقط بالصفوف *الجديدة*
-- المُدرَجة بعد تركيب الـtrigger. أي صف كان موجوداً بالفعل في final_decisions/
-- pm10_readings_history/device_readings_history/إلخ *قبل* migration 202608110008
-- لا يملك أي أثر في الدفتر إطلاقاً — لا حذف backfill حتمي لتلك الصفوف القديمة
-- (خطر حقيقي: ترتيب backfill بأثر رجعي قد يختلف عن ترتيب الإنشاء الفعلي،
-- فيخلط بين "دليل كان محمياً بالتجزئة وقت إنشائه الحقيقي" و"دليل أُدرِج لاحقاً
-- في السلسلة برتبة مختلفة تماماً عن زمن حدوثه الفعلي" — قرار مستخدم صريح:
-- لا backfill حتمي، بل توثيق صريح لنقطة بداية التغطية بدلاً منه).
--
-- الإصلاح: عمود coverage_started_at على evidence_hash_ledger — قيمة ثابتة
-- واحدة (created_at لصف __genesis__ نفسه، أول صف أُنشئ في نفس migration
-- 202608110007 التي أنشأت الجدول، قبل تركيب الـtrigger في 202608110008
-- مباشرة بلحظات — أدق تقريب متاح فعلياً لـ"متى بدأت السلسلة تغطي أدلة
-- حقيقية"). أي دليل (بأي جدول من الجداول العشرة) بتاريخ أقدم من هذه القيمة
-- غير مُغطّى بسلسلة التجزئة إطلاقاً — حقيقة يجب أن تكون صريحة وقابلة
-- للاستعلام، لا ضمنية تتطلب أرشفة migrations لاكتشافها.
-- =====================================================================

alter table public.evidence_hash_ledger
  add column if not exists coverage_started_at timestamptz;

comment on column public.evidence_hash_ledger.coverage_started_at is
  'يُملأ فقط على صف __genesis__ (source_table)، بقيمة created_at ذلك الصف نفسه — نقطة بداية تغطية سلسلة التجزئة صراحة. أي دليل تاريخي (final_decisions/pm10_readings_history/إلخ) بتاريخ أقدم منها غير مُغطّى بهذه السلسلة إطلاقاً (وُجد قبل تركيب append_evidence_hash_link، migration 202608110008) — قرار مستخدم صريح بعدم backfill حتمي بأثر رجعي (راجع تعليق هذا الملف الكامل للمبرر). null لكل الصفوف الأخرى (غير __genesis__) عمداً — لا تكرار لنفس القيمة على كل صف.';

update public.evidence_hash_ledger
set coverage_started_at = created_at
where source_table = '__genesis__'
  and coverage_started_at is null;

-- RPC قراءة فقط — يعيد نقطة بداية التغطية صراحة، بلا حاجة لاستعلام الدفتر
-- مباشرة أو معرفة تفاصيل صف __genesis__ الداخلية. تُستخدَم في scheduler-
-- heartbeat/route.ts (evidence_integrity) وفي أي تدقيق مستقبلي يحتاج الإجابة
-- الصريحة عن "منذ متى هذا الدليل محمي بسلسلة تجزئة فعلياً؟".
create or replace function public.get_evidence_chain_coverage_started_at()
returns timestamptz
language sql
security invoker
set search_path = pg_catalog, public
stable
as $$
  select coverage_started_at
  from public.evidence_hash_ledger
  where source_table = '__genesis__'
  limit 1;
$$;

revoke all on function public.get_evidence_chain_coverage_started_at() from public, anon, authenticated;
grant execute on function public.get_evidence_chain_coverage_started_at() to service_role;
