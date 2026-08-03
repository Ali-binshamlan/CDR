-- =====================================================================
-- DCR — 202608020004_alerts_realtime_publication.sql
-- =====================================================================
-- alerts له بالفعل policy مقيَّدة لصالح authenticated (alerts_owner_select،
-- راجع 202608020003_close_direct_client_write_access.sql)، لكنه لم يكن
-- مُدرَجاً إطلاقاً بـsupabase_realtime publication — فاشتراك sidebar-alerts-
-- count في Sidebar.tsx كان يفشل صامتاً بلا أي حدث يصل مهما حدث بالجدول،
-- بنفس العلة التي كانت تمنع تحديث final_decisions تلقائياً (راجع
-- 202608020002_final_decisions_realtime_policy.sql). idempotent بنفس النمط.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'alerts'
  ) then
    alter publication supabase_realtime add table public.alerts;
  end if;
end $$;
