-- =====================================================================
-- DCR — 202608130008_pm10_device_readings_realtime.sql
-- =====================================================================
-- يفعّل اشتراك Realtime المباشر (من المتصفح) على pm10_readings_history
-- وdevice_readings_history — جزء من تحويل صفحتي القراءات (readings/page.tsx
-- وActivityReadingsCharts.tsx) من استطلاع (polling) كل دقيقة إلى تحديث فوري
-- بالحدث، ضمن تحقيق ضغط Compute/CPU/Disk IO المرتفع على خطة Free.
--
-- نفس نمط 202608020002_final_decisions_realtime_policy.sql بالضبط، وبنفس
-- السبب: RLS مفعَّل على كلا الجدولين لكن بلا أي policy تمنح authenticated
-- صلاحية SELECT (device_readings_history حتى بـrevoke all صريح من anon/
-- authenticated) — بلا هذه الـpolicy، اشتراك postgres_changes من المتصفح
-- كان سيفتح بنجاح ظاهري (SUBSCRIBED) لكن لن يصل أي حدث INSERT إطلاقاً (فشل
-- صامت تماماً، نفس العلة الموثَّقة سابقاً في alerts/final_decisions قبل
-- إصلاحهما). القراءة الحالية عبر API routes تمر بـservice_role
-- (supabaseAdmin) وتتجاوز RLS بالكامل — هذه الـpolicy جديدة الغرض كلياً:
-- تفعيل الاشتراك المباشر فقط.
--
-- بلا فرع super_admin عمداً، لنفس سبب final_decisions_owner_select
-- (user_authorizations بلا أي policy لـauthenticated، الاستعلام منها هنا
-- سيفشل دائماً) — هذا تحسين تجربة عرض لمالك المشروع العادي فقط.
create policy "pm10_readings_history_owner_select"
  on public.pm10_readings_history for select
  to authenticated
  using (
    exists (
      select 1 from public.projects
      where projects.id = pm10_readings_history.project_id
        and projects.user_id = auth.uid()
    )
  );

create policy "device_readings_history_owner_select"
  on public.device_readings_history for select
  to authenticated
  using (
    exists (
      select 1 from public.projects
      where projects.id = device_readings_history.project_id
        and projects.user_id = auth.uid()
    )
  );

-- انضمام الجدولين لـpublication الـRealtime — idempotent، نفس نمط
-- alerts/final_decisions.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'pm10_readings_history'
  ) then
    alter publication supabase_realtime add table public.pm10_readings_history;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'device_readings_history'
  ) then
    alter publication supabase_realtime add table public.device_readings_history;
  end if;
end $$;
