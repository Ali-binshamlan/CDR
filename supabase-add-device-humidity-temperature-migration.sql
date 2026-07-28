-- =====================================================================
-- هجرة: إضافة قراءات الرطوبة النسبية ودرجة الحرارة إلى project_devices —
-- تمديد لأعمدة last_* الحالية (سرعة/اتجاه الرياح، PM10، PM2.5، الرؤية)
-- لدعم رطوبة/حرارة كحقلين قابلين للقراءة من جهاز رصد حقيقي، بدل الاعتماد
-- حصرياً على Open-Meteo كما كان الحال قبل هذه الهجرة.
--
-- جزء من إعادة ترتيب أولوية القراءات بطلب صريح من المستخدم: جهاز > تقدير
-- الطقس (Open-Meteo) > إدخال يدوي onsite_* — عكس الترتيب القديم (جهاز >
-- يدوي > طقس). راجع mergeDustReading في app/utils/dust-engine/engine.ts.
--
-- ملاحظة مهمة: لا يوجد لهذين الحقلين طبقة "onsite_*" يدوية مقابلة في جدول
-- الأنشطة اليوم (بعكس الرؤية/PM10/PM2.5) — الأولوية الفعلية لهما تبقى فقط
-- جهاز > Open-Meteo، بلا مستوى ثالث احتياطي، حتى إشعار آخر.
-- =====================================================================

alter table public.project_devices
  add column if not exists last_relative_humidity_percent numeric,
  add column if not exists last_temperature_c numeric;

-- تحقق سريع بعد التنفيذ:
--   select column_name, data_type from information_schema.columns
--   where table_schema = 'public' and table_name = 'project_devices'
--   order by ordinal_position;
