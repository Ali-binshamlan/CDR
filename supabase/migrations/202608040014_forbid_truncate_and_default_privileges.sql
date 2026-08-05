-- =====================================================================
-- DCR — 202608040014_forbid_truncate_and_default_privileges.sql
-- =====================================================================
-- خطأ أمني مكتشَف (القسم 5.9/14 من "دليل الإصلاح الجذري لمنظومة مرقاب" —
-- "append-only غير مكتمل"): forbid_evidence_mutation() (202607290004) هي
-- trigger على مستوى الصف (BEFORE UPDATE OR DELETE FOR EACH ROW) — لا تمنع
-- TRUNCATE إطلاقاً (TRUNCATE لا يُطلِق triggers على مستوى الصف في
-- PostgreSQL، فقط triggers على مستوى العبارة BEFORE/AFTER TRUNCATE
-- FOR EACH STATEMENT). أي دور يملك صلاحية TRUNCATE على أحد جداول الأدلة
-- (service_role بطبيعته يملكها ما لم تُسحَب صراحة) يقدر يمحو الجدول بالكامل
-- بعبارة واحدة رغم كل حماية UPDATE/DELETE القائمة.
--
-- الإصلاح: trigger منفصل على مستوى العبارة (BEFORE TRUNCATE FOR EACH
-- STATEMENT) على كل جدول أدلة، بالإضافة إلى REVOKE TRUNCATE صريح من كل
-- الأدوار (حتى service_role — الحماية على مستوى الصلاحية والـtrigger معاً،
-- فلا تعتمد سلامة الجدول على أن أحداً لم ينسَ سحب TRUNCATE يدوياً).
-- =====================================================================

create or replace function public.forbid_evidence_truncate()
returns trigger
language plpgsql
as $$
begin
  raise exception 'evidence tables cannot be truncated — % on % is not permitted', TG_OP, TG_TABLE_NAME;
end;
$$;

-- كل جدول أدلة/تدقيق موجود فعلياً في هذا المشروع — القائمة الكاملة من كل
-- trigger UPDATE/DELETE append-only سابق، بالإضافة إلى الجداول الجديدة
-- (device_events/device_measurements، القسم 8.3) التي تحمل نفس درجة
-- الحساسية (دليل تاريخي غير قابل لإعادة الحساب).
do $$
declare
  t text;
  evidence_tables text[] := array[
    'decision_records',
    'dust_evaluations',
    'dust_compliance_evaluations',
    'pm10_readings_history',
    'alert_state_events',
    'device_readings_history',
    'final_decisions',
    'admin_audit_log',
    'device_events',
    'device_measurements'
  ];
begin
  foreach t in array evidence_tables loop
    execute format(
      'drop trigger if exists %I_no_truncate on public.%I;',
      t, t
    );
    execute format(
      'create trigger %I_no_truncate before truncate on public.%I for each statement execute function public.forbid_evidence_truncate();',
      t, t
    );
    execute format(
      'revoke truncate on public.%I from anon, authenticated, service_role;',
      t
    );
  end loop;
end $$;

-- =====================================================================
-- Default Privileges — القسم 14.3: يمنع أي جدول/دالة جديدة مستقبلاً من
-- الانفتاح تلقائياً بصلاحيات افتراضية لـpublic/anon/authenticated. بلا
-- هذا، إضافة جدول جديد لاحقاً (migration مستقبلية تنسى REVOKE صريحاً) قد
-- يُقرَأ بالكامل عبر أي مستخدم فوراً.
-- =====================================================================
revoke create on schema public from public, anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;

alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated;

alter default privileges for role postgres in schema public
  revoke execute on functions from public, anon, authenticated;
