// =============================================================
// Riyadh Dust Compliance Engine — Rule Metadata Registry
//
// Single central registry for documentation fields (ruleId/ruleVersion/
// ruleType/indicatorType/activityTypes/conditionPredicate/priority/
// mandatoryStop/riskLevel/decisionCategory/requiredActions/
// restartConditions/escalationPolicy/overridePolicy/source/effectiveFrom/
// effectiveTo/isActive) attached to each rule hit. See the RuleMetadata
// comment in types.ts for the full architectural rationale — this replaces
// the separate hand-maintained rulesCatalog.ts, which could silently drift
// from the actual rulebook.ts/engine.ts logic.
//
// This file is documentation only — never consumed by the actual decision
// logic (evaluateDustCompliance). attachRuleMetadata() attaches this data to
// each DustRuleHit after it is built, not during; editing a field here or
// removing an entry never changes any decision the engine emits.
//
// priority is derived from DECISION_PRIORITY[decisionCategory] in
// rulebook.ts, multiplied by 10 — never an independent number that could
// drift from it.
// =============================================================

import type { DustRuleHit, RegulatoryDustActivity, RuleMetadata } from './types';
import { DECISION_PRIORITY, RULEBOOK_VERSION } from './rulebook';

function priorityFor(decisionCategory: RuleMetadata['decisionCategory']): number {
  return DECISION_PRIORITY[decisionCategory] * 10;
}

function overridePolicyFor(mandatoryStop: boolean, decisionCategory: RuleMetadata['decisionCategory']): RuleMetadata['overridePolicy'] {
  return mandatoryStop || decisionCategory === 'STOP_AFFECTED_ACTIVITY' ? 'NO_OVERRIDE' : 'FIELD_OVERRIDE_ALLOWED';
}

function meta(entry: {
  ruleId: string;
  ruleType: RuleMetadata['ruleType'];
  indicatorType: RuleMetadata['indicatorType'];
  activityTypes: RegulatoryDustActivity[];
  conditionPredicate: string;
  decisionCategory: RuleMetadata['decisionCategory'];
  riskLevel: RuleMetadata['riskLevel'];
  requiredActions: string[];
  restartConditions?: string;
  escalationPolicy?: RuleMetadata['escalationPolicy'];
  source: string;
  effectiveFrom: string;
  effectiveTo?: string | null;
  isActive?: boolean;
  overridePolicyOverride?: RuleMetadata['overridePolicy'];
}): RuleMetadata {
  const mandatoryStop = entry.decisionCategory === 'MANDATORY_STOP';
  return {
    ruleId: entry.ruleId,
    ruleVersion: RULEBOOK_VERSION,
    ruleType: entry.ruleType,
    indicatorType: entry.indicatorType,
    activityTypes: entry.activityTypes,
    conditionPredicate: entry.conditionPredicate,
    priority: priorityFor(entry.decisionCategory),
    mandatoryStop,
    riskLevel: entry.riskLevel,
    decisionCategory: entry.decisionCategory,
    requiredActions: entry.requiredActions,
    restartConditions: entry.restartConditions ?? '',
    escalationPolicy: entry.escalationPolicy ?? 'NONE',
    overridePolicy: entry.overridePolicyOverride ?? overridePolicyFor(mandatoryStop, entry.decisionCategory),
    source: entry.source,
    effectiveFrom: entry.effectiveFrom,
    effectiveTo: entry.effectiveTo ?? null,
    isActive: entry.isActive ?? true,
  };
}

const RIYADH_ANNEX_A = 'الاستخراج التنظيمي من المرفق (الملحق أ)';
const RIYADH_SECTION_4 = 'الاستخراج التنظيمي من المرفق، القسم الرابع';

export const RULE_METADATA_REGISTRY: Record<string, RuleMetadata> = {
  // ------------------------ Top-priority gates ------------------------
  'GATE-DMP-001': meta({
    ruleId: 'GATE-DMP-001', ruleType: 'GATE', indicatorType: 'NONE', activityTypes: [],
    conditionPredicate: 'activity.isActiveOrPlanned && project.dmpApprovalStatus NOT IN (APPROVED, NOT_REQUIRED, UNKNOWN)',
    decisionCategory: 'MANDATORY_STOP', riskLevel: 'CRITICAL',
    requiredActions: ['استصدار موافقة معتمدة على خطة إدارة الغبار (DMP) من الجهة المختصة'],
    restartConditions: 'اعتماد DMP رسمياً من الجهة المختصة',
    source: RIYADH_ANNEX_A, effectiveFrom: '2026-01-01',
  }),
  'GATE-DVI-002': meta({
    ruleId: 'GATE-DVI-002', ruleType: 'GATE', indicatorType: 'PM10', activityTypes: [],
    conditionPredicate: 'dvi.mandatoryStop === true (خطر فيزيائي فوري: رؤية حرجة/عاصفة، أو PM10 مؤكَّد/موقوف حسب dviMandatoryStopIsPm10Only)',
    decisionCategory: 'MANDATORY_STOP', riskLevel: 'CRITICAL',
    requiredActions: ['إخلاء منطقة العمل', 'انتظار تحسّن حالة الجو (الرؤية/تركيز الغبار)'],
    restartConditions: 'تحسّن القياس الفيزيائي (رؤية/PM10) دون العتبة الحرجة، مع استقرار 10 دقائق (RESUME-STABILITY-HOLD)',
    escalationPolicy: 'AUTO_ESCALATE_ON_PERSISTENCE',
    source: RIYADH_ANNEX_A, effectiveFrom: '2026-01-01',
  }),
  'GATE-SUPPRESSION-003': meta({
    ruleId: 'GATE-SUPPRESSION-003', ruleType: 'GATE', indicatorType: 'CONTROL_STATE', activityTypes: [],
    conditionPredicate: 'activity.isDustGenerating && controls.dustSuppressionSystemOperational === false',
    decisionCategory: 'MANDATORY_STOP', riskLevel: 'CRITICAL',
    requiredActions: ['إعادة تشغيل نظام تثبيط الغبار', 'التحقق من عمله فعلياً قبل الاستئناف'],
    restartConditions: 'تأكيد تشغيل نظام تثبيط الغبار فعلياً',
    source: RIYADH_ANNEX_A, effectiveFrom: '2026-01-01',
  }),
  'GATE-WIND-ABOVE-25-004': meta({
    ruleId: 'GATE-WIND-ABOVE-25-004', ruleType: 'GATE', indicatorType: 'WIND', activityTypes: [],
    conditionPredicate: 'windSpeedKmh > 25 && activity.isDustGenerating (باستثناء BATCHING_PLANT بشرطي silosSealed + pm10FilterEfficiencyPercent≥99% معاً)',
    decisionCategory: 'STOP_AFFECTED_ACTIVITY', riskLevel: 'HIGH',
    requiredActions: ['إيقاف النشاط', 'تأمين المواد السائبة', 'انتظار انخفاض الرياح دون 25 كم/س'],
    restartConditions: 'انخفاض سرعة الرياح إلى ما دون 25 كم/س صراحة (GATE-WIND-ABOVE-25-RESUME-HOLD)',
    source: RIYADH_ANNEX_A, effectiveFrom: '2026-01-01',
  }),
  'GATE-WIND-15-25-ENHANCED-005': meta({
    ruleId: 'GATE-WIND-15-25-ENHANCED-005', ruleType: 'GATE', indicatorType: 'WIND', activityTypes: [],
    conditionPredicate: 'windSpeedKmh in [15, 25] && activity.isDustGenerating && !isEnclosedOperation',
    decisionCategory: 'ALLOW_WITH_CONTROLS', riskLevel: 'MEDIUM',
    requiredActions: ['رش ساعي', 'تغطية الأكوام', 'خفض ارتفاع التفريغ لمتر واحد', 'تشديد تنظيف الطرق وغسيل الإطارات'],
    source: RIYADH_ANNEX_A, effectiveFrom: '2026-01-01',
  }),
  'GATE-WIND-GUST-SAFETY': meta({
    ruleId: 'GATE-WIND-GUST-SAFETY', ruleType: 'GATE', indicatorType: 'WIND', activityTypes: [],
    conditionPredicate: 'windGustKmh > 25 && windSpeedKmh <= 25 (هبة عابرة، لا رياح مستدامة)',
    decisionCategory: 'ALLOW_WITH_CONTROLS', riskLevel: 'LOW',
    requiredActions: ['تأمين المواد السائبة والمعدات الخفيفة فوراً', 'مراقبة استقرار سرعة الرياح المستدامة'],
    source: RIYADH_ANNEX_A, effectiveFrom: '2026-01-01',
  }),

  // ------------------------ General regulatory PM10 ------------------------
  'PM10-WARNING-008': meta({
    ruleId: 'PM10-WARNING-008', ruleType: 'GATE', indicatorType: 'PM10', activityTypes: [],
    conditionPredicate: 'pm10UgM3 in [250, 340)',
    decisionCategory: 'ALLOW_WITH_CONTROLS', riskLevel: 'MEDIUM',
    requiredActions: ['رش ساعي أو مثبطات', 'تغطية الأكوام وخفض ارتفاع التفريغ لمتر', 'تقليل واجهات العمل المتزامنة', 'تقييد حركة النقل'],
    source: RIYADH_SECTION_4, effectiveFrom: '2026-01-01',
  }),
  'PM10-VIOLATION-STOP-006': meta({
    ruleId: 'PM10-VIOLATION-STOP-006', ruleType: 'GATE', indicatorType: 'PM10', activityTypes: [],
    conditionPredicate: 'pm10UgM3 >= 340 مستمرة لدقيقتين متتاليتين فأكثر (مؤكَّدة، pm10ConfirmedViolation340=true)، قبل اكتمال 30 دقيقة',
    decisionCategory: 'ALLOW_WITH_CONTROLS', riskLevel: 'HIGH',
    requiredActions: ['استمرار التثبيط المعزز فوراً', 'رش ساعي أو مثبطات', 'تغطية الأكوام', 'خفض ارتفاع التفريغ', 'تقييد حركة النقل'],
    escalationPolicy: 'AUTO_ESCALATE_ON_PERSISTENCE',
    source: RIYADH_SECTION_4, effectiveFrom: '2026-01-01',
  }),
  'MRQ-PM10-BLACK-PENDING-104': meta({
    ruleId: 'MRQ-PM10-BLACK-PENDING-104', ruleType: 'GATE', indicatorType: 'PM10', activityTypes: [],
    conditionPredicate: 'pm10UgM3 >= 340 لكن لم تكتمل دقيقتا الاستمرار بعد (pendingConfirmation)',
    decisionCategory: 'ALLOW_WITH_CONTROLS', riskLevel: 'MEDIUM',
    requiredActions: ['تفعيل التثبيط المعزز فوراً', 'مراقبة استمرار القراءة عن كثب'],
    escalationPolicy: 'AUTO_ESCALATE_ON_PERSISTENCE',
    source: RIYADH_SECTION_4, effectiveFrom: '2026-01-01',
  }),
  'RCRC-PM10-30M-SUSPENSION-012': meta({
    ruleId: 'RCRC-PM10-30M-SUSPENSION-012', ruleType: 'GATE', indicatorType: 'PM10', activityTypes: [],
    conditionPredicate: 'pm10UgM3 > 340 مستمرة فعلياً طوال 30 دقيقة متواصلة (pm10Suspended250For30Min)',
    decisionCategory: 'STOP_AFFECTED_ACTIVITY', riskLevel: 'CRITICAL',
    requiredActions: ['تعليق النشاط المسبب للغبار', 'تفعيل التثبيط المعزز فوراً'],
    restartConditions: 'انخفاض التركيز واستقراره دون الحد لفترة كافية',
    source: RIYADH_SECTION_4, effectiveFrom: '2026-01-01',
  }),

  // ------------------------ Demolition ------------------------
  'DEMO-WIND-STOP-001': meta({
    ruleId: 'DEMO-WIND-STOP-001', ruleType: 'ACTIVITY_SPECIFIC', indicatorType: 'WIND', activityTypes: ['DEMOLITION'],
    conditionPredicate: '!isEnclosedOperation && windBand in (FROM_15_TO_25, ABOVE_25)',
    decisionCategory: 'MANDATORY_STOP', riskLevel: 'HIGH',
    requiredActions: ['إيقاف أعمال الهدم المكشوفة فوراً', 'انتظار انخفاض الرياح دون 15 كم/س، أو التحويل لعملية مغلقة'],
    restartConditions: 'انخفاض سرعة الرياح دون 15 كم/س، أو تحويل العملية لتشغيل مغلق',
    source: RIYADH_ANNEX_A, effectiveFrom: '2026-01-01',
  }),
  'DEMO-AREA-002': meta({
    ruleId: 'DEMO-AREA-002', ruleType: 'ACTIVITY_SPECIFIC', indicatorType: 'AREA', activityTypes: ['DEMOLITION'],
    conditionPredicate: 'demolitionActiveAreaM2 > 100',
    decisionCategory: 'STOP_AFFECTED_ACTIVITY', riskLevel: 'HIGH',
    requiredActions: ['تقسيم أعمال الهدم إلى مراحل بحيث لا تتجاوز 100 م² في المرة الواحدة'],
    restartConditions: 'خفض المساحة النشطة الفعلية إلى 100 م² أو أقل',
    source: RIYADH_ANNEX_A, effectiveFrom: '2026-01-01',
  }),

  // ------------------------ Crusher ------------------------
  'CRUSHER-CATEGORY-001': meta({
    ruleId: 'CRUSHER-CATEGORY-001', ruleType: 'ACTIVITY_SPECIFIC', indicatorType: 'NONE', activityTypes: ['CRUSHER'],
    conditionPredicate: 'riskClass !== CATEGORY_III_HIGH',
    decisionCategory: 'MANDATORY_STOP', riskLevel: 'CRITICAL',
    requiredActions: ['إيقاف تشغيل الكسارة — غير مسموح بها إلا في مشاريع الفئة الثالثة'],
    restartConditions: 'وصول تصنيف المشروع إلى الفئة الثالثة (عالية المخاطر)',
    source: RIYADH_ANNEX_A, effectiveFrom: '2026-01-01',
  }),
  'CRUSHER-DISTANCE-200-002B': meta({
    ruleId: 'CRUSHER-DISTANCE-200-002B', ruleType: 'ACTIVITY_SPECIFIC', indicatorType: 'DISTANCE', activityTypes: ['CRUSHER'],
    conditionPredicate: 'crusherDistanceToNearestReceptorM < 200 (تنبيه توعوي فقط، لا يؤثر على decisionCategory)',
    decisionCategory: 'ALLOW_WITH_CONTROLS', riskLevel: 'LOW',
    requiredActions: ['يُفضَّل نقل الكسارة لمسافة لا تقل عن 200 م عن أقرب مستقبل حساس، أو زيادة إجراءات التثبيط'],
    source: RIYADH_ANNEX_A, effectiveFrom: '2026-01-01',
    overridePolicyOverride: 'FIELD_OVERRIDE_ALLOWED',
  }),
  'CRUSHER-DISTANCE-500-002C': meta({
    ruleId: 'CRUSHER-DISTANCE-500-002C', ruleType: 'ACTIVITY_SPECIFIC', indicatorType: 'DISTANCE', activityTypes: ['CRUSHER'],
    conditionPredicate: 'crusherDistanceToResidentialReceptorM < 500 (تنبيه توعوي فقط، لا يؤثر على decisionCategory)',
    decisionCategory: 'ALLOW_WITH_CONTROLS', riskLevel: 'LOW',
    requiredActions: ['يُفضَّل نقل الكسارة لمسافة لا تقل عن 500 م عن أقرب منطقة سكنية/مدرسة/مستشفى'],
    source: RIYADH_ANNEX_A, effectiveFrom: '2026-01-01',
  }),
  'MRQ-RECEPTOR-DOWNWIND-120': meta({
    ruleId: 'MRQ-RECEPTOR-DOWNWIND-120', ruleType: 'ACTIVITY_SPECIFIC', indicatorType: 'DISTANCE', activityTypes: ['CRUSHER'],
    conditionPredicate: 'crusherDistanceToDownwindReceptorAutoM < 500 (تنبيه توعوي فقط)',
    decisionCategory: 'ALLOW_WITH_CONTROLS', riskLevel: 'LOW',
    requiredActions: ['زيادة إجراءات التثبيط طالما استمر اتجاه الرياح نحو المستقبِل الحساس'],
    source: RIYADH_ANNEX_A, effectiveFrom: '2026-01-01',
  }),

  // ------------------------ Batching plant ------------------------
  'BATCHING-SILO-001': meta({
    ruleId: 'BATCHING-SILO-001', ruleType: 'ACTIVITY_SPECIFIC', indicatorType: 'CONTROL_STATE', activityTypes: ['BATCHING_PLANT'],
    conditionPredicate: 'controls.silosSealed === false',
    decisionCategory: 'MANDATORY_STOP', riskLevel: 'CRITICAL',
    requiredActions: ['إحكام إغلاق صوامع الإسمنت بالكامل'],
    restartConditions: 'تأكيد إحكام إغلاق الصوامع',
    source: RIYADH_SECTION_4, effectiveFrom: '2026-01-01',
  }),
  'BATCHING-FILTER-002': meta({
    ruleId: 'BATCHING-FILTER-002', ruleType: 'ACTIVITY_SPECIFIC', indicatorType: 'CONTROL_STATE', activityTypes: ['BATCHING_PLANT'],
    conditionPredicate: 'controls.pm10FilterEfficiencyPercent < 99',
    decisionCategory: 'MANDATORY_STOP', riskLevel: 'CRITICAL',
    requiredActions: ['استبدال أو إصلاح فلتر الجسيمات العالقة حتى تصل كفاءته إلى 99% على الأقل'],
    restartConditions: 'كفاءة الفلتر ≥ 99%',
    source: RIYADH_SECTION_4, effectiveFrom: '2026-01-01',
  }),
  'BATCHING-LEAK-003': meta({
    ruleId: 'BATCHING-LEAK-003', ruleType: 'ACTIVITY_SPECIFIC', indicatorType: 'CONTROL_STATE', activityTypes: ['BATCHING_PLANT'],
    conditionPredicate: 'controls.leakDetected === true',
    decisionCategory: 'STOP_AFFECTED_ACTIVITY', riskLevel: 'HIGH',
    requiredActions: ['إصلاح مصدر التسرب في الصومعة أو نظام النقل فوراً'],
    restartConditions: 'تأكيد إصلاح مصدر التسرب',
    source: RIYADH_SECTION_4, effectiveFrom: '2026-01-01',
  }),
  'BATCHING-DRYCLEAN-004': meta({
    ruleId: 'BATCHING-DRYCLEAN-004', ruleType: 'ACTIVITY_SPECIFIC', indicatorType: 'CONTROL_STATE', activityTypes: ['BATCHING_PLANT'],
    conditionPredicate: 'controls.dryCleaningMethodUsed === true',
    decisionCategory: 'RESTRICT_ACTIVITY', riskLevel: 'MEDIUM',
    requiredActions: ['استبدال الكنس الجاف/الهواء المضغوط بالشفط أو التنظيف الرطب'],
    source: RIYADH_SECTION_4, effectiveFrom: '2026-01-01',
  }),
  'BATCHING-SUPPRESSION-005': meta({
    ruleId: 'BATCHING-SUPPRESSION-005', ruleType: 'ACTIVITY_SPECIFIC', indicatorType: 'CONTROL_STATE', activityTypes: ['BATCHING_PLANT'],
    conditionPredicate: 'controls.dustSuppressionSystemOperational === false',
    decisionCategory: 'STOP_AFFECTED_ACTIVITY', riskLevel: 'HIGH',
    requiredActions: ['تشغيل نظام تثبيط الغبار عند محطة الخلط قبل الاستئناف'],
    restartConditions: 'تأكيد تشغيل نظام التثبيط',
    source: RIYADH_SECTION_4, effectiveFrom: '2026-01-01',
  }),
  'BATCHING-DISTANCE-200': meta({
    ruleId: 'BATCHING-DISTANCE-200', ruleType: 'ACTIVITY_SPECIFIC', indicatorType: 'DISTANCE', activityTypes: ['BATCHING_PLANT'],
    conditionPredicate: 'batchingDistanceToNearestReceptorM < 200 (تنبيه توعوي فقط)',
    decisionCategory: 'ALLOW_WITH_CONTROLS', riskLevel: 'LOW',
    requiredActions: ['يُفضَّل نقل محطة الخلط لمسافة لا تقل عن 200 م عن أقرب مستقبِل حساس'],
    source: RIYADH_SECTION_4, effectiveFrom: '2026-01-01',
  }),

  // ------------------------ Stone cutting ------------------------
  'STONECUT-WIND-ENHANCED-004': meta({
    ruleId: 'STONECUT-WIND-ENHANCED-004', ruleType: 'ACTIVITY_SPECIFIC', indicatorType: 'WIND', activityTypes: ['STONE_CUTTING'],
    conditionPredicate: '!isEnclosedOperation && windBand === FROM_15_TO_25',
    decisionCategory: 'ALLOW_WITH_CONTROLS', riskLevel: 'MEDIUM',
    requiredActions: ['رش مائي مستمر أثناء القطع', 'تقليل واجهات العمل المتزامنة', 'مراقبة سرعة الرياح باستمرار'],
    source: RIYADH_ANNEX_A, effectiveFrom: '2026-01-01',
  }),
  'STONECUT-WIND-STOP-003': meta({
    ruleId: 'STONECUT-WIND-STOP-003', ruleType: 'ACTIVITY_SPECIFIC', indicatorType: 'WIND', activityTypes: ['STONE_CUTTING'],
    conditionPredicate: '!isEnclosedOperation && windBand === ABOVE_25',
    decisionCategory: 'STOP_AFFECTED_ACTIVITY', riskLevel: 'HIGH',
    requiredActions: ['إيقاف القطع المكشوف فوراً', 'انتظار انخفاض الرياح دون 25 كم/س، أو التحويل لتشغيل مغلق'],
    restartConditions: 'انخفاض سرعة الرياح دون 25 كم/س',
    source: RIYADH_ANNEX_A, effectiveFrom: '2026-01-01',
  }),

  // ------------------------ Entry/exit (removal deferred — see rulebook.ts) ------------------------
  'ENTRY-WHEELWASH-001': meta({
    ruleId: 'ENTRY-WHEELWASH-001', ruleType: 'ACTIVITY_SPECIFIC', indicatorType: 'CONTROL_STATE', activityTypes: ['ENTRY_EXIT'],
    conditionPredicate: 'controls.wheelWashOperational === false',
    decisionCategory: 'STOP_AFFECTED_ACTIVITY', riskLevel: 'HIGH',
    requiredActions: ['تشغيل وحدة غسيل الإطارات أو توفير بديل عامل قبل السماح بخروج الشاحنات'],
    source: RIYADH_ANNEX_A, effectiveFrom: '2026-01-01', isActive: false,
  }),
  'ENTRY-TRACKOUT-002': meta({
    ruleId: 'ENTRY-TRACKOUT-002', ruleType: 'ACTIVITY_SPECIFIC', indicatorType: 'DISTANCE', activityTypes: ['ENTRY_EXIT'],
    conditionPredicate: 'measurements.visibleTrackoutBeyond15m === true',
    decisionCategory: 'STOP_AFFECTED_ACTIVITY', riskLevel: 'HIGH',
    requiredActions: ['تنظيف الأتربة المنقولة خارج البوابة فوراً ومعالجة سبب انتقالها'],
    source: RIYADH_ANNEX_A, effectiveFrom: '2026-01-01', isActive: false,
  }),
  'ENTRY-INSPECTION-003': meta({
    ruleId: 'ENTRY-INSPECTION-003', ruleType: 'ACTIVITY_SPECIFIC', indicatorType: 'WIND', activityTypes: ['ENTRY_EXIT'],
    conditionPredicate: 'windBand === FROM_15_TO_25 && controls.hourlyInspectionRecorded === false',
    decisionCategory: 'RESTRICT_ACTIVITY', riskLevel: 'MEDIUM',
    requiredActions: ['تسجيل فحص موثّق لوحدة غسيل الإطارات كل ساعة طوال فترة الرياح 15-25 كم/س'],
    source: RIYADH_ANNEX_A, effectiveFrom: '2026-01-01', isActive: false,
  }),
  'ENTRY-POINT-MISSING-004': meta({
    ruleId: 'ENTRY-POINT-MISSING-004', ruleType: 'ACTIVITY_SPECIFIC', indicatorType: 'NONE', activityTypes: ['ENTRY_EXIT'],
    conditionPredicate: 'measurements.entryPointLat === null || measurements.entryPointLng === null',
    decisionCategory: 'FIELD_VERIFICATION_REQUIRED', riskLevel: 'LOW',
    requiredActions: ['تحديد نقطة دخول المشروع على الخريطة في بيانات النشاط'],
    source: RIYADH_ANNEX_A, effectiveFrom: '2026-01-01', isActive: false,
  }),
  'ENTRY-EXITPOINT-MISSING-005': meta({
    ruleId: 'ENTRY-EXITPOINT-MISSING-005', ruleType: 'ACTIVITY_SPECIFIC', indicatorType: 'NONE', activityTypes: ['ENTRY_EXIT'],
    conditionPredicate: 'measurements.exitPointLat === null || measurements.exitPointLng === null',
    decisionCategory: 'FIELD_VERIFICATION_REQUIRED', riskLevel: 'LOW',
    requiredActions: ['تحديد نقطة خروج المشروع على الخريطة في بيانات النشاط'],
    source: RIYADH_ANNEX_A, effectiveFrom: '2026-01-01', isActive: false,
  }),
  'ENTRY-ROADPAVED-006': meta({
    ruleId: 'ENTRY-ROADPAVED-006', ruleType: 'ACTIVITY_SPECIFIC', indicatorType: 'CONTROL_STATE', activityTypes: ['ENTRY_EXIT'],
    conditionPredicate: 'controls.accessRoadPaved === false',
    decisionCategory: 'RESTRICT_ACTIVITY', riskLevel: 'MEDIUM',
    requiredActions: ['إسفلت الطريق المؤدي للمدخل أو تمهيده بمادة تمنع تطاير الغبار'],
    source: RIYADH_ANNEX_A, effectiveFrom: '2026-01-01', isActive: false,
  }),
  'ENTRY-SANDTRAP-007': meta({
    ruleId: 'ENTRY-SANDTRAP-007', ruleType: 'ACTIVITY_SPECIFIC', indicatorType: 'CONTROL_STATE', activityTypes: ['ENTRY_EXIT'],
    conditionPredicate: "controls.tireCleaningMethod === 'WHEEL_WASH' && controls.sandTrapPresent === false",
    decisionCategory: 'RESTRICT_ACTIVITY', riskLevel: 'MEDIUM',
    requiredActions: ['تركيب مصيدة رمال في وحدة غسيل الإطارات'],
    source: RIYADH_ANNEX_A, effectiveFrom: '2026-01-01', isActive: false,
  }),
  'ENTRY-OILSEP-008': meta({
    ruleId: 'ENTRY-OILSEP-008', ruleType: 'ACTIVITY_SPECIFIC', indicatorType: 'CONTROL_STATE', activityTypes: ['ENTRY_EXIT'],
    conditionPredicate: "controls.tireCleaningMethod === 'WHEEL_WASH' && controls.oilSeparatorPresent === false",
    decisionCategory: 'RESTRICT_ACTIVITY', riskLevel: 'MEDIUM',
    requiredActions: ['تركيب فاصل زيوت في وحدة غسيل الإطارات'],
    source: RIYADH_ANNEX_A, effectiveFrom: '2026-01-01', isActive: false,
  }),
  'ENTRY-WASHCYCLE-009': meta({
    ruleId: 'ENTRY-WASHCYCLE-009', ruleType: 'ACTIVITY_SPECIFIC', indicatorType: 'CONTROL_STATE', activityTypes: ['ENTRY_EXIT'],
    conditionPredicate: "controls.tireCleaningMethod === 'WHEEL_WASH' && controls.washCycleDurationAdequate === false",
    decisionCategory: 'RESTRICT_ACTIVITY', riskLevel: 'MEDIUM',
    requiredActions: ['ضبط مدة دورة الغسيل على 20 ثانية على الأقل لكل محور'],
    source: RIYADH_ANNEX_A, effectiveFrom: '2026-01-01', isActive: false,
  }),
  'ENTRY-WASHREUSE-010': meta({
    ruleId: 'ENTRY-WASHREUSE-010', ruleType: 'ACTIVITY_SPECIFIC', indicatorType: 'CONTROL_STATE', activityTypes: ['ENTRY_EXIT'],
    conditionPredicate: "controls.tireCleaningMethod === 'WHEEL_WASH' && controls.washWaterReused === false",
    decisionCategory: 'ALLOW_WITH_CONTROLS', riskLevel: 'LOW',
    requiredActions: ['إضافة نظام إعادة استخدام لمياه غسيل الإطارات'],
    source: RIYADH_ANNEX_A, effectiveFrom: '2026-01-01', isActive: false,
  }),
  'ENTRY-IMMERSION-MESH-011': meta({
    ruleId: 'ENTRY-IMMERSION-MESH-011', ruleType: 'ACTIVITY_SPECIFIC', indicatorType: 'CONTROL_STATE', activityTypes: ['ENTRY_EXIT'],
    conditionPredicate: "controls.tireCleaningMethod === 'WATER_IMMERSION' && controls.antiSlipMeshPresent === false",
    decisionCategory: 'RESTRICT_ACTIVITY', riskLevel: 'MEDIUM',
    requiredActions: ['تركيب شبكة مانعة للانزلاق في منطقة غمر الإطارات'],
    source: RIYADH_ANNEX_A, effectiveFrom: '2026-01-01', isActive: false,
  }),
  'ENTRY-IMMERSION-LENGTH-012': meta({
    ruleId: 'ENTRY-IMMERSION-LENGTH-012', ruleType: 'ACTIVITY_SPECIFIC', indicatorType: 'CONTROL_STATE', activityTypes: ['ENTRY_EXIT'],
    conditionPredicate: "controls.tireCleaningMethod === 'WATER_IMMERSION' && controls.immersionZoneLengthAdequate === false",
    decisionCategory: 'RESTRICT_ACTIVITY', riskLevel: 'MEDIUM',
    requiredActions: ['توسيع منطقة غمر الإطارات إلى 8 أمتار على الأقل'],
    source: RIYADH_ANNEX_A, effectiveFrom: '2026-01-01', isActive: false,
  }),
  'ENTRY-BASIN-013': meta({
    ruleId: 'ENTRY-BASIN-013', ruleType: 'ACTIVITY_SPECIFIC', indicatorType: 'CONTROL_STATE', activityTypes: ['ENTRY_EXIT'],
    conditionPredicate: "controls.tireCleaningMethod === 'WATER_IMMERSION' && controls.collectionBasinPresent === false",
    decisionCategory: 'RESTRICT_ACTIVITY', riskLevel: 'MEDIUM',
    requiredActions: ['إنشاء حوض سفلي لتجميع مخلفات غمر الإطارات'],
    source: RIYADH_ANNEX_A, effectiveFrom: '2026-01-01', isActive: false,
  }),
  'ENTRY-PATHCLEAN-014': meta({
    ruleId: 'ENTRY-PATHCLEAN-014', ruleType: 'ACTIVITY_SPECIFIC', indicatorType: 'CONTROL_STATE', activityTypes: ['ENTRY_EXIT'],
    conditionPredicate: 'controls.truckPathCleanedWithin15Min === false',
    decisionCategory: 'RESTRICT_ACTIVITY', riskLevel: 'MEDIUM',
    requiredActions: ['تنظيف مسار الشاحنات خلال 15 دقيقة من كل عملية عبور'],
    source: RIYADH_ANNEX_A, effectiveFrom: '2026-01-01', isActive: false,
  }),
  'ENTRY-WATERTRACE-015': meta({
    ruleId: 'ENTRY-WATERTRACE-015', ruleType: 'ACTIVITY_SPECIFIC', indicatorType: 'DISTANCE', activityTypes: ['ENTRY_EXIT'],
    conditionPredicate: 'measurements.waterTracesBeyond15mFromGate === true',
    decisionCategory: 'RESTRICT_ACTIVITY', riskLevel: 'MEDIUM',
    requiredActions: ['إزالة آثار المياه والمخلفات حول البوابة', 'تقليل كمية المياه المستخدمة في الغسيل'],
    source: RIYADH_ANNEX_A, effectiveFrom: '2026-01-01', isActive: false,
  }),

  // ------------------------ Stockpiles and handling ------------------------
  'STOCKPILE-DISTANCE-002': meta({
    ruleId: 'STOCKPILE-DISTANCE-002', ruleType: 'ACTIVITY_SPECIFIC', indicatorType: 'DISTANCE', activityTypes: ['MATERIAL_HANDLING_STOCKPILE'],
    conditionPredicate: 'stockpileDistanceToNearestReceptorM < 200 (تنبيه توعوي فقط)',
    decisionCategory: 'ALLOW_WITH_CONTROLS', riskLevel: 'LOW',
    requiredActions: ['يُفضَّل نقل الأكوام/محطة الخلط إلى مسافة لا تقل عن 200 م عن أقرب مستقبل حساس'],
    source: RIYADH_ANNEX_A, effectiveFrom: '2026-01-01',
  }),

  // ------------------------ Idle surfaces ------------------------
  'IDLE-STABILIZE-001': meta({
    ruleId: 'IDLE-STABILIZE-001', ruleType: 'ACTIVITY_SPECIFIC', indicatorType: 'CONTROL_STATE', activityTypes: ['IDLE_SURFACE'],
    conditionPredicate: 'idleDays > 5 && controls.idleSurfaceStabilized === false',
    decisionCategory: 'RESTRICT_ACTIVITY', riskLevel: 'MEDIUM',
    requiredActions: ['تثبيت السطح غير النشط بمواد تثبيت أو أغطية واقية'],
    source: RIYADH_ANNEX_A, effectiveFrom: '2026-01-01',
  }),
  'IDLE-COVER-002': meta({
    ruleId: 'IDLE-COVER-002', ruleType: 'ACTIVITY_SPECIFIC', indicatorType: 'CONTROL_STATE', activityTypes: ['IDLE_SURFACE'],
    conditionPredicate: 'controls.idleSurfaceCoverIntact === false',
    decisionCategory: 'RESTRICT_ACTIVITY', riskLevel: 'MEDIUM',
    requiredActions: ['إصلاح أو استبدال غطاء السطح غير النشط التالف'],
    source: RIYADH_ANNEX_A, effectiveFrom: '2026-01-01',
  }),
  'IDLE-COVER-WIND-003': meta({
    ruleId: 'IDLE-COVER-WIND-003', ruleType: 'ACTIVITY_SPECIFIC', indicatorType: 'WIND', activityTypes: ['IDLE_SURFACE'],
    conditionPredicate: 'windSpeedKmh > 20 && controls.idleSurfaceCoverIntact IN (false, null)',
    decisionCategory: 'FIELD_VERIFICATION_REQUIRED', riskLevel: 'MEDIUM',
    requiredActions: ['النزول للموقع وفحص أغطية الأسطح غير النشطة الآن', 'إصلاح أي غطاء تضرر من الرياح'],
    source: RIYADH_ANNEX_A, effectiveFrom: '2026-01-01',
  }),

  // ------------------------ General decision layer (after activity rules) ------------------------
  'GATE-WIND-ABOVE-25-RESUME-HOLD': meta({
    ruleId: 'GATE-WIND-ABOVE-25-RESUME-HOLD', ruleType: 'DECISION_LAYER', indicatorType: 'WIND', activityTypes: [],
    conditionPredicate: 'previousDecidingRuleCode === GATE-WIND-ABOVE-25-004 && windBand !== ABOVE_25 && windSpeedKmh >= WIND_GATE_STOP_KMH',
    decisionCategory: 'STOP_AFFECTED_ACTIVITY', riskLevel: 'HIGH',
    requiredActions: ['انتظار انخفاض سرعة الرياح إلى ما دون 25 كم/س صراحة قبل الاستئناف'],
    restartConditions: 'انخفاض سرعة الرياح دون 25 كم/س صراحة (لا مجرد العودة إلى 25 بالضبط)',
    source: RIYADH_ANNEX_A, effectiveFrom: '2026-01-01',
    overridePolicyOverride: 'NO_OVERRIDE',
  }),
  'RESUME-STABILITY-HOLD': meta({
    ruleId: 'RESUME-STABILITY-HOLD', ruleType: 'DECISION_LAYER', indicatorType: 'NONE', activityTypes: [],
    conditionPredicate: 'previousWasStopped && minutesSinceGoodReadingBegan < 10',
    decisionCategory: 'STOP_AFFECTED_ACTIVITY', riskLevel: 'MEDIUM',
    requiredActions: ['إبقاء النشاط موقوفاً حتى تستقر القراءة الجيدة لمدة 10 دقائق متواصلة'],
    restartConditions: 'استقرار القراءة الجيدة 10 دقائق متواصلة',
    source: 'قرار هندسي داخلي (منع استئناف تلقائي فوري)', effectiveFrom: '2026-01-01',
  }),
  'PREVIOUS-DECISION-QUERY-FAILED-HOLD': meta({
    ruleId: 'PREVIOUS-DECISION-QUERY-FAILED-HOLD', ruleType: 'DECISION_LAYER', indicatorType: 'NONE', activityTypes: [],
    conditionPredicate: 'previousDecisionQueryFailed === true && decisionCategory < STOP_AFFECTED_ACTIVITY',
    decisionCategory: 'STOP_AFFECTED_ACTIVITY', riskLevel: 'MEDIUM',
    requiredActions: ['إعادة المحاولة أو التحقق من اتصال قاعدة البيانات قبل اعتماد أي قرار على هذا النشاط'],
    restartConditions: 'نجاح استعلام القرار السابق وإثبات عدم وجود إيقاف فعّال',
    source: 'قرار هندسي داخلي (فشل آمن عند تعذّر قراءة الحالة السابقة)', effectiveFrom: '2026-01-01',
  }),
  'VISIBILITY-DATA-MISSING-RESUME-HOLD': meta({
    ruleId: 'VISIBILITY-DATA-MISSING-RESUME-HOLD', ruleType: 'DECISION_LAYER', indicatorType: 'VISIBILITY', activityTypes: [],
    conditionPredicate: 'previousWasStopped && visibilityDataMissing === true',
    decisionCategory: 'STOP_AFFECTED_ACTIVITY', riskLevel: 'MEDIUM',
    requiredActions: ['التأكد من توفر بيانات رؤية حية قبل السماح بالاستئناف'],
    restartConditions: 'توفر بيانات رؤية حية تثبت زوال سبب الإيقاف',
    source: 'قرار هندسي داخلي (فشل آمن عند نقص بيانات الرؤية وقت الاستئناف)', effectiveFrom: '2026-01-01',
  }),
  'WIND-DATA-MISSING-RESUME-HOLD': meta({
    ruleId: 'WIND-DATA-MISSING-RESUME-HOLD', ruleType: 'DECISION_LAYER', indicatorType: 'WIND', activityTypes: [],
    conditionPredicate: 'previousWasStopped && windDataMissing === true',
    decisionCategory: 'STOP_AFFECTED_ACTIVITY', riskLevel: 'MEDIUM',
    requiredActions: ['التأكد من توفر بيانات رياح حية قبل السماح بالاستئناف'],
    restartConditions: 'توفر بيانات رياح حية تثبت زوال سبب الإيقاف',
    source: 'قرار هندسي داخلي (فشل آمن عند نقص بيانات الرياح وقت الاستئناف)', effectiveFrom: '2026-01-01',
  }),
  'PM10-DATA-MISSING-RESUME-HOLD': meta({
    ruleId: 'PM10-DATA-MISSING-RESUME-HOLD', ruleType: 'DECISION_LAYER', indicatorType: 'PM10', activityTypes: [],
    conditionPredicate: 'previousWasStopped && pm10DataMissing === true',
    decisionCategory: 'STOP_AFFECTED_ACTIVITY', riskLevel: 'MEDIUM',
    requiredActions: ['التأكد من توفر بيانات PM10 حية قبل السماح بالاستئناف'],
    restartConditions: 'توفر بيانات PM10 حية تثبت زوال سبب الإيقاف',
    source: 'قرار هندسي داخلي (فشل آمن عند نقص بيانات PM10 وقت الاستئناف)', effectiveFrom: '2026-01-01',
  }),
  'LOW-CONFIDENCE-VERIFICATION': meta({
    ruleId: 'LOW-CONFIDENCE-VERIFICATION', ruleType: 'DECISION_LAYER', indicatorType: 'CONFIDENCE', activityTypes: [],
    conditionPredicate: 'decisionCategory === ALLOW && confidenceScore < 70',
    decisionCategory: 'FIELD_VERIFICATION_REQUIRED', riskLevel: 'LOW',
    requiredActions: ['مراجعة البيانات الناقصة/غير المؤكدة ميدانياً قبل اعتماد القرار كسماح كامل'],
    source: 'قرار هندسي داخلي (لا تخفيض قرار أشد قائم)', effectiveFrom: '2026-01-01',
  }),
};

// Attaches metadata from the registry above to each DustRuleHit after it is
// built; never mutates code/severity/messageAr/actionAr/overridable/
// regulatoryFinding. A rule missing from the registry (should not happen for
// any live rule, but fails safe for a future addition) is left without
// metadata (undefined) rather than throwing and aborting the evaluation.
export function attachRuleMetadata(hit: DustRuleHit): DustRuleHit {
  const metadata = RULE_METADATA_REGISTRY[hit.code];
  return metadata ? { ...hit, metadata } : hit;
}
