'use client';

// Completely independent visual indicator for the new Live Data layer status (SSE) — does not
// touch Dustwidgetcard/Compliancewidgetcard (very sensitive, displaying computed decisions
// from an entirely different source: polling+Realtime, not this layer). Renders only behind
// LIVE_DATA_V2, and completely disappears if the feature flag is disabled (see page.tsx).
//
// Explicit request: "Do not present stale data as Live" — the state here is strictly built from:
// (a) the SSE connection status itself (connecting/connected/disconnected), and
// (b) the age of the latest actual snapshot received. No fabricated or estimated values ever.

import type { LiveConnectionStatus } from '@/app/lib/liveData/useLiveDeviceData';
import type { LiveDeviceSnapshot } from '@/app/lib/liveData/types';

const STALE_THRESHOLD_MS = 60_000;

interface LiveDataIndicatorProps {
  connectionStatus: LiveConnectionStatus;
  snapshots: Map<string, LiveDeviceSnapshot>;
  nowTs: number;
}

export default function LiveDataIndicator({ connectionStatus, snapshots, nowTs }: LiveDataIndicatorProps) {
  if (connectionStatus === 'connecting') {
    return (
      <div className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-3 py-1 text-xs font-bold text-slate-500">
        <span className="h-2 w-2 animate-pulse rounded-full bg-slate-400" />
        جاري الاتصال بالبيانات الحية...
      </div>
    );
  }

  if (connectionStatus === 'disconnected') {
    return (
      <div className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-3 py-1 text-xs font-bold text-amber-700">
        <span className="h-2 w-2 rounded-full bg-amber-500" />
        جاري محاولة استعادة الاتصال...
      </div>
    );
  }

  const latestSnapshot = [...snapshots.values()].sort(
    (a, b) => new Date(b.updatedAtIso).getTime() - new Date(a.updatedAtIso).getTime()
  )[0];

  if (!latestSnapshot) {
    return (
      <div className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-3 py-1 text-xs font-bold text-slate-500">
        <span className="h-2 w-2 rounded-full bg-slate-400" />
        متصل — بانتظار أول قراءة
      </div>
    );
  }

  const ageMs = nowTs - new Date(latestSnapshot.updatedAtIso).getTime();
  const isStale = ageMs > STALE_THRESHOLD_MS;
  const ageSeconds = Math.max(0, Math.round(ageMs / 1000));
  const ageLabel = ageSeconds < 60 ? `${ageSeconds} ثانية` : `${Math.round(ageSeconds / 60)} دقيقة`;

  if (isStale) {
    return (
      <div className="inline-flex items-center gap-1.5 rounded-full bg-orange-50 px-3 py-1 text-xs font-bold text-orange-700">
        <span className="h-2 w-2 rounded-full bg-orange-500" />
        قديمة — آخر تحديث منذ {ageLabel}
      </div>
    );
  }

  return (
    <div className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-3 py-1 text-xs font-bold text-emerald-700">
      <span className="h-2 w-2 rounded-full bg-emerald-500" />
      مباشر — آخر تحديث منذ {ageLabel}
    </div>
  );
}