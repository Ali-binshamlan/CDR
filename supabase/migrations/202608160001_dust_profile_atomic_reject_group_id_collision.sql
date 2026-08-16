-- =====================================================================
-- DCR — 202608160001_dust_profile_atomic_reject_group_id_collision.sql
-- =====================================================================
-- ثغرة مكتشَفة (مراجعة كود): الوحدات المتعددة لنشاط واحد (كسارتان/محطتا
-- خلط/سطحان خاملان) تُقسَّم إلى activity_group_id مستقلة بصيغة
-- ${base}-uN تحديداً لإغلاق سباق كتابة CAS كان موجوداً سابقاً — أي وحدتين
-- تشتركان بنفس activity_group_id تتنافسان على نفس صف current_dust_
-- decisions/current_dust_compliance_decisions، فأيّتهما تفوز بالـCAS تحدد
-- القرار المعروض للمجموعة كلها بصرف النظر عن شدة قرارها الفعلي.
--
-- الصيغة الصحيحة (${base}-uN) تُولَّد فقط من AddActivityModal/index.tsx —
-- الخادم (POST /api/dust-profiles) لا يفرضها إطلاقاً: activity_group_id
-- يُقبَل من العميل بلا أي تحقق تنسيق (Zod: min(1).max(200) فقط)، وinsert_
-- dust_profile_atomic نفسها تستخدم `on conflict (project_id, id) do
-- nothing` على activity_groups — فإعادة استخدام نفس المعرّف (بلا لاحقة -uN
-- أصلاً، أو لاحقة مكرَّرة) من استدعاء API مباشر (لا AddActivityModal) كانت
-- تنجح بصمت، ويُضاف صف project_dust_profiles جديد يشارك نفس المعرّف —
-- يُعيد فتح سباق CAS الذي صُمِّمت آلية -uN أصلاً لإغلاقه، لأي مصدر لا يمر
-- عبر الواجهة (اختبار يدوي، تكامل مستقبلي، استغلال متعمَّد).
--
-- الإصلاح: كل استدعاء لهذه الدالة يُنشئ صفاً جديداً دائماً (لا مسار تعديل/
-- إعادة إرسال يُعيد استخدام activity_group_id قائم فعلاً — لا idempotency
-- key، لا PATCH يمر عبرها؛ تأكَّد بمراجعة route.ts كاملاً) — فأي
-- activity_group_id يرتبط مسبقاً بصف project_dust_profiles واحد على الأقل
-- في نفس المشروع يعني حتماً محاولة تكرار/تصادم، لا استخداماً شرعياً أبداً.
-- الفحص والإدراج يقعان ضمن نفس الدالة الذرية (نفس الترانزاكشن الضمني لكل
-- استدعاء RPC)، فلا نافذة سباق بين الفحص والإدراج نفسه.
-- =====================================================================

create or replace function public.insert_dust_profile_atomic(
  p_project_id uuid,
  p_activity_group_id text,
  p_insert jsonb
)
returns public.project_dust_profiles
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_row public.project_dust_profiles;
  v_final_insert jsonb;
begin
  if p_activity_group_id is null or btrim(p_activity_group_id) = '' then
    raise exception using errcode = '22023', message = 'activity_group_id إلزامي';
  end if;

  if exists (
    select 1 from public.project_dust_profiles
    where project_id = p_project_id and activity_group_id = p_activity_group_id
  ) then
    raise exception using
      errcode = '23505',
      message = format('activity_group_id "%s" مستخدَم مسبقاً في هذا المشروع', p_activity_group_id);
  end if;

  insert into public.activity_groups (project_id, id)
  values (p_project_id, p_activity_group_id)
  on conflict (project_id, id) do nothing;

  -- id/created_at يُحقَنان صراحة كقيم فعلية — لا يُترَكان لـjsonb_populate_
  -- record (راجع 202608120004 للسبب الكامل).
  v_final_insert := (p_insert - 'id' - 'created_at')
    || jsonb_build_object('id', gen_random_uuid(), 'created_at', clock_timestamp());

  insert into public.project_dust_profiles
  select * from jsonb_populate_record(null::public.project_dust_profiles, v_final_insert)
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.insert_dust_profile_atomic(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.insert_dust_profile_atomic(uuid, text, jsonb) to service_role;
