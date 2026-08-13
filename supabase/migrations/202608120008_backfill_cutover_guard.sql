-- =====================================================================
-- DCR — 202608120008_backfill_cutover_guard.sql
-- =====================================================================
-- خطأ مكتشَف (مراجعة كود خارجي — "ترقية Credentials V2 غير قابلة للتنفيذ
-- على قاعدة قائمة"): ترقية provider_connections.credentials إلى enc:v2
-- (202608040016 Expand → backfill خارجي (scripts/migrate-provider-
-- credentials-v2.mjs) → 202608040017 Validate → 202608040018 Cutover) طُبِّقت
-- فعلاً بنجاح تاريخياً — app/lib/credentialsEncryption.ts الحالي يقرأ
-- credentials_ciphertext (enc:v2:) حصراً بلا أي fallback للعمود القديم
-- credentials، فلا شك أن الترحيل اكتمل قبل نشر الكود الحالي. لا حاجة (ولا
-- أمان) لتعديل الملفات التاريخية 202608040016/017/018 بأثر رجعي — Postgres
-- migrations قائمة سبق تطبيقها لا تُعدَّل، تُضاف فوقها هجرة جديدة فقط.
--
-- الفجوة الفعلية المتبقية: 202608040018 (Cutover — SET NOT NULL + DROP
-- COLUMN) كانت تعتمد كلياً على رسالة خطأ Postgres العامة لو بقي صف
-- credentials_ciphertext=null (ALTER COLUMN ... SET NOT NULL يفشل تلقائياً
-- في هذه الحالة) — لا حارس صريح برسالة تشخيصية واضحة ("N صف غير مُرحَّل، لا
-- تكمل") قبل محاولة القفل. هذا الملف يوثّق النمط الصحيح كمرجع لأي عملية
-- Expand/Backfill/Contract مستقبلية مشابهة في هذا المشروع (مثال: ترقية
-- تشفير مماثلة لجدول آخر) — دالة عامة (لا خاصة بـprovider_connections) تتحقق
-- صراحة من عدد الصفوف غير المكتملة وترفض المتابعة برسالة واضحة، بدل الاعتماد
-- على خطأ NOT NULL العام كحارس ضمني وحيد.
--
-- الاستخدام المستقبلي المقترح: قبل أي migration Cutover (SET NOT NULL/DROP
-- COLUMN) في نمط Expand/Contract، استدعِ:
--   select public.assert_backfill_complete(
--     'schema_name.table_name', 'new_column_name'
--   );
-- داخل الـmigration نفسها، قبل عبارات ALTER — ترفع استثناءً صريحاً بعدد
-- الصفوف المتبقية إن وُجد أي صف NULL، بدل ترك ALTER TABLE يفشل برسالة عامة
-- لاحقاً (أو الأسوأ: ينجح صامتاً لو كان التحقق غائباً تماماً).
-- =====================================================================

create or replace function public.assert_backfill_complete(
  p_table text,
  p_column text
)
returns void
language plpgsql
as $$
declare
  v_remaining bigint;
begin
  execute format('select count(*) from %s where %I is null', p_table, p_column)
  into v_remaining;

  if v_remaining > 0 then
    raise exception using errcode = '55000', message = format(
      'Cutover مرفوض: % صف في %s لا يزال %I=NULL — أعد تشغيل سكربت الـbackfill وتأكد من اكتماله (صفر صف متبقٍّ) قبل إعادة محاولة هذه الهجرة',
      v_remaining, p_table, p_column
    );
  end if;
end;
$$;

comment on function public.assert_backfill_complete(text, text) is
  'حارس عام لأي migration Cutover (نمط Expand/Backfill/Contract) — يرفض المتابعة صراحة برسالة واضحة إن بقي صف واحد على الأقل بعمود مُرحَّل جديد=NULL، بدل الاعتماد على رسالة NOT NULL العامة من Postgres كحارس ضمني وحيد. راجع تعليق هذا الملف الكامل للسياق (ترقية provider_connections.credentials_ciphertext، 202608040016-018).';

revoke all on function public.assert_backfill_complete(text, text) from public, anon, authenticated;
grant execute on function public.assert_backfill_complete(text, text) to service_role;

-- ملاحظة: لا استدعاء بأثر رجعي هنا على provider_connections.credentials_ciphertext
-- عمداً — ذلك العمود NOT NULL فعلياً بالفعل (نتيجة 202608040018 الناجحة
-- تاريخياً)، فأي select count(*) where credentials_ciphertext is null يُرجع
-- صفراً بحكم القيد نفسه دائماً — تحقق لا معنى له، لا حارس فعلي. هذه الدالة
-- مرجع جاهز للاستخدام في أي migration Cutover *مستقبلية* مشابهة قبل تطبيقها
-- (حين يكون العمود الهدف لا يزال nullable فعلياً وقت كتابة تلك الهجرة).
