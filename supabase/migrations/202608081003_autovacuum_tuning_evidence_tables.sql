-- =====================================================================
-- DCR — 202608081003_autovacuum_tuning_evidence_tables.sql
-- =====================================================================
-- حادثة إنتاج متكررة (2026-08-07 ثم 2026-08-08): dust_evaluations وصل
-- 402MB ثم 122MB، dust_compliance_evaluations وصل 74MB ثم 92MB — في كلتا
-- المرتين الجدول كان يحوي عشرات الصفوف الحيّة فقط فعلياً
-- (pg_stat_user_tables: last_vacuum/last_autovacuum غالباً null أو متأخر
-- جداً) — انتفاخ (bloat) غير مُعالَج بالسرعة الكافية، لا حجم بيانات حقيقي.
-- الحل اليدوي (VACUUM FULL) أعاد كلا الجدولين لعشرات الكيلوبايتات، لكن
-- autovacuum الافتراضي (يعتمد على نسبة مئوية من حجم الجدول: افتراضياً 20%
-- صفوف "ميتة"/محتاجة تحديث إحصائيات) لا يشتغل بفعالية كافية على جداول
-- append-only تبدأ صغيرة وتنمو بكتابة مستمرة — النسبة المئوية الثابتة تعني
-- عتبة تفعيل متزايدة الحجم مع نمو الجدول نفسه، فيتراكم الانتفاخ بصمت.
--
-- ملاحظة: هذه الجداول append-only (INSERT فقط، ممنوعة UPDATE/DELETE بواسطة
-- triggers forbid_evidence_mutation في 202607290004) — autovacuum هنا لا
-- يخدم "تنظيف صفوف ميتة من DELETE/UPDATE" بالمعنى المعتاد، بل تحديث
-- إحصائيات ANALYZE (يحسّن خطط الاستعلام مع نمو الجدول) ومعالجة أي bloat
-- ناتج عن عمليات داخلية (index bloat على العمود jsonb، إلخ) دورياً بدل
-- تراكمه بصمت لأسابيع حتى يُكتشف يدوياً من جديد.

alter table public.dust_evaluations set (
  autovacuum_vacuum_scale_factor = 0.05,
  autovacuum_analyze_scale_factor = 0.02
);

alter table public.dust_compliance_evaluations set (
  autovacuum_vacuum_scale_factor = 0.05,
  autovacuum_analyze_scale_factor = 0.02
);

alter table public.pm10_readings_history set (
  autovacuum_vacuum_scale_factor = 0.05,
  autovacuum_analyze_scale_factor = 0.02
);

alter table public.device_readings_history set (
  autovacuum_vacuum_scale_factor = 0.05,
  autovacuum_analyze_scale_factor = 0.02
);
