-- =====================================================================
-- هجرة: عمود device_id في pm10_readings_history
--
-- الثغرة المكتشفة (مراجعة كود مدير — ملاحظة #4): الجدول لا يحمل أي معرّف
-- جهاز — فقط source عام ('device' | 'manual' | 'open-meteo'). fetchPm10Sustained
-- Status في app/lib/dustEvaluation.ts يستعلم بحسب project_id فقط، فتُدمَج
-- قراءات كل أجهزة المشروع معاً بصرف النظر عن أي جهاز أرسل كل قراءة. سيناريو
-- فعلي: مشروع فيه جهازان (A مرتبط بنشاط 1، B مرتبط بنشاط 2)، وكل جهاز يرسل
-- قراءة واحدة فقط ≥340 بالتناوب (12:00 A=350، 12:01 B=355، 12:02 A=360) —
-- السلسلة المحسوبة تُظهر "استمرار 3 دقائق" رغم أن لا جهاز منفرد أثبت
-- استمراراً فعلياً، فتتأكد "مخالفة تنظيمية" لنشاط 1 من قراءات جهاز 2 جزئياً.
--
-- الإصلاح: عمود device_id (nullable — قراءات onsite/open-meteo لا تخص جهازاً
-- محدداً، تبقى null كما كانت). fetchPm10SustainedStatus يُفلتر الآن بحسب
-- device_id النشاط المحدد (project_dust_profiles.device_id) عندما يكون
-- النشاط مرتبطاً بجهاز — لا مستوى المشروع بأكمله.
-- =====================================================================

alter table public.pm10_readings_history
  add column if not exists device_id uuid references public.project_devices(id) on delete set null;

create index if not exists idx_pm10_readings_history_device_time
  on public.pm10_readings_history (device_id, recorded_at desc);
