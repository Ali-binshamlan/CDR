import { useEffect, useState } from 'react';

// يوفّر "الآن" كقيمة حالة تتحدّث دورياً، بدل استدعاء Date.now() مباشرة أثناء
// الـrender (كان React Compiler يرفض ذلك — استدعاء دالة غير نقية أثناء
// الـrender ينتج نتائج غير مستقرة قد لا تُعاد حسابها عند تفعيل التذكّر).
// كل مستهلكي "منذ متى؟"/"هل انتهى الآن؟"/"هل قديم؟" في بطاقات الأنشطة
// يستبدلون Date.now() المباشر بقيمة هذا الـhook.
export function useNow(intervalMs: number = 30000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);

  return now;
}
