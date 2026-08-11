-- =====================================================================
-- DCR — 202608110015_provider_connections_rpc_pull_cursor.sql
-- =====================================================================
-- list_active_provider_connections (202608040032، وسِّعت آخر مرة في
-- 202608040033 لإضافة last_pull_at) يجب أن تُرجع pull_cursor_at الجديد
-- (202608110014) أيضاً — provider-pull/route.ts يحسب sinceMs منه الآن
-- بدل last_pull_at (راجع تعليق 202608110014 الكامل للسبب).
-- =====================================================================

drop function if exists public.list_active_provider_connections();

create or replace function public.list_active_provider_connections()
returns table (
  id uuid,
  device_id uuid,
  project_id uuid,
  provider text,
  credentials_ciphertext text,
  credentials_key_version integer,
  vendor_station_id text,
  provider_instance_id uuid,
  last_pull_at timestamptz,
  pull_cursor_at timestamptz
)
language sql
security invoker
set search_path = pg_catalog, public
stable
as $$
  select
    pc.id, pc.device_id, pc.project_id, pc.provider,
    pc.credentials_ciphertext, pc.credentials_key_version,
    pc.vendor_station_id, pc.provider_instance_id, pc.last_pull_at,
    pc.pull_cursor_at
  from public.provider_connections pc
  where pc.is_active = true
    and pc.vendor_station_id is not null;
$$;

revoke all on function public.list_active_provider_connections() from public, anon, authenticated;
grant execute on function public.list_active_provider_connections() to service_role;
