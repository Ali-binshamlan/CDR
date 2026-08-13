-- =====================================================================
-- DCR — 202608130007_drop_confirmed_unused_indexes.sql
-- =====================================================================
-- حذف فهارس مؤكَّدة عديمة الفائدة (طلب صريح من المستخدم — تحقيق مباشر في
-- ضغط Compute/CPU/Disk IO المرتفع على خطة Free، راجع لوحة Infrastructure:
-- 92% compute، 92% CPU، 90% disk IO). list_unused_indexes() (migration
-- 202608130004) رصدها جميعاً بـ idx_scan=0 — تحقيق كودي شامل لاحق (قراءة
-- كل استعلام .eq()/.order() في app/** وكل جسم RPC في migrations/** يلمس
-- هذه الجداول) أكّد أن لا مسار قراءة واحد يستخدم أياً من هذه الأعمدة؛
-- كلها أعمدة تُكتَب فقط (write-only)، تدفع تكلفة صيانة الفهرس مع كل
-- INSERT/UPDATE بلا أي فائدة قرائية إطلاقاً — هدر Disk IO/CPU مباشر
-- ومُثبَت.
--
-- استُبعِد عمداً من هذه القائمة: idx_final_decisions_dvi_evaluation
-- وidx_final_decisions_compliance_evaluation (أُضيفا اليوم في migration
-- 202608130006 كبنية تحتية مقصودة لميزة إعادة إنتاج/تدقيق القرار تاريخياً
-- لم تُبنَ بعد — حجمهما ضئيل جداً (~40KB لكل منهما) فلا يستحقان مخاطرة
-- الحذف والحاجة لإعادة الإنشاء لاحقاً عند بناء تلك الميزة).
--
-- بلا CONCURRENTLY عمداً: يتطلب تنفيذاً خارج transaction block تماماً، وهذا
-- المشروع يُشغِّل كل migrations يدوياً عبر Supabase SQL Editor (لا اتصال
-- مباشر آلي بقاعدة الإنتاج) — الأضمن جملة DROP INDEX عادية قابلة للتضمين
-- بأمان ضمن أي سياق تنفيذ. القفل الناتج (ACCESS EXCLUSIVE قصير جداً، أجزاء
-- من الثانية) مقبول هنا: كل فهرس من العشرة صغير جداً (بين 40KB و3.3MB)،
-- والجداول المتأثرة نفسها متوسطة الحجم (أكبرها dust_compliance_evaluations
-- ~80MB فقط وقت كتابة هذه الـmigration) — حذف فهرس أصغر بكثير وأسرع
-- إنشائياً من إنشائه، فلا خطر تعليق ملموس.

drop index if exists public.idx_dust_evaluations_profile;
drop index if exists public.idx_dust_evaluations_project_id;
drop index if exists public.idx_evaluation_runs_project_time;
drop index if exists public.idx_weather_forecasts_group_time;
drop index if exists public.idx_project_evaluation_jobs_project;
drop index if exists public.idx_weather_forecasts_project_time;
drop index if exists public.idx_device_measurements_latest_lookup;
drop index if exists public.idx_final_decisions_evaluation_run;
drop index if exists public.idx_dust_compliance_evaluations_profile;
drop index if exists public.idx_device_measurements_event;
