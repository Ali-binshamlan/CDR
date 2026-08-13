-- =====================================================================
-- DCR — 202608060001_device_true_north_calibration.sql
-- =====================================================================
-- خطأ مكتشَف ومُصلَح (مراجعة خبير خارجي — "توثيق الشمال الحقيقي: توثيق
-- محاذاة اتجاه الرياح موضوع على مستوى المشروع، بينما يجب أن يكون مرتبطاً
-- بكل محطة أو حساس اتجاه رياح، ويتضمن: تاريخ التوجيه، طريقة التحقق، الشخص
-- المنفذ، الشمال الحقيقي أو المغناطيسي، الانحراف المطبق، مستند أو صورة
-- الإثبات"):
--
-- projects.true_north_alignment_documented (202607290001/full-supabase-
-- add-pm10-sustained-rules-migration.sql) كان عموداً boolean واحداً على
-- مستوى المشروع كله — لا يميّز بين محطتين مختلفتين لنفس المشروع (واحدة
-- معايَرة فعلياً، أخرى لم تُعايَر بعد)، ولا يحمل أياً من تفاصيل المعايرة
-- الستة المطلوبة (كان فقط "موثَّق/غير موثَّق" بلا سياق).
--
-- الإصلاح: الأعمدة الستة تُضاف على project_devices (المحطة الفعلية، لا
-- المشروع) — كل جهاز رصد يحمل توثيق معايرته الخاص به. العمود القديم على
-- projects لا يُحذف هنا (قد تعتمد عليه صفوف تاريخية/مسارات أخرى) لكن لم يعد
-- يُقرأ من أي مسار قرار حي بعد هذه الهجرة (راجع تعديلات adapters.ts).
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
  'هل محطة الرصد هذه معايَرة فعلياً على الشمال الحقيقي (لا مغناطيسي/تقريبي)؟ null=غير موثّق، يُعامَل معاملة false في القرار.';
comment on column public.project_devices.true_north_alignment_type is
  'TRUE_NORTH (شمال حقيقي فعلي) أو MAGNETIC_NORTH (مغناطيسي، يتطلب انحراف مُطبَّق) — null إن لم يُوثَّق بعد.';
comment on column public.project_devices.true_north_verification_method is
  'طريقة التحقق من المحاذاة (نص حر: مساحة GPS، بوصلة معايَرة، مقارنة مرجع فلكي، إلخ).';
comment on column public.project_devices.true_north_verified_by is
  'اسم/هوية الشخص أو الجهة التي نفّذت عملية التحقق من المحاذاة.';
comment on column public.project_devices.true_north_verified_at is
  'تاريخ إجراء التحقق من المحاذاة فعلياً — منفصل عن created_at الجهاز (قد تُعاد المعايرة لاحقاً).';
comment on column public.project_devices.true_north_deviation_deg is
  'الانحراف المُطبَّق (بالدرجات) بين الشمال المغناطيسي المقروء والشمال الحقيقي — يُضاف إلى last_wind_direction_deg الخام قبل استخدامه في أي قاعدة اتجاه رياح.';
comment on column public.project_devices.true_north_evidence_url is
  'رابط مستند أو صورة إثبات عملية المعايرة (شهادة مساحة، صورة تركيب الجهاز مع مرجع الاتجاه، إلخ).';
