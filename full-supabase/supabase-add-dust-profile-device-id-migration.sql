-- =====================================================================
-- ربط نشاط غبار (project_dust_profiles) بمحطة رصد محددة (project_devices)
-- =====================================================================
-- طلب صريح من المستخدم: عند إضافة نشاط في AddActivityModal، يختار
-- المستخدم إلزامياً محطة الرصد التي ستؤخذ قراءاتها لهذا النشاط تحديداً
-- (بدل الاعتماد على "أحدث جهاز نشط بالمشروع" بلا وعي بأي نشاط قريب منه
-- فعلياً — راجع resolveFreshProjectDevice في app/lib/dustEvaluation.ts).
--
-- on delete set null (لا cascade): حذف محطة لاحقاً لا يجوز أن يحذف صفوف
-- أنشطة تاريخية مرتبطة بها — يبقى النشاط موجوداً، فقط يفقد ربط الجهاز
-- (يعود تلقائياً لمسار "لا جهاز مرتبط" في القراءة، بلا أي خطأ).
alter table public.project_dust_profiles
  add column if not exists device_id uuid references public.project_devices(id) on delete set null;

-- تحقق سريع بعد التنفيذ:
--   select column_name, data_type from information_schema.columns
--   where table_schema = 'public' and table_name = 'project_dust_profiles'
--   order by ordinal_position;
