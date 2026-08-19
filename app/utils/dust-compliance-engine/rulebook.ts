// =============================================================
// Riyadh Dust Compliance Engine — Rulebook
// Classification and rule logic from the RCRC/NCEC dust-control guide for
// Riyadh construction projects, plus the "Marqab" design document (Sections 6-9).
// Each IF/THEN rule is a separate function returning DustRuleHit[] — no eval,
// no dynamic interpretation (Marqab Section 17.1).
// =============================================================

import type {
  DustActivityComplianceProfile,
  DustComplianceDecisionCategory,
  DustProjectComplianceProfile,
  DustRiskClass,
  DustRuleHit,
  DustWindBand,
  RuleRegulatoryFinding,
} from './types';
import { ACTIVE_RULE_BUNDLE } from '@/app/utils/rule-bundles/riyadh-dust';
import { getRuleParameters } from './ruleParameters';

export const RULEBOOK_VERSION = ACTIVE_RULE_BUNDLE.id;

// Arabic label for each regulatory activity (RegulatoryDustActivity) — shown on
// the compliance card instead of the underlying physical DVI activity_type,
// since the user cares about the specific regulatory activity that stop/restrict
// decisions are built on, not the general physical classification.
export const REGULATORY_ACTIVITY_LABEL_AR: Record<string, string> = {
  EARTHWORKS: 'أعمال الحفر والترابية',
  SITE_TRAFFIC: 'حركة الشاحنات والطرق الداخلية',
  ENTRY_EXIT: 'نقاط الدخول والخروج',
  MATERIAL_HANDLING_STOCKPILE: 'مناولة وتخزين المواد والأكوام',
  DEMOLITION: 'الهدم والترميم',
  CRUSHER: 'الكسارة',
  BATCHING_PLANT: 'محطة خلط الخرسانة',
  STONE_CUTTING: 'قطع الأحجار والصخور',
  CD_WASTE_TRANSPORT: 'نقل مخلفات الهدم والبناء',
  IDLE_SURFACE: 'الأسطح المكشوفة غير النشطة',
  OTHER: 'نشاط غبار عام',
};

// Crusher-to-sensitive-receptor distance: the regulatory guide cites 200m in
// one place (Section 3.5, material storage) and 500m in another (Section 3.8,
// crusher zones specifically). We apply the more conservative 500m for the
// crusher specifically until an official clarification is issued — see Marqab
// Section 9.5. These thresholds are read live from getRuleParameters()
// (ruleParameters.ts) — the currently published value (or the default matching
// the prior hardcoded constant if nothing has been published yet) — via small
// getter functions instead of inlining getRuleParameters().X everywhere; names
// and meaning are unchanged elsewhere in the file, only the read source moved
// from a static literal to a publishable live value.
const CRUSHER_SENSITIVE_RECEPTOR_DISTANCE_M = () => getRuleParameters().CRUSHER_SENSITIVE_RECEPTOR_DISTANCE_M;
const CRUSHER_GENERAL_RECEPTOR_DISTANCE_M = () => getRuleParameters().CRUSHER_GENERAL_RECEPTOR_DISTANCE_M;
// Category I (low risk) area threshold — used only in classifyProject to
// classify the project category by area (Section 6). Unrelated to crusher
// operating eligibility, which is determined solely by the final riskClass in
// crusherRules (CRUSHER-CATEGORY-001), which permits Category III regardless of
// why the project reached it (large area, truck traffic, or an explicit crusher
// declaration). Deliberately excluded from the rule-parameter publishing system —
// this determines the project's overall regulatory category, not a single rule
// threshold, so it stays a hardcoded constant.
const CATEGORY_I_MAX_AREA_M2 = 2000;
const STOCKPILE_SENSITIVE_RECEPTOR_DISTANCE_M = () => getRuleParameters().STOCKPILE_SENSITIVE_RECEPTOR_DISTANCE_M;
const DEMOLITION_MAX_AREA_M2 = () => getRuleParameters().DEMOLITION_MAX_AREA_M2;
const IDLE_SURFACE_MAX_DAYS = () => getRuleParameters().IDLE_SURFACE_MAX_DAYS;
// UNPAVED_SPEED_LIMIT_KMH/PAVED_SPEED_LIMIT_KMH/SPILL_CLEANUP_LIMIT_MIN
// (SITE_TRAFFIC), DROP_HEIGHT_NORMAL_LIMIT_M/DROP_HEIGHT_HIGH_WIND_LIMIT_M
// (EARTHWORKS/MATERIAL_HANDLING_STOCKPILE), and DEBRIS_PILE_MAX_HEIGHT_M
// (CD_WASTE_TRANSPORT) were removed along with the only rules that used them —
// see the siteTrafficRules/earthworksRules/stockpileRules/cdWasteTransportRules comments.
const IMMERSION_ZONE_MIN_LENGTH_M = () => getRuleParameters().IMMERSION_ZONE_MIN_LENGTH_M;
const WHEEL_WASH_CYCLE_MIN_SEC = () => getRuleParameters().WHEEL_WASH_CYCLE_MIN_SEC;
const STONE_CUTTING_WIND_STOP_KMH = () => getRuleParameters().STONE_CUTTING_WIND_STOP_KMH;
// A6 — minimum PM10 filter efficiency for sealed silos and enclosed batching
// plants (Section 4-b; the annex regulatory extraction, Section 6 — the
// threshold used to stay operational during the >25 km/h wind stop).
// Exported (not local-only) because engine.ts also needs it to tie the enclosed
// batching exemption to the >25 km/h wind stop gate (GATE-WIND-ABOVE-25-004),
// not just to the local BATCHING-FILTER-002 rule here.
export const BATCHING_PM10_FILTER_MIN_PERCENT = () => getRuleParameters().BATCHING_PM10_FILTER_MIN_PERCENT;
// A4 — wind speed above which idle-surface cover must be inspected and
// repaired immediately (distinct from the general 15/25 km/h thresholds — specific to cover condition).
const IDLE_SURFACE_COVER_INSPECTION_WIND_KMH = () => getRuleParameters().IDLE_SURFACE_COVER_INSPECTION_WIND_KMH;

// PM10 thresholds — 3 levels only (unified from 4 previous branches): Marqab's
// operational range is separate from the official regulatory judgment
// (warningThresholdInclusive/violationThresholdExclusive below). Don't edit
// these values directly here — any change requires a new rule bundle in app/utils/rule-bundles.
//   <=249   -> allowed (ALLOW) — no PM10-specific trigger
//   250-340 -> unified warning + enhanced controls (ALLOW_WITH_CONTROLS), with
//              the 30-minute sustain rule (RCRC-PM10-30M-SUSPENSION-012) below
//   > 340   -> pending/confirmed (STOP_AFFECTED_ACTIVITY/MANDATORY_STOP), with
//              the 2-minute sustain rule (>120s)
// Exported (not local-only) — also used in buildPlanningForecastResult
// (engine.ts) to determine "is the forecast suitable for the activity?" based
// on the regulatory judgment, not physical DVI alone (see the isFavorable
// comment there for the full rationale).
export const PM10_WARNING_UG_M3 = ACTIVE_RULE_BUNDLE.pm10.regulatory.warningThresholdInclusive;
// Exported (not local-only) — also used in alert-outbox-worker/route.ts to
// build the viewer-facing violation text ("تم تجاوز الحد 340...") without a
// hardcoded duplicate of the threshold.
export const PM10_VIOLATION_STOP_UG_M3 = ACTIVE_RULE_BUNDLE.pm10.regulatory.violationThresholdExclusive;

// -----------------------------------------------------------------------
// Project risk category classification (Marqab Section 6, Table 1 of the regulatory guide)
// -----------------------------------------------------------------------
export function classifyProject(profile: DustProjectComplianceProfile): {
  riskClass: DustRiskClass;
  reasonAr: string;
} {
  const { siteAreaM2, dailyTruckMovements, hasOnsiteCrusher, hasOnsiteBatchingPlant } = profile;

  if (
    siteAreaM2 !== null && siteAreaM2 !== undefined && siteAreaM2 > 5000
  ) {
    return { riskClass: 'CATEGORY_III_HIGH', reasonAr: 'مساحة الموقع تتجاوز 5,000 م²' };
  }
  if (
    dailyTruckMovements !== null && dailyTruckMovements !== undefined && dailyTruckMovements > 50
  ) {
    return { riskClass: 'CATEGORY_III_HIGH', reasonAr: 'حركة الشاحنات اليومية تتجاوز 50 رحلة' };
  }
  if (hasOnsiteCrusher === true) {
    return { riskClass: 'CATEGORY_III_HIGH', reasonAr: 'يوجد كسارة داخل الموقع' };
  }
  if (hasOnsiteBatchingPlant === true) {
    return { riskClass: 'CATEGORY_III_HIGH', reasonAr: 'يوجد محطة خلط خرساني داخل الموقع' };
  }

  // Guard against a false-low classification: Category III can never be ruled
  // out when any high-risk trigger is unknown — missing data is not equivalent to low risk.
  if (
    siteAreaM2 === null || siteAreaM2 === undefined ||
    dailyTruckMovements === null || dailyTruckMovements === undefined ||
    hasOnsiteCrusher === null || hasOnsiteCrusher === undefined ||
    hasOnsiteBatchingPlant === null || hasOnsiteBatchingPlant === undefined
  ) {
    return { riskClass: 'UNCLASSIFIED', reasonAr: 'بيانات تصنيف المشروع غير مكتملة — يتعذر استبعاد الفئة الثالثة' };
  }

  if (siteAreaM2 >= CATEGORY_I_MAX_AREA_M2) {
    return { riskClass: 'CATEGORY_II_MEDIUM', reasonAr: 'مساحة الموقع بين 2,000 و5,000 م²' };
  }
  return { riskClass: 'CATEGORY_I_LOW', reasonAr: 'مساحة الموقع أقل من 2,000 م² ولا يوجد محفز خطر عالٍ آخر' };
}

// -----------------------------------------------------------------------
// Wind band classification (Annex A protocol)
// -----------------------------------------------------------------------
export function classifyWind(windSpeedKmh: number | null): DustWindBand {
  if (windSpeedKmh === null || windSpeedKmh === undefined) return 'UNKNOWN';
  const { WIND_GATE_ENHANCED_MIN_KMH, WIND_GATE_STOP_KMH } = getRuleParameters();
  if (windSpeedKmh < WIND_GATE_ENHANCED_MIN_KMH) return 'BELOW_15';
  if (windSpeedKmh <= WIND_GATE_STOP_KMH) return 'FROM_15_TO_25';
  return 'ABOVE_25';
}

// Per-hour regulatory wind gate (same threshold as GATE-WIND-ABOVE-25-004 in
// engine.ts) — used to tag the hourly forecast grid (workDayHourly) without
// running the full compliance engine per hour; just the same gate condition:
// exposed dust-generating activity + >25 km/h wind for that specific hour.
export function isRegulatoryWindGateActive(
  windSpeedKmh: number | null,
  isDustGenerating: boolean,
  isEnclosedOperation: boolean
): boolean {
  return classifyWind(windSpeedKmh) === 'ABOVE_25' && isDustGenerating && !isEnclosedOperation;
}

// -----------------------------------------------------------------------
// Decision priority order (Marqab Section 8) — highest always wins
// -----------------------------------------------------------------------
export const DECISION_PRIORITY: Record<DustComplianceDecisionCategory, number> = {
  ALLOW: 0,
  PRECAUTION: 1,
  ALLOW_WITH_CONTROLS: 2,
  FIELD_VERIFICATION_REQUIRED: 3,
  RESTRICT_ACTIVITY: 4,
  STOP_AFFECTED_ACTIVITY: 5,
  MANDATORY_STOP: 6,
};

function severityToDecision(severity: DustRuleHit['severity']): DustComplianceDecisionCategory {
  return severity;
}

export function decisionFromRules(
  ruleHits: DustRuleHit[],
  missingCriticalInputs: string[]
): DustComplianceDecisionCategory {
  let decision: DustComplianceDecisionCategory = 'ALLOW';

  for (const rule of ruleHits) {
    const candidate = severityToDecision(rule.severity);
    if (DECISION_PRIORITY[candidate] > DECISION_PRIORITY[decision]) {
      decision = candidate;
    }
  }

  // Missing critical data only blocks a green decision — it never downgrades an
  // already-worse decision.
  if (
    missingCriticalInputs.length > 0 &&
    DECISION_PRIORITY.FIELD_VERIFICATION_REQUIRED > DECISION_PRIORITY[decision]
  ) {
    decision = 'FIELD_VERIFICATION_REQUIRED';
  }

  return decision;
}

// -----------------------------------------------------------------------
// Regulatory activity rules (Marqab Section 9)
// -----------------------------------------------------------------------

// actionAr is fully independent of messageAr (see the DustRuleHit comment in
// types.ts) — a corrective action directed at the user, not a restatement of the violation.
//
// overridable is optional — defaults to the old general rule (severity below
// MANDATORY_STOP/STOP_AFFECTED_ACTIVITY = overridable) for any rule that
// doesn't set it explicitly, so dozens of existing ruleHit() calls don't need
// updating. Pass it explicitly only when a rule's overridability differs from
// the general severity default (see overridable in types.ts for the full rationale).
//
// Exported (not local-only) because engine.ts also builds it for the three
// decision layers (wind-gate resume/resume stability/low confidence) after
// converting them from directly mutating decisionCategory to a real
// DustRuleHit — see the rule/decision separation comment in engine.ts.
//
// regulatoryFinding is optional (see RuleRegulatoryFinding in types.ts) —
// defaults to 'NONE' for FIELD_VERIFICATION_REQUIRED/PRECAUTION (missing data
// or a precaution, not a violation in itself), and 'VIOLATION' for any higher
// severity (RESTRICT_ACTIVITY and up, including ALLOW_WITH_CONTROLS rules that
// carry an actually documented violation like PM10-VIOLATION-STOP-006) — this
// matches the vast majority of actual rules (an explicit numeric/legal
// threshold exceeded). Exceptional rules (a purely operational state with no
// threshold exceeded, or pending confirmation) pass the value explicitly at
// the ruleHit() call site — no need to touch every call, only the exceptions.
export function ruleHit(
  code: string,
  severity: DustRuleHit['severity'],
  messageAr: string,
  actionAr: string,
  overridable: boolean = severity !== 'MANDATORY_STOP' && severity !== 'STOP_AFFECTED_ACTIVITY',
  // Required, no inferred default (deliberately removed — a P0 bug slipped
  // through exactly because a rule silently fell back to this argument's old
  // default: STONECUT-WIND-ENHANCED-004 omitted it and inherited 'VIOLATION'
  // for what was actually a non-violating advisory, wrongly flipping
  // regulatoryFinding to NON_COMPLIANT downstream). severity alone cannot
  // answer "did a regulatory violation occur?" — the same severity
  // (ALLOW_WITH_CONTROLS) means "operational state, no violation" for one
  // rule (wind 15-25 km/h) and "confirmed violation, no immediate stop" for
  // another (PM10 confirmed >340 for 2+ minutes) — every call site must state
  // its own regulatoryFinding explicitly, never inherit one from severity.
  regulatoryFinding: RuleRegulatoryFinding
): DustRuleHit {
  return { code, severity, messageAr, actionAr, overridable, regulatoryFinding };
}

// General gate over all exposed, dust-generating activities — the annex
// regulatory extraction, Section 5: 15-25 km/h wind requires enhanced
// suppression (hourly spraying, covering piles, reducing drop height to one
// meter, stricter road cleaning and wheel washing), without a full stop —
// unlike GATE-WIND-ABOVE-25-004 (same exposed/dust-generating scope but above
// 25 km/h, an actual stop). Its low priority (ALLOW_WITH_CONTROLS) means it
// never overrides a more severe activity rule already active at the same wind
// band (e.g. the strict demolition stop DEMO-WIND-STOP-001 at the same band remains higher priority).
export function enhancedSuppressionRule(
  isDustGenerating: boolean,
  isEnclosedOperation: boolean,
  windBand: DustWindBand
): DustRuleHit[] {
  if (windBand !== 'FROM_15_TO_25' || !isDustGenerating || isEnclosedOperation) return [];
  return [
    ruleHit(
      'GATE-WIND-15-25-ENHANCED-005',
      'ALLOW_WITH_CONTROLS',
      'تثبيط معزز مطلوب: سرعة الرياح بين 15-25 كم/س',
      'فعّل الرش الساعي، غطِّ الأكوام، اخفض ارتفاع التفريغ إلى متر واحد، وشدّد تنظيف الطرق وغسيل الإطارات',
      undefined,
      // A purely operational state (e.g. "20 km/h -> ALLOW_WITH_CONTROLS is an
      // operational state requiring enhanced controls, not necessarily a
      // violation") — no documented numeric/legal threshold exceeded by itself,
      // just an intermediate operational band.
      'NONE'
    ),
  ];
}

// A transient strong gust — an additional safety precaution of our own, not a
// clause from the "Annex A protocol" (the regulatory text only cites "wind
// speed" at the 15/25 km/h thresholds, with no mention of gusts). Reads raw
// windGustKmh directly (not effectiveWindKmh, and never affects
// windBand/classifyWind) — entirely separate from the two regulatory wind
// gates above (GATE-WIND-ABOVE-25-004/GATE-WIND-15-25-ENHANCED-005), with its
// own code (GATE-WIND-GUST-SAFETY) and a lighter severity (advisory/
// suppression, not a hard mandatory stop) so the UI doesn't read it as an
// Annex A violation. The threshold (50 km/h) is deliberately far above the
// Annex A limit (25) — a transient gust of, say, 30 doesn't warrant any action
// beyond what the sustained wind speed itself already requires; only gusts
// genuinely severe (near the physical DVI-WIND-LOOSE-MATERIAL-005 threshold in
// dust-engine/engine.ts) warrant a separate alert.
const WIND_GUST_SAFETY_THRESHOLD_KMH = () => getRuleParameters().WIND_GUST_SAFETY_THRESHOLD_KMH;

export function windGustSafetyRule(
  isDustGenerating: boolean,
  isEnclosedOperation: boolean,
  windGustKmh: number | null
): DustRuleHit[] {
  const windGustSafetyThresholdKmh = WIND_GUST_SAFETY_THRESHOLD_KMH();
  if (
    windGustKmh === null ||
    windGustKmh === undefined ||
    windGustKmh < windGustSafetyThresholdKmh ||
    !isDustGenerating ||
    isEnclosedOperation
  ) {
    return [];
  }
  return [
    ruleHit(
      'GATE-WIND-GUST-SAFETY',
      'ALLOW_WITH_CONTROLS',
      `هبة رياح قوية عابرة رُصدت (${windGustKmh} كم/س) — احتراز سلامة إضافي، ليست مخالفة بموجب بروتوكول الملحق أ`,
      'أمّن المواد السائبة والمعدات الخفيفة فوراً حتى تهدأ الهبة، وراقب استقرار سرعة الرياح المستدامة',
      undefined,
      // An additional safety precaution of our own (see the full function
      // comment above) — the message itself explicitly states "not a violation under the Annex A protocol".
      'NONE'
    ),
  ];
}

// Minimum sustain duration (in minutes) before a >=340 reading is classified as
// a "confirmed regulatory violation" (RCRC-PM10-340-VIOLATION-011) rather than
// merely "pending" (MRQ-PM10-BLACK-PENDING-104) — the regulatory text says
// "for more than two minutes". The actual threshold
// (PM10_VIOLATION_CONFIRM_MINUTES) no longer lives here — it moved along with
// the full computation to computeSustainedPm10Status in
// app/lib/dustEvaluation.ts, now the sole source for the "confirmed" decision
// (see pm10ConfirmedViolation340 in DustComplianceContext and the
// pm10ThresholdRule comment below). No duplicate constant here, so this file
// doesn't look like an actual decision source when it isn't.

// Minimum sustain duration to trigger a full activity suspension at >340
// (RCRC-PM10-30M-SUSPENSION-012) — see the pm10ThresholdRule comment below for
// the full regulatory decision detail (round two: the stop requires the
// exceedance to sustain above 340 itself specifically, not the [250,340]
// warning range). Still used here only to render the minute count in the
// message text — the "suspended 30 minutes" decision itself is read ready-made
// from pm10Suspended250For30Min, not derived from this constant.
//
// This used to be an independently hand-written number, disconnected from
// ACTIVE_RULE_BUNDLE.pm10.regulatory.activityStopDurationMsInclusive — the
// actual value (30 minutes) hasn't changed, it's now just read from the active bundle.
const PM10_SUSPENSION_MINUTES = ACTIVE_RULE_BUNDLE.pm10.regulatory.activityStopDurationMsInclusive / 60_000;

// General regulatory PM10 thresholds — the annex regulatory extraction,
// Section 6. Entirely separate from the physical DVI gates
// (DVI-PM10-ACTION-003 and DVI-DUST-ACTIVITY-STOP-004 in dust-engine/engine.ts)
// — these are official regulatory thresholds straight from the document, not physical estimates.
//
// This function used to receive the two minute counts
// (sustainedMinutesAbove340/250) and re-derive "confirmed"/"suspended 30
// minutes" itself from a simple local comparison — losing all of
// computeSustainedPm10Status's real checks (is the series actually
// device-sourced? is the last reading fresh or is the device stalled?), and
// potentially comparing a minute count computed from a series with a different
// source than pm10UgM3 itself (project-level device readings are merged into
// any activity — see fetchPm10SustainedStatus). Fix: the decision is now
// computed exactly once in computeSustainedPm10Status (where all the evidence
// is available together) and passed here ready-made as
// confirmedViolation340/suspended250For30Min — never re-derived from raw numbers here.
export function pm10ThresholdRule(
  pm10UgM3: number | null,
  // The two ready-made states from computeSustainedPm10Status (via
  // DustComplianceContext.pm10ConfirmedViolation340/pm10Suspended250For30Min)
  // — undefined means "no sustain data available", treated as false (fail-safe:
  // the decision stays pending, never confirmed without evidence).
  //
  // This signature previously accepted an isPm10ExemptEnclosedBatching
  // parameter that exempted a batching plant (sealed silos + filter >=99%)
  // from all PM10 rules — inconsistent with the regulatory reference. The
  // exemption remains scoped only to the wind gate
  // (isEnclosedExemptFromHighWind in engine.ts).
  confirmedViolation340?: boolean,
  suspended250For30Min?: boolean
): DustRuleHit[] {
  if (pm10UgM3 === null || pm10UgM3 === undefined) return [];

  const hits: DustRuleHit[] = [];

  // Escalation to >340 for more than two minutes no longer triggers an
  // immediate mandatory stop; confirming a 340 violation is now
  // documentation/alerting only (PM10-VIOLATION-STOP-006,
  // ALLOW_WITH_CONTROLS), the same control level as the [250,340] range. The
  // only actual activity stop is RCRC-PM10-30M-SUSPENSION-012 below, which
  // itself now requires the exceedance to stay above 340 for 30 minutes, not
  // a unified sustain from 250 (see computeSustainedPm10Status in
  // dustEvaluation.ts for full detail). Uses `>` explicitly, not `>=`, at the
  // violation threshold (340 exactly stays in the warning range below, not a
  // "violation", until actually exceeded). Confirming the violation itself
  // (the two minutes) uses `>=` instead of `>` (completing exactly two
  // minutes is sufficient) — see isConfirmedViolation340 in dustEvaluation.ts.
  if (pm10UgM3 > PM10_VIOLATION_STOP_UG_M3) {
    const isConfirmed = confirmedViolation340 === true;
    if (isConfirmed) {
      hits.push(
        ruleHit(
          'PM10-VIOLATION-STOP-006',
          'ALLOW_WITH_CONTROLS',
          `مخالفة تنظيمية مؤكدة ومسجَّلة: تركيز PM10 تجاوز حد المخالفة (${PM10_VIOLATION_STOP_UG_M3} ميكروجرام/م³) لدقيقتين متتاليتين فأكثر — النشاط مستمر تحت الضوابط المعزَّزة، الإيقاف الفعلي مرتبط فقط باستمرار التجاوز فوق ${PM10_VIOLATION_STOP_UG_M3} ميكروجرام/م³ لمدة ${PM10_SUSPENSION_MINUTES} دقيقة متواصلة`,
          'استمر بتطبيق التثبيط المعزز فوراً (رش ساعي أو مثبطات، تغطية الأكوام، خفض ارتفاع التفريغ، تقييد حركة النقل) — هذه مخالفة موثَّقة رسمياً، لا إيقاف إلزامي بحد ذاته',
          undefined,
          // Confirmed violation (2+ minutes sustained above 340) — documented
          // and alerted, not an operational stop by itself (see message).
          'VIOLATION'
        )
      );
    } else {
      // A reading not yet confirmed (under two minutes sustained) stays
      // ALLOW_WITH_CONTROLS (same level as PM10-WARNING-008), not
      // STOP_AFFECTED_ACTIVITY — the latter would make decideFinal escalate
      // to PROTECTIVE_STOP (via pendingAffectedStop in
      // final-decision-engine/engine.ts) and show a red "temporarily
      // suspended" state with a score cap, i.e. an actual restriction before
      // the two minutes even complete. No stop or restriction for PM10 is
      // warranted before 30 minutes above 340 is confirmed. The reading
      // stays "pending" (pendingConfirmation=true via isPendingRuleHit in
      // engine.ts) but with enhanced controls and monitoring only, no operational restriction.
      hits.push(
        ruleHit(
          'MRQ-PM10-BLACK-PENDING-104',
          'ALLOW_WITH_CONTROLS',
          `تنبيه: تركيز PM10 تجاوز حد المخالفة (${PM10_VIOLATION_STOP_UG_M3} ميكروجرام/م³) — بانتظار اكتمال دقيقتين استمرار لتصنيفها مخالفة تنظيمية مؤكدة`,
          'فعّل التثبيط المعزز فوراً (رش ساعي أو مثبطات، تغطية الأكوام، خفض ارتفاع التفريغ) وراقب استمرار القراءة عن كثب — ستُصبح مخالفة تنظيمية مؤكدة وموثَّقة (بلا إيقاف إلزامي فوري) إن استمر التجاوز دقيقتين فأكثر',
          undefined,
          // Exceedance observed but confirmation evidence (two-minute
          // sustain) not yet complete — PENDING, not VIOLATION, regardless of
          // the fact that the final regulatoryFinding
          // (final-decision-engine) may display it under
          // PENDING_CONFIRMATION via the separate pendingConfirmation flag.
          'PENDING'
        )
      );
    }
  } else if (pm10UgM3 >= PM10_WARNING_UG_M3) {
    // Unified warning/enhanced-control range [250,340] — merges the former
    // separate "caution" and "severe restriction" ranges into a single level
    // (no internal grading), matching the regulatory document's literal text
    // (3 tiers, not 4). The branch above (> PM10_VIOLATION_STOP_UG_M3 = 340)
    // handles everything past the violation threshold in complete isolation
    // — this else branch stops automatically at that point.
    hits.push(
      ruleHit(
        'PM10-WARNING-008',
        'ALLOW_WITH_CONTROLS',
        `تحذير: تركيز PM10 بلغ أو تجاوز حد التحذير (${PM10_WARNING_UG_M3} ميكروجرام/م³)`,
        'فعّل التثبيط المعزز فوراً: رش ساعي أو مثبطات، تغطية الأكوام وخفض ارتفاع التفريغ إلى متر واحد، تقليل واجهات العمل المتزامنة، وتقييد حركة النقل',
        undefined,
        // The [250,340] warning range is an operational state requiring
        // enhanced control; it has not yet exceeded the violation threshold
        // (340) — not itself a regulatory violation.
        'NONE'
      )
    );
  }

  // RCRC-PM10-30M-SUSPENSION-012: the actual stop requires the exceedance to
  // stay above 340 itself (pm10UgM3 > PM10_VIOLATION_STOP_UG_M3, not >=
  // PM10_WARNING_UG_M3) for 30 minutes, consistent with suspended250For30Min
  // now measuring (via computeSustainedPm10Status) the sustain duration above
  // 340 specifically, not a unified sustain from 250. Independent of the
  // PM10-VIOLATION-STOP-006/MRQ-PM10-BLACK-PENDING-104 condition above (both
  // may fire together; decisionFromRules picks the stricter one). The
  // decision is ready-made from computeSustainedPm10Status, not re-derived here.
  if (pm10UgM3 > PM10_VIOLATION_STOP_UG_M3 && suspended250For30Min === true) {
    hits.push(
      ruleHit(
        'RCRC-PM10-30M-SUSPENSION-012',
        'STOP_AFFECTED_ACTIVITY',
        `تعليق النشاط: تركيز PM10 استمر فوق ${PM10_VIOLATION_STOP_UG_M3} ميكروجرام/م³ لمدة ${PM10_SUSPENSION_MINUTES} دقيقة متواصلة`,
        'علّق النشاط المسبب للغبار حتى ينخفض التركيز ويستقر دون الحد لفترة كافية، وفعّل التثبيط المعزز فوراً',
        undefined,
        // Confirmed sustained violation (>340 for 30 continuous minutes) —
        // the actual operational stop.
        'VIOLATION'
      )
    );
  }

  return hits;
}

// A1 — site prep and earthworks (excavation, grading, backfill, trenching,
// compaction). Section 4-2: soil spraying during excavation/loading/dumping
// is mandatory, and soil drop height follows the same A5 limits (1.5m
// normal, 1m at wind >=15 km/h) — both are advisory-only text now, with no effect on the decision.
//
// dropHeightM (EARTHWORKS-DROP-002/003) was previously excluded from the
// general governance decision as "a numeric measurement, not a disclosure" —
// but it has no input field in DustStep.tsx at all (same gap as
// SITE_TRAFFIC), so the exception was removed and treatment unified with the rest of this activity's controls.
function earthworksRules(
  _activity: DustActivityComplianceProfile,
  _windBand: DustWindBand
): DustRuleHit[] {
  return [];
}

// 9.4 Demolition — only the wind gate (DEMO-WIND-STOP-001) and area limit
// (DEMO-AREA-002) are active rules: they depend on isEnclosedOperation (a
// real structural question, see its comment in DustStep.tsx) and
// demolitionActiveAreaM2 (a numeric measurement), the only two fields that
// remain real inputs for this activity. The remaining controls
// (spraying/screens/water-cannon range/crusher covering/cutting
// method/sand-blast pressure) are shown as general advisory text only, with
// no effect on the decision — see the earthworksRules comment above for full context.
function demolitionRules(
  activity: DustActivityComplianceProfile,
  windBand: DustWindBand
): DustRuleHit[] {
  const hits: DustRuleHit[] = [];
  const isExposed = !activity.isEnclosedOperation;

  if (isExposed && (windBand === 'FROM_15_TO_25' || windBand === 'ABOVE_25')) {
    const windGateEnhancedMinKmh = getRuleParameters().WIND_GATE_ENHANCED_MIN_KMH;
    hits.push(
      ruleHit(
        'DEMO-WIND-STOP-001',
        'MANDATORY_STOP',
        `إيقاف إلزامي: أعمال هدم مكشوفة أثناء رياح ≥${windGateEnhancedMinKmh} كم/س (الحد الأقصى التنظيمي ${windGateEnhancedMinKmh} كم/س لأعمال الهدم)`,
        `أوقف أعمال الهدم المكشوفة فوراً حتى تنخفض سرعة الرياح إلى ما دون ${windGateEnhancedMinKmh} كم/س، أو حوّلها لعملية مغلقة`,
        undefined,
        'VIOLATION'
      )
    );
  }

  const activeArea = activity.measurements.demolitionActiveAreaM2;
  const demolitionMaxAreaM2 = DEMOLITION_MAX_AREA_M2();
  if (activeArea !== null && activeArea !== undefined && activeArea > demolitionMaxAreaM2) {
    hits.push(
      ruleHit(
        'DEMO-AREA-002',
        'STOP_AFFECTED_ACTIVITY',
        `مساحة الهدم النشطة (${activeArea} م²) تتجاوز الحد المسموح (${demolitionMaxAreaM2} م² في المرة الواحدة)`,
        `قسّم أعمال الهدم إلى مراحل بحيث لا تتجاوز المساحة النشطة ${demolitionMaxAreaM2} م² في المرة الواحدة`,
        undefined,
        'VIOLATION'
      )
    );
  }

  return hits;
}

// 9.5 Crusher
function crusherRules(
  project: DustProjectComplianceProfile,
  riskClass: DustRiskClass,
  activity: DustActivityComplianceProfile
): DustRuleHit[] {
  const hits: DustRuleHit[] = [];

  if (riskClass !== 'CATEGORY_III_HIGH') {
    hits.push(
      ruleHit(
        'CRUSHER-CATEGORY-001',
        'MANDATORY_STOP',
        'الكسارات مسموحة فقط في مشاريع الفئة الثالثة (عالية المخاطر)',
        'أوقف تشغيل الكسارة — غير مسموح بها إلا في مشاريع الفئة الثالثة (عالية المخاطر)',
        undefined,
        'VIOLATION'
      )
    );
  }


  // The distance auto-computed from crusher coordinates + the
  // sensitive_receptors table (when available) takes priority over the
  // legacy manual field.
  const autoAny = activity.measurements.crusherDistanceToNearestReceptorAutoM;
  const autoResidential = activity.measurements.crusherDistanceToResidentialReceptorAutoM;
  const manualDistance = activity.measurements.crusherDistanceToReceptorM;

  // Sensitive-receptor distance no longer drives a stop/restriction: all
  // crusher receptor-distance rules (missing data, general/residential
  // distance, wind direction) used to emit
  // MANDATORY_STOP/FIELD_VERIFICATION_REQUIRED/RESTRICT_ACTIVITY based on
  // receptor data that may be incomplete (the sensitive_receptors table is
  // purely manual and excludes auto-discovered OSM receptors shown
  // advisory-only on the same screen — see
  // app/api/projects/[projectId]/route.ts). The general/residential distance
  // and wind-direction rules below are now ALLOW_WITH_CONTROLS
  // (warning/advisory only).
  //
  // CRUSHER-RECEPTORS-DATA-MISSING was removed entirely (not just
  // downgraded): even as an ALLOW_WITH_CONTROLS advisory, a "could not
  // verify... no data" message is inherently misleading because it knows
  // nothing about the auto-discovered OSM receptors shown advisory-only on
  // the same screen (computeUnitReceptors in route.ts) — absence of the
  // manual table alone does not actually mean "no data available". The other
  // rules (actual distance when computed auto/manual) remain, since they
  // reflect a genuinely known distance, not an absence of data.
  const crusherGeneralReceptorDistanceM = CRUSHER_GENERAL_RECEPTOR_DISTANCE_M();
  const crusherSensitiveReceptorDistanceM = CRUSHER_SENSITIVE_RECEPTOR_DISTANCE_M();

  const generalDistance = autoAny ?? manualDistance;
  if (generalDistance !== null && generalDistance !== undefined && generalDistance < crusherGeneralReceptorDistanceM) {
    hits.push(
      ruleHit(
        'CRUSHER-DISTANCE-200-002B',
        'ALLOW_WITH_CONTROLS',
        `تنبيه: مسافة الكسارة عن أقرب مستقبل حساس (${autoAny !== null && autoAny !== undefined ? 'محسوبة تلقائياً: ' : ''}${generalDistance} م) أقل من الحد الأدنى (${crusherGeneralReceptorDistanceM} م). تنبيه توعوي فقط، لا يوقف النشاط`,
        `يُفضَّل نقل الكسارة لمسافة لا تقل عن ${crusherGeneralReceptorDistanceM} م عن أقرب مستقبل حساس، أو زيادة إجراءات التثبيط`,
        undefined,
        // Purely advisory (the message itself states "does not stop the
        // activity") — not itself a regulatory violation.
        'NONE'
      )
    );
  }

  const residentialDistance = autoResidential ?? manualDistance;
  if (residentialDistance !== null && residentialDistance !== undefined && residentialDistance < crusherSensitiveReceptorDistanceM) {
    hits.push(
      ruleHit(
        'CRUSHER-DISTANCE-500-002C',
        'ALLOW_WITH_CONTROLS',
        `تنبيه: مسافة الكسارة عن سكني/مدارس/مستشفيات (${autoResidential !== null && autoResidential !== undefined ? 'محسوبة تلقائياً: ' : ''}${residentialDistance} م) أقل من الحد الأدنى (${crusherSensitiveReceptorDistanceM} م). تنبيه توعوي فقط، لا يوقف النشاط`,
        `يُفضَّل نقل الكسارة لمسافة لا تقل عن ${crusherSensitiveReceptorDistanceM} م عن أقرب منطقة سكنية/مدرسة/مستشفى، أو زيادة إجراءات التثبيط`,
        undefined,
        'NONE'
      )
    );
  }

  // MRQ-RECEPTOR-DOWNWIND-120: advisory when a sensitive receptor is actually
  // located in the current wind's downwind direction (not just nearby in
  // straight-line distance) — applies only when wind direction is available
  // (crusherDistanceToDownwindReceptorAutoM stays null if wind direction is
  // unavailable at all, see adapters.ts).
  const downwindDistance = activity.measurements.crusherDistanceToDownwindReceptorAutoM;
  if (
    downwindDistance !== null &&
    downwindDistance !== undefined &&
    downwindDistance < crusherSensitiveReceptorDistanceM
  ) {
    hits.push(
      ruleHit(
        'MRQ-RECEPTOR-DOWNWIND-120',
        'ALLOW_WITH_CONTROLS',
        `تنبيه: مستقبِل حساس (سكني/مدرسي/صحي) يقع فعلياً باتجاه هبوب الرياح الحالي من الكسارة (على بُعد ${downwindDistance === Infinity ? '—' : downwindDistance + ' م'}). تنبيه توعوي فقط، لا يوقف النشاط`,
        'يُفضَّل زيادة إجراءات التثبيط طالما استمر اتجاه الرياح نحو المستقبِل الحساس',
        undefined,
        'NONE'
      )
    );
  }

  // Detailed crusher controls (unit/conveyor covering, spray/fog systems, drop
  // height, suction and filtration) are shown as general advisory text only,
  // with no effect on the decision — an explicitly adopted governance decision
  // (see the earthworksRules comment above for full context). The rules that
  // remain actually active: CRUSHER-CATEGORY-001 (project classification, not
  // a user input) and the two sensitive-receptor distances above
  // (auto-computed from the crusher's map location, still a real input).

  return hits;
}

// A6 — batching plants and cement transport (Section 4-b; the A6 activity
// matrix in the annex regulatory extraction).
function batchingPlantRules(activity: DustActivityComplianceProfile): DustRuleHit[] {
  const hits: DustRuleHit[] = [];

  if (activity.controls.silosSealed === false) {
    hits.push(
      ruleHit('BATCHING-SILO-001', 'MANDATORY_STOP', 'إيقاف إلزامي: صوامع الإسمنت غير محكمة الإغلاق', 'أوقف التشغيل حتى يتم إحكام إغلاق صوامع الإسمنت بالكامل', undefined, 'VIOLATION')
    );
  }

  const filterEfficiency = activity.controls.pm10FilterEfficiencyPercent;
  const batchingPm10FilterMinPercent = BATCHING_PM10_FILTER_MIN_PERCENT();
  if (
    filterEfficiency !== null && filterEfficiency !== undefined &&
    filterEfficiency < batchingPm10FilterMinPercent
  ) {
    hits.push(
      ruleHit(
        'BATCHING-FILTER-002',
        'MANDATORY_STOP',
        `كفاءة فلتر الجسيمات العالقة (${filterEfficiency}%) أقل من الحد الأدنى (${batchingPm10FilterMinPercent}%)`,
        `استبدل أو اصلح فلتر الجسيمات العالقة حتى تصل كفاءته إلى ${batchingPm10FilterMinPercent}% على الأقل`,
        undefined,
        'VIOLATION'
      )
    );
  }

  if (activity.controls.leakDetected === true) {
    hits.push(
      ruleHit('BATCHING-LEAK-003', 'STOP_AFFECTED_ACTIVITY', 'تسرب مرصود من صومعة الإسمنت أو نظام النقل', 'أصلح مصدر التسرب في الصومعة أو نظام النقل فوراً', undefined, 'VIOLATION')
    );
  }

  if (activity.controls.dryCleaningMethodUsed === true) {
    hits.push(
      ruleHit('BATCHING-DRYCLEAN-004', 'RESTRICT_ACTIVITY', 'استخدام الكنس الجاف أو النفخ بالهواء المضغوط ممنوع؛ يلزم الشفط أو التنظيف الرطب', 'استبدل الكنس الجاف/الهواء المضغوط بالشفط أو التنظيف الرطب', undefined, 'VIOLATION')
    );
  }

  if (activity.controls.dustSuppressionSystemOperational === false) {
    hits.push(
      ruleHit('BATCHING-SUPPRESSION-005', 'STOP_AFFECTED_ACTIVITY', 'نظام تثبيط الغبار غير مُشغَّل عند محطة الخلط', 'شغّل نظام تثبيط الغبار عند محطة الخلط قبل الاستئناف', undefined, 'VIOLATION')
    );
  }

  // The regulatory reference (Section 3.5, material storage) prohibits
  // establishing batching plants or material storage within 200m of
  // schools/hospitals/mosques/residential areas — the same threshold actually
  // used for the crusher's nearest sensitive receptor
  // (CRUSHER_GENERAL_RECEPTOR_DISTANCE_M above). The auto-computed coordinates
  // and distance (batchingDistanceToNearestReceptorAutoM, via adapters.ts +
  // geo.ts) were already being collected and passed all the way to
  // DustActivityComplianceProfile, but no rule here consumed them — so a
  // batching plant meters from a school passed with no distance violation at all.
  //
  // null (not Infinity) means specifically "batching plant coordinates haven't
  // been entered on the map yet" (see nearestReceptorDistancesM in geo.ts:
  // missing lat/lng -> null; coordinates present but no nearby sensitive
  // receptor registered -> Infinity).
  const batchingDistance = activity.measurements.batchingDistanceToNearestReceptorAutoM;
  // Sensitive receptors no longer drive stop decisions (same governance
  // decision applied to the crusher rules above): BATCHING-DISTANCE-200 below
  // is now ALLOW_WITH_CONTROLS (advisory only) instead of MANDATORY_STOP.
  //
  // BATCHING-DISTANCE-MISSING and BATCHING-RECEPTORS-DATA-MISSING were removed
  // entirely — same logic as CRUSHER-RECEPTORS-DATA-MISSING above: a "could
  // not verify..." message remains confusing even as an advisory, since it
  // knows nothing about auto-discovered OSM receptors shown advisorily on the
  // same screen. There is no stop or advisory at all now for missing batching
  // plant coordinates or missing receptor data — only BATCHING-DISTANCE-200
  // stays active when an actual distance below the threshold is computed.
  if (batchingDistance !== null && batchingDistance < CRUSHER_GENERAL_RECEPTOR_DISTANCE_M()) {
    const crusherGeneralReceptorDistanceM = CRUSHER_GENERAL_RECEPTOR_DISTANCE_M();
    hits.push(
      ruleHit(
        'BATCHING-DISTANCE-200',
        'ALLOW_WITH_CONTROLS',
        `تنبيه: مسافة محطة الخلط عن أقرب مستقبل حساس (محسوبة تلقائياً: ${batchingDistance} م) أقل من الحد الأدنى (${crusherGeneralReceptorDistanceM} م). تنبيه توعوي فقط، لا يوقف النشاط`,
        `يُفضَّل نقل محطة الخلط لمسافة لا تقل عن ${crusherGeneralReceptorDistanceM} م عن أقرب مستقبِل حساس (مدرسة/مستشفى/مسجد/منطقة سكنية)، أو زيادة إجراءات التثبيط`,
        undefined,
        'NONE'
      )
    );
  }

  // The remaining batching plant controls (filter maintenance, leak
  // detection checks, dry-cleaning/compressed-air ban, waste moisture) are
  // shown as general advisory text only, with no effect on the decision —
  // see the earthworksRules comment above for full context. The five fields
  // above plus the receptor distance above remain real inputs.

  return hits;
}

// 9.6 Stone cutting — cuttingResiduesCleaned/wetCuttingActive/hepaExtractionActive
// have no UI input; they render as general advisory text only, with no
// effect on the decision (see the earthworksRules comment above for full context).
//
// wetCuttingActive/hepaExtractionActive were briefly wired into the general
// governance decision (STONECUT-DUST-CONTROL-006, an actual MANDATORY_STOP)
// on the theory that the regulatory reference states the wet-spray/HEPA
// requirement in unusually mandatory terms. That surfaced a real gap: the
// rule depended entirely on these two fields, and neither had a checkbox in
// DustStep.tsx (same gap as SITE_TRAFFIC), so every exposed stone-cutting
// activity was stopped regardless of actual conditions. A checkbox was added
// to close the gap, but the decision was then made to remove the inputs and
// treat this like the other nine activities — no exception for stone cutting.
// The two checkboxes were removed from DustStep.tsx (see GENERAL_ALERTS_AR
// there for the replacement advisory text); REGULATORY_ACTIVITY_FIELDS_DEFAULTS
// still defines both fields (for compatibility with old saved rows that may
// carry true) but nothing here reads them.
function stoneCuttingRules(
  activity: DustActivityComplianceProfile,
  windBand: DustWindBand
): DustRuleHit[] {
  const hits: DustRuleHit[] = [];

  const isExposed = !activity.isEnclosedOperation;

  // Exposed stone cutting follows the same Annex A wind sequence as other
  // activities (except demolition, which has its own documented 15 km/h
  // stop via the separate DEMO-WIND-STOP-001/WIND_GATE_ENHANCED_MIN_KMH):
  // 15-25 km/h means enhanced suppression (ALLOW_WITH_CONTROLS), only above
  // 25 km/h is an actual stop (STOP_AFFECTED_ACTIVITY) — stone cutting is
  // explicitly listed among the activities that stop above 25, not at 15.
  // STONE_CUTTING_WIND_STOP_KMH (25 by default) is the actual stop
  // threshold; WIND_GATE_ENHANCED_MIN_KMH (15) is the enhanced-suppression
  // start threshold (the same general constant used to classify windBand).
  if (isExposed && windBand === 'FROM_15_TO_25') {
    const windGateEnhancedMinKmh = getRuleParameters().WIND_GATE_ENHANCED_MIN_KMH;
    hits.push(
      ruleHit(
        'STONECUT-WIND-ENHANCED-004',
        'ALLOW_WITH_CONTROLS',
        `تنبيه: قطع أحجار مكشوف أثناء رياح ${windGateEnhancedMinKmh}-${STONE_CUTTING_WIND_STOP_KMH()} كم/س — تثبيط معزَّز مطلوب`,
        'فعّل التثبيط المعزز فوراً: رش مائي مستمر أثناء القطع، تقليل واجهات العمل المتزامنة، ومراقبة سرعة الرياح باستمرار',
        undefined,
        // Same enhanced-suppression band as the general GATE-WIND-15-25-
        // ENHANCED-005 gate (regulatoryFinding='NONE' there) — an operational
        // state requiring enhanced controls, not itself a regulatory
        // violation. This rule previously omitted the argument and fell back
        // to ruleHit()'s default (severity !== FIELD_VERIFICATION_REQUIRED/
        // PRECAUTION -> 'VIOLATION'), incorrectly marking a 15-25 km/h
        // advisory as a confirmed violation and pushing final-decision-engine
        // to regulatoryFinding='NON_COMPLIANT' for stone cutting alone.
        'NONE'
      )
    );
  } else if (isExposed && windBand === 'ABOVE_25') {
    const stoneCuttingWindStopKmh = STONE_CUTTING_WIND_STOP_KMH();
    hits.push(
      ruleHit(
        'STONECUT-WIND-STOP-003',
        'STOP_AFFECTED_ACTIVITY',
        `إيقاف: قطع أحجار مكشوف أثناء رياح تتجاوز الحد المسموح (${stoneCuttingWindStopKmh} كم/س)`,
        `أوقف القطع المكشوف فوراً حتى تنخفض سرعة الرياح إلى ما دون ${stoneCuttingWindStopKmh} كم/س، أو حوّله لتشغيل مغلق`,
        undefined,
        'VIOLATION'
      )
    );
  }

  return hits;
}

// 9.7 Entry/exit — branches on tire-cleaning method (wheel wash vs. water
// immersion), each with its own questions, per the site-prep/earthworks reference document.
function entryExitRules(
  activity: DustActivityComplianceProfile,
  windBand: DustWindBand
): DustRuleHit[] {
  const hits: DustRuleHit[] = [];

  if (activity.controls.wheelWashOperational === false) {
    hits.push(ruleHit('ENTRY-WHEELWASH-001', 'STOP_AFFECTED_ACTIVITY', 'وحدة غسيل الإطارات غير متوفرة أو غير عاملة', 'شغّل وحدة غسيل الإطارات أو وفّر بديلاً عاملاً قبل السماح بخروج الشاحنات', undefined, 'VIOLATION'));
  }

  if (activity.measurements.visibleTrackoutBeyond15m === true) {
    hits.push(ruleHit('ENTRY-TRACKOUT-002', 'STOP_AFFECTED_ACTIVITY', 'أتربة منقولة مرئية تتجاوز 15 متراً من بوابة الخروج', 'نظّف الأتربة المنقولة خارج البوابة فوراً وعالج سبب انتقالها', undefined, 'VIOLATION'));
  }

  if (windBand === 'FROM_15_TO_25' && activity.controls.hourlyInspectionRecorded === false) {
    hits.push(ruleHit('ENTRY-INSPECTION-003', 'RESTRICT_ACTIVITY', 'لم يُسجَّل فحص وحدة غسيل الإطارات كل ساعة أثناء الرياح 15-25 كم/س', 'سجّل فحصاً موثقاً لوحدة غسيل الإطارات كل ساعة طوال فترة الرياح 15-25 كم/س', undefined, 'VIOLATION'));
  }

  if (activity.measurements.entryPointLat === null || activity.measurements.entryPointLng === null) {
    hits.push(ruleHit('ENTRY-POINT-MISSING-004', 'FIELD_VERIFICATION_REQUIRED', 'لم يتم تحديد نقطة دخول المشروع على الخريطة', 'حدّد نقطة دخول المشروع على الخريطة في بيانات النشاط', undefined, 'NONE'));
  }
  if (activity.measurements.exitPointLat === null || activity.measurements.exitPointLng === null) {
    hits.push(ruleHit('ENTRY-EXITPOINT-MISSING-005', 'FIELD_VERIFICATION_REQUIRED', 'لم يتم تحديد نقطة خروج المشروع على الخريطة', 'حدّد نقطة خروج المشروع على الخريطة في بيانات النشاط', undefined, 'NONE'));
  }
  if (activity.controls.accessRoadPaved === false) {
    hits.push(ruleHit('ENTRY-ROADPAVED-006', 'RESTRICT_ACTIVITY', 'الطريق المؤدي للمدخل غير مسفلت أو غير ممهد', 'اسفلت الطريق المؤدي للمدخل أو مهّده بمادة تمنع تطاير الغبار', undefined, 'VIOLATION'));
  }

  // فرع وحدة غسيل الإطارات
  if (activity.controls.tireCleaningMethod === 'WHEEL_WASH') {
    if (activity.controls.sandTrapPresent === false) {
      hits.push(ruleHit('ENTRY-SANDTRAP-007', 'RESTRICT_ACTIVITY', 'لا توجد مصيدة رمال في وحدة غسيل الإطارات', 'ركّب مصيدة رمال في وحدة غسيل الإطارات', undefined, 'VIOLATION'));
    }
    if (activity.controls.oilSeparatorPresent === false) {
      hits.push(ruleHit('ENTRY-OILSEP-008', 'RESTRICT_ACTIVITY', 'لا يوجد فاصل زيوت في وحدة غسيل الإطارات', 'ركّب فاصل زيوت في وحدة غسيل الإطارات', undefined, 'VIOLATION'));
    }
    if (activity.controls.washCycleDurationAdequate === false) {
      const wheelWashCycleMinSec = WHEEL_WASH_CYCLE_MIN_SEC();
      hits.push(ruleHit('ENTRY-WASHCYCLE-009', 'RESTRICT_ACTIVITY', `مدة دورة غسيل الإطارات أقل من ${wheelWashCycleMinSec} ثانية لكل محور`, `اضبط مدة دورة الغسيل على ${wheelWashCycleMinSec} ثانية على الأقل لكل محور`, undefined, 'VIOLATION'));
    }
    if (activity.controls.washWaterReused === false) {
      hits.push(ruleHit('ENTRY-WASHREUSE-010', 'ALLOW_WITH_CONTROLS', 'يُفضَّل إعادة استخدام مياه غسيل الإطارات', 'أضف نظام إعادة استخدام لمياه غسيل الإطارات', undefined, 'NONE'));
    }
  }

  // فرع غمر الإطارات بالمياه
  if (activity.controls.tireCleaningMethod === 'WATER_IMMERSION') {
    if (activity.controls.antiSlipMeshPresent === false) {
      hits.push(ruleHit('ENTRY-IMMERSION-MESH-011', 'RESTRICT_ACTIVITY', 'لا توجد شبكة مانعة للانزلاق في منطقة غمر الإطارات', 'ركّب شبكة مانعة للانزلاق في منطقة غمر الإطارات', undefined, 'VIOLATION'));
    }
    if (activity.controls.immersionZoneLengthAdequate === false) {
      const immersionZoneMinLengthM = IMMERSION_ZONE_MIN_LENGTH_M();
      hits.push(ruleHit('ENTRY-IMMERSION-LENGTH-012', 'RESTRICT_ACTIVITY', `طول منطقة غمر الإطارات أقل من ${immersionZoneMinLengthM} أمتار`, `وسّع منطقة غمر الإطارات إلى ${immersionZoneMinLengthM} أمتار على الأقل`, undefined, 'VIOLATION'));
    }
    if (activity.controls.collectionBasinPresent === false) {
      hits.push(ruleHit('ENTRY-BASIN-013', 'RESTRICT_ACTIVITY', 'لا يوجد حوض سفلي لتجميع مخلفات غمر الإطارات', 'أنشئ حوضاً سفلياً لتجميع مخلفات غمر الإطارات', undefined, 'VIOLATION'));
    }
  }

  if (activity.controls.truckPathCleanedWithin15Min === false) {
    hits.push(ruleHit('ENTRY-PATHCLEAN-014', 'RESTRICT_ACTIVITY', 'لم يتم تنظيف مسار الشاحنات خلال 15 دقيقة', 'نظّف مسار الشاحنات خلال 15 دقيقة من كل عملية عبور', undefined, 'VIOLATION'));
  }
  if (activity.measurements.waterTracesBeyond15mFromGate === true) {
    hits.push(ruleHit('ENTRY-WATERTRACE-015', 'RESTRICT_ACTIVITY', 'آثار مياه أو مخلفات ظاهرة على بعد 15 متراً من البوابة', 'أزل آثار المياه والمخلفات حول البوابة وقلّل كمية المياه المستخدمة في الغسيل', undefined, 'VIOLATION'));
  }

  return hits;
}

// 9.8 الطرق والنقل (A2 — النقل داخل الموقع والطرق الخدمية) — كل ضوابط هذا
// النشاط (تغطية الحمولة، سرعة الطرق المسفلتة/غير المسفلتة، زمن تنظيف
// الانسكاب، الرش/اللافتات/الكنس/غسيل الإطارات) أصبحت تنبيهات نصية عامة
// فقط، بلا أي تأثير على القرار — قرار حوكمة معتمَد صراحةً (راجع تعليق
// earthworksRules أعلاه للسياق الكامل).
//
// خطأ مكتشَف ومُصلَح (طلب صريح من المستخدم — "بإستثناء الأحجار أريد البقية
// تكون تنبيهات توعوية"): TRAFFIC-LOAD-004/TRAFFIC-UNPAVED-002/TRAFFIC-
// PAVED-003/TRAFFIC-SPILL-005 كانت الاستثناء الوحيد المتبقي من قرار
// الحوكمة العام (الملاحظة #8) — TRAFFIC-LOAD-004 تحديداً كانت مُستثناة
// عمداً بحجة "قاعدة إلزامية صريحة في الدليل التنظيمي"، والثلاثة الأخرى
// كانت "قياسات رقمية، لا تصريحات". لكن فحصاً لاحقاً كشف أن حقولها الأربعة
// (loadCovered/unpavedSpeedKmh/pavedSpeedKmh/spillCleanupMinutes) لم تكن
// موجودة في DustStep.tsx كحقول إدخال فعلية أصلاً (فقط في constants.ts/
// index.tsx كقيم افتراضية ثابتة لا تُعرَض للمستخدم أبداً) — نفس فجوة
// STONECUT-DUST-CONTROL-006 المُكتشَفة سابقاً، لكن دون حسم صريح لصالح
// "قاعدة فعلية" هنا. المستخدم أُبلغ بالتناقض (الاستثناء التوثيقي مقابل
// غياب أي حقل إدخال) واختار توحيد المعاملة مع بقية النشاط: تنبيه فقط.
function siteTrafficRules(
  _activity: DustActivityComplianceProfile,
  _riskClass: DustRiskClass
): DustRuleHit[] {
  return [];
}

// نقل مخلفات الهدم والبناء — كل ضوابط هذا النشاط (الرش/التخزين/التغطية/
// السعة، وارتفاع أكوام المخلفات) أصبحت تنبيهات نصية عامة فقط، بلا أي
// تأثير على القرار — قرار حوكمة معتمَد صراحةً (راجع تعليق earthworksRules
// أعلاه للسياق الكامل، بما فيه سبب إلغاء استثناء debrisPileHeightM لاحقاً
// — طلب صريح من المستخدم، نفس فجوة dropHeightM: بلا أي حقل إدخال فعلي).
function cdWasteTransportRules(_activity: DustActivityComplianceProfile): DustRuleHit[] {
  return [];
}

// 9.9 الأكوام والمناولة
function stockpileRules(
  riskClass: DustRiskClass,
  windBand: DustWindBand,
  activity: DustActivityComplianceProfile
): DustRuleHit[] {
  const hits: DustRuleHit[] = [];

  // STOCKPILE-HEIGHT-001 حُذفت (طلب صريح من المستخدم — نفس معالجة
  // dropHeightM أدناه: stockpileHeightM بلا أي حقل إدخال في DustStep.tsx
  // إطلاقاً، فأُلغي استثناؤها من قرار الحوكمة العام). riskClass لم يعد
  // يُستخدَم داخل هذه الدالة بعد الحذف — يبقى في التوقيع للتوافق مع
  // applyActivityRules فقط.
  void riskClass;

  // المسافة المحسوبة تلقائياً من إحداثيات موقع الأكوام + جدول
  // sensitive_receptors (عند توفرها) لها الأولوية على الحقل اليدوي — لا
  // يجوز أن يعتمد قرار المطابقة على تصريح المستخدم وحده بأن لا مستقبل
  // حساس قريب، لأنه قد يخطئ أو يتجاهل وجود منشأة فعلياً.
  //
  // خطأ مكتشَف ومُصلَح (مراجعة كود خارجي — "قاعدة مخزون 200م ما زالت تصدر
  // STOP_AFFECTED_ACTIVITY، بخلاف قرار المستخدم الأخير أن قواعد 200م/500م
  // تنبيه فقط"): فجوة فاتت commit 6f328f8 ("إزالة قرارات الإيقاف/المنع
  // المبنية على مسافة المستقبِلات الحساسة") — تلك المعالجة شملت 7 قواعد
  // (CRUSHER-*/BATCHING-*/MRQ-RECEPTOR-DOWNWIND-120) لكن فاتها
  // STOCKPILE-DISTANCE-002 تحديداً، رغم نفس السبب المنطقي بالضبط (تناقض
  // نافذة AEI التي تدمج OSM+يدوي مقابل هذا الحقل الذي يقرأ الجدول اليدوي/
  // المحسوب تلقائياً فقط — راجع رسالة 6f328f8 الكاملة). نفس المعالجة الآن:
  // ALLOW_WITH_CONTROLS بدل STOP_AFFECTED_ACTIVITY — القاعدة نفسها تبقى
  // مفعَّلة كتنبيه توعوي (لا تزال تُسجَّل ضمن triggeredRules)، فقط أثرها على
  // decisionCategory أُلغي.
  const distance = activity.measurements.stockpileDistanceToNearestReceptorAutoM ?? activity.measurements.stockpileBatchingDistanceToReceptorM;
  const stockpileSensitiveReceptorDistanceM = STOCKPILE_SENSITIVE_RECEPTOR_DISTANCE_M();
  if (distance !== null && distance !== undefined && distance < stockpileSensitiveReceptorDistanceM) {
    hits.push(
      ruleHit(
        'STOCKPILE-DISTANCE-002',
        'ALLOW_WITH_CONTROLS',
        `تنبيه: مسافة الأكوام/محطة الخلط من المستقبِل الحساس (${activity.measurements.stockpileDistanceToNearestReceptorAutoM !== null && activity.measurements.stockpileDistanceToNearestReceptorAutoM !== undefined ? 'محسوبة تلقائياً: ' : ''}${distance} م) أقل من ${stockpileSensitiveReceptorDistanceM} م — تنبيه توعوي فقط، لا يوقف النشاط`,
        `يُفضَّل نقل الأكوام/محطة الخلط إلى مسافة لا تقل عن ${stockpileSensitiveReceptorDistanceM} م عن أقرب مستقبل حساس، أو زيادة إجراءات التثبيط`,
        undefined,
        'NONE'
      )
    );
  }

  // ضوابط التغطية/الرش/الشكل/الحواجز/السيور، وارتفاع التفريغ
  // (STOCKPILE-DROP-004/005) تظهر كلها كتنبيهات نصية عامة فقط، بلا أي
  // تأثير على القرار — قرار حوكمة معتمَد صراحةً (راجع تعليق earthworksRules
  // أعلاه للسياق الكامل، بما فيه سبب إلغاء استثناء dropHeightM لاحقاً).
  void windBand;

  return hits;
}

// 9.10 الأسطح غير النشطة (A4 — يشمل أيضاً عنصري حالة الأغطية واتجاه/سرعة
// الرياح من مصفوفة الأنشطة A4)
function idleSurfaceRules(
  activity: DustActivityComplianceProfile,
  windSpeedKmh: number | null
): DustRuleHit[] {
  const hits: DustRuleHit[] = [];
  const idleDays = activity.measurements.idleDays;
  const idleSurfaceMaxDays = IDLE_SURFACE_MAX_DAYS();

  if (
    idleDays !== null && idleDays !== undefined && idleDays > idleSurfaceMaxDays &&
    activity.controls.idleSurfaceStabilized === false
  ) {
    hits.push(
      ruleHit(
        'IDLE-STABILIZE-001',
        'RESTRICT_ACTIVITY',
        `سطح غير نشط لأكثر من ${idleSurfaceMaxDays} أيام دون تثبيت`,
        'ثبّت السطح غير النشط بمواد تثبيت أو أغطية واقية',
        undefined,
        'VIOLATION'
      )
    );
  }

  // حالة الأغطية غير سليمة — مخالفة بذاتها بصرف النظر عن عدد الأيام
  if (activity.controls.idleSurfaceCoverIntact === false) {
    hits.push(
      ruleHit('IDLE-COVER-002', 'RESTRICT_ACTIVITY', 'غطاء السطح غير النشط غير سليم أو تالف', 'أصلح أو استبدل غطاء السطح غير النشط التالف', undefined, 'VIOLATION')
    );
  }

  // فحص الأغطية إلزامي بعد رياح >20 كم/س — حالة الغطاء مجهولة عند هذه
  // السرعة تُعامَل كمخالفة محتملة (نفس مبدأ عدم إصدار قرار أخضر مع نقص بيانات)
  const idleSurfaceCoverInspectionWindKmh = IDLE_SURFACE_COVER_INSPECTION_WIND_KMH();
  if (
    windSpeedKmh !== null && windSpeedKmh !== undefined &&
    windSpeedKmh > idleSurfaceCoverInspectionWindKmh &&
    (activity.controls.idleSurfaceCoverIntact === false || activity.controls.idleSurfaceCoverIntact === null)
  ) {
    hits.push(
      ruleHit(
        'IDLE-COVER-WIND-003',
        'FIELD_VERIFICATION_REQUIRED',
        `رياح تجاوزت ${idleSurfaceCoverInspectionWindKmh} كم/س — يلزم فحص أغطية الأسطح غير النشطة وإصلاحها فوراً`,
        'انزل للموقع وافحص أغطية الأسطح غير النشطة الآن، وأصلح أي غطاء تضرر من الرياح',
        undefined,
        'NONE'
      )
    );
  }

  // exposedAreaCurrentlyIdle/stockpileAreaExists/suppressantUsedAtStockpileArea/
  // windBarriersNearStockpiles/constructionScheduledImmediatelyAfterPrep
  // تظهر كتنبيهات نصية عامة فقط، بلا أي تأثير على القرار — قرار حوكمة
  // معتمَد صراحةً (راجع تعليق earthworksRules أعلاه للسياق الكامل).
  // idleDays/idleSurfaceStabilized/idleSurfaceCoverIntact أعلاه تبقى
  // مدخلات حقيقية.

  return hits;
}

// نقطة الدخول الموحّدة لتطبيق قواعد النشاط التنظيمي حسب نوعه
export function applyActivityRules(
  project: DustProjectComplianceProfile,
  riskClass: DustRiskClass,
  windBand: DustWindBand,
  activity: DustActivityComplianceProfile,
  windSpeedKmh: number | null = null
): DustRuleHit[] {
  switch (activity.regulatoryActivity) {
    case 'DEMOLITION':
      return demolitionRules(activity, windBand);
    case 'CRUSHER':
      return crusherRules(project, riskClass, activity);
    case 'BATCHING_PLANT':
      return batchingPlantRules(activity);
    case 'STONE_CUTTING':
      return stoneCuttingRules(activity, windBand);
    // ENTRY_EXIT: قرار حذف نهائي مؤجَّل صراحةً (المستخدم: "لا ناجل الحذف
    // الى وقت لاحق") — entryExitRules() كود ميت عملياً بالفعل (ENTRY_EXIT
    // محذوف من REGULATORY_ACTIVITY_OPTIONS في AddActivityModal/constants.ts
    // فلا يمكن للمستخدم إنشاء هذا النوع من الواجهة)، فإبقاء هذا الفرع هنا
    // لا يؤثر على أي قرار فعلي — لا تُحذف هذه الحالة قبل تعليمات لاحقة
    // صريحة بإتمام الحذف.
    case 'ENTRY_EXIT':
      return entryExitRules(activity, windBand);
    case 'SITE_TRAFFIC':
      return siteTrafficRules(activity, riskClass);
    case 'CD_WASTE_TRANSPORT':
      return cdWasteTransportRules(activity);
    case 'MATERIAL_HANDLING_STOCKPILE':
      return stockpileRules(riskClass, windBand, activity);
    case 'IDLE_SURFACE':
      return idleSurfaceRules(activity, windSpeedKmh);
    case 'EARTHWORKS':
      return earthworksRules(activity, windBand);
    case 'OTHER':
    default:
      return [];
  }
}
