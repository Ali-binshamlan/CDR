import type { SupabaseClient } from '@supabase/supabase-js';

// =============================================================
// Riyadh Dust Compliance Engine — Rule Parameters (Tunable Thresholds)
// =============================================================
// The rule engine itself (rulebook.ts/engine.ts) stays plain IF/THEN logic —
// intentionally not a dynamic rule interpreter (too risky for a regulatory
// compliance system). Instead, only the tunable numeric thresholds
// (distances, wind speeds, durations, percentages) are moved from plain
// TypeScript constants to values editable through a real versioning system
// (rule_parameter_definitions/rule_parameter_versions, migration
// 202608060003), while the rule structure itself (which rules fire, under
// which conditions) stays exactly as coded — the admin panel can adjust a
// threshold on an existing rule, never add or remove a rule.
//
// PM10 thresholds (340/250/...) are explicitly excluded from this system —
// they remain exclusively controlled by ACTIVE_RULE_BUNDLE (app/utils/rule-bundles).
//
// Mechanism: each parameter here is a module-level `let` (not `const`)
// initialized to a default matching what was previously hardcoded in
// rulebook.ts/engine.ts — a safe fallback that preserves prior behavior
// exactly until a parameter is published. refreshRuleParameters (called
// once per evaluation cycle in computeDustComplianceResults) fetches all
// currently PUBLISHED versions and swaps these variables in one batch
// before each new evaluation. rulebook.ts/engine.ts remain pure functions
// (no I/O) that read these variables as plain values — no change to their
// signatures or call patterns.

export interface RuleParameters {
  CRUSHER_SENSITIVE_RECEPTOR_DISTANCE_M: number;
  CRUSHER_GENERAL_RECEPTOR_DISTANCE_M: number;
  STOCKPILE_SENSITIVE_RECEPTOR_DISTANCE_M: number;
  DEMOLITION_MAX_AREA_M2: number;
  IDLE_SURFACE_MAX_DAYS: number;
  STONE_CUTTING_WIND_STOP_KMH: number;
  BATCHING_PM10_FILTER_MIN_PERCENT: number;
  IDLE_SURFACE_COVER_INSPECTION_WIND_KMH: number;
  WIND_GATE_ENHANCED_MIN_KMH: number;
  WIND_GATE_STOP_KMH: number;
  WIND_GUST_SAFETY_THRESHOLD_KMH: number;
  CONFIDENCE_MIN_FOR_ALLOW: number;
  // Previously raw constants (0.5/1 km) hardcoded directly in
  // applyMandatoryGates (dust-engine/engine.ts), untracked by
  // rule_parameter_versions and thus not captured by
  // computeInputSnapshotHash (dustEvaluation.ts) — unlike every other
  // threshold in this file, the effective value at decision time could not
  // be reconstructed later if changed. Moved here using the same mechanism
  // as the rest (default fallback matches the old value exactly).
  VISIBILITY_MANDATORY_STOP_KM: number;
  VISIBILITY_RESTRICT_SEVERE_KM: number;
}

// Default values — match exactly what was previously hardcoded as
// constants in rulebook.ts/engine.ts (code_default_value in migration
// 202608060003). The only fallback before a parameter's first publish.
export const DEFAULT_RULE_PARAMETERS: RuleParameters = Object.freeze({
  CRUSHER_SENSITIVE_RECEPTOR_DISTANCE_M: 500,
  CRUSHER_GENERAL_RECEPTOR_DISTANCE_M: 200,
  STOCKPILE_SENSITIVE_RECEPTOR_DISTANCE_M: 200,
  DEMOLITION_MAX_AREA_M2: 100,
  IDLE_SURFACE_MAX_DAYS: 5,
  // Must match WIND_GATE_STOP_KMH (25) per Annex A's wind sequencing, not
  // WIND_GATE_ENHANCED_MIN_KMH (15, the enhanced-suppression threshold).
  // See the stoneCuttingRules comment in rulebook.ts.
  STONE_CUTTING_WIND_STOP_KMH: 25,
  BATCHING_PM10_FILTER_MIN_PERCENT: 99,
  IDLE_SURFACE_COVER_INSPECTION_WIND_KMH: 20,
  WIND_GATE_ENHANCED_MIN_KMH: 15,
  WIND_GATE_STOP_KMH: 25,
  WIND_GUST_SAFETY_THRESHOLD_KMH: 50,
  CONFIDENCE_MIN_FOR_ALLOW: 70,
  VISIBILITY_MANDATORY_STOP_KM: 0.5,
  VISIBILITY_RESTRICT_SEVERE_KM: 1,
});

// Live state actually read by rulebook.ts/engine.ts — starts equal to the
// defaults, fully replaced (never partially merged) on each successful
// refreshRuleParameters. A single atomically-swappable object (not
// individually-updatable fields) prevents readers from observing a mix of
// old and new values mid-update.
let current: RuleParameters = DEFAULT_RULE_PARAMETERS;

// `current` above holds only raw numbers, with no trace of their source.
// This is a separate companion snapshot — {parameter_code:
// rule_parameter_versions.id} — deliberately not embedded inside
// RuleParameters itself: rulebook.ts/engine.ts read getRuleParameters().X as
// a plain number in comparisons (if (windSpeed >= WIND_GATE_STOP_KMH()));
// changing the shape to {value, versionId} would break every consumption
// site for no benefit to the decision engine. Provenance is an audit
// concern captured only at persistence time (dustEvaluation.ts), not during
// evaluation.
export interface RuleParameterVersionSnapshot {
  [parameterCode: string]: string; // parameter_code -> rule_parameter_versions.id
}

// A parameter with no PUBLISHED version (using the DEFAULT_RULE_PARAMETERS
// fallback) is deliberately absent from this map — a missing key explicitly
// means "no version controls this parameter, value comes from the code
// default", rather than an ambiguous empty id.
let currentVersionIds: RuleParameterVersionSnapshot = {};

export function getRuleParameters(): RuleParameters {
  return current;
}

// Snapshot of the version ids in effect as of the last successful
// refreshRuleParameters — read once per evaluation cycle (evaluateProject.ts)
// and passed through to persist_activity_decision_atomic to be stored in
// final_decisions.rule_parameter_version_snapshot.
export function getActiveParameterVersionIds(): RuleParameterVersionSnapshot {
  return currentVersionIds;
}

// Test-only — resets state to the explicit default, fully isolated from any
// real DB (no Supabase import needed in unit tests for rulebook.ts/engine.ts).
export function resetRuleParametersForTests(): void {
  current = DEFAULT_RULE_PARAMETERS;
  currentVersionIds = {};
}

// Test-only — sets one or more parameters directly without Supabase, to
// prove rulebook.ts/engine.ts reads live values from this module (not a
// frozen constant) — uses the same mechanism as real publishing (a whole
// new object, never an in-place partial update).
export function setRuleParametersForTests(overrides: Partial<RuleParameters>): void {
  current = { ...current, ...overrides };
}

// Called once at the start of each computeDustComplianceResults cycle —
// fetches all currently PUBLISHED versions in a single query (not one query
// per parameter) and builds a whole new object before the atomic swap.
// A failed query does not abort evaluation — `current` is left as the last
// known-good values, never silently reset to defaults that may differ from
// the actual latest published version.
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
    // Atomic swap of both together — same principle as `current` above (no
    // partial merge, no reading a mix of new value with stale version id or
    // vice versa).
    current = next;
    currentVersionIds = nextVersionIds;
  } catch {
    // Query failure (network/DB) does not abort evaluation — current/currentVersionIds are left unchanged.
  }
}

// =============================================================
// Explicit async mutex — prevents a concurrency race:
//
// current/currentVersionIds are module-level state shared across the whole
// process, not isolated per evaluation cycle. evaluateProject is called
// from 3 independent sources (POST /evaluate, devices/ingest on each device
// reading, the periodic scheduler-worker), which can interleave on the same
// instance (serverless warm reuse). Between refreshRuleParameters() and the
// actual consumption of getRuleParameters() inside
// computeDustResults/computeDustComplianceResults there are several real
// awaits (DB queries: evaluation_runs, project_dust_profiles,
// project_shifts, sensitive_receptors) — suspension points where the event
// loop can run another concurrent evaluateProject cycle, which calls its
// own refreshRuleParameters and overwrites the global current/
// currentVersionIds *before* the first cycle actually consumes them. The
// result: the rule_parameter_version_snapshot persisted in final_decisions
// could reference version ids that don't actually match the values used to
// compute dvi/compliance in that cycle — a false provenance record that
// breaks later reproduction/audit.
//
// Fix: an explicit lock guarantees sequential (non-interleaved) execution
// of the critical section (from refreshRuleParameters through final
// value consumption/persist) across concurrent evaluateProject cycles,
// without needing to thread RuleParameters explicitly through every call
// layer (rulebook.ts/engine.ts/dust-engine keep their current signatures
// unchanged) — it's enough to guarantee `current` doesn't change under a
// cycle that's still running. A simple runQueue Promise chain (no external
// library) — each withRuleParametersLock call waits its turn in the queue.
let runQueue: Promise<unknown> = Promise.resolve();

export function withRuleParametersLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = runQueue.then(fn, fn);
  // Swallow this call's result/error when building the next wait chain —
  // one failed evaluation cycle must not block the next cycle in the queue
  // from starting; the error itself still reaches the caller via the
  // returned `result`.
  runQueue = result.catch(() => {});
  return result;
}
