-- =====================================================================
-- DCR — 202608110011_evidence_chain_verification_rpc.sql
-- =====================================================================
-- بنية Tamper-Evidence — المرحلة 4: RPC قراءة فقط تعيد حساب chain_hash
-- لآخر p_window صفاً من evidence_hash_ledger وتقارنها بالمخزَّن — أي تعديل
-- مباشر على الدفتر (تجاوز التطبيق بالكامل، عبر دور مالك القاعدة) يُنتج
-- عدم تطابق يُكتشَف هنا. نافذة محدودة (افتراضي 50) — فحص السلسلة كاملة من
-- أول صف يبقى مهمة منفصلة أثقل، لا تُشغَّل في كل نبضة مراقبة.
-- =====================================================================

create or replace function public.verify_evidence_chain_tail(p_window integer default 50)
returns table(
  seq bigint,
  is_valid boolean,
  expected_chain_hash text,
  stored_chain_hash text
)
language sql
security invoker
set search_path = pg_catalog, public
stable
as $$
  with tail as (
    select el.seq, el.row_hash, el.previous_hash, el.chain_hash,
           lag(el.chain_hash) over (order by el.seq) as prior_chain_hash
    from public.evidence_hash_ledger el
    order by el.seq desc
    limit greatest(p_window, 1) + 1
  ),
  checked as (
    select
      t.seq,
      t.chain_hash as stored_chain_hash,
      encode(digest(t.row_hash || t.previous_hash, 'sha256'), 'hex') as expected_chain_hash,
      t.prior_chain_hash,
      t.previous_hash
    from tail t
  )
  select
    c.seq,
    (
      c.expected_chain_hash = c.stored_chain_hash
      and (c.prior_chain_hash is null or c.prior_chain_hash = c.previous_hash)
    ) as is_valid,
    c.expected_chain_hash,
    c.stored_chain_hash
  from checked c
  order by c.seq desc
  limit p_window;
$$;

revoke all on function public.verify_evidence_chain_tail(integer) from public, anon, authenticated;
grant execute on function public.verify_evidence_chain_tail(integer) to service_role;
