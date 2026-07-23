"use client";

import { useEffect } from 'react';
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet';
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

// أيقونة دائرية مخصصة بدل أيقونة Leaflet الافتراضية (اللي تنكسر مع Next.js/webpack)
function makeIcon(color: string) {
  return L.divIcon({
    className: '',
    html: `<div style="width:18px;height:18px;border-radius:9999px;background:${color};border:3px solid white;box-shadow:0 1px 4px rgba(0,0,0,0.35)"></div>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
    popupAnchor: [0, -10],
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
}

export default function ProjectsMap({
  points,
  onSelect,
}: {
  points: ProjectPoint[];
  onSelect?: (id: string) => void;
}) {
  // الرياض كمركز افتراضي عند عدم وجود نقاط
  const defaultCenter: [number, number] =
    points.length > 0 ? [points[0].latitude, points[0].longitude] : [24.7136, 46.6753];

  return (
    <MapContainer
      center={defaultCenter}
      zoom={6}
      scrollWheelZoom={false}
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
          eventHandlers={{ click: () => onSelect?.(p.id) }}
        >
          <Popup>
            <div style={{ fontWeight: 700, fontFamily: 'inherit' }}>{p.name}</div>
            {p.city && <div style={{ fontSize: 12, color: '#64748b' }}>{p.city}</div>}
          </Popup>
        </Marker>
      ))}
    </MapContainer>
  );
}
