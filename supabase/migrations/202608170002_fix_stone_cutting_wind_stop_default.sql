-- خطأ مكتشَف ومُصلَح (مراجعة كود خارجي — "قطع الأحجار الخارجي لا يتبع
-- تسلسل الملحق أ"): STONE_CUTTING_WIND_STOP_KMH.code_default_value كانت 15
-- كم/س — تطابق عتبة بداية التثبيط المعزَّز (WIND_GATE_ENHANCED_MIN_KMH)، لا
-- عتبة الإيقاف الفعلي التي يجب أن تطابق بقية الأنشطة (WIND_GATE_STOP_KMH=25)
-- حسب الملحق أ. الكود الحي (DEFAULT_RULE_PARAMETERS في ruleParameters.ts)
-- صُحِّح إلى 25 في نفس التغيير — هذه الهجرة تُحدِّث فقط صف التعريف هنا
-- (code_default_value، للعرض في لوحة إدارة القواعد) ليطابقه، بلا أي تأثير
-- على أي نسخة PUBLISHED منشورة فعلياً في rule_parameter_versions (إن
-- وُجدت، تبقى كما هي — هذا التصحيح يمس فقط قيمة "الافتراضي من الكود"
-- المعروضة كمرجع، لا القيمة الحية المُطبَّقة إن كانت مختلفة عمداً).
update public.rule_parameter_definitions
set code_default_value = 25
where code = 'STONE_CUTTING_WIND_STOP_KMH';
