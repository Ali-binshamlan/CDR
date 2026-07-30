-- =====================================================================
-- إصلاح: السماح بـ activity_group_id = null في pm10_readings_history
--
-- الخطأ المكتشَف: العمود activity_group_id مُعرَّف not null منذ الهجرة
-- الأصلية (supabase-add-pm10-sustained-rules-migration.sql)، بينما
-- app/api/devices/ingest/route.ts يُدرج قراءات الجهاز بمستوى المشروع فقط
-- (project_id بلا activity_group_id، لأن الجهاز مرتبط بالمشروع ككل لا
-- بنشاط محدد — نفس التصميم المطبَّق فعلياً في fetchPm10SustainedStatus
-- بـapp/lib/dustEvaluation.ts، الذي يُعامل activity_group_id = null على
-- أنه "قراءة عامة على مستوى المشروع تخص كل الأنشطة").
--
-- الأثر: كل إدراج من devices/ingest كان يفشل بصمت (القيد not null يرفضه،
-- بلا أي معالجة خطأ على ذلك الاستدعاء تحديداً) منذ إنشاء الجدول — فلم
-- تُسجَّل أي قراءة جهاز واحدة في السجل التاريخي رغم نجاح تحديث
-- project_devices.last_pm10 نفسه، فبقيت دالة حساب الاستمرار الزمني
-- (computeSustainedPm10Status) تُرجع دائماً "صفر دقيقة استمرار" لكل قراءات
-- الأجهزة، ولا يمكن لأي قراءة جهاز الوصول لحالة "مخالفة مؤكدة" مهما طالت
-- مدة التجاوز الفعلية.
-- =====================================================================

alter table public.pm10_readings_history
  alter column activity_group_id drop not null;
