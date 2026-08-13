'use client';

import { useEffect, useRef, useState } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import type { ValueType } from 'recharts/types/component/DefaultTooltipContent';
import type { AxiosError } from 'axios';
import { LineChart as LineChartIcon } from 'lucide-react';
import { apiClient } from '@/app/lib/apiClient';
import { useProjectDeviceReadingsRealtime } from '@/app/lib/useProjectDeviceReadingsRealtime';

// عناصر القياس السبعة — كل عنصر رسمه الخاص المستقل (لا محور مزدوج أبداً،
// راجع dataviz skill: "قياسان مختلفا النطاق → رسمان منفصلان، لا محور ثانٍ").
// اللون لكل عنصر ثابت من نفس لوحة الألوان التصنيفية المستخدمة في
// app/dashboard/Projects/[id]/readings/page.tsx (SERIES_COLORS) — يبقى كل
// عنصر بنفس هويته اللونية أينما ظهر في الواجهة.
interface ReadingPoint {
  time: string;
  windSpeedKmh: number | null;
  windGustKmh: number | null;
  windDirectionDeg: number | null;
  pm10: number | null;
  pm25: number | null;
  visibilityM: number | null;
  relativeHumidityPercent: number | null;
  temperatureC: number | null;
}

interface ActivityReadingsSeries {
  activityGroupId: string;
  label: string;
  readings: ReadingPoint[];
}

const ELEMENTS: {
  key: keyof Omit<ReadingPoint, 'time'>;
  titleAr: string;
  unit: string;
  color: string;
}[] = [
  { key: 'pm10', titleAr: 'تركيز PM10', unit: 'µg/m³', color: '#3995FF' },
  { key: 'pm25', titleAr: 'تركيز PM2.5', unit: 'µg/m³', color: '#F97316' },
  { key: 'windSpeedKmh', titleAr: 'سرعة الرياح', unit: 'كم/س', color: '#10B981' },
  { key: 'windGustKmh', titleAr: 'هبّات الرياح', unit: 'كم/س', color: '#8B5CF6' },
  { key: 'visibilityM', titleAr: 'الرؤية', unit: 'م', color: '#06B6D4' },
  { key: 'relativeHumidityPercent', titleAr: 'الرطوبة النسبية', unit: '%', color: '#EAB308' },
  { key: 'temperatureC', titleAr: 'درجة الحرارة', unit: '°م', color: '#EF4444' },
];

// خطأ أداء مكتشَف ومُصلَح (تحقيق ضغط Compute/CPU/Disk IO على خطة Free):
// كانت هذه البطاقة تستطلع (poll) كل دقيقة بصرف النظر عن وصول قراءة جديدة
// فعلاً أم لا — بل تُركَّب مرة لكل بطاقة نشاط ظاهرة، فعدة بطاقات معاً تعني
// عدة استطلاعات متوازية لنفس المشروع. التحديث الفوري يصل الآن عبر اشتراك
// Realtime مُشترَك (useProjectDeviceReadingsRealtime، قناة واحدة لكل مشروع
// بصرف النظر عن عدد البطاقات). REFRESH_INTERVAL_MS يبقى فقط كشبكة أمان
// احتياطية بطيئة جداً تغطي فشل اتصال WebSocket صامت.
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_HOURS = 6;

function formatTimeAr(iso: string): string {
  return new Date(iso).toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Riyadh' });
}

function formatDateTimeAr(iso: string): string {
  return new Date(iso).toLocaleString('ar-SA', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Riyadh',
  });
}

// رسم واحد لعنصر واحد — سلسلة نقاط فعلية فقط (لا استيفاء)، خط 2px، نقطة
// نهاية بارزة (r=4، حلقة سطح 2px) بنفس مواصفات dataviz skill. بلا خريطة
// ألوان تسلسلية متدرجة هنا لأن كل رسم سلسلة واحدة فقط — لا حاجة لتدرّج.
function SingleElementChart({
  element,
  points,
}: {
  element: (typeof ELEMENTS)[number];
  points: ReadingPoint[];
}) {
  const data = points
    .filter((p) => p[element.key] !== null)
    .map((p) => ({ time: p.time, value: p[element.key] as number }));

  if (data.length === 0) {
    return (
      <div className="bg-slate-50 rounded-xl border border-dashed border-slate-200 p-4 text-center">
        <div className="text-[11px] font-bold text-slate-400">{element.titleAr} — لا توجد قراءات مسجَّلة بعد</div>
      </div>
    );
  }

  const latest = data[data.length - 1];

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-3">
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: element.color }} />
          <h4 className="text-[11px] font-black text-[#061B40]">{element.titleAr}</h4>
        </div>
        <span className="text-[11px] font-black text-[#061B40]" dir="ltr">
          {latest.value} <span className="text-slate-400 font-bold">{element.unit}</span>
        </span>
      </div>
      <div style={{ width: '100%', height: 110 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" vertical={false} />
            <XAxis
              dataKey="time"
              tickFormatter={formatTimeAr}
              tick={{ fontSize: 9, fill: '#898781' }}
              minTickGap={30}
              axisLine={{ stroke: '#E2E8F0' }}
              tickLine={false}
            />
            <YAxis
              tick={{ fontSize: 9, fill: '#898781' }}
              width={32}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip
              labelFormatter={(v) => formatDateTimeAr(String(v))}
              formatter={(value: ValueType | undefined) => [`${value ?? ''} ${element.unit}`, element.titleAr]}
              contentStyle={{ borderRadius: 10, border: '1px solid #E2E8F0', fontSize: 11, direction: 'rtl' }}
            />
            <Line
              type="monotone"
              dataKey="value"
              stroke={element.color}
              strokeWidth={2}
              dot={{ r: 2, fill: element.color, strokeWidth: 2, stroke: '#fff' }}
              activeDot={{ r: 4, strokeWidth: 2, stroke: '#fff' }}
              connectNulls={false}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// شبكة رسوم منفصلة لكل عنصر قياس — لنشاط واحد محدَّد (activityGroupId)،
// وليست مقارنة بين عدة أنشطة (ذاك دور صفحة app/dashboard/Projects/[id]/
// readings/page.tsx المنفصلة). تُعرض داخل بطاقة تفاصيل النشاط نفسها
// (ComplianceWidgetCard) — طلب صريح من المستخدم: "مؤشر للقراءات حق النشاط،
// رسم بياني منفصل لكل عنصر".
export default function ActivityReadingsCharts({
  projectId,
  activityGroupId,
}: {
  projectId?: string;
  activityGroupId?: string;
}) {
  const [series, setSeries] = useState<ActivityReadingsSeries | null>(null);
  // القيمة الابتدائية تعكس ما إذا كان الجلب سيُطلَق فعلياً (projectId/
  // activityGroupId متوفران) — بلا حاجة لتصحيحها لاحقاً false داخل الـEffect.
  const [loading, setLoading] = useState(Boolean(projectId && activityGroupId));
  const [error, setError] = useState<string | null>(null);

  // يُستدعى أيضاً من useProjectDeviceReadingsRealtime عند وصول قراءة جديدة
  // لهذا المشروع (silent=true) — راجع تعليق REFRESH_INTERVAL_MS أعلاه.
  const fetchHistoryRef = useRef<(silent?: boolean) => void>(() => {});

  useEffect(() => {
    if (!projectId || !activityGroupId) return;
    let cancelled = false;

    const fetchHistory = async (silent = false) => {
      try {
        if (!silent) setLoading(true);
        const { data } = await apiClient.get(`/projects/${projectId}/device-readings-history`, {
          params: { hours: DEFAULT_HOURS },
        });
        if (cancelled) return;
        const found = (data.activities || []).find((a: ActivityReadingsSeries) => a.activityGroupId === activityGroupId);
        setSeries(found ?? { activityGroupId, label: '', readings: [] });
        setError(null);
      } catch (err) {
        if (cancelled || silent) return;
        const axiosErr = err as AxiosError<{ error?: string }>;
        setError(axiosErr?.response?.data?.error || 'حدث خطأ أثناء جلب سجل قراءات النشاط');
      } finally {
        if (!cancelled && !silent) setLoading(false);
      }
    };

    fetchHistoryRef.current = fetchHistory;
    fetchHistory();
    const intervalId = window.setInterval(() => fetchHistory(true), REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [projectId, activityGroupId]);

  useProjectDeviceReadingsRealtime(projectId, () => fetchHistoryRef.current(true));

  if (!projectId || !activityGroupId) return null;

  return (
    <div className="mt-4">
      <div className="flex items-center gap-2 mb-3">
        <LineChartIcon className="w-4 h-4 text-[#3995FF]" />
        <h3 className="text-[12px] font-black text-[#061B40]">مؤشر القراءات لهذا النشاط</h3>
        <span className="text-[10px] font-bold text-slate-400">— آخر {DEFAULT_HOURS} ساعات، يتحدّث تلقائياً فور وصول قراءة جديدة</span>
      </div>

      {loading && (
        <div className="bg-slate-50 rounded-xl border border-dashed border-slate-200 p-6 text-center">
          <div className="text-[11px] font-bold text-slate-400 animate-pulse">جاري تحميل سجل القراءات...</div>
        </div>
      )}

      {!loading && error && (
        <div className="bg-red-50 rounded-xl border border-red-200 p-4 text-center text-[11px] font-bold text-red-600">
          {error}
        </div>
      )}

      {!loading && !error && series && series.readings.length === 0 && (
        <div className="bg-slate-50 rounded-xl border border-dashed border-slate-200 p-6 text-center">
          <div className="text-[11px] font-bold text-slate-400">
            لا توجد قراءات جهاز مسجَّلة لهذا النشاط خلال آخر {DEFAULT_HOURS} ساعات — يتطلب جهاز رصد مرتبط بالنشاط يرسل قراءات فعلية.
          </div>
        </div>
      )}

      {!loading && !error && series && series.readings.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
          {ELEMENTS.map((element) => (
            <SingleElementChart key={element.key} element={element} points={series.readings} />
          ))}
        </div>
      )}
    </div>
  );
}
