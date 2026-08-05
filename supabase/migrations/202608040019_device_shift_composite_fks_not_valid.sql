-- =====================================================================
-- DCR — 202608040019_device_shift_composite_fks_not_valid.sql
-- =====================================================================
-- خطأ عزل مكتشَف (القسم 18.5 من "دليل الإصلاح الجذري لمنظومة مرقاب" —
-- "Current Pointer: Device/Shift في مشروع A يشير إلى B يفشل"): device_id/
-- shift_id على project_dust_profiles وpm10_readings_history/provider_
-- connections/device_events/device_measurements كانت جميعها مربوطة بـFK
-- بسيط (device_id → project_devices(id) فقط، بلا project_id) — لا شيء في
-- قاعدة البيانات نفسها يمنع ربط جهاز/وردية من مشروع A بصف ينتمي لمشروع B؛
-- العزل كان يعتمد كلياً على أن التطبيق (app/api/**) لا يرتكب هذا الخطأ، لا
-- على قيد بنيوي. نفس مبدأ activity_groups (202608040006/7/8) الذي طُبِّق
-- على activity_group_id، مطبَّق هنا الآن على device_id/shift_id.
--
-- المرحلة 1 (هذه الهجرة): مفتاح فريد مركّب (id, project_id) على project_
-- devices/project_shifts (هدف FK مركّب صالح — عمود id وحده مفتاح أساسي
-- بالفعل، فهذا القيد الإضافي فريد بديهياً، لا يغيّر أي سلوك قائم)، ثم قيود
-- FK مركّبة NOT VALID (project_id, device_id)/(project_id, shift_id) على كل
-- جدول تابع — لا تُقفَل الجداول لفحص كامل فوري. VALIDATE CONSTRAINT الفعلي
-- في هجرة تالية منفصلة (202608040020).
-- =====================================================================

alter table public.project_devices
  add constraint project_devices_id_project_id_key unique (id, project_id);

alter table public.project_shifts
  add constraint project_shifts_id_project_id_key unique (id, project_id);

alter table public.project_dust_profiles
  add constraint project_dust_profiles_device_project_fk
  foreign key (device_id, project_id)
  references public.project_devices (id, project_id)
  not valid;

alter table public.project_dust_profiles
  add constraint project_dust_profiles_shift_project_fk
  foreign key (shift_id, project_id)
  references public.project_shifts (id, project_id)
  not valid;

alter table public.pm10_readings_history
  add constraint pm10_readings_history_device_project_fk
  foreign key (device_id, project_id)
  references public.project_devices (id, project_id)
  not valid;

alter table public.provider_connections
  add constraint provider_connections_device_project_fk
  foreign key (device_id, project_id)
  references public.project_devices (id, project_id)
  not valid;

alter table public.device_events
  add constraint device_events_device_project_fk
  foreign key (device_id, project_id)
  references public.project_devices (id, project_id)
  not valid;

alter table public.device_measurements
  add constraint device_measurements_device_project_fk
  foreign key (device_id, project_id)
  references public.project_devices (id, project_id)
  not valid;

alter table public.device_metric_latest
  add constraint device_metric_latest_device_project_fk
  foreign key (device_id, project_id)
  references public.project_devices (id, project_id)
  not valid;
