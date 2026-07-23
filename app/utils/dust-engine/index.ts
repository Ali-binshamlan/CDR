// =============================================================
// DVI Engine — Public Entry Point
// أي شاشة في مرقاب تريد عرض قرار الرؤية والغبار يجب أن تستدعي
// evaluateDustVisibility من هنا، ولا تعيد الحساب محليًا.
// =============================================================

export * from './types';
export * from './tables';
export { fetchDustWeather, fetchDustWeatherHourly } from './weather';
export {
  evaluateDustVisibility,
  evaluateDustVisibilityHourly,
  evaluateDustVisibilityWindow,
  evaluateDustVisibilityWorkDayHourly,
  computeDviResult,
  classifyCause,
} from './engine';