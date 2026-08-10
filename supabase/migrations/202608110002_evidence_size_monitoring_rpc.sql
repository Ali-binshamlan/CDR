-- =====================================================================
-- DCR — 202608110002_evidence_size_monitoring_rpc.sql
-- =====================================================================
-- خطة الاحتفاظ طويلة المدى — القسم 3: RPC خفيفة تُغلِّف نفس استعلام
-- pg_total_relation_size المُستخدَم يدوياً على القاعدة الحية (2026-08-10)
-- — بلا أي تغيير في المنطق، فقط إتاحته لـscheduler-heartbeat بدل تشغيله
-- يدوياً فقط عبر SQL Editor. تُستخدَم لمراقبة نمو جداول الأدلة العشرة
-- (append-only، لا حذف أبداً) مقابل عتبات رقمية صريحة — لا تنفّذ أي تنظيف
-- أو حذف بنفسها، قراءة فقط.
-- =====================================================================

create or replace function public.get_database_and_table_sizes()
returns table(table_name text, total_bytes bigint, row_estimate bigint)
language sql
security invoker
set search_path = pg_catalog, public
stable
as $$
  select
    c.relname as table_name,
    pg_total_relation_size(c.oid) as total_bytes,
    s.n_live_tup as row_estimate
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  left join pg_stat_user_tables s on s.relid = c.oid
  where n.nspname = 'public' and c.relkind = 'r'
  order by pg_total_relation_size(c.oid) desc;
$$;

revoke all on function public.get_database_and_table_sizes() from public, anon, authenticated;
grant execute on function public.get_database_and_table_sizes() to service_role;
