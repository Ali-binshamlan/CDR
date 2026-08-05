-- =====================================================================
-- DCR — 202608040006_activity_groups_identity.sql
-- =====================================================================
-- القسم 12.3 من "دليل الإصلاح الجذري لمنظومة مرقاب" — activity_group_id
-- كان نصاً حراً nullable على project_dust_profiles، بلا جدول هوية مستقل
-- يفرض أن كل (project_id, activity_group_id) موجود وينتمي فعلاً لمشروعه.
-- لا شيء في قاعدة البيانات كان يمنع جدولي الأدلة (dust_evaluations،
-- dust_compliance_evaluations، final_decisions) من الإشارة لمعرّف مجموعة
-- نشاط غير موجود أصلاً، أو (نظرياً) بمشروع لا يطابق project_id المرافق —
-- التطبيق وحده (dustEvaluation.ts) كان يضمن التطابق.
--
-- الإصلاح: activity_groups جدول هوية بمفتاح مركّب (project_id, id) —
-- المجموعة قد تضم أكثر من صف نشاط واحد (وحدات متعددة: عدة كسارات/محطات
-- خلط لنفس النشاط التنظيمي، راجع computeUnitReceptors في dustEvaluation.ts)،
-- فلا يجوز أن يكون project_dust_profiles نفسه جدول الهوية.
-- =====================================================================

create table if not exists public.activity_groups (
  project_id uuid not null references public.projects(id) on delete restrict,
  id text not null,
  archived_at timestamptz,
  archived_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (project_id, id),
  check (length(btrim(id)) between 1 and 200)
);

alter table public.activity_groups enable row level security;
revoke all on public.activity_groups from anon, authenticated;
grant select, insert, update on public.activity_groups to service_role;

-- =====================================================================
-- Backfill: project_dust_profiles.activity_group_id فارغ/null → قيمة
-- ثابتة مشتقة من id الصف نفسه (نفس fallback التطبيقي الحالي `dust-${id}`،
-- راجع computeDustResults في dustEvaluation.ts) — بلا هذا، NOT NULL أدناه
-- يفشل على أي صف تاريخي قديم لم يُملأ حقله بعد.
-- =====================================================================
update public.project_dust_profiles
set activity_group_id = 'dust-' || id::text
where activity_group_id is null or btrim(activity_group_id) = '';

alter table public.project_dust_profiles
  alter column activity_group_id set not null;

-- إدخال هويات المجموعات من كل الصفوف الحالية (project_dust_profiles) وكل
-- الجداول التاريخية التي قد تحمل مجموعات لم تعد ممثَّلة بصف نشاط حي (نشاط
-- مؤرشَف/محذوف قديماً) — بلا هذا، VALIDATE CONSTRAINT لاحقاً على تلك
-- الجداول يفشل على أي صف تاريخي يتيم.
insert into public.activity_groups (project_id, id)
select distinct project_id, activity_group_id
from public.project_dust_profiles
where activity_group_id is not null
on conflict do nothing;

insert into public.activity_groups (project_id, id)
select distinct project_id, activity_group_id
from public.dust_evaluations
where activity_group_id is not null
on conflict do nothing;

insert into public.activity_groups (project_id, id)
select distinct project_id, activity_group_id
from public.dust_compliance_evaluations
where activity_group_id is not null
on conflict do nothing;

insert into public.activity_groups (project_id, id)
select distinct project_id, activity_group_id
from public.final_decisions
where activity_group_id is not null
on conflict do nothing;

insert into public.activity_groups (project_id, id)
select distinct project_id, activity_group_id
from public.current_dust_decisions
where activity_group_id is not null
on conflict do nothing;

insert into public.activity_groups (project_id, id)
select distinct project_id, activity_group_id
from public.current_dust_compliance_decisions
where activity_group_id is not null
on conflict do nothing;

-- pm10_readings_history/weather_forecasts: activity_group_id هنا أيضاً قد
-- يشير لمجموعة تاريخية — نفس الإدخال الوقائي.
insert into public.activity_groups (project_id, id)
select distinct project_id, activity_group_id
from public.pm10_readings_history
where activity_group_id is not null
on conflict do nothing;

insert into public.activity_groups (project_id, id)
select distinct project_id, activity_group_id
from public.weather_forecasts
where activity_group_id is not null
on conflict do nothing;
