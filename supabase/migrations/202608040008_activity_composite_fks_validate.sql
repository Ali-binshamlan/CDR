-- =====================================================================
-- DCR — 202608040008_activity_composite_fks_validate.sql
-- =====================================================================
-- القسم 12.3 — VALIDATE CONSTRAINT الفعلي لكل قيد أُضيف NOT VALID في
-- 202608040007. مرحلة منفصلة عمداً (نفس توصية القسم 16 — "سياسة migrations":
-- افصل Backfill عن SET NOT NULL/VALIDATE عندما يكون الحجم كبيراً) — تفحص كل
-- صف قائم بالفعل دون قفل كتابة طويل إضافي على مرحلة الإضافة نفسها.
--
-- فشل أي VALIDATE هنا يعني وجود صف يتيم فعلياً (project_id, activity_
-- group_id) لا يقابله صف activity_groups — البذر في 202608040006 يُفترض
-- أن يمنع ذلك؛ لو فشل فعلياً، يجب فحص البيانات يدوياً قبل إعادة تنفيذ هذه
-- الهجرة (لا يجوز حذف الصف اليتيم تلقائياً هنا — قد يكون دليلاً تاريخياً
-- append-only لا يجوز لمسه).
-- =====================================================================

alter table public.dust_evaluations
  validate constraint dust_evaluations_activity_group_fk;

alter table public.dust_compliance_evaluations
  validate constraint dust_compliance_evaluations_activity_group_fk;

alter table public.final_decisions
  validate constraint final_decisions_activity_group_fk;

alter table public.current_dust_decisions
  validate constraint current_dust_decisions_activity_group_fk;

alter table public.current_dust_compliance_decisions
  validate constraint current_dust_compliance_decisions_activity_group_fk;

alter table public.project_dust_profiles
  validate constraint project_dust_profiles_activity_group_fk;
