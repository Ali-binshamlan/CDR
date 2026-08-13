-- =====================================================================
-- DCR — 202608110005_final_decisions_rule_parameter_snapshot.sql
-- =====================================================================
-- خطأ مكتشَف (مراجعة تدقيق — "لا تُحفظ معرفات نسخ المعاملات المستخدمة مع
-- القرار"): لا سجل حالياً يوثّق أي نسخ rule_parameter_versions (لا
-- rule_bundle_version، الذي يخزّن معرّف حزمة PM10 الثابتة ACTIVE_RULE_
-- BUNDLE.id — غير ذي صلة بمعاملات rule_parameter_versions إطلاقاً، ولا
-- input_snapshot_hash، الذي يبصم مخرجات التقييم لا مدخلات العتبات) كانت
-- PUBLISHED فعلياً وقت حساب قرار final_decisions معيّن. لو أعاد مسؤول نشر
-- معامل لاحقاً بقيمة جديدة، لا توجد أي طريقة لإثبات أي قيمة كانت فعلية
-- وقت قرار تاريخي محدد.
--
-- الإصلاح: عمود جديد nullable — بصمة كاملة (خريطة parameter_code ->
-- rule_parameter_versions.id لكل معامل له نسخة PUBLISHED فعلية وقت هذه
-- الدورة؛ معامل بلا نسخة منشورة [يستخدم code_default_value] غائب من
-- الخريطة عمداً، لا مفتاحاً بقيمة فارغة). نفس نمط evaluation_run_id/
-- input_snapshot_hash (202608040021) بالضبط — عمود يُملأ من التطبيق
-- (TypeScript)، لا من القاعدة (لا تعرف القاعدة شكل RuleParameters).
--
-- final_decisions فقط (لا dust_evaluations/dust_compliance_evaluations) —
-- الفجوة المؤكَّدة خاصة بـfinal_decisions تحديداً (سجل القرار الظاهر
-- للوحة/التدقيق التنظيمي)؛ توسيع النطاق لجدولي أدلة إضافيين بلا حاجة
-- مؤكَّدة الآن يزيد المخاطرة بلا داعٍ.
--
-- عمود nullable بلا CHECK/NOT NULL — إضافة سريعة على مستوى meta فقط
-- (Postgres MVCC، لا إعادة كتابة جدول)، بلا NOT VALID (لا قيد يحتاج تحقق
-- صفوف قائمة).
-- =====================================================================

alter table public.final_decisions
  add column if not exists rule_parameter_version_snapshot jsonb;

create index if not exists idx_final_decisions_rule_parameter_version_snapshot
  on public.final_decisions using gin (rule_parameter_version_snapshot);
