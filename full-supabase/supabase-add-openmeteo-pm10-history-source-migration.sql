-- =====================================================================
-- هجرة: السماح بتسجيل قراءات Open-Meteo في pm10_readings_history
--
-- المشكلة المكتشفة: التسجيل في pm10_readings_history كان مقيَّداً بـ
-- dataSource === 'onsite' فقط (app/lib/dustEvaluation.ts) — أي نشاط
-- يعتمد فقط على توقعات Open-Meteo (بلا جهاز رصد ولا قراءة يدوية
-- onsite_pm10) لا يُبنى له أي سجل تاريخي إطلاقاً، فتبقى دالة حساب
-- الاستمرار الزمني (fetchPm10SustainedStatus) تُرجع دائماً "صفر دقيقة"،
-- ويبقى القرار "معلَّق" (MRQ-PM10-BLACK-PENDING-104 / STOP_AFFECTED_
-- ACTIVITY) إلى الأبد بلا أي إمكانية للتحول لمخالفة مؤكدة، مهما طال
-- الوقت الفعلي لاستمرار التجاوز.
--
-- الإصلاح: توسيع قيد source ليشمل 'open-meteo' أيضاً (بجانب 'device' و
-- 'manual' الموجودين أصلاً)، ليصبح كل نشاط قادراً على الوصول لحالة
-- مؤكدة/معلَّقة طبيعياً حسب الوقت الفعلي بصرف النظر عن مصدر القراءة.
-- =====================================================================

alter table public.pm10_readings_history
  drop constraint if exists pm10_readings_history_source_check;

alter table public.pm10_readings_history
  add constraint pm10_readings_history_source_check
  check (source in ('device', 'manual', 'open-meteo'));
