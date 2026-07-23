'use client';

// =============================================================
// MultiActivityMapPicker — خريطة واحدة تعرض مواقع كل الأنشطة التنظيمية
// معاً. كل نشاط "عادي" نقطة واحدة (المرجع = item.lat/lng)، بينما أنشطة
// الخلاطة/الكسارة تعرض نقطة لكل وحدة (محطة خلط/كسارة) — موقع الوحدة الأولى
// هو نفسه موقع النشاط العام (مُتزامن تلقائياً في index.tsx)، فلا خريطة
// منفصلة "لموقع النشاط" مقابل "موقع الوحدة" لهذين النوعين. المستخدم يختار
// "النقطة النشِطة" (activePointId) من شريط الرقائق أعلى الخريطة، ثم ينقر
// على الخريطة لتحديد موقعها — أو ينقر على أي نقطة موجودة لتنشيطها.
// =============================================================

import { useState, useEffect } from 'react';
import 'leaflet/dist/leaflet.css';
import { MapContainer, TileLayer, Marker, Circle, Polygon, useMapEvents } from 'react-leaflet';
import { MapPin } from 'lucide-react';
import { MapController } from './MapController';
import type { ProjectZone } from '@/app/utils/geo/zone';
import { clampPointToZone, isPointInProjectZone } from '@/app/utils/geo/zone';
import type { RegulatoryActivityItem } from './constants';
import { REGULATORY_ACTIVITY_LABEL_AR } from './constants';

// ألوان مميزة متتابعة لكل نشاط — نقاط نفس النشاط (وحدات خلاطة/كسارة) تشترك
// في نفس اللون، وتُرقَّم فرعياً (1-1، 1-2، ...) لتمييزها عن بعضها
const MARKER_COLORS = ['#3995FF', '#F97316', '#10B981', '#EF4444', '#A855F7', '#EAB308', '#06B6D4', '#EC4899'];

// نقطة واحدة قابلة للتحديد على الخريطة — إما نشاط كامل (عادي) أو وحدة واحدة
// (محطة خلط/كسارة) ضمن نشاط خلاطة/كسارة
export interface MapPoint {
  id: string;
  itemId: string;
  label: string;
  colorIndex: number;
  numberLabel: string;
  lat: number | null;
  lng: number | null;
}

function buildNumberedIcon(numberLabel: string, color: string, isActive: boolean): any {
  if (typeof window === 'undefined') return undefined;
  const L = require('leaflet');
  const size = isActive ? 34 : 28;
  return L.divIcon({
    className: '',
    html: `<div style="
      width:${size}px;height:${size}px;border-radius:50%;
      background:${color};color:#fff;display:flex;align-items:center;justify-content:center;
      font-weight:800;font-size:${isActive ? 12 : 11}px;border:${isActive ? 3 : 2}px solid #fff;
      box-shadow:0 1px 4px rgba(0,0,0,0.4);
    ">${numberLabel}</div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
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

// يبني قائمة النقاط القابلة للتحديد من كل الأنشطة — نقطة واحدة للأنشطة
// العادية، ونقطة لكل وحدة لأنشطة الخلاطة/الكسارة (بلا نقطة إضافية لموقع
// النشاط العام، لأنه نفسه موقع الوحدة الأولى).
export function buildMapPoints(items: RegulatoryActivityItem[]): MapPoint[] {
  const points: MapPoint[] = [];
  items.forEach((item, index) => {
    const activityLabel = REGULATORY_ACTIVITY_LABEL_AR[item.fields.regulatoryActivity] || item.fields.regulatoryActivity;
    if (item.fields.regulatoryActivity === 'BATCHING_PLANT' && item.batchingUnits.length > 0) {
      item.batchingUnits.forEach((unit, unitIndex) => {
        points.push({
          id: `${item.id}:batching:${unitIndex}`,
          itemId: item.id,
          label: `${activityLabel} — محطة ${unitIndex + 1}`,
          colorIndex: index,
          numberLabel: `${index + 1}-${unitIndex + 1}`,
          lat: typeof unit.batchingLat === 'number' ? unit.batchingLat : null,
          lng: typeof unit.batchingLng === 'number' ? unit.batchingLng : null,
        });
      });
    } else if (item.fields.regulatoryActivity === 'CRUSHER' && item.crusherUnits.length > 0) {
      item.crusherUnits.forEach((unit, unitIndex) => {
        points.push({
          id: `${item.id}:crusher:${unitIndex}`,
          itemId: item.id,
          label: `${activityLabel} — كسارة ${unitIndex + 1}`,
          colorIndex: index,
          numberLabel: `${index + 1}-${unitIndex + 1}`,
          lat: typeof unit.crusherLat === 'number' ? unit.crusherLat : null,
          lng: typeof unit.crusherLng === 'number' ? unit.crusherLng : null,
        });
      });
    } else {
      points.push({
        id: item.id,
        itemId: item.id,
        label: activityLabel,
        colorIndex: index,
        numberLabel: String(index + 1),
        lat: item.lat,
        lng: item.lng,
      });
    }
  });
  return points;
}

interface MultiActivityMapPickerProps {
  items: RegulatoryActivityItem[];
  activePointId: string | null;
  onActivate: (pointId: string) => void;
  onPointLocationChange: (point: MapPoint, lat: number, lng: number) => void;
  isMounted: boolean;
  centerLat: number;
  centerLng: number;
  projectZone: ProjectZone;
}

export function MultiActivityMapPicker({
  items,
  activePointId,
  onActivate,
  onPointLocationChange,
  isMounted,
  centerLat,
  centerLng,
  projectZone,
}: MultiActivityMapPickerProps) {
  const points = buildMapPoints(items);
  const activePoint = points.find((p) => p.id === activePointId) || null;
  const activePosition: [number, number] | null =
    activePoint && typeof activePoint.lat === 'number' && typeof activePoint.lng === 'number'
      ? [activePoint.lat, activePoint.lng]
      : null;
  const isActiveOutside =
    activePosition !== null && !isPointInProjectZone({ lat: activePosition[0], lng: activePosition[1] }, projectZone);

  const handlePick = (rawLat: number, rawLng: number) => {
    if (!activePoint) return;
    const clamped = clampPointToZone({ lat: rawLat, lng: rawLng }, projectZone);
    onPointLocationChange(activePoint, clamped.lat, clamped.lng);
  };

  // إدخال يدوي للإحداثيات كبديل عن النقر على الخريطة — نصوص محلية حتى يقدر
  // المستخدم يكتب بحرية (مثلاً يمسح الحقل مؤقتاً) قبل أن يُطبَّق التغيير
  // الفعلي (قصّ داخل حدود المشروع) عند اكتمال رقم صالح.
  const [latText, setLatText] = useState('');
  const [lngText, setLngText] = useState('');
  useEffect(() => {
    setLatText(activePosition ? String(activePosition[0]) : '');
    setLngText(activePosition ? String(activePosition[1]) : '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePointId, activePosition?.[0], activePosition?.[1]]);

  const commitManualCoords = (nextLatText: string, nextLngText: string) => {
    if (!activePoint) return;
    const lat = Number(nextLatText);
    const lng = Number(nextLngText);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return;
    const clamped = clampPointToZone({ lat, lng }, projectZone);
    onPointLocationChange(activePoint, clamped.lat, clamped.lng);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-sm font-bold text-[#061B40]">
        <MapPin className="w-4 h-4 text-[#3995FF]" />
        مواقع الأنشطة التنظيمية على الخريطة
        <span className="text-red-500">*</span>
      </div>
      <p className="text-xs text-[#061B40]/60">
        اختر النقطة من الشريط أدناه ثم انقر على الخريطة لتحديد موقعها — يجب أن تقع كل المواقع داخل حدود المشروع.
        لأنشطة الخلاطة/الكسارة: موقع كل وحدة هو نفسه، وموقع الوحدة الأولى يمثّل موقع النشاط ذاته.
      </p>

      {points.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {points.map((point) => {
            const color = MARKER_COLORS[point.colorIndex % MARKER_COLORS.length];
            const hasLocation = typeof point.lat === 'number' && typeof point.lng === 'number';
            const isActive = point.id === activePointId;
            return (
              <button
                key={point.id}
                type="button"
                onClick={() => onActivate(point.id)}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold border transition-all ${
                  isActive ? 'text-white' : 'bg-white text-[#061B40] hover:bg-gray-50'
                }`}
                style={isActive ? { backgroundColor: color, borderColor: color } : { borderColor: color }}
              >
                <span
                  className="w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-black shrink-0"
                  style={{ backgroundColor: isActive ? 'rgba(255,255,255,0.3)' : color, color: '#fff' }}
                >
                  {point.numberLabel}
                </span>
                {point.label}
                {!hasLocation && <span className="text-red-500">●</span>}
              </button>
            );
          })}
        </div>
      )}

      {/* إدخال يدوي للإحداثيات — بديل عن النقر على الخريطة، للنقطة النشِطة
          فقط. يُقيَّد داخل حدود منطقة المشروع بنفس منطق النقر تماماً. */}
      {activePoint && (
        <div className="flex flex-wrap items-end gap-2 bg-[#F4F7FB] rounded-lg border border-[#061B40]/10 p-2.5">
          <div className="flex-1 min-w-[110px]">
            <label className="block text-[11px] font-bold text-[#061B40]/60 mb-1">خط العرض (Latitude)</label>
            <input
              type="text"
              inputMode="decimal"
              placeholder="مثال: 24.7136"
              value={latText}
              onChange={(e) => setLatText(e.target.value)}
              onBlur={() => commitManualCoords(latText, lngText)}
              className="w-full border border-[#061B40]/20 rounded-lg p-1.5 text-xs bg-white focus:outline-none focus:ring-1 focus:ring-[#3995FF]"
              dir="ltr"
            />
          </div>
          <div className="flex-1 min-w-[110px]">
            <label className="block text-[11px] font-bold text-[#061B40]/60 mb-1">خط الطول (Longitude)</label>
            <input
              type="text"
              inputMode="decimal"
              placeholder="مثال: 46.6753"
              value={lngText}
              onChange={(e) => setLngText(e.target.value)}
              onBlur={() => commitManualCoords(latText, lngText)}
              className="w-full border border-[#061B40]/20 rounded-lg p-1.5 text-xs bg-white focus:outline-none focus:ring-1 focus:ring-[#3995FF]"
              dir="ltr"
            />
          </div>
          <button
            type="button"
            onClick={() => commitManualCoords(latText, lngText)}
            className="text-xs font-bold px-3 py-1.5 rounded-lg bg-[#3995FF] text-white hover:bg-[#3995FF]/90 transition-colors shrink-0"
          >
            تطبيق
          </button>
        </div>
      )}

      {isMounted && typeof window !== 'undefined' ? (
        <div className="w-full h-[340px] rounded-xl border border-[#061B40]/20 shadow-inner relative z-0">
          <MapContainer center={[centerLat, centerLng]} zoom={16} scrollWheelZoom style={{ height: '100%', width: '100%', zIndex: 10 }}>
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />
            <MapController lat={centerLat} lng={centerLng} />
            <ClickHandler onClick={handlePick} />

            {projectZone.zoneType === 'polygon' && projectZone.polygon && (
              <Polygon
                positions={projectZone.polygon.map((p) => [p.lat, p.lng])}
                pathOptions={{ color: '#061B40', fillOpacity: 0.03, weight: 1.5, dashArray: '4 4' }}
              />
            )}
            {projectZone.zoneType === 'circle' && projectZone.circleCenter && projectZone.circleRadiusM && (
              <Circle
                center={[projectZone.circleCenter.lat, projectZone.circleCenter.lng]}
                radius={projectZone.circleRadiusM}
                pathOptions={{ color: '#061B40', fillOpacity: 0.03, weight: 1.5, dashArray: '4 4' }}
              />
            )}

            {points.map((point) => {
              if (typeof point.lat !== 'number' || typeof point.lng !== 'number') return null;
              const color = MARKER_COLORS[point.colorIndex % MARKER_COLORS.length];
              const isActive = point.id === activePointId;
              return (
                <Marker
                  key={point.id}
                  position={[point.lat, point.lng]}
                  icon={buildNumberedIcon(point.numberLabel, color, isActive)}
                  draggable={isActive}
                  eventHandlers={{
                    click: () => onActivate(point.id),
                    dragend: (e: any) => {
                      const newPos = e.target.getLatLng();
                      const clamped = clampPointToZone({ lat: newPos.lat, lng: newPos.lng }, projectZone);
                      onPointLocationChange(point, clamped.lat, clamped.lng);
                    },
                  }}
                />
              );
            })}
          </MapContainer>
        </div>
      ) : (
        <div className="w-full h-[340px] bg-slate-100 rounded-xl flex items-center justify-center text-slate-500 border-2 border-dashed border-slate-300">
          <span className="text-sm font-bold animate-pulse">جاري تحميل الخريطة...</span>
        </div>
      )}

      {activePoint && !activePosition && (
        <p className="text-[11px] font-bold text-amber-600">
          لم يُحدَّد موقع النقطة المختارة بعد — انقر على الخريطة أعلاه.
        </p>
      )}
      {isActiveOutside && (
        <p className="text-[11px] font-bold text-red-600">تنبيه: الموقع المحدد خارج حدود المشروع — سيُعاد ضبطه تلقائياً.</p>
      )}
    </div>
  );
}
