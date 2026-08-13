-- =====================================================================
-- DCR — 202608020003_close_direct_client_write_access.sql
-- =====================================================================
-- خطأ أمني مكتشَف (مراجعة تصحيح خارجية على dcr-app): سياسات "for all" على
-- projects/project_shifts/project_dust_profiles/alerts/decision_records
-- (راجع 202607290001_baseline_final.sql) تسمح لصاحب المشروع بالكتابة
-- المباشرة عبر Supabase (anon/publishable key + جلسة authenticated)،
-- متجاوزاً تماماً كل التحقق الخادمي في app/api/** (Zod، حساب AEI/DVI
-- الخادمي، منع تعديل status_aei/score_aei من العميل، إلخ). هذا يُبطل قيمة
-- تلك التحققات بالكامل — مستخدم يقدر يكتب مباشرة لصف project_dust_profiles
-- أو decision_records بأي قيمة يريدها بلا مرور على أي محرك قرار.
--
-- التطبيق الحالي (app/api/**) لا يستخدم أي عميل Supabase من المتصفح
-- للكتابة إطلاقاً — كل الكتابات تمر عبر app/lib/supabaseAdmin.ts
-- (service_role، يتجاوز RLS بالكامل بتصميمه). القراءة المباشرة من
-- المتصفح الوحيدة المعتمدة فعلياً هي اشتراك Realtime على final_decisions
-- (راجع 202608020002_final_decisions_realtime_policy.sql، نفس النمط
-- المطبَّق هنا). لذلك تحويل هذه السياسات من "for all" إلى "for select"
-- فقط + سحب DML من anon/authenticated لا يكسر أي مسار كتابة موجود فعلياً.
--
-- ملاحظة: project_devices سبق أن أُغلقت بالكامل (revoke all) في
-- 202607290002_security_hardening.sql، وalert_state_events في
-- 202607290004_append_only_audit.sql — هذه الهجرة تُكمل الجداول المتبقية
-- التي لا تزال بسياسة "for all" مفتوحة.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1) projects
-- ---------------------------------------------------------------------
drop policy if exists "projects_owner_all" on public.projects;
create policy "projects_owner_select"
  on public.projects for select
  to authenticated
  using (auth.uid() = user_id);

-- ---------------------------------------------------------------------
-- 2) project_shifts
-- ---------------------------------------------------------------------
drop policy if exists "project_shifts_owner_all" on public.project_shifts;
create policy "project_shifts_owner_select"
  on public.project_shifts for select
  to authenticated
  using (
    exists (
      select 1 from public.projects
      where projects.id = project_shifts.project_id
        and projects.user_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------
-- 3) project_dust_profiles
-- ---------------------------------------------------------------------
drop policy if exists "project_dust_profiles_owner_all" on public.project_dust_profiles;
create policy "project_dust_profiles_owner_select"
  on public.project_dust_profiles for select
  to authenticated
  using (
    exists (
      select 1 from public.projects
      where projects.id = project_dust_profiles.project_id
        and projects.user_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------
-- 4) alerts
-- ---------------------------------------------------------------------
drop policy if exists "alerts_owner_all" on public.alerts;
create policy "alerts_owner_select"
  on public.alerts for select
  to authenticated
  using (
    exists (
      select 1 from public.projects
      where projects.id = alerts.project_id
        and projects.user_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------
-- 5) decision_records
-- ---------------------------------------------------------------------
drop policy if exists "decision_records_owner_all" on public.decision_records;
create policy "decision_records_owner_select"
  on public.decision_records for select
  to authenticated
  using (
    exists (
      select 1 from public.projects
      where projects.id = decision_records.project_id
        and projects.user_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------
-- سحب صريح لصلاحيات DML على مستوى الجدول — لا تكفي إزالة سياسات RLS
-- وحدها: RLS يتحقق فقط إن كان الامتياز على مستوى الجدول موجوداً أصلاً؛
-- لو بقي GRANT UPDATE/INSERT/DELETE من إعداد سابق (أو منح افتراضي)، غياب
-- سياسة "with check" مطابقة لا يمنع محاولة الكتابة من الفشل بخطأ RLS بدل
-- خطأ صلاحيات — لكن الأصوب أمنياً ألا يملك الدور الامتياز أصلاً.
-- ---------------------------------------------------------------------
revoke insert, update, delete, truncate, references, trigger
  on public.projects,
     public.project_shifts,
     public.project_dust_profiles,
     public.alerts,
     public.decision_records
  from anon, authenticated;

commit;

-- =====================================================================
-- اختبار قبول بعد التطبيق:
--   select grantee, table_name, privilege_type
--   from information_schema.role_table_grants
--   where table_schema = 'public'
--     and grantee in ('anon', 'authenticated')
--     and table_name in ('projects','project_shifts','project_dust_profiles','alerts','decision_records')
--     and privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER');
-- يجب أن يُرجع صفر صفوف. الكتابة عبر app/api/** (service_role) يجب أن
-- تستمر بالنجاح كما هي، دون أي تغيير مطلوب في كود التطبيق.
-- =====================================================================
