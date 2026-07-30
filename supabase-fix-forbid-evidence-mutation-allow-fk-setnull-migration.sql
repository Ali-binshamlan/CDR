-- =====================================================================
-- هجرة: السماح لـ ON DELETE SET NULL (FK) بتحديث dust_profile_id فقط،
-- مع بقاء كل تعديل/حذف آخر ممنوعاً على جداول الأدلة append-only
--
-- الثغرة/العطل المكتشَف: بعد supabase-append-only-evidence-and-alert-
-- events-migration.sql، صار trigger واحد (forbid_evidence_mutation) يمنع
-- أي UPDATE OR DELETE على dust_evaluations/dust_compliance_evaluations
-- بلا أي استثناء. لاحقاً supabase-fix-evidence-cascade-delete-migration.sql
-- غيّر dust_profile_id (foreign key من dust_evaluations/dust_compliance_
-- evaluations نحو project_dust_profiles) من on delete cascade إلى
-- on delete set null، بقصد أن حذف نشاط (project_dust_profiles) يُفصل
-- الأدلة عنه تلقائياً بدل حذفها.
--
-- لكن Postgres ينفّذ on delete set null كـ UPDATE ضمني على الصفوف
-- المرتبطة — وهذا الـ UPDATE يصطدم بنفس trigger forbid_evidence_mutation
-- (الذي لا يفرّق بين UPDATE من كود التطبيق وUPDATE ناتج عن FK action)،
-- فيفشل حذف project_dust_profiles نفسه بالكامل بخطأ 500، رغم أن route.ts
-- (app/api/activities/route.ts DELETE) توقف عن حذف جداول الأدلة صراحة.
-- بمعنى آخر: المنع كان يمنع حتى الآلية المصمَّمة خصيصاً لحل نفس المشكلة.
--
-- الإصلاح: forbid_evidence_mutation يسمح حصراً بحالة واحدة —
-- UPDATE حيث العمود الوحيد المتغيّر هو dust_profile_id (وقيمته الجديدة
-- null)، وهذا فقط على dust_evaluations/dust_compliance_evaluations
-- (الجدولين الوحيدين اللذين يملكان هذا العمود). أي تغيير آخر على أي عمود
-- آخر، أو أي DELETE، يبقى ممنوعاً تماماً كما كان — بما فيها decision_records
-- وpm10_readings_history اللي ما عندها هذا العمود أصلاً فتبقى محمية 100%.
-- =====================================================================

create or replace function public.forbid_evidence_mutation()
returns trigger
language plpgsql
as $$
begin
  if TG_OP = 'UPDATE'
     and TG_TABLE_NAME in ('dust_evaluations', 'dust_compliance_evaluations')
     and NEW.dust_profile_id is null
     and OLD.dust_profile_id is distinct from NEW.dust_profile_id
     and to_jsonb(NEW) - 'dust_profile_id' = to_jsonb(OLD) - 'dust_profile_id'
  then
    return NEW;
  end if;

  raise exception 'audit/evidence rows are append-only — % on % is not permitted', TG_OP, TG_TABLE_NAME;
end;
$$;
