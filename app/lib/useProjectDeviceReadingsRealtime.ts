'use client';

import { useEffect, useRef } from 'react';
import { supabase } from '@/app/lib/supabase';

// اشتراك Realtime مُشترَك على device_readings_history لمشروع واحد، بعداد
// مراجع (ref count) بدل قناة منفصلة لكل مستهلك — ActivityReadingsCharts.tsx
// يُركَّب مرة واحدة لكل بطاقة نشاط ظاهرة، فقد تُفتَح عدة نسخ معاً على نفس
// صفحة المشروع؛ بلا هذا التجميع، كل بطاقة كانت ستفتح قناة WebSocket مستقلة
// لنفس project_id، مضاعِفةً عدد الاتصالات بلا أي فائدة إضافية (كل قناة
// كانت ستستقبل بالضبط نفس الأحداث).
//
// device_readings_history لا يحمل activity_group_id كعمود مباشر (الربط
// بالنشاط يتم فقط بالخادم عبر device_id → project_dust_profiles) — فلا يمكن
// تقييد الاشتراك من جانب العميل لنشاط محدد؛ الفلترة هنا بـproject_id فقط،
// وكل مستمع (بطاقة نشاط) يُعيد جلب بياناته الخاصة بلا تمييز عند أي حدث،
// نفس ما كان يحدث سابقاً كل دقيقة عبر polling لكن الآن فقط عند وصول قراءة
// فعلية جديدة.

interface SharedChannelEntry {
  channel: ReturnType<typeof supabase.channel>;
  listeners: Set<() => void>;
  authListener: ReturnType<typeof supabase.auth.onAuthStateChange>['data']['subscription'];
}

const sharedChannels = new Map<string, SharedChannelEntry>();

function subscribe(projectId: string, onEvent: () => void): () => void {
  let entry = sharedChannels.get(projectId);
  if (!entry) {
    const listeners = new Set<() => void>();
    const channel = supabase
      .channel(`device-readings-${projectId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'device_readings_history', filter: `project_id=eq.${projectId}` },
        () => {
          listeners.forEach((fn) => fn());
        }
      )
      .subscribe();

    // نفس نمط final_decisions/pm10 — إعادة توثيق القناة عند كل تجديد جلسة
    // فعلي (JWT صالح لساعة واحدة، لا يتجدد تلقائياً على قناة مفتوحة مسبقاً).
    supabase.auth.getSession().then(({ data }) => {
      const token = data.session?.access_token;
      if (token) supabase.realtime.setAuth(token);
    });
    const { data: authListener } = supabase.auth.onAuthStateChange(async (_event, session) => {
      if (!session?.access_token) return;
      await supabase.realtime.setAuth(session.access_token);
    });

    entry = { channel, listeners, authListener: authListener.subscription };
    sharedChannels.set(projectId, entry);
  }

  entry.listeners.add(onEvent);
  return () => {
    const current = sharedChannels.get(projectId);
    if (!current) return;
    current.listeners.delete(onEvent);
    if (current.listeners.size === 0) {
      current.authListener.unsubscribe();
      supabase.removeChannel(current.channel);
      sharedChannels.delete(projectId);
    }
  };
}

// يستدعي onEvent في كل مرة تُدرَج قراءة جهاز جديدة لهذا المشروع — لا يُمرَّر
// أي بيانات (الحمولة الفعلية تبقى مسؤولية المستهلك عبر إعادة جلب بياناته).
export function useProjectDeviceReadingsRealtime(projectId: string | undefined, onEvent: () => void) {
  const onEventRef = useRef(onEvent);
  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  useEffect(() => {
    if (!projectId) return;
    const unsubscribe = subscribe(projectId, () => onEventRef.current());
    return unsubscribe;
  }, [projectId]);
}
