-- =====================================================================
-- DCR — 202608110004_forbid_bundle_mutation.sql
-- =====================================================================
-- نفس فلسفة forbid_published_rule_parameter_mutation (202608060003) —
-- rule_parameter_publication_bundles سجل تدقيق، لا يجوز تعديله بعد الإنشاء
-- إلا الانتقال الوحيد المسموح PUBLISHED→ROLLED_BACK (الذي تكتبه
-- rollback_rule_parameter_bundle نفسها، 202608110003). ملف منفصل عمداً
-- (لا مدموج في 202608110003) — عزل قابلية عزل/تراجع trigger الحماية عن
-- DDL/RPC الحزمة نفسها، حسب عرف المشروع "ملف واحد عالي الخطورة لكل تعديل".
-- =====================================================================

create or replace function public.forbid_rule_parameter_bundle_mutation()
returns trigger
language plpgsql
as $$
begin
  if old.status = 'PUBLISHED' and new.status = 'ROLLED_BACK'
     and new.change_reason_ar = old.change_reason_ar
     and new.published_by is not distinct from old.published_by
     and new.published_at = old.published_at
     and new.is_rollback = old.is_rollback
     and new.rolled_back_from_bundle_id is not distinct from old.rolled_back_from_bundle_id then
    return new;
  end if;

  raise exception using errcode = '0A000',
    message = 'rule_parameter_publication_bundles: لا يجوز تعديل بندلة إلا انتقال PUBLISHED→ROLLED_BACK — append-only';
end;
$$;

drop trigger if exists trg_forbid_rule_parameter_bundle_mutation on public.rule_parameter_publication_bundles;
create trigger trg_forbid_rule_parameter_bundle_mutation
  before update on public.rule_parameter_publication_bundles
  for each row
  execute function public.forbid_rule_parameter_bundle_mutation();
