-- =====================================================================
-- DCR — 202608020005_archive_instead_of_delete.sql
-- =====================================================================
-- خطأ مكتشَف (مراجعة تصحيح خارجية — "الأرشفة بدل الحذف"): DELETE /api/
-- activities يحذف صف project_dust_profiles فعلياً (delete()، لا تحديث
-- حالة). dust_evaluations/dust_compliance_evaluations/decision_records
-- المرتبطة به (append-only، لا تُحذَف — راجع تعليق DELETE في
-- app/api/activities/route.ts) تبقى محفوظة، لكن dust_profile_id عليها
-- يتحول null (on delete set null)، فتفقد سلسلة الأدلة رابطها المرئي
-- بالنشاط الأصلي — يصعّب تتبع "أي نشاط أنتج هذا القرار التاريخي" رغم بقاء
-- البيانات نفسها. نفس المشكلة على project_devices (DELETE فعلي في
-- app/api/projects/[projectId]/devices/[deviceId]/route.ts، رغم أن
-- PATCH لنفس الملف يدعم أصلاً is_active=false + revoked_at كإلغاء ناعم).
--
-- الإصلاح: عمودا أرشفة على project_dust_profiles (project_devices تملك
-- is_active/revoked_at مسبقاً، لا حاجة لعمود جديد) — الكود التطبيقي
-- (app/api/activities/route.ts) يُحوَّل من DELETE فعلي إلى UPDATE
-- archived_at في تعديل منفصل تالٍ لهذه الهجرة.
-- =====================================================================

alter table public.project_dust_profiles
  add column if not exists archived_at timestamptz,
  add column if not exists archived_by uuid references auth.users(id) on delete set null;

create index if not exists idx_project_dust_profiles_archived_at
  on public.project_dust_profiles (project_id, archived_at)
  where archived_at is null;
