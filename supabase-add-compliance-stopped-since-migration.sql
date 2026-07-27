-- =====================================================================
-- هجرة: stopped_since في current_dust_compliance_decisions
--
-- المشكلة: منع الاستئناف الفوري بعد إيقاف (RESUME_STABILITY_MINUTES في
-- app/utils/dust-compliance-engine/engine.ts) كان يعتمد على عمود
-- updated_at الموجود أصلاً — لكن ذلك العمود يتحدّث أيضاً عند إعادة كتابة
-- *نفس* القرار الموقِف (بعد مرور 5 دقائق فقط، راجع
-- MIN_MINUTES_BETWEEN_UNCHANGED_EVALUATIONS/shouldSkipPersist في
-- dustEvaluation.ts)، لا فقط عند تغيّر القرار فعلياً. النتيجة: مجرد فتح
-- صفحة المشروع بشكل متكرر أثناء إيقاف قائم كان "يمدّد" عداد الـ10 دقائق
-- من جديد في كل مرة بلا قصد، فيبقى النشاط عالقاً موقوفاً أطول من المفترض.
--
-- الحل: عمود مستقل يُسجَّل فيه "منذ متى بدأ آخر إيقاف مستمر" فقط — يُكتب
-- مرة واحدة عند الدخول إلى حالة إيقاف، ولا يتغيّر طالما القرار ما زال
-- موقِفاً (حتى لو تكرّرت الكتابة لنفس القرار)، ويُفرَّغ (null) فور تحسّن
-- القرار فعلياً. راجع persistDustComplianceEvaluations في dustEvaluation.ts.
-- =====================================================================

alter table public.current_dust_compliance_decisions
  add column if not exists stopped_since timestamptz;

-- تعبئة أولية للصفوف الموقِفة الحالية: نستخدم updated_at كأفضل تقدير متاح
-- (نفس القيمة المستخدمة سابقاً)، حتى لا تفقد الأنشطة الموقِفة حالياً
-- تتبّع مدة إيقافها بعد الترحيل مباشرة.
update public.current_dust_compliance_decisions
set stopped_since = updated_at
where decision in ('MANDATORY_STOP', 'STOP_AFFECTED_ACTIVITY')
  and stopped_since is null;
