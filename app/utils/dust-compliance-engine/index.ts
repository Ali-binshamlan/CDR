// =============================================================
// Riyadh Dust Compliance Engine — Public Entry Point
// Callers must pass a precomputed DVI result to evaluateDustCompliance —
// this engine never recomputes DVI itself.
// =============================================================

export * from './types';
export { RULEBOOK_VERSION, classifyProject, classifyWind, isRegulatoryWindGateActive, BATCHING_PM10_FILTER_MIN_PERCENT, PM10_WARNING_UG_M3, DECISION_PRIORITY } from './rulebook';
export {
  buildComplianceContext,
  buildProjectComplianceProfile,
  buildActivityComplianceProfile,
  buildSensitiveReceptor,
} from './adapters';
export { evaluateDustCompliance } from './engine';
export { haversineDistanceM, nearestReceptorDistancesM, receptorsWithinRadiusM, UNIT_RECEPTOR_RADIUS_M } from './geo';
export type { ReceptorWithinRadius } from './geo';
export {
  getRuleParameters,
  refreshRuleParameters,
  resetRuleParametersForTests,
  setRuleParametersForTests,
  DEFAULT_RULE_PARAMETERS,
  getActiveParameterVersionIds,
  withRuleParametersLock,
} from './ruleParameters';
export type { RuleParameters, RuleParameterVersionSnapshot } from './ruleParameters';
