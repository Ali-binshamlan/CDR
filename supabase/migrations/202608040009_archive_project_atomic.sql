-- =====================================================================
-- DCR — 202608040009_archive_project_atomic.sql
-- =====================================================================
-- خطأ تشغيلي/أمني مكتشَف (القسم 13 من "دليل الإصلاح الجذري لمنظومة
-- مرقاب" — "الأرشفة الذرية"): المشروع المؤرشف يُستبعد من التقييم المعتاد
-- (scheduler-tick/provider-pull يفلتران .is('archived_at', null))، لكنه
-- كان لا يزال يقبل قراءات جهاز جديدة (push مباشر عبر /api/devices/ingest،
-- الذي لا يمر عبر provider_connections إطلاقاً فلا يستفيد من ذلك
-- الاستبعاد) — requireDeviceApiKey وingest_device_reading_atomic/
-- ingest_device_event_v2 يفحصان نشاط الجهاز (is_active) فقط، لا أرشفة
-- المشروع المرتبط به. كذلك عملية الأرشفة نفسها (DELETE في [projectId]/
-- route.ts) كانت UPDATE واحداً على projects فقط — لا تعطيل ذرّي للأجهزة/
-- الاتصالات/المهام المعلَّقة في نفس المعاملة، ولا قفل يمنع سباق أرشفة
-- متزامنة مع تقييم/إدخال جارٍ لنفس المشروع بنفس اللحظة.
--
-- قاعدة القفل (القسم 13.2): كل العمليات (أرشفة، إدخال جهاز، حفظ قرار)
-- تأخذ قفل المشروع نفسه أولاً (pg_advisory_xact_lock)، ثم تتحقق من
-- archived_at، ثم تُنفِّذ — هذا الترتيب الموحَّد يمنع Deadlocks وسباق
-- archive/ingest/evaluate. الدالة أدناه (وpersist_activity_decision_atomic/
-- ingest_device_reading_atomic/ingest_device_event_v2 المُعدَّلة في الهجرة
-- التالية) تستخدم نفس مفتاح القفل بالضبط: hashtextextended('project:' ||
-- project_id::text, 0).
-- =====================================================================

create or replace function public.archive_project_atomic(
  p_project_id uuid,
  p_actor_id uuid
)
returns void
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  perform pg_advisory_xact_lock(
    hashtextextended('project:' || p_project_id::text, 0)
  );

  update public.projects
  set archived_at = clock_timestamp(), archived_by = p_actor_id
  where id = p_project_id and archived_at is null;

  if not found then
    raise exception using errcode = 'P0001', message = 'PROJECT_NOT_FOUND_OR_ARCHIVED';
  end if;

  -- تعطيل كل الأجهزة النشطة لهذا المشروع — trigger موجود مسبقاً
  -- (cascade_device_deactivation_to_provider_connections، من
  -- 202608030003) يُعطِّل provider_connections تلقائياً تبعاً لذلك، فلا
  -- حاجة لتحديثها هنا يدوياً.
  update public.project_devices
  set is_active = false,
      revoked_at = coalesce(revoked_at, clock_timestamp())
  where project_id = p_project_id and is_active = true;

  -- إلغاء أي مهمة تقييم معلَّقة/جارية لهذا المشروع — لا معنى لمعالجتها بعد
  -- الأرشفة (راجع project_evaluation_jobs، 202608040004).
  update public.project_evaluation_jobs
  set status = 'DEAD', last_error = 'PROJECT_ARCHIVED', lease_until = null, completed_at = clock_timestamp()
  where project_id = p_project_id and status in ('PENDING', 'RETRY', 'RUNNING');

  insert into public.admin_audit_log (admin_user_id, action, target_project_id, details)
  values (p_actor_id, 'project_archive', p_project_id, null);
end;
$$;

revoke all on function public.archive_project_atomic(uuid, uuid) from public, anon, authenticated;
grant execute on function public.archive_project_atomic(uuid, uuid) to service_role;
