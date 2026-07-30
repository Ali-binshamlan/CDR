-- =====================================================================
-- هجرة: إصلاح on delete cascade من project_dust_profiles إلى جداول الأدلة
-- (اكتُشفت أثناء تشخيص عطل حي: "لماذا لا أستطيع حذف الأنشطة؟")
--
-- الثغرة المكتشفة: dust_evaluations.dust_profile_id وdust_compliance_
-- evaluations.dust_profile_id كلاهما `not null references
-- project_dust_profiles(id) on delete cascade` — بعد تطبيق append-only
-- على هذين الجدولين (راجع supabase-append-only-evidence-and-alert-events-
-- migration.sql، trigger forbid_evidence_mutation يمنع UPDATE/DELETE
-- نهائياً)، أصبح حذف أي صف project_dust_profiles يُفشِل نفسه بالكامل:
-- Postgres يحاول تفعيل الـ cascade على صفوف الأدلة المرتبطة، فيصطدم بالـ
-- trigger الذي يرفض الحذف حتى لو نتج عن cascade، فتفشل عملية حذف النشاط
-- بأكملها بخطأ 500 (نفس مبدأ حماية الأدلة، لكن بأثر جانبي غير مقصود: منع
-- حذف النشاط الأب نفسه بالكامل، لا فقط حماية الأدلة).
--
-- alerts.activity_id وdecision_records.activity_id لا يحتاجان إصلاحاً —
-- كلاهما عمود نصي حر (لا uuid، لا foreign key إطلاقاً)، فلا cascade عليهما
-- أصلاً؛ يبقيان محفوظين تماماً بصرف النظر عن مصير project_dust_profiles.
--
-- الإصلاح: dust_profile_id يصبح nullable + on delete set null (بدل cascade)
-- — حذف النشاط لا يعود يحذف سجل تقييماته التاريخي، فقط يفصل الرابط
-- (dust_profile_id يصبح null على تلك الصفوف). الأدلة نفسها (عمود result
-- الكامل JSONB) تبقى محفوظة بالكامل للتدقيق، غير مرتبطة بنشاط مرئي بعد
-- الآن — نفس فلسفة أرشفة المشروع تماماً (لا حذف فعلي لأي أثر تدقيق).
--
-- اكتشاف اسم القيد تلقائياً (بدل افتراض الاسم القياسي لـ Postgres) —
-- أسلم من `alter table ... drop constraint <اسم مفترَض>` لو أُنشئ القيد
-- سابقاً باسم مختلف عن التسمية الافتراضية.
-- =====================================================================

do $$
declare
  fk_name text;
begin
  select tc.constraint_name into fk_name
  from information_schema.table_constraints tc
  join information_schema.key_column_usage kcu
    on tc.constraint_name = kcu.constraint_name and tc.table_schema = kcu.table_schema
  where tc.table_schema = 'public'
    and tc.table_name = 'dust_evaluations'
    and tc.constraint_type = 'FOREIGN KEY'
    and kcu.column_name = 'dust_profile_id'
  limit 1;

  if fk_name is not null then
    execute format('alter table public.dust_evaluations drop constraint %I', fk_name);
  end if;
end $$;

alter table public.dust_evaluations
  alter column dust_profile_id drop not null;

alter table public.dust_evaluations
  add constraint dust_evaluations_dust_profile_id_fkey
  foreign key (dust_profile_id) references public.project_dust_profiles(id) on delete set null;

do $$
declare
  fk_name text;
begin
  select tc.constraint_name into fk_name
  from information_schema.table_constraints tc
  join information_schema.key_column_usage kcu
    on tc.constraint_name = kcu.constraint_name and tc.table_schema = kcu.table_schema
  where tc.table_schema = 'public'
    and tc.table_name = 'dust_compliance_evaluations'
    and tc.constraint_type = 'FOREIGN KEY'
    and kcu.column_name = 'dust_profile_id'
  limit 1;

  if fk_name is not null then
    execute format('alter table public.dust_compliance_evaluations drop constraint %I', fk_name);
  end if;
end $$;

alter table public.dust_compliance_evaluations
  alter column dust_profile_id drop not null;

alter table public.dust_compliance_evaluations
  add constraint dust_compliance_evaluations_dust_profile_id_fkey
  foreign key (dust_profile_id) references public.project_dust_profiles(id) on delete set null;
