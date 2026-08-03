-- =====================================================================
-- DCR — 202608020002_final_decisions_realtime_policy.sql
-- =====================================================================
-- يسمح لمالك المشروع (authenticated) بقراءة final_decisions الخاصة
-- بمشاريعه فقط — ضروري لعمل Supabase Realtime من المتصفح (اشتراك
-- postgres_changes يتحقق من RLS فعلياً خلف الكواليس، بنفس صلاحيات SELECT
-- العادية). القراءة الحالية عبر API routes تمر أصلاً بـservice_role
-- (supabaseAdmin) وتتجاوز RLS بالكامل — هذه الـpolicy جديدة الغرض كلياً:
-- تفعيل اشتراك مباشر (WebSocket) من صفحة تفاصيل المشروع بالمتصفح، ليتحدث
-- القرار المعروض فوراً لحظة كتابة صف final_decisions جديد، بدل انتظار
-- دورة polling.
--
-- بلا فرع super_admin عمداً (بخلاف verifyProjectOwnership في apiAuth.ts) —
-- التحقق من user_authorizations.is_super_admin داخل الـpolicy نفسها يتطلب
-- قراءتها بصلاحية authenticated، لكن user_authorizations بلا أي policy
-- إطلاقاً (service_role فقط، راجع 202607290002_security_hardening.sql) —
-- محاولة الاستعلام منها هنا كانت ستفشل دائماً. هذا تحسين تجربة عرض لمالك
-- المشروع العادي، لا ميزة إدارية؛ السوبر أدمن يستمر يعتمد على مسارات
-- /api/admin/** (service_role) للوصول الإداري، لا هذا الاشتراك المباشر.
create policy "final_decisions_owner_select"
  on public.final_decisions for select
  to authenticated
  using (
    exists (
      select 1 from public.projects
      where projects.id = final_decisions.project_id
        and projects.user_id = auth.uid()
    )
  );

-- تأكيد انضمام الجدول لـpublication الـRealtime — idempotent (لا يكرر
-- الإضافة لو الجدول مفعَّل مسبقاً يدوياً من لوحة تحكم Supabase، إذ
-- ALTER PUBLICATION ... ADD TABLE يفشل بخطأ لو الجدول مضاف مسبقاً بلا هذا
-- الفحص المسبق).
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'final_decisions'
  ) then
    alter publication supabase_realtime add table public.final_decisions;
  end if;
end $$;
