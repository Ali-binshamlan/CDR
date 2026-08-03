-- =====================================================================
-- هجرة: إغلاق project_devices أمام anon/authenticated بالكامل — إغلاق
-- ثغرة تزوير قراءة جهاز (مراجعة كود خبير خارجي — "مالك المشروع يستطيع
-- تزوير قراءة الجهاز")
--
-- الثغرة المكتشفة: project_devices_owner_all (for all) كانت تسمح لمالك
-- المشروع (auth.uid() = projects.user_id) بالوصول المباشر عبر عميل anon
-- الجانبي (app/lib/supabase.ts، بجلسته الخاصة، بلا أي كود خلفي متورط) —
-- بلا أي تقييد على الأعمدة — لـ:
--   • last_pm10 / last_reading_at وبقية last_* — تزوير قراءة جهاز مباشرة
--     (supabase.from('project_devices').update({ last_pm10: 20 })...)،
--     متجاوزاً بالكامل مسار الأدلة الموثَّق POST /api/devices/ingest ونظام
--     pm10_readings_history المصمَّم لإثبات "استمرار مخالفة" بمصدر device
--     موثوق (راجع computeSustainedPm10Status في dustEvaluation.ts) — مالك
--     يقدر يُظهر قراءة نظيفة مزوَّرة بدل تجاوز فعلي، أو العكس.
--   • api_key_hash — قراءة مباشرة لهاش مفتاح API الخاص بجهازه (سر يُفترض
--     ألا يغادر الخادم إطلاقاً تحت أي ظرف، راجع تعليق DEVICE_LIST_COLUMNS
--     في app/api/projects/[projectId]/devices/route.ts).
--
-- كل مسارات إدارة الأجهزة الفعلية (app/api/projects/[projectId]/devices/**،
-- app/api/devices/ingest) تمر بالفعل عبر supabaseAdmin (service_role) وتُصفّي
-- الأعمدة المسموحة بانضباط (DEVICE_LIST_COLUMNS/DEVICE_SAFE_COLUMNS تستبعدان
-- api_key_hash صراحة، PATCH يقبل فقط name/lat/lng/is_active) — لا يوجد أي
-- استدعاء supabase.from('project_devices') من كود العميل (تحقق شامل: صفر
-- نتائج) — فإغلاق الجدول أمام anon/authenticated بالكامل لا يكسر أي مسار
-- تطبيق فعلي، فقط يمنع الوصول المباشر من المتصفح.
--
-- POST /api/devices/ingest (الجهاز الفعلي، لا مستخدم بشري) لا يتأثر: يستخدم
-- requireDeviceApiKey (مفتاح الجهاز الخام، لا جلسة Supabase) عبر supabaseAdmin
-- أيضاً — دور service_role دائماً، لا anon/authenticated أبداً.
-- =====================================================================

drop policy if exists "project_devices_owner_all" on public.project_devices;

revoke all on public.project_devices from anon, authenticated;
