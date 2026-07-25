"use client";

import { useEffect, useState } from 'react';
import { MapContainer, TileLayer, Marker, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { apiClient } from '@/app/lib/apiClient';

export type Decision = 'safe' | 'caution' | 'restricted' | 'postpone' | 'stopped';

const decisionColor: Record<Decision, string> = {
  safe: '#10b981',
  caution: '#f59e0b',
  restricted: '#f97316',
  postpone: '#f43f5e',
  stopped: '#b91c1c',
};

const PROJECT_STATUS_LABEL_AR: Record<string, string> = {
  not_started: 'لم يبدأ',
  in_progress: 'جاري',
};

// أيقونة دائرية مخصصة بدل أيقونة Leaflet الافتراضية (اللي تنكسر مع Next.js/webpack)
function makeIcon(color: string) {
  return L.divIcon({
    className: '',
    html: `<div style="width:18px;height:18px;border-radius:9999px;background:${color};border:3px solid white;box-shadow:0 1px 4px rgba(0,0,0,0.35)"></div>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });
}

// يضبط تكبير/تمركز الخريطة تلقائياً بحيث تظهر كل نقاط المشاريع
function FitBounds({ points }: { points: { latitude: number; longitude: number }[] }) {
  const map = useMap();

  useEffect(() => {
    if (points.length === 0) return;
    if (points.length === 1) {
      map.setView([points[0].latitude, points[0].longitude], 11);
    } else {
      const bounds = L.latLngBounds(points.map((p) => [p.latitude, p.longitude] as [number, number]));
      map.fitBounds(bounds, { padding: [40, 40] });
    }
  }, [points, map]);

  return null;
}

export interface ProjectPoint {
  id: string;
  name: string;
  city?: string;
  latitude: number;
  longitude: number;
  // null = لا يوجد نشاط جارٍ الآن لهذا المشروع، فلا يوجد قرار لعرضه —
  // النقطة تُرسم بلون محايد بلا أي دلالة خطر/أمان (بطلب صريح من المستخدم:
  // "اذا لا يوجد نشاط لا تظهر قرارات"). القرار عند وجوده هو "القرار الموحد
  // للنشاط" (DVI + الامتثال التنظيمي)، راجع computeUnifiedActivityDecision
  // في app/lib/dustEvaluation.ts وliveActivityByProjectId في route.ts.
  decision: Decision | null;
  projectStatus?: string | null;
  todayActivitiesCount?: number;
  hasLiveActivity?: boolean;
  statusLabel?: string;
  statusReason?: string;
}

const decisionLabelAr: Record<Decision, string> = {
  safe: 'آمن',
  caution: 'مناسب بحذر',
  restricted: 'مقيد',
  postpone: 'يُقترح تأجيله',
  stopped: 'إيقاف',
};

// رمادي محايد — لا نشاط جارٍ الآن فلا قرار لعرضه إطلاقاً
const NO_ACTIVITY_COLOR = '#94a3b8';
const NO_ACTIVITY_LABEL_AR = 'لا يوجد نشاط جارٍ حالياً';

interface LiveWeather {
  windSpeedKmh: number | null;
  windDirectionDeg: number | null;
  pm10: number | null;
  pm25: number | null;
}

// يحوّل درجة اتجاه الرياح (خط الشمال = صفر، اتجاه دوران الساعة) إلى نص
// بوصلة عربي مختصر — أسهل قراءة سريعة من رقم الدرجات وحده
function degToCompassAr(deg: number): string {
  const directions = ['شمالية', 'شمالية شرقية', 'شرقية', 'جنوبية شرقية', 'جنوبية', 'جنوبية غربية', 'غربية', 'شمالية غربية'];
  const index = Math.round(deg / 45) % 8;
  return directions[index];
}

// بطاقة معلومات تظهر عند الهوفر (mouseover) على نقطة مشروع — موضعة بإحداثيات
// شاشة ثابتة (screenPosition) بدل Popup الافتراضي لأن الأخير يفتح بالنقر فقط
// ولا يدعم "تتبع الفأرة" بسلاسة. قراءات الطقس الحية (رياح/PM10/PM2.5) تُجلب
// كسولاً هنا فقط عند الهوفر الفعلي — لا دفعة واحدة لكل مشاريع الخريطة — عبر
// /api/weather (استثناء متعمَّد لقاعدة "لا نعرض رقماً خاماً" في dust-engine،
// مبرَّر هنا لأنها نظرة عامة على الخريطة لا شاشة قرار تشغيلي لنشاط محدد).
function HoverCard({
  point,
  screenPosition,
}: {
  point: ProjectPoint;
  screenPosition: { x: number; y: number };
}) {
  const [weather, setWeather] = useState<LiveWeather | null>(null);
  const [isLoadingWeather, setIsLoadingWeather] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setWeather(null);
    setIsLoadingWeather(true);
    apiClient
      .get('/weather', { params: { lat: point.latitude, lng: point.longitude } })
      .then(({ data }) => {
        if (!cancelled) setWeather(data?.data ?? null);
      })
      .catch(() => {
        if (!cancelled) setWeather(null);
      })
      .finally(() => {
        if (!cancelled) setIsLoadingWeather(false);
      });
    return () => {
      cancelled = true;
    };
  }, [point.id, point.latitude, point.longitude]);

  return (
    <div
      className="absolute z-[1000] pointer-events-none bg-white rounded-xl shadow-lg border border-slate-200 p-3 min-w-[220px]"
      style={{ left: screenPosition.x + 14, top: screenPosition.y - 14, transform: 'translateY(-100%)' }}
      dir="rtl"
    >
      <div className="font-black text-[#061B40] text-sm mb-1">{point.name}</div>
      {point.city && <div className="text-xs text-slate-500 mb-2">{point.city}</div>}
      <div className="flex items-center gap-1.5 mb-1">
        <span
          className="w-2.5 h-2.5 rounded-full shrink-0"
          style={{ backgroundColor: point.decision ? decisionColor[point.decision] : NO_ACTIVITY_COLOR }}
        />
        <span className="text-xs font-bold text-slate-700">
          {point.decision ? point.statusLabel || decisionLabelAr[point.decision] : NO_ACTIVITY_LABEL_AR}
        </span>
      </div>
      {point.hasLiveActivity && point.statusReason && (
        <div className="text-[11px] text-slate-500 mb-1.5 leading-relaxed">{point.statusReason}</div>
      )}
      <div className="text-[11px] text-slate-500">
        الحالة الإدارية: <span className="font-bold text-slate-700">{PROJECT_STATUS_LABEL_AR[point.projectStatus || ''] || 'غير محدد'}</span>
      </div>
      <div className="text-[11px] text-slate-500 mb-2">
        أنشطة اليوم: <span className="font-bold text-slate-700">{point.todayActivitiesCount ?? 0}</span>
      </div>

      <div className="pt-2 border-t border-slate-100 space-y-1">
        {isLoadingWeather ? (
          <div className="text-[11px] text-slate-400">جاري جلب قراءات الطقس...</div>
        ) : weather ? (
          <>
            <div className="text-[11px] text-slate-500">
              الرياح:{' '}
              <span className="font-bold text-slate-700">
                {weather.windSpeedKmh != null ? `${weather.windSpeedKmh} كم/س` : '—'}
                {weather.windDirectionDeg != null ? ` (${degToCompassAr(weather.windDirectionDeg)})` : ''}
              </span>
            </div>
            <div className="text-[11px] text-slate-500">
              PM10: <span className="font-bold text-slate-700">{weather.pm10 != null ? `${weather.pm10} µg/m³` : '—'}</span>
            </div>
            <div className="text-[11px] text-slate-500">
              PM2.5: <span className="font-bold text-slate-700">{weather.pm25 != null ? `${weather.pm25} µg/m³` : '—'}</span>
            </div>
          </>
        ) : (
          <div className="text-[11px] text-slate-400">تعذّر جلب قراءات الطقس</div>
        )}
      </div>
    </div>
  );
}

export default function ProjectsMap({
  points,
  onSelect,
}: {
  points: ProjectPoint[];
  onSelect?: (id: string) => void;
}) {
  const [hovered, setHovered] = useState<{ point: ProjectPoint; screenPosition: { x: number; y: number } } | null>(null);

  // الرياض كمركز افتراضي عند عدم وجود نقاط
  const defaultCenter: [number, number] =
    points.length > 0 ? [points[0].latitude, points[0].longitude] : [24.7136, 46.6753];

  return (
    <div className="relative w-full h-full">
      <MapContainer
        center={defaultCenter}
        zoom={6}
        scrollWheelZoom
        style={{ height: '100%', width: '100%' }}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <FitBounds points={points} />
        {points.map((p) => (
          <Marker
            key={p.id}
            position={[p.latitude, p.longitude]}
            icon={makeIcon(p.decision ? decisionColor[p.decision] : NO_ACTIVITY_COLOR)}
            eventHandlers={{
              click: () => onSelect?.(p.id),
              mouseover: (e) => {
                const containerPoint = e.target._map.latLngToContainerPoint(e.latlng);
                setHovered({ point: p, screenPosition: { x: containerPoint.x, y: containerPoint.y } });
              },
              mousemove: (e) => {
                const containerPoint = e.target._map.latLngToContainerPoint(e.latlng);
                setHovered((prev) => (prev ? { ...prev, screenPosition: { x: containerPoint.x, y: containerPoint.y } } : prev));
              },
              mouseout: () => setHovered(null),
            }}
          />
        ))}
      </MapContainer>
      {hovered && <HoverCard point={hovered.point} screenPosition={hovered.screenPosition} />}
    </div>
  );
}
