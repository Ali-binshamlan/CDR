-- =====================================================================
-- DCR — 202608040032_provider_connections_active_rpc.sql
-- =====================================================================
-- خطأ تشغيلي مكتشَف (إنتاج فعلي): PostgREST على مشروع الإنتاج يرفض رؤية
-- عمود provider_connections.credentials_ciphertext (وقبله، علاقة provider_
-- instances) رغم تأكيد ثلاثي عبر information_schema/pg_constraint/
-- information_schema.column_privileges أن العمود موجود فعلياً، صلاحياته
-- صحيحة (service_role يملك SELECT كاملة)، والـFK موجود ومُفعَّل (convalidated
-- =true). عدة محاولات لإجبار PostgREST على إعادة تحميل مخططه (NOTIFY pgrst
-- 'reload schema'، تعديل تعليق القيد، الانتظار) لم تنجح — schema cache
-- الخاص بـPostgREST نفسه عالق في حالة غير متسقة مع قاعدة البيانات الحقيقية،
-- منفصلة تماماً عن أي إجراء SQL طبيعي.
--
-- الإصلاح: دالة RPC واحدة تُرجع كل ما يحتاجه provider-pull/route.ts —
-- استدعاء RPC يُنفَّذ داخل قاعدة البيانات مباشرة (execute function)، لا عبر
-- آلية "قراءة قائمة أعمدة الجدول عبر PostgREST" المتأثرة بالخلل الحالي.
-- =====================================================================

create or replace function public.list_active_provider_connections()
returns table (
  id uuid,
  device_id uuid,
  project_id uuid,
  provider text,
  credentials_ciphertext text,
  credentials_key_version integer,
  vendor_station_id text,
  provider_instance_id uuid
)
language sql
security invoker
set search_path = pg_catalog, public
stable
as $$
  select
    pc.id, pc.device_id, pc.project_id, pc.provider,
    pc.credentials_ciphertext, pc.credentials_key_version,
    pc.vendor_station_id, pc.provider_instance_id
  from public.provider_connections pc
  where pc.is_active = true
    and pc.vendor_station_id is not null;
$$;

revoke all on function public.list_active_provider_connections() from public, anon, authenticated;
grant execute on function public.list_active_provider_connections() to service_role;
