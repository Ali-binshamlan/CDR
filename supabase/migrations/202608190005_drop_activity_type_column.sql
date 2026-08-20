-- طلب مستخدم صريح (توحيد كامل لنظامي "نوع النشاط"): activity_type كان
-- التصنيف الهندسي العام القديم (6 قيم مثل HEAVY_EQUIPMENT_MOVEMENT)
-- المستخدَم فقط داخلياً لتغذية حساب حساسية محرك DVI (ActivityCategory في
-- dust-engine/types.ts) — بعد هذا التوحيد، regulatory_activity (التسعة
-- أنشطة تنظيمية فعلية مثل CRUSHER/DEMOLITION) هو الحقل الوحيد المستهلَك في
-- أي حساب قرار عبر كل المحركات (DVI/AEI/الامتثال). التطبيق توقف بالكامل عن
-- كتابة/قراءة activity_type (app/api/dust-profiles/route.ts، app/lib/
-- dustEvaluation.ts، app/components/AddActivityModal). تحقَّقنا مسبقاً: لا
-- views ولا triggers ولا generated columns تعتمد على هذا العمود بالاسم،
-- وinsert_dust_profile_atomic (jsonb_populate_record عام) تتكيف تلقائياً مع
-- شكل الجدول بلا حاجة لتعديل signature. حذف نهائي بالكامل — لا إبقاء فارغاً
-- (قرار مستخدم صريح: الحذف الكامل أفضل من عمود ميت غير مستخدَم إطلاقاً).
alter table public.project_dust_profiles drop column activity_type;

-- regulatory_activity كان له default='OTHER' توافقاً مع القيمة القديمة
-- الفارغة/الافتراضية — 'OTHER' لم تعد قيمة صالحة بعد حذف ENTRY_EXIT/OTHER من
-- RegulatoryDustActivity (dust-compliance-engine/types.ts)، والحقل بات
-- إجبارياً حقيقياً في schema الـAPI (regulatory_activity: z.enum(...) بلا
-- .optional()). إزالة الـdefault المضلِّل — لا تأثير على أي كتابة مستقبلية
-- (التطبيق يرسل قيمة صريحة دائماً)، فقط يمنع القيمة الافتراضية القديمة من
-- الظهور خطأً لو أُدرج صف مباشرة بتجاوز طبقة التطبيق.
alter table public.project_dust_profiles alter column regulatory_activity drop default;
