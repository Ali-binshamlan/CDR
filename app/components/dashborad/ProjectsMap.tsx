"use client";

import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { MapContainer, TileLayer, Marker, useMap, useMapEvent } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { apiClient } from '@/app/lib/apiClient';
import { SAUDI_BOUNDS, SAUDI_CENTER } from '@/app/utils/geo/countryBounds';
import type { Decision } from '@/app/lib/decisionMeta';

// Explicit user request: This was previously a local standalone copy independent of decisionMeta.ts (the same
// five old values rewritten here) — risk of silent drift if the single source of truth there was updated without
// updating this file in sync (exactly what happened when Decision was simplified to 3 levels). Now it imports
// the type directly, and the colors correspond to the same 3 levels (safe/restricted/stopped).
export type { Decision };

const decisionColor: Record<Decision, string> = {
  safe: '#10b981',
  restricted: '#f59e0b',
  stopped: '#b91c1c',
};

const PROJECT_STATUS_LABEL_AR: Record<string, string> = {
  not_started: 'لم يبدأ',
  in_progress: 'جاري',
};

// Custom circular icon instead of default Leaflet icon (which breaks with Next.js/webpack)
function makeIcon(color: string) {
  return L.divIcon({
    className: '',
    html: `<div style="width:18px;height:18px;border-radius:9999px;background:${color};border:3px solid white;box-shadow:0 1px 4px rgba(0,0,0,0.35)"></div>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });
}

// Automatically adjusts map zoom/center so that all project points are visible — but without
// exceeding the strict Saudi boundaries (SAUDI_BOUNDS), so auto-zoom doesn't "escape"
// outside the allowed region even if project points actually exist outside it.
function FitBounds({ points }: { points: { latitude: number; longitude: number }[] }) {
  const map = useMap();

  useEffect(() => {
    if (points.length === 0) return;
    const saudi = L.latLngBounds(SAUDI_BOUNDS);
    const withinSaudi = points.filter((p) => saudi.contains([p.latitude, p.longitude]));
    if (withinSaudi.length === 0) return;
    if (withinSaudi.length === 1) {
      map.setView([withinSaudi[0].latitude, withinSaudi[0].longitude], 11);
    } else {
      const bounds = L.latLngBounds(withinSaudi.map((p) => [p.latitude, p.longitude] as [number, number]));
      map.fitBounds(bounds, { padding: [40, 40] });
    }
  }, [points, map]);

  return null;
}

// Closes the pinned card when clicking anywhere else on the map (background without
// a project point) — clicking the marker itself is handled directly in eventHandlers
// above; this is only for clicking outside any marker.
function CloseCardOnMapClick({ onClose }: { onClose: () => void }) {
  useMapEvent('click', onClose);
  return null;
}

export interface ProjectPoint {
  id: string;
  name: string;
  city?: string;
  latitude: number;
  longitude: number;
  // null = no active ongoing activity for this project, so there is no decision to display —
  // the point is drawn in a neutral color without risk/safety indication (by explicit user request:
  // "if there is no activity, do not show decisions"). The decision when present is the "unified
  // activity decision" (DVI + regulatory compliance), see computeUnifiedActivityDecision
  // in app/lib/dustEvaluation.ts and liveActivityByProjectId in route.ts.
  decision: Decision | null;
  projectStatus?: string | null;
  todayActivitiesCount?: number;
  hasLiveActivity?: boolean;
  statusLabel?: string;
  statusReason?: string;
  /** Timestamp of recording the current decision (final_decisions.evaluated_at) — explicit request from
   * monitoring entity: displays "when was this violation recorded" rather than current load time. */
  decisionEvaluatedAt?: string | null;
  /** Actual reading that generated this specific decision (device_readings_history
   * closest to decisionEvaluatedAt), not current live reading — they may differ
   * completely if conditions changed since recording time. */
  decisionReadingPm10UgM3?: number | null;
  decisionReadingWindSpeedKmh?: number | null;
}

const decisionLabelAr: Record<Decision, string> = {
  safe: 'سماح',
  restricted: 'مراقبة',
  stopped: 'إيقاف',
};

// Neutral gray — no activity in progress so no decision to display at all
const NO_ACTIVITY_COLOR = '#94a3b8';
const NO_ACTIVITY_LABEL_AR = 'لا يوجد نشاط جارٍ حالياً';

interface LiveWeather {
  windSpeedKmh: number | null;
  windDirectionDeg: number | null;
  pm10: number | null;
  pm25: number | null;
}

// Converts wind direction degrees (North line = 0, clockwise direction) to a concise
// Arabic compass text — easier for quick reading than degree numbers alone
function degToCompassAr(deg: number): string {
  const directions = ['شمالية', 'شمالية شرقية', 'شرقية', 'جنوبية شرقية', 'جنوبية', 'جنوبية غربية', 'غربية', 'شمالية غربية'];
  const index = Math.round(deg / 45) % 8;
  return directions[index];
}

// Decision recording time — in Riyadh time, formatted as a concise date+time sufficient for
// hover card context (no seconds needed).
function formatDecisionTimeAr(iso: string): string {
  const d = new Date(iso);
  const datePart = d.toLocaleDateString('ar-SA', { day: 'numeric', month: 'short', timeZone: 'Asia/Riyadh', calendar: 'gregory' });
  const timePart = d.toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Riyadh', calendar: 'gregory' });
  return `${datePart} — ${timePart}`;
}

// Info card for a project point — positioned via fixed screen coordinates (screenPosition)
// instead of default Popup because the latter does not smoothly support "mouse tracking" on hover.
// Live weather readings (wind/PM10/PM2.5) are lazily fetched here only when the card is actually
// opened — not all at once for all map projects — via /api/weather (an intentional
// exception to the "no raw numbers" rule in dust-engine, justified here because it is a general
// map overview, not an operational decision screen for a specific activity).
//
// Discovered and fixed accessibility bug ("Map relied on hover, weakening touch and keyboard usability"):
// this card appeared exclusively via mouseover/mousemove/mouseout — with no alternative path via
// touch (which never fires these events) or keyboard (focus only reached click handler, not hover).
// Now it opens via tap/click, keyboard focus (Tab), or Enter/Space on the marker itself,
// and closes via clicking outside, Escape, or the explicit close button inside — same content without
// compromising accessibility mechanism.
function HoverCard({
  point,
  screenPosition,
  hideRawReadings = false,
  minimal = false,
  onSelect,
  onClose,
}: {
  point: ProjectPoint;
  screenPosition: { x: number; y: number };
  // Explicit user request: Monitoring entity is not shown raw live readings
  // (wind/PM10/PM2.5) — name/location/decision color and status/status reason remain
  // visible as is. When enabled, /api/weather is not called at all (not just
  // hiding after fetch) — saving unnecessary network request.
  hideRawReadings?: boolean;
  // Subsequent explicit request from user (monitoring entity only): hover card shows only
  // project name/city and violation status — all other details are hidden (status
  // reason, administrative status, today's activities count, and all weather readings).
  minimal?: boolean;
  // "View Details" button inside card — first click on marker opens card (hover alternative),
  // does not navigate immediately; actual navigation to project page occurs only from this
  // explicit button inside card.
  onSelect?: () => void;
  onClose: () => void;
}) {
  const [weather, setWeather] = useState<LiveWeather | null>(null);
  // Initial value reflects whether request will actually be fired — hideRawReadings/
  // minimal prevent fetch entirely (see condition below), so no need to start true then
  // correct to false later inside Effect.
  const [isLoadingWeather, setIsLoadingWeather] = useState(!hideRawReadings && !minimal);

  useEffect(() => {
    if (hideRawReadings || minimal) return;
    let cancelled = false;
    // Scheduled via microtask instead of calling setWeather/setIsLoadingWeather directly
    // from Effect body — direct synchronous state update inside Effect (same documented
    // reason as in fetchDevices/fetchHistory on project pages).
    void Promise.resolve().then(() => {
      if (cancelled) return;
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
    });
    return () => {
      cancelled = true;
    };
  }, [point.id, point.latitude, point.longitude, hideRawReadings, minimal]);

  return (
    <div
      role="dialog"
      aria-label={`تفاصيل ${point.name}`}
      className="absolute z-[1000] bg-white rounded-xl shadow-lg border border-slate-200 p-3 min-w-[220px]"
      style={{ left: screenPosition.x + 14, top: screenPosition.y - 14, transform: 'translateY(-100%)' }}
      dir="rtl"
    >
      <div className="flex items-start justify-between gap-2 mb-1">
        <div className="font-black text-[#061B40] text-sm">{point.name}</div>
        <button
          type="button"
          onClick={onClose}
          aria-label="إغلاق"
          className="shrink-0 text-slate-400 hover:text-slate-600 text-xs font-bold leading-none w-4 h-4 flex items-center justify-center"
        >
          ✕
        </button>
      </div>
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
      {!minimal && point.hasLiveActivity && point.statusReason && (
        <div className="text-[11px] text-slate-500 mb-1.5 leading-relaxed">{point.statusReason}</div>
      )}

      {/* Explicit request from monitoring entity: Violation recording time + actual readings
          specifically at recording time (not current live reading) — displayed even in minimal
          mode, unlike other details intentionally hidden for this mode. */}
      {point.hasLiveActivity && point.decisionEvaluatedAt && (
        <div className="text-[11px] text-slate-500 mb-1.5 pt-1.5 border-t border-slate-100 space-y-0.5">
          <div>
            وقت التسجيل: <span className="font-bold text-slate-700">{formatDecisionTimeAr(point.decisionEvaluatedAt)}</span>
          </div>
          {(point.decisionReadingPm10UgM3 !== null && point.decisionReadingPm10UgM3 !== undefined) && (
            <div>
              PM10 وقت التسجيل: <span className="font-bold text-slate-700">{point.decisionReadingPm10UgM3} µg/m³</span>
            </div>
          )}
          {(point.decisionReadingWindSpeedKmh !== null && point.decisionReadingWindSpeedKmh !== undefined) && (
            <div>
              الرياح وقت التسجيل: <span className="font-bold text-slate-700">{point.decisionReadingWindSpeedKmh} كم/س</span>
            </div>
          )}
        </div>
      )}

      {!minimal && (
        <div className="text-[11px] text-slate-500">
          الحالة الإدارية: <span className="font-bold text-slate-700">{PROJECT_STATUS_LABEL_AR[point.projectStatus || ''] || 'غير محدد'}</span>
        </div>
      )}
      {!minimal && (
        <div className="text-[11px] text-slate-500 mb-2">
          أنشطة اليوم: <span className="font-bold text-slate-700">{point.todayActivitiesCount ?? 0}</span>
        </div>
      )}

      {!hideRawReadings && !minimal && (
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
      )}

      {onSelect && (
        <button
          type="button"
          onClick={onSelect}
          className="mt-2 pt-2 border-t border-slate-100 w-full text-center text-[11px] font-bold text-[#0176FB] hover:underline"
        >
          عرض التفاصيل
        </button>
      )}
    </div>
  );
}

interface ActiveCardState {
  point: ProjectPoint;
  screenPosition: { x: number; y: number };
  pinned: boolean;
}

type SetActiveCard = Dispatch<SetStateAction<ActiveCardState | null>>;

// Single project marker on map. Extracted as standalone component (instead of inline Marker
// inside loop) because binding 'focus' event requires direct access to L.Marker object via ref —
// 'focus' is actually supported at runtime in Leaflet (marker icon is focusable by default,
// tabIndex=0 + role=button) but doesn't exist in LeafletEventHandlerFnMap type used in
// eventHandlers prop, so cannot be passed through it directly in a type-safe manner.
function ProjectMarker({ point: p, setActiveCard }: { point: ProjectPoint; setActiveCard: SetActiveCard }) {
  const markerRef = useRef<L.Marker | null>(null);

  useEffect(() => {
    const marker = markerRef.current;
    if (!marker) return;
    const handleFocus = () => {
      const map = (marker as unknown as { _map: L.Map })._map;
      const containerPoint = map.latLngToContainerPoint(marker.getLatLng());
      setActiveCard({ point: p, screenPosition: { x: containerPoint.x, y: containerPoint.y }, pinned: true });
    };
    marker.on('focus', handleFocus);
    return () => {
      marker.off('focus', handleFocus);
    };
  }, [p, setActiveCard]);

  return (
    <Marker
      ref={markerRef}
      position={[p.latitude, p.longitude]}
      icon={makeIcon(p.decision ? decisionColor[p.decision] : NO_ACTIVITY_COLOR)}
      eventHandlers={{
        // Click/tap (as well as Enter/Space via keyboard, or Tab focus
        // — see marker.on('focus', ...) above) opens the same info card
        // previously shown on hover only — an equivalent alternative that works for touch and
        // keyboard alike. Second click on the same point (or close button inside
        // card) closes it. "View Details" button inside card is the sole path
        // for actual navigation to project page (onSelect) — automatically disappears in
        // minimal mode because onSelect is not passed from parent in that case.
        click: (e) => {
          // Prevent event from bubbling to map click handler (CloseCardOnMapClick) — without this,
          // clicking marker would open card then immediately close it on same click via
          // map event bubbling.
          L.DomEvent.stopPropagation(e);
          const containerPoint = e.target._map.latLngToContainerPoint(e.latlng);
          setActiveCard((prev) =>
            prev?.pinned && prev.point.id === p.id
              ? null
              : { point: p, screenPosition: { x: containerPoint.x, y: containerPoint.y }, pinned: true }
          );
        },
        keypress: (e) => {
          const key = e.originalEvent.key;
          if (key !== 'Enter' && key !== ' ') return;
          const containerPoint = e.target._map.latLngToContainerPoint(e.target.getLatLng());
          setActiveCard({ point: p, screenPosition: { x: containerPoint.x, y: containerPoint.y }, pinned: true });
        },
        keydown: (e) => {
          if (e.originalEvent.key !== 'Escape') return;
          setActiveCard((prev) => (prev?.point.id === p.id ? null : prev));
        },
        // Intentionally no blur handler to close card — card is rendered outside marker's DOM
        // tree (absolute positioning above map), so Tab from marker to access
        // its buttons (close/view details) doesn't pass through "marker's own focus" but
        // jumps to next element in page sequence. If card closed on blur, no keyboard
        // user would ever reach those buttons. Card stays open until explicit close
        // (close button, Escape, or clicking outside via CloseCardOnMapClick).
        //
        // Hover remains a quick additional preview for mouse users only — does not replace
        // an already pinned card opened by click/focus on another point.
        mouseover: (e) => {
          setActiveCard((prev) => {
            if (prev?.pinned) return prev;
            const containerPoint = e.target._map.latLngToContainerPoint(e.latlng);
            return { point: p, screenPosition: { x: containerPoint.x, y: containerPoint.y }, pinned: false };
          });
        },
        mousemove: (e) => {
          const containerPoint = e.target._map.latLngToContainerPoint(e.latlng);
          setActiveCard((prev) =>
            prev && !prev.pinned && prev.point.id === p.id
              ? { ...prev, screenPosition: { x: containerPoint.x, y: containerPoint.y } }
              : prev
          );
        },
        mouseout: () => setActiveCard((prev) => (prev?.pinned ? prev : null)),
      }}
    />
  );
}

export default function ProjectsMap({
  points,
  onSelect,
  hideRawReadings = false,
  minimal = false,
}: {
  points: ProjectPoint[];
  onSelect?: (id: string) => void;
  hideRawReadings?: boolean;
  // Explicit request from user: In monitoring entity hover card, show only project name/
  // city and decision status — all other details are hidden (see HoverCard above).
  minimal?: boolean;
}) {
  // activeCard: "pinned" card (pinned=true) opened by click/tap or keyboard focus —
  // remains visible until explicitly closed (close button, Escape, or clicking outside),
  // unlike transient hover (pinned=false) which disappears on mouseout as a quick preview only,
  // and does not replace any already pinned card.
  const [activeCard, setActiveCard] = useState<ActiveCardState | null>(null);

  return (
    <div className="relative w-full h-full">
      <MapContainer
        center={SAUDI_CENTER}
        zoom={6}
        minZoom={5}
        scrollWheelZoom
        maxBounds={SAUDI_BOUNDS}
        maxBoundsViscosity={1.0}
        style={{ height: '100%', width: '100%' }}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <FitBounds points={points} />
        <CloseCardOnMapClick onClose={() => setActiveCard((prev) => (prev?.pinned ? null : prev))} />
        {points.map((p) => (
          <ProjectMarker key={p.id} point={p} setActiveCard={setActiveCard} />
        ))}
      </MapContainer>
      {activeCard && (
        <HoverCard
          point={activeCard.point}
          screenPosition={activeCard.screenPosition}
          hideRawReadings={hideRawReadings}
          minimal={minimal}
          onSelect={onSelect ? () => onSelect(activeCard.point.id) : undefined}
          onClose={() => setActiveCard(null)}
        />
      )}
    </div>
  );
}