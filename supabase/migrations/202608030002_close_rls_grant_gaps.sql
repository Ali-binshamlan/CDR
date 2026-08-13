-- =====================================================================
-- DCR — 202608030002_close_rls_grant_gaps.sql
-- =====================================================================
-- فحص أمني شامل (مراجعة كود) كشف فجوتين في نمط RLS المتّبع بباقي الجداول:
--
-- 1) سبع جداول أُنشئت بـ"enable row level security" بلا أي policy وبلا
--    "revoke all" صريح (dust_evaluations، current_dust_decisions،
--    dust_compliance_evaluations، current_dust_compliance_decisions،
--    pm10_readings_history، weather_forecasts، sensitive_receptors —
--    كلها في 202607290001_baseline_final.sql). عملياً anon/authenticated
--    لا يريان صفوفاً منها اليوم (RLS بلا policy = رفض كل شيء)، لكن هذا
--    اعتماد ضمني على سلوك الرفض الافتراضي، لا حاجزاً موصوفاً في SQL نفسه
--    كما هو الحال في project_devices/user_authorizations/provider_connections/
--    device_readings_history/final_decisions (راجع "revoke all" في كل
--    منها). لو أضاف أحد مستقبلاً GRANT SELECT على أحد هذه الجداول (مثلاً
--    لعرضها بلوحة تحكم) بلا policy مصاحبة، يصبح الجدول مقروءاً بالكامل
--    عبر كل المستخدمين بلا أي تصفية — نفس الفجوة التي أُغلقت سابقاً على
--    باقي الجداول. الإصلاح: نفس "revoke all" الصريح المطبَّق بالفعل على
--    نظرائها.
--
-- 2) final_decisions وalerts: سياسة SELECT مضافة لهما (202608020002،
--    202608020003) بعد أن سُحبت كل الصلاحيات عنهما تماماً من anon/
--    authenticated (202607290006 لـfinal_decisions، revoke insert/update/
--    delete فقط لـalerts في 202608020003 — لم يُعَد GRANT SELECT صراحةً
--    في أي منهما). القراءة الحالية عبر Realtime/policy تعتمد فعلياً على
--    منح SELECT الافتراضي الذي يضبطه Supabase تلقائياً لكل جدول جديد على
--    مستوى المشروع، لا على شيء موصوف في هذه الملفات — لو أُلغي ذاك
--    الافتراضي مستقبلاً (بيئة جديدة، reset كامل، إلخ) يفشل اشتراك
--    Realtime بصمت بلا أي خطأ واضح. الإصلاح: GRANT SELECT صريح هنا، حتى
--    يبقى السلوك المطلوب موصوفاً بالكامل داخل الهجرات نفسها لا خارجها.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1) سحب صريح لكل الصلاحيات — جداول بلا أي policy، القراءة/الكتابة عبر
--    service_role (supabaseAdmin) فقط في كل مسارات app/api/**.
-- ---------------------------------------------------------------------
revoke all on public.dust_evaluations from anon, authenticated;
revoke all on public.current_dust_decisions from anon, authenticated;
revoke all on public.dust_compliance_evaluations from anon, authenticated;
revoke all on public.current_dust_compliance_decisions from anon, authenticated;
revoke all on public.pm10_readings_history from anon, authenticated;
revoke all on public.weather_forecasts from anon, authenticated;
revoke all on public.sensitive_receptors from anon, authenticated;

-- ---------------------------------------------------------------------
-- 2) استعادة GRANT SELECT صراحةً لما تعتمد عليه policy موجودة فعلاً
--    (final_decisions_owner_select، alerts_owner_select) — السياسة تبقى
--    هي المُصفّي الفعلي؛ هذا فقط يجعل الامتياز الأساسي الذي تتحقق منه RLS
--    موصوفاً في SQL بدل الاعتماد على منح افتراضي خارج هذه الملفات.
-- ---------------------------------------------------------------------
grant select on public.final_decisions to authenticated;
grant select on public.alerts to authenticated;

commit;

-- =====================================================================
-- اختبار قبول بعد التطبيق:
--   select grantee, table_name, privilege_type
--   from information_schema.role_table_grants
--   where table_schema = 'public'
--     and grantee in ('anon', 'authenticated')
--     and table_name in (
--       'dust_evaluations','current_dust_decisions',
--       'dust_compliance_evaluations','current_dust_compliance_decisions',
--       'pm10_readings_history','weather_forecasts','sensitive_receptors'
--     );
-- يجب أن يُرجع صفر صفوف.
--
--   select grantee, table_name, privilege_type
--   from information_schema.role_table_grants
--   where table_schema = 'public'
--     and grantee = 'authenticated'
--     and table_name in ('final_decisions','alerts')
--     and privilege_type = 'SELECT';
-- يجب أن يُرجع صفّين (SELECT فقط لكل جدول) — الفلترة الفعلية تبقى عبر
-- final_decisions_owner_select وalerts_owner_select.
-- =====================================================================
