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
-- الجزء المتعلق باستثناء coverage_started_at (الذي كان موثَّقاً هنا سابقاً)
-- خطأ P0 مكتشَف لاحقاً ومُصلَح بأثر رجعي (نفس نمط dust_profile_id أعلاه
-- بالضبط): استثناء evidence_hash_ledger.coverage_started_at كان لا يزال
-- يصل متأخراً جداً حتى بعد النقل الأول — migration 202608120011 (التي
-- تُضيف العمود وتحتاج تحديثه على صف __genesis__ الموجود مسبقاً) تُنفَّذ
-- *قبل* هذا الملف زمنياً، فأي بيئة تُبنى من الصفر (supabase db reset) كانت
-- لا تزال تتوقف عند 202608120011 بخطأ append-only، حتى بعد إصلاح خطأ الوصول
-- للحقل. الإصلاح النهائي نُقل إلى 202608120011 نفسها (بعد إضافة العمود،
-- قبل الـUPDATE الذي يحتاجه) — راجع تعليق الدالة هناك للنسخة الكاملة
-- الحالية. إعادة التعريف أدناه تبقى مطابقة لتلك النسخة تماماً (idempotent،
-- لا تراجع) فقط للتوثيق التاريخي المتسلسل، لا لأنها ضرورية لحل المشكلة بعد
-- الآن.
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
