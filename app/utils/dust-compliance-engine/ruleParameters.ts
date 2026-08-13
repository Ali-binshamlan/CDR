import type { SupabaseClient } from '@supabase/supabase-js';

// =============================================================
// Riyadh Dust Compliance Engine — Rule Parameters (Tunable Thresholds)
// =============================================================
// خطأ مكتشَف ومُصلَح (مراجعة خبير خارجي — "واجهة إدارة القواعد للعرض فقط؛
// القواعد الفعلية ثابتة داخل دوال برمجية؛ لا يوجد نظام حقيقي يدعم: إنشاء
// نسخة قاعدة، النشر الذري، منع تعديل نسخة منشورة، التراجع لنسخة سابقة"):
// محرك القواعد نفسه (rulebook.ts/engine.ts) يبقى منطقاً برمجياً IF/THEN —
// قرار المستخدم الصريح تجنّب تحويله لمُفسِّر قواعد ديناميكي (مخاطرة عالية
// على نظام امتثال تنظيمي). النطاق المُتفَق عليه بدلاً من ذلك: العتبات
// الرقمية القابلة للضبط فعلياً (مسافات، سرعات رياح، أزمنة، نسب) تُنقَل من
// ثوابت TypeScript صرفة إلى قيم قابلة للتعديل عبر نظام نسخ حقيقي
// (rule_parameter_definitions/rule_parameter_versions، migration
// 202608060003)، بينما تبقى بنية القواعد نفسها (أي قاعدة تُفعَّل، أي شرط
// IF) كما هي تماماً في الكود — لا يجوز حذف/إضافة قاعدة من لوحة التحكم،
// فقط ضبط رقم عتبة قاعدة موجودة أصلاً.
//
// عتبات PM10 (340/250/...) مُستبعَدة صراحةً من هذا النظام — تبقى حصراً من
// ACTIVE_RULE_BUNDLE (app/utils/rule-bundles)، طلب صريح من المستخدم بعدم
// المساس بها هنا.
//
// آلية التطبيق: كل معامل هنا متغيّر وحدة (`let`، لا `const`) يُهيَّأ بقيمة
// افتراضية تطابق ما كان مكتوباً صراحة في rulebook.ts/engine.ts قبل هذا
// التغيير بالضبط — fallback آمن يبقي كل سلوك التقييم مطابقاً تماماً للحالة
// السابقة إن لم يُنشَر أي معامل بعد. refreshRuleParameters (تُستدعى مرة
// واحدة لكل دورة تقييم في computeDustComplianceResults، بنفس نمط
// resolveDeviceTrueNorthCalibrationMap/resolveProjectDeviceMap الموجود
// مسبقاً في dustEvaluation.ts) تجلب كل نسخة PUBLISHED حالياً وتُحدِّث هذه
// المتغيرات دفعة واحدة قبل أي تقييم جديد. rulebook.ts/engine.ts يبقيان
// دالتين نقيتين تماماً (بلا I/O) تقرآن هذه المتغيرات كقيم عادية — لا تغيير
// في تواقيعهما ولا في نمط استدعائهما.

export interface RuleParameters {
  CRUSHER_SENSITIVE_RECEPTOR_DISTANCE_M: number;
  CRUSHER_GENERAL_RECEPTOR_DISTANCE_M: number;
  STOCKPILE_SENSITIVE_RECEPTOR_DISTANCE_M: number;
  DEMOLITION_MAX_AREA_M2: number;
  IDLE_SURFACE_MAX_DAYS: number;
  UNPAVED_SPEED_LIMIT_KMH: number;
  PAVED_SPEED_LIMIT_KMH: number;
  SPILL_CLEANUP_LIMIT_MIN: number;
  DROP_HEIGHT_NORMAL_LIMIT_M: number;
  DROP_HEIGHT_HIGH_WIND_LIMIT_M: number;
  DEBRIS_PILE_MAX_HEIGHT_M: number;
  IMMERSION_ZONE_MIN_LENGTH_M: number;
  WHEEL_WASH_CYCLE_MIN_SEC: number;
  STONE_CUTTING_WIND_STOP_KMH: number;
  BATCHING_PM10_FILTER_MIN_PERCENT: number;
  IDLE_SURFACE_COVER_INSPECTION_WIND_KMH: number;
  WIND_GATE_ENHANCED_MIN_KMH: number;
  WIND_GATE_STOP_KMH: number;
  WIND_GUST_SAFETY_THRESHOLD_KMH: number;
  CONFIDENCE_MIN_FOR_ALLOW: number;
  // خطأ مكتشَف ومُصلَح (مراجعة كود خارجي — "يمكن نشر معاملات رياح متناقضة"،
  // البند الثالث: "انقل حدود الرؤية 500/1000 إلى حزمة القواعد حتى تدخل في
  // replay"): كانتا ثابتين خامين (0.5/1 كم) مباشرة داخل applyMandatoryGates
  // (dust-engine/engine.ts) — لا أثر لهما في rule_parameter_versions، فلا
  // تُلتقَط بصمة قيمتهما الفعلية وقت أي تقييم ضمن computeInputSnapshotHash
  // (dustEvaluation.ts)، ولا يمكن إعادة بناء "ما كانت عليه العتبة وقت هذا
  // القرار" لاحقاً لو تغيّرت — بخلاف كل عتبة أخرى في هذا الملف. نُقلتا هنا
  // بنفس آلية بقية المعاملات (fallback افتراضي مطابق للقيمة القديمة تماماً).
  VISIBILITY_MANDATORY_STOP_KM: number;
  VISIBILITY_RESTRICT_SEVERE_KM: number;
}

// القيم الافتراضية — مطابقة تماماً لما كان مكتوباً صراحةً كثوابت في
// rulebook.ts/engine.ts قبل هذا التغيير (code_default_value في migration
// 202608060003 بالضبط). fallback الوحيد قبل أول نشر فعلي لأي معامل.
export const DEFAULT_RULE_PARAMETERS: RuleParameters = Object.freeze({
  CRUSHER_SENSITIVE_RECEPTOR_DISTANCE_M: 500,
  CRUSHER_GENERAL_RECEPTOR_DISTANCE_M: 200,
  STOCKPILE_SENSITIVE_RECEPTOR_DISTANCE_M: 200,
  DEMOLITION_MAX_AREA_M2: 100,
  IDLE_SURFACE_MAX_DAYS: 5,
  UNPAVED_SPEED_LIMIT_KMH: 10,
  PAVED_SPEED_LIMIT_KMH: 20,
  SPILL_CLEANUP_LIMIT_MIN: 15,
  DROP_HEIGHT_NORMAL_LIMIT_M: 1.5,
  DROP_HEIGHT_HIGH_WIND_LIMIT_M: 1,
  DEBRIS_PILE_MAX_HEIGHT_M: 3,
  IMMERSION_ZONE_MIN_LENGTH_M: 8,
  WHEEL_WASH_CYCLE_MIN_SEC: 20,
  STONE_CUTTING_WIND_STOP_KMH: 15,
  BATCHING_PM10_FILTER_MIN_PERCENT: 99,
  IDLE_SURFACE_COVER_INSPECTION_WIND_KMH: 20,
  WIND_GATE_ENHANCED_MIN_KMH: 15,
  WIND_GATE_STOP_KMH: 25,
  WIND_GUST_SAFETY_THRESHOLD_KMH: 50,
  CONFIDENCE_MIN_FOR_ALLOW: 70,
  VISIBILITY_MANDATORY_STOP_KM: 0.5,
  VISIBILITY_RESTRICT_SEVERE_KM: 1,
});

// الحالة الحية الفعلية التي تقرأها rulebook.ts/engine.ts — تبدأ مطابقة
// للافتراضي تماماً، وتُستبدَل بالكامل (لا دمج جزئي) في كل refreshRuleParameters
// ناجح. كائن واحد قابل للتبديل الذري (لا حقول مفردة قابلة للتحديث المتزامن
// الجزئي) — يمنع قراءة توليفة متناقضة من نصف قيم قديمة ونصف جديدة أثناء
// التحديث نفسه.
let current: RuleParameters = DEFAULT_RULE_PARAMETERS;

// خطأ مكتشَف (مراجعة تدقيق — "لا تُحفظ معرفات نسخ المعاملات المستخدمة مع
// القرار"): current أعلاه يحمل أرقاماً خاماً فقط، بلا أي أثر لمصدرها. بصمة
// مصاحبة منفصلة تماماً — كائن {parameter_code: rule_parameter_versions.id}
// — عمداً لا حقل إضافي داخل كل رقم في RuleParameters نفسها: rulebook.ts/
// engine.ts يقرآن getRuleParameters().X كرقم خام مباشرة في مقارنات حسابية
// (if (windSpeed >= WIND_GATE_STOP_KMH()))؛ تغيير الشكل لـ{value, versionId}
// يكسر كل موقع استهلاك بلا أي فائدة لمحرك القرار نفسه — provenance معلومة
// تدقيقية تُلتقَط عند الحفظ فقط (dustEvaluation.ts)، لا عند التقييم.
export interface RuleParameterVersionSnapshot {
  [parameterCode: string]: string; // parameter_code -> rule_parameter_versions.id
}

// معامل بلا نسخة PUBLISHED فعلية (يستخدم DEFAULT_RULE_PARAMETERS fallback)
// غائب من هذه الخريطة عمداً — غياب المفتاح يعني صراحة "لا نسخة تحكم هذا
// المعامل، القيمة من الكود الافتراضي"، لا "معرّف فارغ" ملتبس.
let currentVersionIds: RuleParameterVersionSnapshot = {};

export function getRuleParameters(): RuleParameters {
  return current;
}

// بصمة معرّفات النسخ الفعلية وقت آخر refreshRuleParameters ناجح — تُقرَأ
// مرة واحدة لكل دورة تقييم (evaluateProject.ts) وتُمرَّر حتى persist_
// activity_decision_atomic لتُخزَّن في final_decisions.rule_parameter_
// version_snapshot.
export function getActiveParameterVersionIds(): RuleParameterVersionSnapshot {
  return currentVersionIds;
}

// للاختبارات فقط — يعيد الحالة للافتراضي الصريح، بمعزل تام عن أي DB حقيقية
// (لا استيراد Supabase في أي مسار اختبار وحدة لـ rulebook.ts/engine.ts).
export function resetRuleParametersForTests(): void {
  current = DEFAULT_RULE_PARAMETERS;
  currentVersionIds = {};
}

export function resetRuleParameterVersionIdsForTests(): void {
  currentVersionIds = {};
}

// للاختبارات فقط — يضبط معاملاً واحداً أو أكثر مباشرة بلا Supabase، لإثبات
// أن rulebook.ts/engine.ts يقرآن القيمة الحية فعلياً (لا ثابتاً مجمَّداً)
// من هذه الوحدة تحديداً — نفس آلية النشر الحقيقية (كائن كامل جديد، لا تحديث
// جزئي في مكانه).
export function setRuleParametersForTests(overrides: Partial<RuleParameters>): void {
  current = { ...current, ...overrides };
}

// تُستدعى مرة واحدة في بداية كل دورة computeDustComplianceResults (نفس نمط
// resolveDeviceTrueNorthCalibrationMap) — تجلب كل نسخة PUBLISHED حالية دفعة
// واحدة (استعلام واحد، لا استعلام لكل معامل) وتبني كائناً جديداً كاملاً قبل
// التبديل الذري. فشل الاستعلام لا يُسقط التقييم (نفس مبدأ resolveFreshProjectDevice)
// — يُبقي current كما كان (آخر قيم معروفة جيدة)، لا رجوعاً صامتاً للافتراضي
// الذي قد يختلف عن آخر نسخة منشورة فعلياً.
export async function refreshRuleParameters(supabaseAdmin: SupabaseClient): Promise<void> {
  try {
    const { data, error } = await supabaseAdmin
      .from('rule_parameter_versions')
      .select('id, parameter_code, value')
      .eq('status', 'PUBLISHED');

    if (error || !data) return;

    const next: RuleParameters = { ...DEFAULT_RULE_PARAMETERS };
    const nextVersionIds: RuleParameterVersionSnapshot = {};
    for (const row of data as { id: string; parameter_code: string; value: number }[]) {
      if (row.parameter_code in next) {
        (next as unknown as Record<string, number>)[row.parameter_code] = Number(row.value);
        nextVersionIds[row.parameter_code] = row.id;
      }
    }
    // تبديل ذرّي لكليهما معاً — نفس مبدأ current أعلاه (لا دمج جزئي، لا
    // قراءة توليفة متناقضة من قيمة جديدة مع معرّف نسخة قديم أو العكس).
    current = next;
    currentVersionIds = nextVersionIds;
  } catch {
    // فشل الاستعلام (شبكة/DB) لا يُسقط التقييم — يبقى current/currentVersionIds كما هما.
  }
}
