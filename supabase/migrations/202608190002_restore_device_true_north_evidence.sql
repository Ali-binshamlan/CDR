-- =====================================================================
-- DCR — 202608190002_restore_device_true_north_evidence.sql
-- =====================================================================
-- خطأ حرج مكتشَف ومُصلَح (مراجعة كود خارجي — "اتجاه الرياح يُستخدم دون
-- توثيق الشمال الحقيقي"): windDirectionDeg (project_devices.
-- last_wind_direction_deg، بعد الدمج عبر mergeDustReading) يُستخدَم مباشرة
-- في nearestDownwindReceptorDistanceM (geo.ts، قاعدة MRQ-RECEPTOR-DOWNWIND-
-- 120) بلا أي اشتراط أن يكون الحساس معايَراً فعلياً على الشمال الحقيقي —
-- انحراف تركيب غير موثَّق (مثال: حساس مركَّب بانحراف 20° عن الشمال الحقيقي)
-- يُنتج تصنيف مستقبلات خاطئاً بصمت (مستقبل حقيقي باتجاه الرياح لا يُكتشف،
-- أو العكس)، وInput Snapshot لا يوضح مرجع الاتجاه المستخدَم، فلا Replay
-- موثوقاً لاحقاً.
--
-- الخلفية: أعمدة توثيق المعايرة (migration 202608060001) كانت موجودة فعلاً
-- على project_devices لهذا الغرض بالضبط، لكن حُذفت لاحقاً (migration
-- 202608130005) — لسبب مختلف تماماً: القيمة كانت تُستهلَك أثناء الحساب ثم
-- تختفي، بلا حفظ داخل لقطة القرار (input_snapshot/evidence_hash)، فيصبح
-- القرار غير قابل لإعادة البناء (Replay) لاحقاً. حذف الأعمدة حلّ تلك
-- المشكلة (لا بيانات مفقودة تُخزَّن جزئياً) لكن ترك المشكلة الأصلية قائمة
-- (لا اشتراط توثيق على استخدام الاتجاه في القرار أصلاً منذ ذلك الحذف).
--
-- الإصلاح الكامل هذه المرة (طلب صريح من المستخدم بعد مراجعة الأثر الكامل):
--   1) إعادة الأعمدة السبعة (نفس تعريفات 202608060001 حرفياً، لا تغيير في
--      الشكل) + قيد اتساق جديد يمنع تسجيل "موثَّق=true" بلا بيانات التوثيق
--      الأساسية (النوع/المتحقِّق/تاريخ التحقق/طريقة التحقق) معاً.
--   2) (commits لاحقة لهذه الهجرة) حفظ نسخة التوثيق المستخدمة فعلياً وقت
--      اتخاذ كل قرار داخل DustComplianceResult.evidence.windDirection —
--      تدخل input_snapshot/input_snapshot_hash/evidence_hash تلقائياً (نفس
--      آلية أي حقل آخر على DustComplianceResult)، فلا يتكرر خطأ 202608130005
--      (قيمة تُستهلَك وتُفقَد بلا أثر قابل لإعادة البناء).
-- =====================================================================

alter table public.project_devices
  add column if not exists true_north_alignment_documented boolean,
  add column if not exists true_north_alignment_type text
    check (true_north_alignment_type in ('TRUE_NORTH', 'MAGNETIC_NORTH') or true_north_alignment_type is null),
  add column if not exists true_north_verification_method text,
  add column if not exists true_north_verified_by text,
  add column if not exists true_north_verified_at timestamptz,
  add column if not exists true_north_deviation_deg numeric,
  add column if not exists true_north_evidence_url text;

comment on column public.project_devices.true_north_alignment_documented is
  'هل محطة الرصد هذه معايَرة فعلياً على الشمال الحقيقي (لا مغناطيسي/تقريبي)؟ null/false=غير موثّق، لا يُستخدَم اتجاهها في تحليل الانتشار المكاني (يبقى يُعرض كقراءة خام فقط).';
comment on column public.project_devices.true_north_alignment_type is
  'TRUE_NORTH (شمال حقيقي فعلي) أو MAGNETIC_NORTH (مغناطيسي، يتطلب انحراف مُطبَّق) — null إن لم يُوثَّق بعد. القرار الحي يستخدم الاتجاه في التحليل فقط عند TRUE_NORTH موثَّق ومطبَّق.';
comment on column public.project_devices.true_north_verification_method is
  'طريقة التحقق من المحاذاة (نص حر: مساحة GPS، بوصلة معايَرة، مقارنة مرجع فلكي، إلخ).';
comment on column public.project_devices.true_north_verified_by is
  'اسم/هوية الشخص أو الجهة التي نفّذت عملية التحقق من المحاذاة.';
comment on column public.project_devices.true_north_verified_at is
  'تاريخ إجراء التحقق من المحاذاة فعلياً — منفصل عن created_at الجهاز (قد تُعاد المعايرة لاحقاً).';
comment on column public.project_devices.true_north_deviation_deg is
  'الانحراف المُطبَّق (بالدرجات) بين الشمال المغناطيسي المقروء والشمال الحقيقي — توثيقي/عرضي فقط في هذه المرحلة، لا يُطبَّق تلقائياً على last_wind_direction_deg قبل التحليل.';
comment on column public.project_devices.true_north_evidence_url is
  'رابط مستند أو صورة إثبات عملية المعايرة (شهادة مساحة، صورة تركيب الجهاز مع مرجع الاتجاه، إلخ).';

-- قيد اتساق جديد (لم يوجد في 202608060001 الأصلية): يمنع تسجيل
-- true_north_alignment_documented=true بلا بيانات التوثيق الأساسية الأربعة
-- معاً (النوع + طريقة التحقق + من قام بالتحقق + تاريخ التحقق) — "موثَّق"
-- بلا دليل توثيق فعلي كان يمكن أن يُدخَل عبر واجهة برمجية مباشرة (bypass
-- للتحقق على مستوى API فقط)، فيثق القرار الحي باتجاه غير موثَّق فعلياً.
alter table public.project_devices
  drop constraint if exists project_devices_true_north_documentation_chk;

alter table public.project_devices
  add constraint project_devices_true_north_documentation_chk
  check (
    true_north_alignment_documented is distinct from true
    or (
      true_north_alignment_type is not null
      and true_north_verified_at is not null
      and nullif(btrim(true_north_verification_method), '') is not null
      and nullif(btrim(true_north_verified_by), '') is not null
    )
  );

comment on constraint project_devices_true_north_documentation_chk on public.project_devices is
  'يمنع تسجيل true_north_alignment_documented=true دون بيانات التوثيق الأساسية الأربعة معاً (النوع/طريقة التحقق/من قام به/تاريخه) — لا "موثَّق" بلا دليل فعلي.';
