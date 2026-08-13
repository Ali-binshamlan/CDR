-- =====================================================================
-- DCR — 202608120015_fix_forbid_evidence_mutation_record_access.sql
-- =====================================================================
-- خطأ حرج مكتشَف ومُصلَح (تطبيق فعلي على الإنتاج — "42703: record NEW has
-- no field dust_profile_id"): forbid_evidence_mutation() كانت تفحص
-- NEW.dust_profile_id مباشرة ضمن عبارة IF واحدة مركَّبة (شرط AND)، فتفشل
-- عند أي UPDATE على جدول لا يملك هذا العمود إطلاقاً (تحديداً
-- evidence_hash_ledger أدناه) — راجع الشرح الكامل لسبب الفشل البنيوي (نوع
-- RECORD، تقييم AND غير مضمون short-circuit) في تعليق الدالة داخل
-- migration 202607290004، حيث نُقل إصلاح هذا الجزء بأثر رجعي (طلب صريح من
-- المستخدم بعد ملاحظته أن أي بيئة جديدة تُبنى من الصفر تفشل في نفس النقطة:
-- 202608120011 تُنفّذ UPDATE على evidence_hash_ledger قبل أن يصل التسلسل
-- الزمني لهذا الملف، فالإصلاح هنا كان متأخراً جداً لأي bootstrap تسلسلي).
--
-- الجزء المتبقي فعلياً في هذا الملف: استثناء ثانٍ مكتشَف فور تطبيق الإصلاح
-- الأول أعلاه على الإنتاج — بعد إصلاح خطأ الوصول للحقل، ظهر الرفض المتوقَّع
-- فعلياً: forbid_evidence_mutation() تمنع append-only بلا استثناء أي
-- UPDATE على evidence_hash_ledger، لكن migration 202608120011
-- (coverage_started_at) تحتاج فعلياً تحديث ذلك العمود تحديداً على صف
-- __genesis__ الموجود مسبقاً. نفس نمط استثناء dust_profile_id بالضبط —
-- استثناء مقيَّد جداً: UPDATE على evidence_hash_ledger مسموح فقط إن كان
-- يُغيِّر عمود coverage_started_at حصراً (من NULL إلى قيمة، أو العكس) بلا
-- أي تغيير آخر على أي عمود آخر في نفس الصف. هذا الاستثناء لا يمكن نقله إلى
-- 202607290004 (يسبق زمنياً وجود عمود coverage_started_at نفسه، الذي
-- يُضاف هنا في هذه الهجرة تحديداً) — يبقى في مكانه الزمني الصحيح.
-- =====================================================================

create or replace function public.forbid_evidence_mutation()
returns trigger
language plpgsql
as $$
begin
  if TG_OP = 'UPDATE' and TG_TABLE_NAME in ('dust_evaluations', 'dust_compliance_evaluations') then
    if NEW.dust_profile_id is null
       and OLD.dust_profile_id is distinct from NEW.dust_profile_id
       and to_jsonb(NEW) - 'dust_profile_id' = to_jsonb(OLD) - 'dust_profile_id'
    then
      return NEW;
    end if;
  end if;

  if TG_OP = 'UPDATE' and TG_TABLE_NAME = 'evidence_hash_ledger' then
    if OLD.coverage_started_at is distinct from NEW.coverage_started_at
       and to_jsonb(NEW) - 'coverage_started_at' = to_jsonb(OLD) - 'coverage_started_at'
    then
      return NEW;
    end if;
  end if;

  raise exception 'audit/evidence rows are append-only — % on % is not permitted', TG_OP, TG_TABLE_NAME;
end;
$$;
