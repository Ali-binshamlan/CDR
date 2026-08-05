-- =====================================================================
-- DCR — 202608040030_evidence_profile_fk_restrict.sql
-- =====================================================================
-- خطأ حرج مكتشَف ومُصلَح (مراجعة خبير خارجي — القسم 7: "حذف Profile
-- يستطيع فصل Evaluation عن دليلها بجعل المرجع NULL"):
--
-- dust_evaluations.dust_profile_id وdust_compliance_evaluations.dust_
-- profile_id (202607290001_baseline_final.sql) كانا على delete set null
-- منذ الأساس — قرار متعمَّد وقتها بديلاً عن on delete cascade الأقدم
-- (الذي كان يحذف سجل التقييم بأكمله عند حذف النشاط، يخالف append-only).
-- لكن set null نفسه يبقى غير مثالي: لو حُذف صف project_dust_profiles
-- فعلياً (لا يوجد اليوم أي مسار كود يفعل هذا — DELETE /api/activities
-- تحوَّل لأرشفة عبر archived_at منذ إصلاح سابق، راجع app/api/activities/
-- route.ts)، تفقد سجلات التقييم التاريخية (dust_evaluations/dust_
-- compliance_evaluations) مرجعها بصمت بدل البقاء مرتبطة بدليل تاريخي
-- صريح — يخالف مباشرة فلسفة append-only الموثَّقة في أماكن أخرى من هذا
-- المشروع (alert_state_events، pm10_readings_history، إلخ: لا يُفقَد دليل
-- أبداً، فقط يُضاف إليه).
--
-- الإصلاح: on delete restrict بدل set null — يمنع أي حذف مستقبلي (يدوي
-- عبر SQL مباشر، أو مسار كود لم يُكتَب بعد) لصف project_dust_profiles
-- طالما توجد تقييمات مرتبطة به، بدل السماح بالحذف وفقدان المرجع بصمت.
-- تغيير آمن تماماً اليوم (بلا أي تأثير سلوكي فعلي) لأن لا مسار حذف حقيقي
-- موجود أصلاً — يغلق فقط الثغرة الكامنة على مستوى المخطط نفسه.
-- =====================================================================

alter table public.dust_evaluations
  drop constraint if exists dust_evaluations_dust_profile_id_fkey;

alter table public.dust_evaluations
  add constraint dust_evaluations_dust_profile_id_fkey
  foreign key (dust_profile_id) references public.project_dust_profiles(id) on delete restrict;

alter table public.dust_compliance_evaluations
  drop constraint if exists dust_compliance_evaluations_dust_profile_id_fkey;

alter table public.dust_compliance_evaluations
  add constraint dust_compliance_evaluations_dust_profile_id_fkey
  foreign key (dust_profile_id) references public.project_dust_profiles(id) on delete restrict;
