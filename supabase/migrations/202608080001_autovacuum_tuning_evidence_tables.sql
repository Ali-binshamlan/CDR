-- =====================================================================
-- ضبط autovacuum صريح على جداول append-only عالية التكرار
-- =====================================================================
-- اكتُشفت مشكلة حقيقية (2026-08-07): dust_evaluations وصل 402MB و
-- dust_compliance_evaluations وصل 74MB رغم أن كل جدول منهما كان يحوي 12
-- صفاً حياً فقط فعلياً (pg_stat_user_tables: last_vacuum/last_autovacuum
-- كلاهما null منذ إنشاء الجدول) — انتفاخ (bloat) كامل غير مُعالَج، لا حجم
-- بيانات حقيقي. حُلّ يدوياً عبر VACUUM FULL (402MB→568KB، 74MB→656KB)،
-- لكن autovacuum الافتراضي (الذي يعتمد على نسبة مئوية من حجم الجدول قبل
-- التشغيل: افتراضياً 20% صفوف ميتة) لا يشتغل بفعالية على جداول تبدأ صغيرة
-- وتنمو بكتابة append-only مستمرة — هذا الملف يضبط عتبات صريحة أقل بكثير
-- بدل الاعتماد على الافتراضي الذي أثبت أنه لم يعمل هنا.
--
-- ملاحظة: هذه الجداول append-only (INSERT فقط، ممنوعة UPDATE/DELETE بواسطة
-- triggers forbid_evidence_mutation) — autovacuum هنا لا يخدم "تنظيف صفوف
-- ميتة من DELETE/UPDATE" بالمعنى المعتاد، بل تحديث إحصائيات ANALYZE
-- (يحسّن خطط الاستعلام مع نمو الجدول) ومعالجة أي bloat ناتج عن عمليات
-- داخلية (index bloat، إلخ) دورياً بدل تراكمه بصمت لأشهر.

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
