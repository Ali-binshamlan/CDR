'use client';

import { use, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ReferenceLine, ResponsiveContainer,
} from 'recharts';
import type { ValueType, NameType } from 'recharts/types/component/DefaultTooltipContent';
import { ArrowRight, Gauge, RefreshCw } from 'lucide-react';
import { apiClient } from '@/app/lib/apiClient';
import { supabase } from '@/app/lib/supabase';
import { ACTIVE_RULE_BUNDLE } from '@/app/utils/rule-bundles/riyadh-dust';

// Operational PM10 thresholds from active rule bundle (ACTIVE_RULE_BUNDLE) —
// read directly from the bundle (not hardcoded here) solely to draw reference
// lines on the chart, with zero impact on actual decisions (calculated exclusively on server).
const PM10_PRECAUTION_UG_M3 = ACTIVE_RULE_BUNDLE.pm10.operational.normalMaxInclusive;
const PM10_WARNING_UG_M3 = ACTIVE_RULE_BUNDLE.pm10.regulatory.warningThresholdInclusive;
const PM10_RED_RESTRICT_UG_M3 = ACTIVE_RULE_BUNDLE.pm10.operational.controlsMaxInclusive;
const PM10_VIOLATION_STOP_UG_M3 = ACTIVE_RULE_BUNDLE.pm10.regulatory.violationThresholdExclusive;

// Performance bug detected and fixed (addressing Compute/CPU/Disk IO pressure on Free plan):
// This page used to poll every minute regardless of whether a new reading actually arrived —
// now instant updates arrive via Realtime subscription (INSERT on pm10_readings_history scoped to project_id,
// same pattern as final_decisions in Projects/[id]/page.tsx). REFRESH_INTERVAL_MS remains only as a very slow fallback
// safety net (5 minutes instead of 1 minute) covering edge cases: silent WebSocket connection failure
// (restricted network/proxy blocking Realtime) without visible UI drop for the user.
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

// Ready-made selectable time ranges — 6 hours default (sufficient for monitoring a single work shift),
// with 24 hours / 3 days / 1 week options for historical review.
const RANGE_OPTIONS: { label: string; hours: number }[] = [
  { label: '6 ساعات', hours: 6 },
  { label: '24 ساعة', hours: 24 },
  { label: '3 أيام', hours: 72 },
  { label: 'أسبوع', hours: 168 },
];

interface ReadingPoint {
  time: string;
  pm10: number;
  source: 'device' | 'manual' | 'open-meteo';
}

interface ActivitySeries {
  activityGroupId: string;
  label: string;
  hasDeviceLink: boolean;
  readings: ReadingPoint[];
}

// Stable colors per activity — rotating over a fixed palette instead of random selection,
// ensuring each activity retains its color across automatic updates (preventing visual reordering).
const SERIES_COLORS = ['#3995FF', '#F97316', '#10B981', '#8B5CF6', '#EF4444', '#06B6D4', '#EAB308', '#EC4899'];

const SOURCE_LABEL_AR: Record<string, string> = {
  device: 'جهاز رصد',
  manual: 'قراءة يدوية',
  'open-meteo': 'توقّع طقس',
};

function formatTimeAr(iso: string): string {
  return new Date(iso).toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Riyadh' });
}

function formatDateTimeAr(iso: string): string {
  return new Date(iso).toLocaleString('ar-SA', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Riyadh',
  });
}

// Converts array of activities (each activity has independent readings over time) into consolidated rows
// with a shared time axis — recharts requires a single data array with keys per line rather than separate arrays.
// Plotting actual reading points only (no interpolation between points), allowing lines to visually break across
// actual data gaps instead of masking them.
function buildChartRows(activities: ActivitySeries[]): Record<string, number | string | null>[] {
  const timeSet = new Set<string>();
  for (const a of activities) for (const r of a.readings) timeSet.add(r.time);
  const times = Array.from(timeSet).sort();

  return times.map((time) => {
    const row: Record<string, number | string | null> = { time };
    for (const a of activities) {
      const point = a.readings.find((r) => r.time === time);
      row[a.activityGroupId] = point ? point.pm10 : null;
    }
    return row;
  });
}

export default function ProjectReadingsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);

  const [activities, setActivities] = useState<ActivitySeries[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hours, setHours] = useState(6);
  const [selectedIds, setSelectedIds] = useState<Set<string> | null>(null); // null = all

  const fetchHistory = async (silent = false) => {
    // Immediate microtask await prior to first setState — detaches direct invocation
    // within Effect body from synchronous state update, preventing React warnings without user-perceptible delay.
    await Promise.resolve();
    try {
      if (!silent) setLoading(true);
      const { data } = await apiClient.get(`/projects/${id}/pm10-history`, { params: { hours } });
      setActivities(data.activities || []);
      setError(null);
    } catch (err: unknown) {
      if (silent) return;
      setError((err as { response?: { data?: { error?: string } } })?.response?.data?.error || 'حدث خطأ أثناء جلب سجل القراءات');
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    // Scheduled via microtask instead of invoking fetchHistory directly in the Effect body —
    // same rationale documented above fetchHistory (synchronous state update inside Effect).
    void Promise.resolve().then(() => { if (!cancelled) fetchHistory(); });

    const intervalId = window.setInterval(() => { if (!cancelled) fetchHistory(true); }, REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, hours]);

  // Realtime subscription — triggers fetchHistory immediately when a new PM10 reading arrives
  // for this project, avoiding waiting for the background polling cycle (5 minutes above).
  // Identical to final-decisions pattern in Projects/[id]/page.tsx: setAuth upon opening channel +
  // re-binding on every session refresh (JWT is valid for 1 hour, does not auto-refresh existing open channel).
  useEffect(() => {
    if (!id) return;
    let channel: ReturnType<typeof supabase.channel> | null = null;
    let cancelled = false;

    const openChannel = () => {
      if (channel) return;
      channel = supabase
        .channel(`pm10-readings-${id}`)
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'pm10_readings_history', filter: `project_id=eq.${id}` },
          () => fetchHistory(true)
        )
        .subscribe();
    };

    (async () => {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token || cancelled) return;
      await supabase.realtime.setAuth(token);
      if (cancelled) return;
      openChannel();
    })();

    const { data: authListener } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (!session?.access_token) return;
      await supabase.realtime.setAuth(session.access_token);
    });

    return () => {
      cancelled = true;
      authListener.subscription.unsubscribe();
      if (channel) supabase.removeChannel(channel);
    };
    // Intentionally omitting fetchHistory from deps array — same rationale as Projects/[id]/page.tsx
    // (prevents tearing down and re-subscribing the WebSocket channel unnecessarily on every render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const visibleActivities = useMemo(
    () => (selectedIds ? activities.filter((a) => selectedIds.has(a.activityGroupId)) : activities),
    [activities, selectedIds]
  );
  const chartRows = useMemo(() => buildChartRows(visibleActivities), [visibleActivities]);

  const toggleActivity = (groupId: string) => {
    setSelectedIds((prev) => {
      const base = prev ?? new Set(activities.map((a) => a.activityGroupId));
      const next = new Set(base);
      if (next.has(groupId)) next.delete(groupId); else next.add(groupId);
      return next;
    });
  };
  const isActivityVisible = (groupId: string) => !selectedIds || selectedIds.has(groupId);

  return (
    <div className="min-h-screen bg-[#F4F7FB] p-6 lg:p-8 font-sans" dir="rtl">
      <div className="max-w-[1440px] mx-auto space-y-6">
        <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center gap-4 bg-white p-6 rounded-2xl border border-slate-200 shadow-sm">
          <div>
            <h1 className="text-2xl font-black text-[#061B40] mb-1 flex items-center gap-2">
              <Gauge className="w-6 h-6 text-[#3995FF]" /> سجل قراءات PM10 لكل نشاط
            </h1>
            <p className="text-sm font-bold text-slate-500">
              كل نقطة تمثّل قراءة فعلية مسجَّلة — يتحدّث تلقائياً فور وصول قراءة جديدة
            </p>
          </div>
          <Link
            href={`/dashboard/Projects/${id}`}
            className="bg-white border border-slate-200 hover:bg-[#F4F7FB] text-[#061B40] px-4 py-2.5 rounded-xl text-sm font-bold flex items-center gap-2 shadow-sm transition-all"
          >
            <ArrowRight className="w-4 h-4 text-[#3995FF]" /> العودة لتفاصيل المشروع
          </Link>
        </div>

        <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 flex-wrap">
            {RANGE_OPTIONS.map((opt) => (
              <button
                key={opt.hours}
                onClick={() => setHours(opt.hours)}
                className={`px-3.5 py-1.5 rounded-lg text-xs font-bold transition-all ${
                  hours === opt.hours
                    ? 'bg-[#061B40] text-white'
                    : 'bg-slate-50 text-slate-500 hover:bg-slate-100'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <button
            onClick={() => fetchHistory()}
            className="flex items-center gap-1.5 text-xs font-bold text-[#3995FF] hover:text-[#0176FB] px-3 py-1.5 rounded-lg hover:bg-blue-50 transition-all"
          >
            <RefreshCw className="w-3.5 h-3.5" /> تحديث الآن
          </button>
        </div>

        {loading && (
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-16 text-center">
            <div className="text-[#061B40] font-bold animate-pulse">جاري تحميل سجل القراءات...</div>
          </div>
        )}

        {!loading && error && (
          <div className="bg-white rounded-2xl border border-red-200 shadow-sm p-10 text-center text-red-600 font-bold">
            {error}
          </div>
        )}

        {!loading && !error && activities.length === 0 && (
          <div className="bg-white rounded-2xl border-2 border-dashed border-slate-200 p-16 text-center">
            <Gauge className="w-12 h-12 text-[#3995FF]/40 mx-auto mb-3" />
            <h3 className="text-base font-black text-[#061B40] mb-1">لا توجد قراءات PM10 مسجَّلة خلال هذا المدى</h3>
            <p className="text-sm text-slate-500">
              القراءات تُسجَّل تلقائياً عند كل تقييم للنشاط أو استقبال قراءة من جهاز رصد — جرّب مدى زمنياً أوسع.
            </p>
          </div>
        )}

        {!loading && !error && activities.length > 0 && (
          <>
            <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm">
              <div className="flex flex-wrap gap-2 mb-4">
                {activities.map((a, idx) => {
                  const color = SERIES_COLORS[idx % SERIES_COLORS.length];
                  const active = isActivityVisible(a.activityGroupId);
                  return (
                    <button
                      key={a.activityGroupId}
                      onClick={() => toggleActivity(a.activityGroupId)}
                      className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-bold border transition-all ${
                        active ? 'border-slate-200 bg-slate-50 text-[#061B40]' : 'border-slate-100 bg-white text-slate-300'
                      }`}
                      title={active ? 'اضغط لإخفاء هذا النشاط' : 'اضغط لإظهار هذا النشاط'}
                    >
                      <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: active ? color : '#CBD5E1' }} />
                      {a.label}
                      {a.hasDeviceLink && <span className="text-[9px] text-slate-400">(جهاز)</span>}
                    </button>
                  );
                })}
              </div>

              <div className="w-full overflow-x-auto">
                <div style={{ minWidth: 640, height: 420 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={chartRows} margin={{ top: 10, right: 20, left: 0, bottom: 10 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                      <XAxis
                        dataKey="time"
                        tickFormatter={formatTimeAr}
                        tick={{ fontSize: 11, fill: '#64748B' }}
                        minTickGap={40}
                      />
                      <YAxis
                        tick={{ fontSize: 11, fill: '#64748B' }}
                        label={{ value: 'PM10 (µg/m³)', angle: -90, position: 'insideLeft', style: { fontSize: 11, fill: '#64748B' } }}
                      />
                      <Tooltip
                        labelFormatter={(v) => formatDateTimeAr(String(v))}
                        formatter={(value: ValueType | undefined, name: NameType | undefined) => {
                          const activity = activities.find((a) => a.activityGroupId === name);
                          return [`${value} µg/m³`, activity?.label ?? String(name)] as [string, string];
                        }}
                        contentStyle={{ borderRadius: 12, border: '1px solid #E2E8F0', fontSize: 12, direction: 'rtl' }}
                      />
                      <Legend
                        formatter={(value) => activities.find((a) => a.activityGroupId === value)?.label ?? value}
                        wrapperStyle={{ fontSize: 12, direction: 'rtl' }}
                      />

                      {/* Regulatory threshold reference lines — purely informational, altering
                          no underlying data, added exclusively to contextualize readings against limits. */}
                      <ReferenceLine y={PM10_PRECAUTION_UG_M3} stroke="#EAB308" strokeDasharray="4 4" label={{ value: `احتراز ${PM10_PRECAUTION_UG_M3}`, position: 'insideTopLeft', fontSize: 10, fill: '#CA8A04' }} />
                      <ReferenceLine y={PM10_WARNING_UG_M3} stroke="#F97316" strokeDasharray="4 4" label={{ value: `تحذير ${PM10_WARNING_UG_M3}`, position: 'insideTopLeft', fontSize: 10, fill: '#EA580C' }} />
                      <ReferenceLine y={PM10_RED_RESTRICT_UG_M3} stroke="#F97316" strokeDasharray="4 4" label={{ value: `تقييد ${PM10_RED_RESTRICT_UG_M3}`, position: 'insideTopLeft', fontSize: 10, fill: '#EA580C' }} />
                      <ReferenceLine y={PM10_VIOLATION_STOP_UG_M3} stroke="#EF4444" strokeDasharray="4 4" label={{ value: `مخالفة ${PM10_VIOLATION_STOP_UG_M3}`, position: 'insideTopLeft', fontSize: 10, fill: '#DC2626' }} />

                      {activities.map((a, idx) => (
                        <Line
                          key={a.activityGroupId}
                          type="monotone"
                          dataKey={a.activityGroupId}
                          name={a.activityGroupId}
                          stroke={SERIES_COLORS[idx % SERIES_COLORS.length]}
                          strokeWidth={2}
                          dot={{ r: 2 }}
                          activeDot={{ r: 4 }}
                          connectNulls={false}
                          hide={!isActivityVisible(a.activityGroupId)}
                        />
                      ))}
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {activities.map((a, idx) => {
                const latest = a.readings[a.readings.length - 1];
                const maxPoint = a.readings.reduce((max, r) => (r.pm10 > max.pm10 ? r : max), a.readings[0]);
                return (
                  <div key={a.activityGroupId} className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: SERIES_COLORS[idx % SERIES_COLORS.length] }} />
                      <h3 className="text-sm font-black text-[#061B40] truncate">{a.label}</h3>
                    </div>
                    <div className="grid grid-cols-3 gap-2 text-center">
                      <div className="bg-slate-50 rounded-lg p-2">
                        <div className="text-[10px] text-slate-400">آخر قراءة</div>
                        <div className="text-sm font-black text-[#061B40]" dir="ltr">{latest?.pm10 ?? '—'}</div>
                      </div>
                      <div className="bg-slate-50 rounded-lg p-2">
                        <div className="text-[10px] text-slate-400">أعلى قراءة</div>
                        <div className="text-sm font-black text-[#061B40]" dir="ltr">{maxPoint?.pm10 ?? '—'}</div>
                      </div>
                      <div className="bg-slate-50 rounded-lg p-2">
                        <div className="text-[10px] text-slate-400">عدد النقاط</div>
                        <div className="text-sm font-black text-[#061B40]" dir="ltr">{a.readings.length}</div>
                      </div>
                    </div>
                    {latest && (
                      <div className="mt-2 text-[10px] text-slate-400 text-center">
                        {formatDateTimeAr(latest.time)} · {SOURCE_LABEL_AR[latest.source] ?? latest.source}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}