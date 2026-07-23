'use client';

// =============================================================
// ZonePicker — معاينة منطقة المشروع (zone) على الخريطة فقط. لا يوجد
// رسم يدوي (لا geoman ولا أدوات تحرير) — منطقة المشروع تُحدَّد حصراً
// عبر استيراد KML (رفع ملف أو لصق نص خام)، ويعرض هذا المكوّن النتيجة
// كـ Polygon/Circle للقراءة فقط.
// =============================================================

import { useEffect, useState } from 'react';
import { MapContainer, TileLayer, Polygon, Circle, useMap } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import type { LatLng, ProjectZoneType } from '@/app/utils/geo/zone';

export interface ZonePickerValue {
  zoneType: ProjectZoneType;
  polygon: LatLng[] | null;
  circleCenter: LatLng | null;
  circleRadiusM: number | null;
}

interface ZonePickerProps {
  initialCenter: LatLng;
  value: ZonePickerValue;
  /** يبقى في الواجهة للتوافق مع الاستدعاءات الحالية؛ لا استخدام فعلياً بعد إزالة الرسم اليدوي */
  onChange?: (value: ZonePickerValue) => void;
  readOnly?: boolean;
}

// يُعيد ضبط حدود الخريطة كل مرة تتغيّر فيها المنطقة (مثلاً بعد استيراد KML
// جديد) — بديل بسيط لأدوات fitBounds التي كانت مرتبطة سابقاً بأحداث geoman.
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, value.zoneType, value.polygon, value.circleCenter, value.circleRadiusM]);

  return null;
}

export default function ZonePicker({ initialCenter, value }: ZonePickerProps) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

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
