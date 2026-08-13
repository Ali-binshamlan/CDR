-- =====================================================================
-- DCR — 202608030003_device_deactivation_cascade_and_audit_fk.sql
-- =====================================================================
-- 1) trigger لتعطيل provider_connections تلقائياً عند تعطيل project_devices
--    (is_active: true→false) — التعطيل حالياً مطبَّق فقط على مستوى التطبيق
--    (PATCH/DELETE في app/api/projects/[projectId]/devices/[deviceId]/route.ts)،
--    وقد سبق أن احتجنا لتصحيح بيانات لمرة واحدة بعد فوات الأمر
--    (202608030001_disable_orphan_provider_connections.sql) لأجهزة أُلغيت
--    قبل إضافة ذاك التعطيل التلقائي في كود التطبيق. أي إلغاء جهاز يحدث
--    مستقبلاً من مسار آخر (SQL مباشر، أداة إدارية مختلفة) يعيد نفس حالة
--    "اتصال يتيم" التي كانت تسبب محاولات سحب فاشلة مستمرة كل دورة cron.
--    هذا الـtrigger يضمن الضمانة على مستوى القاعدة، بلا اعتماد على تذكّر
--    كل مسار تطبيقي مستقبلي فعل ذلك بنفسه.
create or replace function public.cascade_device_deactivation_to_provider_connections()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.is_active = false and old.is_active = true then
    update public.provider_connections
    set is_active = false, updated_at = now()
    where device_id = new.id and is_active = true;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_cascade_device_deactivation on public.project_devices;
create trigger trg_cascade_device_deactivation
  after update on public.project_devices
  for each row
  execute function public.cascade_device_deactivation_to_provider_connections();

-- ---------------------------------------------------------------------
-- 2) admin_audit_log.admin_user_id: توضيح صريح لسلوك ON DELETE (كان يعتمد
--    على NO ACTION الافتراضي بلا كتابته في SQL) — يمنع حذف حساب auth.users
--    لأي مسؤول له سجل تدقيق، بدل السماح بحذفه ومحو أثره (سلوك متعمَّد،
--    ليس تراخياً: سجل التدقيق هو مصدر المحاسبة الوحيد للإجراءات الإدارية،
--    ولا يجوز أن يختفي بحذف حساب المسؤول نفسه).
alter table public.admin_audit_log
  drop constraint if exists admin_audit_log_admin_user_id_fkey;

alter table public.admin_audit_log
  add constraint admin_audit_log_admin_user_id_fkey
  foreign key (admin_user_id) references auth.users(id) on delete restrict;
