-- =====================================================================
-- هجرة: أعمدة timestamp منفصلة لكل حقل قياس بجهاز الرصد (project_devices)
--
-- المشكلة المكتشفة (مراجعة كود خبير خارجي — H-05: "حداثة القياسات مشتركة
-- جزئياً"): last_pm10_at (راجع supabase-add-device-last-pm10-at-migration.sql)
-- أصلح هذه المشكلة لـPM10 تحديداً فقط — لكن الرياح (سرعة/هبة/اتجاه)،
-- الرؤية، الرطوبة، والحرارة ما زالت كلها تشترك في last_reading_at وحده.
-- تحديث جزئي (مثلاً حرارة فقط بلا رياح) "يُنعش" last_reading_at، فتظهر
-- قراءة رياح قديمة فعلياً وكأنها حديثة لمجرد أن الجهاز أرسل حقلاً آخر
-- مؤخراً — أي حزمة جزئية حقيقية قد تجعل حقلاً غير محدَّث "يبدو" حديثاً.
--
-- الإصلاح: عمود timestamp مستقل لكل حقل، بنفس مبدأ last_pm10_at بالضبط —
-- يُحدَّث فقط عند وجود القيمة فعلياً في حمولة push. last_reading_at يبقى
-- كما هو (أعم "آخر اتصال من الجهاز على الإطلاق")، لا كسر توافقي على أي
-- استهلاك حالي له.
-- =====================================================================

alter table public.project_devices
  add column if not exists last_wind_speed_at timestamptz,
  add column if not exists last_wind_gust_at timestamptz,
  add column if not exists last_wind_direction_at timestamptz,
  add column if not exists last_visibility_at timestamptz,
  add column if not exists last_relative_humidity_at timestamptz,
  add column if not exists last_temperature_at timestamptz;

-- تعبئة أولية معقولة للصفوف الموجودة: قِدم كل حقل لا يمكن معرفته بأثر
-- رجعي بدقة، فنستخدم last_reading_at كأفضل تقدير متاح (فشل آمن نحو "قد
-- تكون قديمة" بدل افتراض حداثة زائفة) — نفس أسلوب last_pm10_at بالضبط.
update public.project_devices
  set last_wind_speed_at = last_reading_at
  where last_wind_speed_kmh is not null and last_wind_speed_at is null;

update public.project_devices
  set last_wind_gust_at = last_reading_at
  where last_wind_gust_kmh is not null and last_wind_gust_at is null;

update public.project_devices
  set last_wind_direction_at = last_reading_at
  where last_wind_direction_deg is not null and last_wind_direction_at is null;

update public.project_devices
  set last_visibility_at = last_reading_at
  where last_visibility_m is not null and last_visibility_at is null;

update public.project_devices
  set last_relative_humidity_at = last_reading_at
  where last_relative_humidity_percent is not null and last_relative_humidity_at is null;

update public.project_devices
  set last_temperature_at = last_reading_at
  where last_temperature_c is not null and last_temperature_at is null;
