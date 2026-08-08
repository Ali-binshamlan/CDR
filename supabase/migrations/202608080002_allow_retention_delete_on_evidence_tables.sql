-- =====================================================================
-- السماح بحذف احتفاظ (retention) للصفوف الأقدم من 30 يوماً فقط — بلا فتح
-- الباب لأي DELETE/UPDATE آخر على جداول الأدلة append-only
-- =====================================================================
-- القرار (صريح من المستخدم، 2026-08-08): حذف مباشر بلا أرشفة لبيانات
-- القراءات/التقييمات الأقدم من 30 يوماً — النمو غير المحدود لهذه الجداول
-- (append-only بلا أي تنظيف) هو ما أوصل dust_evaluations/dust_compliance_
-- evaluations لاستهلاك المساحة الفعلي، لا فقط الـbloat الذي عولج سابقاً
-- عبر VACUUM FULL (راجع 202608080001). التريغر الحالي forbid_evidence_
-- mutation يمنع DELETE بإطلاق تام — هذا التعديل يضيف استثناءً واحداً
-- ضيقاً محدداً بشرط عمر الصف فقط (OLD.created_at/recorded_at أقدم من 30
-- يوماً)، لا استثناء عام يفتح الباب لحذف كيفي.
--
-- retention_delete_cron/route.ts (جديد) هو المستهلك الوحيد المقصود لهذا
-- الاستثناء — يُستدعى دورياً (يومياً) عبر cron-job.org بنفس نمط
-- provider-pull/route.ts (سر منفصل RETENTION_CRON_SECRET).
--
-- مقصور على الجداول الأربعة التي شخّصناها فعلياً كمصدر نمو المساحة
-- (dust_evaluations/dust_compliance_evaluations/pm10_readings_history/
-- device_readings_history) — device_events وغيره من جداول append-only
-- الأخرى تبقى بلا استثناء حذف (صغيرة الحجم فعلياً، لا حاجة فعلية).

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

  -- استثناء احتفاظ ضيق: DELETE فقط، فقط على الجداول الأربعة أدناه، وفقط
  -- لصف يتجاوز عمره 30 يوماً فعلياً وقت الحذف (لا يعتمد على من يستدعي —
  -- الشرط على بيانات الصف نفسه، لا على الدور/المصدر).
  if TG_OP = 'DELETE' then
    if TG_TABLE_NAME in ('dust_evaluations', 'dust_compliance_evaluations') and OLD.created_at < now() - interval '30 days' then
      return OLD;
    end if;
    if TG_TABLE_NAME in ('pm10_readings_history', 'device_readings_history') and OLD.recorded_at < now() - interval '30 days' then
      return OLD;
    end if;
  end if;

  raise exception 'audit/evidence rows are append-only — % on % is not permitted (retention delete requires row age > 30 days)', TG_OP, TG_TABLE_NAME;
end;
$$;
