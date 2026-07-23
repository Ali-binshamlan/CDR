'use client';

// =============================================================
// SinglePointMapPicker — تحديد نقطة واحدة على الخريطة بالنقر أو السحب.
// يقبل ProjectZone اختيارية (مضلع/دائرة): إن مُررت، تُعرض حدود المشروع
// كخط مرجعي على الخريطة ويُقيَّد الاختيار داخلها (قصّ تلقائي)، بنفس
// سلوك MultiActivityMapPicker تماماً. بلا ProjectZone، لا يوجد أي قيد
// (يُستخدم مثلاً لموقع الكسارة الذي قد يقع فعلياً خارج حدود المشروع).
// =============================================================

import 'leaflet/dist/leaflet.css';
import { MapContainer, TileLayer, Marker, Circle, Polygon, useMapEvents } from 'react-leaflet';
import { MapPin } from 'lucide-react';
import { MapController } from './MapController';
import type { ProjectZone } from '@/app/utils/geo/zone';
import { clampPointToZone, isPointInProjectZone } from '@/app/utils/geo/zone';

let customIcon: any = null;
if (typeof window !== 'undefined') {
  const L = require('leaflet');
  customIcon = new L.Icon({
    iconUrl: 'https://unpkg.com/leaflet@1.7.1/dist/images/marker-icon.png',
    iconRetinaUrl: 'https://unpkg.com/leaflet@1.7.1/dist/images/marker-icon-2x.png',
    shadowUrl: 'https://unpkg.com/leaflet@1.7.1/dist/images/marker-shadow.png',
    iconSize: [25, 41],
    iconAnchor: [12, 41],
    popupAnchor: [1, -34],
  });
}

function ClickHandler({ onClick }: { onClick: (lat: number, lng: number) => void }) {
  useMapEvents({
    click(e) {
      onClick(e.latlng.lat, e.latlng.lng);
    },
  });
  return null;
}

interface SinglePointMapPickerProps {
  label: string;
  isMounted: boolean;
  lat: number | null;
  lng: number | null;
  onChange: (lat: number, lng: number) => void;
  centerLat?: number;
  centerLng?: number;
  required?: boolean;
  /** إن مُررت: تُعرض حدود المشروع كخط مرجعي، ويُقيَّد الاختيار داخلها تلقائياً. */
  projectZone?: ProjectZone;
}

export function SinglePointMapPicker({
  label,
  isMounted,
  lat,
  lng,
  onChange,
  centerLat = 24.7136,
  centerLng = 46.6753,
  required = false,
  projectZone,
}: SinglePointMapPickerProps) {
  const position: [number, number] | null = typeof lat === 'number' && typeof lng === 'number' ? [lat, lng] : null;
  const mapCenter: [number, number] = position ?? [centerLat, centerLng];

  const isOutside =
    !!projectZone && position !== null && !isPointInProjectZone({ lat: position[0], lng: position[1] }, projectZone);

  const handlePick = (rawLat: number, rawLng: number) => {
    if (projectZone) {
      const clamped = clampPointToZone({ lat: rawLat, lng: rawLng }, projectZone);
      onChange(clamped.lat, clamped.lng);
    } else {
      onChange(rawLat, rawLng);
    }
  };

  const handleDragEnd = (e: any) => {
    const marker = e.target;
    const newPos = marker.getLatLng();
    if (projectZone) {
      const clamped = clampPointToZone({ lat: newPos.lat, lng: newPos.lng }, projectZone);
      if (clamped.lat !== newPos.lat || clamped.lng !== newPos.lng) {
        marker.setLatLng([clamped.lat, clamped.lng]);
      }
      onChange(clamped.lat, clamped.lng);
    } else {
      onChange(newPos.lat, newPos.lng);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-sm font-bold text-[#061B40]">
        <MapPin className="w-4 h-4 text-[#3995FF]" />
        {label}
        {required && <span className="text-red-500">*</span>}
      </div>
      {projectZone && (
        <p className="text-xs text-[#061B40]/60">يجب أن يقع الموقع داخل حدود المشروع المرسومة — سيُعاد ضبطه تلقائياً إن نُقر خارجها.</p>
      )}

      {isMounted && typeof window !== 'undefined' ? (
        <div className="w-full h-[220px] rounded-xl border border-[#061B40]/20 shadow-inner relative z-0">
          <MapContainer center={mapCenter} zoom={position ? 16 : 12} scrollWheelZoom style={{ height: '100%', width: '100%', zIndex: 10 }}>
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />
            <MapController lat={mapCenter[0]} lng={mapCenter[1]} />
            <ClickHandler onClick={handlePick} />

            {projectZone?.zoneType === 'polygon' && projectZone.polygon && (
              <Polygon
                positions={projectZone.polygon.map((p) => [p.lat, p.lng])}
                pathOptions={{ color: '#061B40', fillOpacity: 0.03, weight: 1.5, dashArray: '4 4' }}
              />
            )}
            {projectZone?.zoneType === 'circle' && projectZone.circleCenter && projectZone.circleRadiusM && (
              <Circle
                center={[projectZone.circleCenter.lat, projectZone.circleCenter.lng]}
                radius={projectZone.circleRadiusM}
                pathOptions={{ color: '#061B40', fillOpacity: 0.03, weight: 1.5, dashArray: '4 4' }}
              />
            )}

            {position && (
              <Marker
                position={position}
                icon={customIcon}
                draggable
                eventHandlers={{ dragend: handleDragEnd }}
              />
            )}
          </MapContainer>
        </div>
      ) : (
        <div className="w-full h-[220px] bg-slate-100 rounded-xl flex items-center justify-center text-slate-500 border-2 border-dashed border-slate-300">
          <span className="text-sm font-bold animate-pulse">جاري تحميل الخريطة...</span>
        </div>
      )}

      {!position && (
        <p className="text-[11px] font-bold text-amber-600">لم يُحدَّد الموقع بعد — انقر على الخريطة أعلاه.</p>
      )}
      {isOutside && (
        <p className="text-[11px] font-bold text-red-600">تنبيه: الموقع المحدد خارج حدود المشروع — سيُعاد ضبطه تلقائياً.</p>
      )}
    </div>
  );
}
