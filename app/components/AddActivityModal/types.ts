// AddActivityModal/types.ts
// Types specific to the Add Activity modal DCR version: Dust & Regulatory Compliance + AEI only


// 'choose': Select regulatory activities (multi-selection via ActivityTypeStep)
// 'indicators': Display screen for dust assessment of the selected activity
export type ActivityStep =
  | 'choose'
  | 'indicators'
  | 'dust';

// The only indicator available in DCR — Dust only (no cranes or heat stress)
export type IndicatorTab = 'dust';

// Simplified structure for a monitoring device (project_devices) as displayed in the activity
// device selection list — see GET /api/projects/[projectId]/devices for full shape; here
// only the required fields for display/suggesting nearest device are included (name, location, active status).
export interface ProjectDeviceLite {
  id: string;
  name: string;
  lat: number | null;
  lng: number | null;
  is_active: boolean;
}

// Simplified project structure as used inside the modal (only fields actually needed here)
export interface ProjectLite {
  id: string;
  latitude: number;
  longitude: number;
  terrain_type?: string | null;
  dust_causing_activities?: string | null;
  exposed_dust_area_size?: string | null;
  dust_mitigation_measures?: string | null;
  // Project working hours (HH:MM) — activity entry outside these hours is restricted. Used as
  // fallback/legacy default hours only when actual shifts below are absent.
  work_hours_start?: string | null;
  work_hours_end?: string | null;
  // Actual working shifts defined at project level (project_shifts) — if present,
  // user selects which shift the activity belongs to instead of relying solely on
  // work_hours_start/end as a single window. Empty array/undefined = no shifts.
  shifts?: { id: string; name: string; start_time: string; end_time: string }[] | null;
  // Work days (identifiers: sun..sat) — activity entry restricted on days outside this list
  work_days_list?: string[] | null;
  // Full project area (zone) — used strictly to clamp activity coordinates within bounds.
  // Legacy projects without zone (null) are treated as a default circle around latitude/longitude.
  zone_type?: 'polygon' | 'circle' | null;
  zone_polygon?: { lat: number; lng: number }[] | null;
  zone_radius_m?: number | null;
  // Additional fields that may be attached from actual project row but not used
  // directly inside this modal — kept as unknown shape rather than any, requiring
  // type guard narrowing prior to actual usage.
  [key: string]: unknown;
}

export interface AddActivityModalProps {
  project: ProjectLite;
  // Invoked after modal closes following successful save (all indicators complete) — parent
  // page (Projects/[id]/page.tsx) fetches dashboard data via local useState/useEffect,
  // not Server Component, so router.refresh() alone won't trigger re-render;
  // this callback allows parent to trigger immediate refetch without manual page refresh.
  onActivityCreated?: () => void;
}