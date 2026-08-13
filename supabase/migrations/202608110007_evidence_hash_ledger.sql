-- =====================================================================
-- DCR — 202608110007_evidence_hash_ledger.sql
-- =====================================================================
-- تحقيق مؤكَّد: forbid_evidence_mutation/forbid_evidence_truncate
-- (202607290004/202608040014) تمنع التعديل عبر service_role لكنها ليست
-- Tamper-Evident — لا hash chain، لا توقيع، لا تثبيت خارجي، ولا تحقق من
-- input_snapshot_hash على مستوى القاعدة (يُحسَب في التطبيق ويُخزَّن بثقة
-- عمياء). الأخطر: دور postgres المالك يقدر ALTER TABLE ... DISABLE TRIGGER
-- ALL، يعدّل بحرية، ثم يعيد التفعيل — بلا أي أثر حالياً.
--
-- لا يمكن لأي migration منع دور Postgres المالك من الوصول (خارج نطاق أي حل
-- من طرف العميل على خطة Supabase مُدارة). الهدف الواقعي: جعل أي تلاعب قابلاً
-- للاكتشاف خلال دورة مراقبة واحدة، عبر سجل مستقل (دفتر تجزئة موحَّد لكل
-- الجداول العشرة، لاحقاً مُثبَّت خارجياً على GitHub في migration/route منفصل).
--
-- دفتر واحد موحَّد (لا 10 سلاسل منفصلة) — bigint identity يعطي ترتيباً
-- زمنياً كلياً موثوقاً (created_at غير فريد تحت التزامن)، ويبسّط التحقق
-- لمسار واحد بدل عشرة.
-- =====================================================================

create table if not exists public.evidence_hash_ledger (
  seq bigint generated always as identity primary key,
  source_table text not null,
  source_row_id uuid not null,
  row_created_at timestamptz not null,
  row_hash text not null,
  previous_hash text not null,
  chain_hash text not null,
  created_at timestamptz not null default clock_timestamp()
);

create unique index if not exists idx_evidence_hash_ledger_source
  on public.evidence_hash_ledger (source_table, source_row_id);
create index if not exists idx_evidence_hash_ledger_seq on public.evidence_hash_ledger (seq);

-- بذرة أولى (genesis) — بشرط عدم وجودها مسبقاً، تضمن أن أول صف حقيقي دائماً
-- له previous_hash محدَّد (لا NULL خاص يحتاج معالجة استثنائية في كل تحقق).
insert into public.evidence_hash_ledger (source_table, source_row_id, row_created_at, row_hash, previous_hash, chain_hash)
select '__genesis__', '00000000-0000-0000-0000-000000000000', now(),
       encode(digest('DCR-EVIDENCE-CHAIN-GENESIS', 'sha256'), 'hex'),
       encode(digest('DCR-EVIDENCE-CHAIN-GENESIS', 'sha256'), 'hex'),
       encode(digest(encode(digest('DCR-EVIDENCE-CHAIN-GENESIS', 'sha256'), 'hex') ||
                      encode(digest('DCR-EVIDENCE-CHAIN-GENESIS', 'sha256'), 'hex'), 'sha256'), 'hex')
where not exists (select 1 from public.evidence_hash_ledger);

alter table public.evidence_hash_ledger enable row level security;
revoke all on public.evidence_hash_ledger from anon, authenticated;
grant select, insert on public.evidence_hash_ledger to service_role;

-- الدفتر نفسه جدول أدلة (سُهي عنه في القائمة الأصلية) — نفس حماية
-- append-only المستخدَمة لبقية العشرة، بالإضافة إلى REVOKE TRUNCATE صريح.
drop trigger if exists evidence_hash_ledger_immutable on public.evidence_hash_ledger;
create trigger evidence_hash_ledger_immutable
  before update or delete on public.evidence_hash_ledger
  for each row execute function public.forbid_evidence_mutation();

drop trigger if exists evidence_hash_ledger_no_truncate on public.evidence_hash_ledger;
create trigger evidence_hash_ledger_no_truncate
  before truncate on public.evidence_hash_ledger
  for each statement execute function public.forbid_evidence_truncate();

revoke truncate on public.evidence_hash_ledger from anon, authenticated, service_role;
