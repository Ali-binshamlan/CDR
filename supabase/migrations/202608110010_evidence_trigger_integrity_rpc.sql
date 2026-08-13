-- =====================================================================
-- DCR — 202608110010_evidence_trigger_integrity_rpc.sql
-- =====================================================================
-- بنية Tamper-Evidence — المرحلة 2: RPC قراءة فقط تقرأ pg_trigger مباشرة
-- (نفس نمط get_database_and_table_sizes، 202608110002 — security invoker،
-- search_path مقيَّد بـpg_catalog/public، grant لـservice_role فقط) لتكشف
-- إن عُطِّل أحد triggers الحماية على أي جدول أدلة (مثلاً عبر ALTER TABLE
-- ... DISABLE TRIGGER من دور يملك صلاحيات مالك القاعدة).
--
-- left join (لا inner join) — trigger محذوف تماماً (لا فقط معطَّل) يجب أن
-- يظهر صراحةً كـis_enabled=false، لا يختفي بصمت من النتيجة.
-- =====================================================================

create or replace function public.check_evidence_trigger_integrity()
returns table(
  table_name text,
  trigger_name text,
  is_enabled boolean
)
language sql
security invoker
set search_path = pg_catalog, public
stable
as $$
  with evidence_tables as (
    select unnest(array[
      'decision_records', 'dust_evaluations', 'dust_compliance_evaluations',
      'pm10_readings_history', 'alert_state_events', 'device_readings_history',
      'final_decisions', 'admin_audit_log', 'device_events', 'device_measurements',
      'evidence_hash_ledger', 'evidence_anchor_runs'
    ]) as tbl
  ),
  expected_triggers as (
    select tbl, tbl || '_immutable' as trg from evidence_tables
    union all
    select tbl, tbl || '_no_truncate' as trg from evidence_tables
    union all
    select tbl, tbl || '_hash_chain_append' as trg
    from evidence_tables
    where tbl not in ('evidence_hash_ledger', 'evidence_anchor_runs')
  )
  select
    e.tbl as table_name,
    e.trg as trigger_name,
    coalesce(t.tgenabled <> 'D', false) as is_enabled
  from expected_triggers e
  left join pg_class c on c.relname = e.tbl and c.relnamespace = 'public'::regnamespace
  left join pg_trigger t on t.tgrelid = c.oid and t.tgname = e.trg
  order by e.tbl, e.trg;
$$;

revoke all on function public.check_evidence_trigger_integrity() from public, anon, authenticated;
grant execute on function public.check_evidence_trigger_integrity() to service_role;
