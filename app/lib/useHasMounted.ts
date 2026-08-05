import { useSyncExternalStore } from 'react';

// يستبدل نمط useState(false) + useEffect(() => setState(true), []) المتكرر
// في مكوّنات تحتاج معرفة "هل اكتملت الهدرجة (hydration) في المتصفح؟" —
// (خرائط Leaflet/مكوّنات تحتاج window، تجنّباً لعدم تطابق SSR). التسجيل
// دائماً false في التمرير الأول على الخادم، ثم true بعد أول render في
// المتصفح — نفس السلوك تماماً، لكن بلا استدعاء setState داخل Effect (كان
// React Compiler يرفضه بوصفه تأثيراً جانبياً غير ضروري: القيمة "متصفح أم
// لا" ثابتة فعلياً بعد التحميل، لا حالة تتغيّر بمرور الوقت).
const subscribe = () => () => {};

export function useHasMounted(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true, // في المتصفح: مُهَدرَج بالفعل عند أول استدعاء
    () => false // على الخادم: لم يُهَدرَج بعد
  );
}
