'use client';

import { useEffect, useRef, useState } from 'react';
import { supabase } from '@/app/lib/supabase';
import type { LiveDeviceSnapshot } from './types';

// Hook عميل لطبقة Live Data الجديدة (SSE) — يُستخدم فقط خلف Feature Flag
// LIVE_DATA_V2 (راجع app/lib/liveData/featureFlag.ts)، بلا أي أثر على
// النظام الحالي (polling + Supabase Realtime في page.tsx) عند إيقافه.
// يبث فقط القراءة الخام لكل جهاز في المشروع (pm10/wind/temp/...)، لا
// القرار المحسوب (إيقاف/مسموح) — ذاك يبقى مصدره polling+Realtime الحالي
// (قرار تصميمي متعمّد: القرار حسّاس تنظيمياً، لا يُبنى فوقه إلا بعد ثقة
// كاملة بهذه الطبقة أولاً — راجع نقاش المحادثة).
//
// EventSource المتصفحي القياسي يعيد الاتصال تلقائياً عند انقطاع الشبكة —
// لا حاجة لإعادة اتصال يدوية لهذا السبب وحده. لكن التوكن هنا صالح لساعة
// واحدة فقط (نفس قيد صفحة final_decisions Realtime أعلاه في page.tsx)،
// و EventSource لا يعيد قراءة query params بعد فتح الاتصال — فنعيد إنشاء
// الاتصال بالكامل (توكن جديد) عند كل تجديد جلسة فعلي (TOKEN_REFRESHED).

export type LiveConnectionStatus = 'connecting' | 'connected' | 'disconnected';

export interface UseLiveDeviceDataResult {
  snapshots: Map<string, LiveDeviceSnapshot>;
  connectionStatus: LiveConnectionStatus;
}

export function useLiveDeviceData(projectId: string | null): UseLiveDeviceDataResult {
  const [snapshots, setSnapshots] = useState<Map<string, LiveDeviceSnapshot>>(new Map());
  const [connectionStatus, setConnectionStatus] = useState<LiveConnectionStatus>('connecting');
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!projectId) return;

    let cancelled = false;

    const openConnection = async () => {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token || cancelled) return;

      // اتصال سابق (توكن قديم) يُغلَق أولاً — لا نترك اتصالين مفتوحين معاً.
      eventSourceRef.current?.close();

      setConnectionStatus('connecting');
      const url = `/api/live/stream?projectId=${encodeURIComponent(projectId)}&token=${encodeURIComponent(token)}`;
      const es = new EventSource(url);
      eventSourceRef.current = es;

      es.addEventListener('open', () => {
        if (!cancelled) setConnectionStatus('connected');
      });

      es.addEventListener('snapshot_batch', (event) => {
        if (cancelled) return;
        try {
          const batch = JSON.parse((event as MessageEvent).data) as LiveDeviceSnapshot[];
          setSnapshots(new Map(batch.map((s) => [s.deviceId, s])));
        } catch {
          // حمولة غير متوقعة — تجاهل هذا الحدث، لا كسر بقية الاتصال.
        }
      });

      es.addEventListener('snapshot', (event) => {
        if (cancelled) return;
        try {
          const snapshot = JSON.parse((event as MessageEvent).data) as LiveDeviceSnapshot;
          setSnapshots((prev) => {
            const next = new Map(prev);
            next.set(snapshot.deviceId, snapshot);
            return next;
          });
        } catch {
          // تجاهل حدث مشوّه — لا نُسقط الاتصال بالكامل لحدث واحد فاسد.
        }
      });

      // onerror يُستدعى أيضاً أثناء إعادة الاتصال التلقائي للمتصفح — نعرض
      // "منقطع" فوراً، ثم يعود connected تلقائياً عند نجاح إعادة المحاولة
      // (المتصفح يتكفّل بالمحاولة، لا كود إضافي هنا).
      es.addEventListener('error', () => {
        if (!cancelled) setConnectionStatus('disconnected');
      });
    };

    void openConnection();

    // تجديد الجلسة الفعلي → إعادة فتح الاتصال بتوكن جديد (نفس نمط
    // realtime.setAuth في page.tsx، لكن EventSource يحتاج اتصالاً جديداً
    // بالكامل بدل تحديث توكن اتصال قائم).
    const { data: authListener } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'TOKEN_REFRESHED' || event === 'SIGNED_IN') void openConnection();
    });

    return () => {
      cancelled = true;
      authListener.subscription.unsubscribe();
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
    };
  }, [projectId]);

  return { snapshots, connectionStatus };
}
