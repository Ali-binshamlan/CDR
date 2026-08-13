// =============================================================
// AEI Engine — Public Entry Point
// أي شاشة تريد عرض قابلية تنفيذ نشاط متأثر بالغبار يجب أن تستدعي
// evaluateAeiForDustActivity من هنا بعد حساب DVI أولاً، ولا تعيد
// حساب المنطق محليًا.
// =============================================================

export * from './types';
export * from './tables';
export { evaluateAei } from './engine';
