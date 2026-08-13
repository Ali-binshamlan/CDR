// =============================================================
// Final Decision Engine — Public Entry Point
// أي شاشة/مسار يحتاج "القرار النهائي" لنشاط (دمج DVI + الامتثال + AEI)
// يجب أن يستدعي decideFinal من هنا بعد حساب المحركات الثلاثة، ولا يعيد
// اشتقاق الأولويات محلياً (البانر مقابل الخريطة مقابل مولّد التنبيهات).
// =============================================================

export * from './types';
export { decideFinal, pickWorstDecision } from './engine';
export { buildFinalDecisionInput } from './adapters';
