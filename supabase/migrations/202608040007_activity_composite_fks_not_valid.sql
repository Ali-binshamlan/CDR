-- =====================================================================
-- DCR — 202608040007_activity_composite_fks_not_valid.sql
-- =====================================================================
-- القسم 12.3 من "دليل الإصلاح الجذري لمنظومة مرقاب" — يبدأ القيود على
-- بيانات قائمة بصيغة NOT VALID (لا تُقفَل الجداول لفحص كامل فوري)؛
-- VALIDATE CONSTRAINT الفعلي في migration تالية منفصلة
-- (202608040008_activity_composite_fks_validate.sql).
--
-- كل قيد يشير إلى activity_groups(project_id, id) — لا يجوز بعد الآن لأي
-- صف دليل أن يحمل (project_id, activity_group_id) لا يقابله صف هوية
-- مسجَّل فعلياً؛ الجدول الهوية نفسه (202608040006) بُذِر من كل الجداول
-- القائمة أولاً فلا يفشل أي صف تاريخي حقيقي هنا.
-- =====================================================================

alter table public.dust_evaluations
  add constraint dust_evaluations_activity_group_fk
  foreign key (project_id, activity_group_id)
  references public.activity_groups (project_id, id)
  not valid;

alter table public.dust_compliance_evaluations
  add constraint dust_compliance_evaluations_activity_group_fk
  foreign key (project_id, activity_group_id)
  references public.activity_groups (project_id, id)
  not valid;

alter table public.final_decisions
  add constraint final_decisions_activity_group_fk
  foreign key (project_id, activity_group_id)
  references public.activity_groups (project_id, id)
  not valid;

alter table public.current_dust_decisions
  add constraint current_dust_decisions_activity_group_fk
  foreign key (project_id, activity_group_id)
  references public.activity_groups (project_id, id)
  not valid;

alter table public.current_dust_compliance_decisions
  add constraint current_dust_compliance_decisions_activity_group_fk
  foreign key (project_id, activity_group_id)
  references public.activity_groups (project_id, id)
  not valid;

-- project_dust_profiles نفسه — كل صف نشاط ينتمي لهوية مجموعة مسجَّلة (لا
-- NOT NULL وحده كافياً؛ يضمن أيضاً أن project_id يطابق فعلياً).
alter table public.project_dust_profiles
  add constraint project_dust_profiles_activity_group_fk
  foreign key (project_id, activity_group_id)
  references public.activity_groups (project_id, id)
  not valid;
