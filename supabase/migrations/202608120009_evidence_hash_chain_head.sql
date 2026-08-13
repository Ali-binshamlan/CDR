-- =====================================================================
-- DCR — 202608120009_evidence_hash_chain_head.sql
-- =====================================================================
-- خطأ مكتشَف ومُصلَح (طلب صريح من المستخدم — مراجعة كود خارجي: "سلسلة Hash
-- يمكن أن تتفرع تحت التزامن"): append_evidence_hash_link (202608110008)
-- كانت تحدد previous_hash عبر:
--   select chain_hash from evidence_hash_ledger order by seq desc limit 1 for update;
-- هذا لا يُسلسِل الإدراجات المتزامنة فعلياً رغم FOR UPDATE — السيناريو
-- الحقيقي: معاملتان A وB تبدآن معاً، كلتاهما تُقيِّمان ORDER BY seq DESC
-- LIMIT 1 وتجدان *نفس* الصف X (آخر seq وقتها) كذيل السلسلة، فتحاولان قفله
-- معاً؛ A تفوز بالقفل أولاً، تُدرِج صفاً جديداً (previous_hash=X.chain_hash)
-- وتُنهي المعاملة (تحرّر القفل)؛ B كانت قد قرأت X.chain_hash *قبل* الانتظار
-- على القفل (القراءة تمّت في نفس عبارة SELECT التي طلبت القفل، لا بعد
-- الحصول عليه) — فتُدرِج صفها الجديد أيضاً بـprevious_hash=X.chain_hash،
-- لا بصف A الجديد (seq أعلى). النتيجة: صفّان مختلفان في evidence_hash_ledger
-- يدّعيان نفس previous_hash — تفرّع فعلي في السلسلة، لا خط واحد متصل، رغم
-- أن الإدراجين نفسيهما (INSERT) تسلسلا بلا تعارض (كل واحد seq مختلف حقيقي
-- من identity — المشكلة في previous_hash المُدرَج معه، لا في seq ذاته).
--
-- السبب الجذري: FOR UPDATE يقفل الصف الذي *تعثر عليه* عبارة SELECT — لا
-- يمنع عبارتين منفصلتين من العثور على نفس الصف "الأحدث" أولاً قبل أن
-- يتنافسا على قفله. لا يوجد صف واحد ثابت الهوية (identity) تتنافس عليه كل
-- المعاملات منذ البداية؛ "الذيل" نفسه متغيّر الهوية (يتغيّر الصف الذي
-- يُطابِق seq الأقصى بين استعلام وآخر).
--
-- الإصلاح (طلب صريح): جدول evidence_chain_head — صف واحد ثابت الهوية
-- دائماً (id=true قيد PRIMARY KEY، لا يمكن وجود أكثر من صف)، يحمل last_seq/
-- last_hash فقط. append_evidence_hash_link تقفل *هذا الصف الثابت* (SELECT
-- ... FOR UPDATE WHERE id = true) أولاً — كل المعاملات المتزامنة تتسابق على
-- نفس صف الهوية الثابتة منذ البداية (لا صف متغيّر يُكتشَف لاحقاً)، فتُسلسَل
-- فعلياً: الفائزة تقرأ last_hash، تُدرِج صفها، ثم تُحدِّث الصف الثابت
-- (last_seq/last_hash الجديدين) *قبل* أن تُحرِّر القفل عند commit — الخاسرة
-- تنتظر حتى commit الفائزة، ثم تقرأ القيم *المحدَّثة* فعلياً (last_hash
-- الجديد، لا القديم) لأنها تُعيد تنفيذ نفس SELECT FOR UPDATE من جديد بعد
-- تحرّر القفل، لا تستخدم قيمة قرأتها قبل الانتظار.
-- =====================================================================

create table if not exists public.evidence_chain_head (
  id boolean primary key default true,
  last_seq bigint not null,
  last_hash text not null,
  updated_at timestamptz not null default clock_timestamp(),
  constraint evidence_chain_head_singleton check (id)
);

comment on table public.evidence_chain_head is
  'صف واحد ثابت الهوية (id=true دائماً، قيد singleton) يحمل ذيل evidence_hash_ledger الحالي — append_evidence_hash_link تقفله (FOR UPDATE) ليسلسل الإدراجات المتزامنة فعلياً، بدل ORDER BY seq DESC LIMIT 1 غير الآمن تحت تزامن (راجع تعليق migration 202608120009 الكامل).';

alter table public.evidence_chain_head enable row level security;
revoke all on public.evidence_chain_head from anon, authenticated;
grant select, insert, update on public.evidence_chain_head to service_role;

-- append-only بنفس درجة evidence_hash_ledger نفسها — التحديث الوحيد المسموح
-- هو last_seq/last_hash/updated_at (ما تكتبه append_evidence_hash_link على
-- الصف الثابت الوحيد)، لا أي تعديل آخر، ولا حذف/إدراج صف ثانٍ (يمنعه أصلاً
-- قيد PRIMARY KEY على id=true).
create or replace function public.forbid_evidence_chain_head_mutation()
returns trigger
language plpgsql
as $$
begin
  if TG_OP = 'UPDATE'
     and new.id = old.id
     and new.last_seq >= old.last_seq
  then
    return new;
  end if;

  raise exception 'evidence_chain_head: يُسمَح فقط بتحديث last_seq/last_hash/updated_at تصاعدياً — % على % مرفوض', TG_OP, TG_TABLE_NAME;
end;
$$;

drop trigger if exists evidence_chain_head_immutable on public.evidence_chain_head;
create trigger evidence_chain_head_immutable
  before update or delete on public.evidence_chain_head
  for each row execute function public.forbid_evidence_chain_head_mutation();

drop trigger if exists evidence_chain_head_no_truncate on public.evidence_chain_head;
create trigger evidence_chain_head_no_truncate
  before truncate on public.evidence_chain_head
  for each statement execute function public.forbid_evidence_truncate();
revoke truncate on public.evidence_chain_head from anon, authenticated, service_role;

-- تهيئة الصف الثابت من ذيل evidence_hash_ledger الحالي فعلياً (يشمل صف
-- genesis إن لم يوجد أي صف حقيقي بعد) — مرة واحدة فقط، on conflict do nothing
-- يحمي من إعادة التهيئة لو أُعيد تشغيل هذه الهجرة.
insert into public.evidence_chain_head (id, last_seq, last_hash)
select true, seq, chain_hash
from public.evidence_hash_ledger
order by seq desc
limit 1
on conflict (id) do nothing;

-- إعادة تعريف append_evidence_hash_link — نفس المنطق بالضبط عدا مصدر
-- previous_hash: يُقرَأ الآن من evidence_chain_head المقفول (لا آخر صف في
-- evidence_hash_ledger نفسه)، ويُحدَّث الصف الثابت فور نجاح الإدراج، داخل
-- نفس المعاملة (نفس trigger AFTER INSERT — يبقى ذرّياً مع الإدراج نفسه).
create or replace function public.append_evidence_hash_link()
returns trigger
language plpgsql
set search_path = pg_catalog, public, extensions
as $$
declare
  v_row_hash text;
  v_previous_hash text;
  v_chain_hash text;
  v_row_created_at timestamptz;
  v_new_seq bigint;
begin
  v_row_hash := encode(digest(to_jsonb(NEW)::text, 'sha256'), 'hex');

  v_row_created_at := coalesce(
    (to_jsonb(NEW)->>'created_at')::timestamptz,
    (to_jsonb(NEW)->>'recorded_at')::timestamptz,
    now()
  );

  -- راجع تعليق migration 202608120009 الكامل أعلى الملف — هذا القفل هو
  -- الإصلاح الجوهري: صف ثابت الهوية (id=true) لا يتغيّر أيّ صف يُطابِقه
  -- بين استعلام وآخر، بخلاف "آخر صف بترتيب seq" الذي كان يتغيّر هويته.
  select last_hash into v_previous_hash
  from public.evidence_chain_head
  where id = true
  for update;

  v_chain_hash := encode(digest(v_row_hash || v_previous_hash, 'sha256'), 'hex');

  insert into public.evidence_hash_ledger (
    source_table, source_row_id, row_created_at, row_hash, previous_hash, chain_hash
  )
  values (TG_TABLE_NAME, NEW.id, v_row_created_at, v_row_hash, v_previous_hash, v_chain_hash)
  returning seq into v_new_seq;

  update public.evidence_chain_head
  set last_seq = v_new_seq,
      last_hash = v_chain_hash,
      updated_at = clock_timestamp()
  where id = true;

  return NEW;
end;
$$;

-- triggers الأصلية (202608110008) تستدعي public.append_evidence_hash_link
-- بالاسم — CREATE OR REPLACE أعلاه يكفي لتحديث كل الجداول العشرة دفعة واحدة
-- بلا حاجة لإعادة إنشاء triggers نفسها.
