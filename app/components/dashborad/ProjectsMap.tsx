"use client";

import { useEffect, useState } from 'react';
import { MapContainer, TileLayer, Marker, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

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
  decision: Decision;
  projectStatus?: string | null;
  todayActivitiesCount?: number;
}

const decisionLabelAr: Record<Decision, string> = {
  safe: 'آمن',
  caution: 'مناسب بحذر',
  restricted: 'مقيد',
  postpone: 'يُقترح تأجيله',
  stopped: 'إيقاف',
};

// بطاقة معلومات تظهر عند الهوفر (mouseover) على نقطة مشروع — موضعة بإحداثيات
// شاشة ثابتة (screenPosition) بدل Popup الافتراضي لأن الأخير يفتح بالنقر فقط
// ولا يدعم "تتبع الفأرة" بسلاسة.
function HoverCard({
  point,
  screenPosition,
}: {
  point: ProjectPoint;
  screenPosition: { x: number; y: number };
}) {
  return (
    <div
      className="absolute z-[1000] pointer-events-none bg-white rounded-xl shadow-lg border border-slate-200 p-3 min-w-[200px]"
      style={{ left: screenPosition.x + 14, top: screenPosition.y - 14, transform: 'translateY(-100%)' }}
      dir="rtl"
    >
      <div className="font-black text-[#061B40] text-sm mb-1">{point.name}</div>
      {point.city && <div className="text-xs text-slate-500 mb-2">{point.city}</div>}
      <div className="flex items-center gap-1.5 mb-1.5">
        <span
          className="w-2.5 h-2.5 rounded-full shrink-0"
          style={{ backgroundColor: decisionColor[point.decision] }}
        />
        <span className="text-xs font-bold text-slate-700">{decisionLabelAr[point.decision]}</span>
      </div>
      <div className="text-[11px] text-slate-500">
        الحالة: <span className="font-bold text-slate-700">{PROJECT_STATUS_LABEL_AR[point.projectStatus || ''] || 'غير محدد'}</span>
      </div>
      <div className="text-[11px] text-slate-500">
        أنشطة اليوم: <span className="font-bold text-slate-700">{point.todayActivitiesCount ?? 0}</span>
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
            icon={makeIcon(decisionColor[p.decision])}
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
