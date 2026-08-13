-- =====================================================================
-- DCR — 202608040033_provider_connections_rpc_last_pull_at.sql
-- =====================================================================
-- خطأ مكتشَف ومُصلَح (مراجعة خبير خارجي — التقرير النهائي: "العينة كل
-- دقيقتين لا تكفي؛ يمكن النقل كل دقيقتين فقط إذا احتوت الإرسالية على جميع
-- عينات الدقيقة بطوابعها المستقلة"): provider-pull/route.ts يحتاج معرفة
-- "منذ متى آخر سحب ناجح/محاولة" لهذا الاتصال تحديداً حتى يطلب من
-- fetchReadingsSince كل العينات التي وصلت المحطة منذ تلك اللحظة (لا آخر
-- عينة فقط) — list_active_provider_connections (202608040032) لم تكن
-- تُرجع عمود last_pull_at إطلاقاً.
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
  last_pull_at timestamptz
)
language sql
security invoker
set search_path = pg_catalog, public
stable
as $$
  select
    pc.id, pc.device_id, pc.project_id, pc.provider,
    pc.credentials_ciphertext, pc.credentials_key_version,
    pc.vendor_station_id, pc.provider_instance_id, pc.last_pull_at
  from public.provider_connections pc
  where pc.is_active = true
    and pc.vendor_station_id is not null;
$$;

revoke all on function public.list_active_provider_connections() from public, anon, authenticated;
grant execute on function public.list_active_provider_connections() to service_role;
