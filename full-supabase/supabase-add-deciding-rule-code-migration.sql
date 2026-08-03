-- =====================================================================
-- هجرة: تخزين سبب الإيقاف الفعلي (كود القاعدة) بدل استنتاجه من فئة القرار
-- (مراجعة كود خبير خارجي)
--
-- الثغرة المكتشفة: dust-compliance-engine/engine.ts (previousStopWasWindGate)
-- كان يفترض أن أي قرار سابق بفئة STOP_AFFECTED_ACTIVITY سببه بالضرورة
-- بوابة الرياح (GATE-WIND-ABOVE-25-004) — خطأ، لأن عشرات القواعد الأخرى
-- (PM10 معلَّق، تسرب صومعة، غسيل إطارات، ارتفاع تفريغ مواد...) تُنتج نفس
-- الفئة تماماً. هذا كان يُطبِّق قيد استئناف بوابة الرياح (لا يُستأنف عند
-- 25 كم/س بالضبط، يلزم أقل من 25 صراحة) على إيقافات سببها لا علاقة له
-- بالرياح إطلاقاً.
--
-- الإصلاح: current_dust_compliance_decisions.deciding_rule_code يخزّن كود
-- القاعدة الفعلية الفائزة (decidingRule.code في engine.ts، مثال:
-- 'GATE-WIND-ABOVE-25-004' أو 'BATCHING-LEAK-003') مع كل قرار. التقييم
-- التالي يقرأه كـ previousDecidingRuleCode ويقارنه بالكود المحدَّد
-- ('GATE-WIND-ABOVE-25-004') بدل مقارنة الفئة العامة وحدها.
--
-- stop_cause: عمود نصي عربي مختصر يصف سبب الإيقاف للعرض المباشر (تدقيق/
-- تقارير) بلا حاجة لترجمة كود القاعدة برمجياً — nullable، يُملأ اختيارياً
-- من نص messageAr الخاص بـ decidingRule عند الكتابة.
-- =====================================================================

alter table public.current_dust_compliance_decisions
  add column if not exists deciding_rule_code text,
  add column if not exists stop_cause text;
