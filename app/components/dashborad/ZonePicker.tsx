'use client';

// =============================================================
// ZonePicker — Preview project zone on the map only. There is no
// manual drawing (no geoman nor editing tools) — the project zone is
// determined exclusively via KML import (file upload or raw text paste),
// and this component displays the result as a read-only Polygon/Circle.
// =============================================================

import { useEffect } from 'react';
import { useHasMounted } from '@/app/lib/useHasMounted';
import { MapContainer, TileLayer, Polygon, Circle, useMap } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import type { LatLng, ProjectZoneType } from '@/app/utils/geo/zone';
import { SAUDI_BOUNDS } from '@/app/utils/geo/countryBounds';

export interface ZonePickerValue {
  zoneType: ProjectZoneType;
  polygon: LatLng[] | null;
  circleCenter: LatLng | null;
  circleRadiusM: number | null;
}

interface ZonePickerProps {
  initialCenter: LatLng;
  value: ZonePickerValue;
  /** Kept in the interface for compatibility with existing invocations; no actual usage after removing manual drawing */
  onChange?: (value: ZonePickerValue) => void;
  readOnly?: boolean;
}

// Adjusts map bounds each time the zone changes (e.g., after importing a new KML) —
// a simple replacement for fitBounds tools previously tied to geoman events.
function FitToZone({ value }: { value: ZonePickerValue }) {
  const map = useMap();

  useEffect(() => {
    if (value.zoneType === 'polygon' && value.polygon && value.polygon.length >= 3) {
      const bounds = value.polygon.map((p) => [p.lat, p.lng] as [number, number]);
      map.fitBounds(bounds, { maxZoom: 18 });
    } else if (value.zoneType === 'circle' && value.circleCenter && value.circleRadiusM) {
      const center: [number, number] = [value.circleCenter.lat, value.circleCenter.lng];
      map.fitBounds(
        [
          [center[0] - value.circleRadiusM / 111000, center[1] - value.circleRadiusM / 111000],
          [center[0] + value.circleRadiusM / 111000, center[1] + value.circleRadiusM / 111000],
        ],
        { maxZoom: 18 }
      );
    }
  }, [map, value.zoneType, value.polygon, value.circleCenter, value.circleRadiusM]);

  return null;
}

export default function ZonePicker({ initialCenter, value }: ZonePickerProps) {
  const mounted = useHasMounted();

  if (!mounted) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-gray-200 text-[#061B40] text-sm font-semibold">
        جاري تحميل الخريطة...
      </div>
    );
  }

  return (
    <MapContainer
      center={[initialCenter.lat, initialCenter.lng]}
      zoom={15}
      minZoom={5}
      maxBounds={SAUDI_BOUNDS}
      maxBoundsViscosity={1.0}
      style={{ height: '100%', width: '100%' }}
      zoomControl={true}
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      <FitToZone value={value} />

      {value.zoneType === 'polygon' && value.polygon && value.polygon.length >= 3 && (
        <Polygon
          positions={value.polygon.map((p) => [p.lat, p.lng])}
          pathOptions={{ color: '#3995FF', fillColor: '#3995FF', fillOpacity: 0.2 }}
        />
      )}
      {value.zoneType === 'circle' && value.circleCenter && value.circleRadiusM && (
        <Circle
          center={[value.circleCenter.lat, value.circleCenter.lng]}
          radius={value.circleRadiusM}
          pathOptions={{ color: '#3995FF', fillColor: '#3995FF', fillOpacity: 0.2 }}
        />
      )}
    </MapContainer>
  );
}