-- =====================================================================
-- DCR — 202608040023_device_events_sequence_not_null.sql
-- =====================================================================
-- القسم 5.10 من "دليل الإصلاح الجذري لمنظومة مرقاب" — "عقد الحدث كامل فقط
-- في Push": device_events.sequence_no كان nullable بلا أي قيد سوى رفض
-- القيم السالبة (CHECK (sequence_no is null or sequence_no >= 0))، وPull/
-- الكاتب الداخلي (deviceReadingWriter.ts) لم يكونا يمرران قيمة إطلاقاً —
-- فيمر null بصمت. deviceReadingWriter.ts الآن يشتق sequence حتمياً من
-- observedAt (طابع Unix بالمللي ثانية) متى لم يُمرَّر صراحةً — كل استدعاء
-- جديد (Push أو Pull) يحمل قيمة فعلية دائماً. هذه الهجرة:
--   1) تُصفِّر (backfill) أي صف قديم بـsequence_no=null بنفس الاشتقاق
--      (طابع Unix للمللي ثانية من received_at، أقرب تقدير ممكن لوقت الحدث
--      الفعلي لصفوف تاريخية سابقة لهذا الإصلاح).
--   2) تفرض NOT NULL + CHECK (sequence_no >= 0) صراحة على العمود.
-- =====================================================================

update public.device_events
set sequence_no = (extract(epoch from received_at) * 1000)::bigint
where sequence_no is null;

-- القيد الأصلي (202608040001) عمود مضمَّن بلا اسم صريح — يُعثَر على اسمه
-- الفعلي المولَّد تلقائياً عبر pg_constraint بدل افتراض اسم ثابت، تفادياً
-- لفشل هذه الهجرة لو اختلفت تسمية Postgres التلقائية عن المتوقَّع.
do $$
declare
  v_constraint_name text;
begin
  select conname into v_constraint_name
  from pg_constraint
  where conrelid = 'public.device_events'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) ilike '%sequence_no%';

  if v_constraint_name is not null then
    execute format('alter table public.device_events drop constraint %I', v_constraint_name);
  end if;
end $$;

alter table public.device_events
  alter column sequence_no set not null;

alter table public.device_events
  add constraint device_events_sequence_no_check check (sequence_no >= 0);
