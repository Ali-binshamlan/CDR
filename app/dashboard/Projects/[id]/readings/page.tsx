'use client';

import { use, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ReferenceLine, ResponsiveContainer,
} from 'recharts';
import { ArrowRight, Gauge, RefreshCw } from 'lucide-react';
import { apiClient } from '@/app/lib/apiClient';

// نفس عتبات PM10 التنظيمية في app/utils/dust-compliance-engine/rulebook.ts
// (PM10_PRECAUTION_UG_M3/PM10_WARNING_UG_M3/PM10_EARLY_WARNING_UG_M3/
// PM10_VIOLATION_STOP_UG_M3) — مكرَّرة عمداً هنا فقط لرسم خطوط مرجعية على
// الرسم البياني، بلا أي تأثير على القرار الفعلي (المحسوب حصراً بالخادم).
const PM10_PRECAUTION_UG_M3 = 150;
const PM10_WARNING_UG_M3 = 250;
const PM10_EARLY_WARNING_UG_M3 = 300;
const PM10_VIOLATION_STOP_UG_M3 = 340;

// دورة التحديث التلقائي — تطابق دورة إرسال الجهاز التصميمية (دقيقتان)
// ودورة polling صفحة تفاصيل المشروع، حتى يبقى الرسم البياني حياً بلا
// حاجة لريفريش يدوي أثناء بقاء المستخدم بالصفحة.
const REFRESH_INTERVAL_MS = 2 * 60 * 1000;

// نطاقات زمنية جاهزة للاختيار — 6 ساعات افتراضياً (كافية لمتابعة نوبة عمل
// واحدة)، مع خيار يوم/3 أيام/أسبوع للمراجعة الرجعية.
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

// ألوان مستقرة لكل نشاط — دوّارة على مجموعة ثابتة بدل عشوائية، حتى يحتفظ
// كل نشاط بنفس لونه بين كل تحديث تلقائي (لا يتبدّل الترتيب بصرياً).
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

// يحوّل مصفوفة الأنشطة (كل نشاط له مصفوفة قراءات مستقلة زمنياً) إلى صفوف
// موحَّدة بمحور زمني مشترك — recharts يحتاج مصفوفة واحدة بمفتاح لكل خط،
// لا مصفوفات منفصلة. نقاط القراءة الفعلية فقط (لا تعبئة/استيفاء بين
// النقاط)، فالخط ينقطع بصرياً في فجوات الانقطاع الحقيقية بدل تمويهها.
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
  const [selectedIds, setSelectedIds] = useState<Set<string> | null>(null); // null = الكل

  const fetchHistory = async (silent = false) => {
    try {
      if (!silent) setLoading(true);
      const { data } = await apiClient.get(`/projects/${id}/pm10-history`, { params: { hours } });
      setActivities(data.activities || []);
      setError(null);
    } catch (err: any) {
      if (silent) return;
      setError(err?.response?.data?.error || 'حدث خطأ أثناء جلب سجل القراءات');
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => {
    if (!id) return;
    fetchHistory();

    const intervalId = window.setInterval(() => fetchHistory(true), REFRESH_INTERVAL_MS);
    return () => window.clearInterval(intervalId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, hours]);

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
              كل نقطة تمثّل قراءة فعلية مسجَّلة — يتحدّث تلقائياً كل دقيقتين
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
                        formatter={(value: any, name: any) => {
                          const activity = activities.find((a) => a.activityGroupId === name);
                          return [`${value} µg/m³`, activity?.label ?? name];
                        }}
                        contentStyle={{ borderRadius: 12, border: '1px solid #E2E8F0', fontSize: 12, direction: 'rtl' }}
                      />
                      <Legend
                        formatter={(value) => activities.find((a) => a.activityGroupId === value)?.label ?? value}
                        wrapperStyle={{ fontSize: 12, direction: 'rtl' }}
                      />

                      {/* خطوط مرجعية للعتبات التنظيمية — إعلامية بحتة، لا تُغيّر
                          أي بيانات، فقط توضّح أين تقع القراءات نسبةً للحدود. */}
                      <ReferenceLine y={PM10_PRECAUTION_UG_M3} stroke="#EAB308" strokeDasharray="4 4" label={{ value: 'احتراز 150', position: 'insideTopLeft', fontSize: 10, fill: '#CA8A04' }} />
                      <ReferenceLine y={PM10_WARNING_UG_M3} stroke="#F97316" strokeDasharray="4 4" label={{ value: 'تحذير 250', position: 'insideTopLeft', fontSize: 10, fill: '#EA580C' }} />
                      <ReferenceLine y={PM10_EARLY_WARNING_UG_M3} stroke="#F97316" strokeDasharray="4 4" label={{ value: 'استباقي 300', position: 'insideTopLeft', fontSize: 10, fill: '#EA580C' }} />
                      <ReferenceLine y={PM10_VIOLATION_STOP_UG_M3} stroke="#EF4444" strokeDasharray="4 4" label={{ value: 'مخالفة 340', position: 'insideTopLeft', fontSize: 10, fill: '#DC2626' }} />

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
