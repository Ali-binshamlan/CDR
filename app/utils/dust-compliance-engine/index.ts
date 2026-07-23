// =============================================================
// Riyadh Dust Compliance Engine — Public Entry Point
// أي شاشة تريد عرض قرار الامتثال التنظيمي للغبار يجب أن تستدعي
// evaluateDustCompliance من هنا، وتُمرِّر له نتيجة DVI الجاهزة —
// لا يعيد هذا المحرك حساب DVI أبداً.
// =============================================================

export * from './types';
export { RULEBOOK_VERSION, classifyProject, classifyWind, isRegulatoryWindGateActive } from './rulebook';
export {
  buildComplianceContext,
  buildProjectComplianceProfile,
  buildActivityComplianceProfile,
  buildSensitiveReceptor,
} from './adapters';
export { evaluateDustCompliance } from './engine';
export { haversineDistanceM, nearestReceptorDistancesM, receptorsWithinRadiusM, UNIT_RECEPTOR_RADIUS_M } from './geo';
export type { ReceptorWithinRadius } from './geo';
