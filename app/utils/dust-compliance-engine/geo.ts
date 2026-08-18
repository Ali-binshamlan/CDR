// =============================================================
// Riyadh Dust Compliance Engine — Geo
// Haversine distance between two points, used to auto-compute a crusher's
// distance to the nearest sensitive receptor instead of relying on manual
// entry for the 200m/500m distance rules.
// =============================================================

import type { SensitiveReceptor, SensitiveReceptorType } from './types';

const EARTH_RADIUS_M = 6371000;

export function haversineDistanceM(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_M * c;
}

// Bearing of the destination point from the origin, in degrees (0-360,
// 0=true north, 90=east...) — used to determine whether a sensitive
// receptor is actually downwind (see MRQ-RECEPTOR-DOWNWIND-120), not just
// close by straight-line distance regardless of direction.
export function bearingDegrees(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const toDeg = (rad: number) => (rad * 180) / Math.PI;
  const dLng = toRad(lng2 - lng1);
  const y = Math.sin(dLng) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLng);
  const bearing = toDeg(Math.atan2(y, x));
  return (bearing + 360) % 360;
}

// Smallest angular difference between two bearings (0-180) — correctly
// handles wraparound at 360/0 (e.g. the difference between 350 and 10 is 20, not 340).
export function angularDifferenceDegrees(a: number, b: number): number {
  const diff = Math.abs(a - b) % 360;
  return diff > 180 ? 360 - diff : diff;
}

// Angular tolerance for considering a receptor "downwind" — a ±45° sector
// around the wind's actual blow-toward direction (not its source), covering
// roughly a quarter circle rather than requiring exact alignment.
export const DOWNWIND_TOLERANCE_DEGREES = 45;

// Is the destination point downwind of the origin?
// windDirectionDeg follows meteorological convention (direction the wind is
// coming FROM), so the actual blow-toward direction is windDirectionDeg+180.
export function isDownwind(
  originLat: number,
  originLng: number,
  targetLat: number,
  targetLng: number,
  windDirectionFromDeg: number,
  toleranceDeg: number = DOWNWIND_TOLERANCE_DEGREES
): boolean {
  const targetBearing = bearingDegrees(originLat, originLng, targetLat, targetLng);
  const windBlowingTowardDeg = (windDirectionFromDeg + 180) % 360;
  return angularDifferenceDegrees(targetBearing, windBlowingTowardDeg) <= toleranceDeg;
}

const RESIDENTIAL_RECEPTOR_TYPES: SensitiveReceptorType[] = ['RESIDENTIAL', 'SCHOOL', 'HOSPITAL'];

// Returns the nearest distance (m) to any sensitive receptor, and the
// nearest distance to a residential/school/hospital receptor specifically
// (subject to a stricter regulatory limit for crushers).
//
// "Location unknown" (null lat/lng) is distinct from "location known but
// the receptor table is genuinely empty": the former means the distance
// cannot be computed at all (null — callers fall back to a stale manual
// value), while the latter is real information ("no known receptor
// nearby") and must translate to a practically safe distance (Infinity),
// not null — otherwise the rule would fall back to a stale manual value
// even though the live computation gives no actual reason to stop,
// contradicting the "no nearby receptors" list shown to the user on the
// same screen.
export function nearestReceptorDistancesM(
  lat: number | null,
  lng: number | null,
  receptors: SensitiveReceptor[]
): { nearestAnyM: number | null; nearestResidentialM: number | null } {
  if (lat === null || lng === null) {
    return { nearestAnyM: null, nearestResidentialM: null };
  }
  if (receptors.length === 0) {
    return { nearestAnyM: Infinity, nearestResidentialM: Infinity };
  }

  let nearestAnyM: number | null = null;
  let nearestResidentialM: number | null = null;

  for (const receptor of receptors) {
    const distance = haversineDistanceM(lat, lng, receptor.lat, receptor.lng);
    if (nearestAnyM === null || distance < nearestAnyM) nearestAnyM = distance;
    if (RESIDENTIAL_RECEPTOR_TYPES.includes(receptor.receptorType)) {
      if (nearestResidentialM === null || distance < nearestResidentialM) nearestResidentialM = distance;
    }
  }

  return { nearestAnyM, nearestResidentialM };
}

// Nearest distance (m) to a residential/school/hospital receptor that is
// actually downwind of the origin — MRQ-RECEPTOR-DOWNWIND-120. Returns null
// if wind direction is unavailable (windDirectionFromDeg=null) or location
// is unknown, or Infinity if no receptor falls within the downwind sector
// (no directional risk currently, regardless of receptors in other directions).
export function nearestDownwindReceptorDistanceM(
  lat: number | null,
  lng: number | null,
  windDirectionFromDeg: number | null,
  receptors: SensitiveReceptor[]
): number | null {
  if (lat === null || lng === null || windDirectionFromDeg === null) return null;

  const downwindResidential = receptors.filter(
    (r) =>
      RESIDENTIAL_RECEPTOR_TYPES.includes(r.receptorType) &&
      isDownwind(lat, lng, r.lat, r.lng, windDirectionFromDeg)
  );
  if (downwindResidential.length === 0) return Infinity;

  return Math.min(...downwindResidential.map((r) => haversineDistanceM(lat, lng, r.lat, r.lng)));
}

// Display radius for receptors around a crusher/batching unit — 500m
// matches the stricter regulatory limit used by CRUSHER-DISTANCE-002 and
// BATCHING-DISTANCE-002 (see rulebook.ts), so the user sees exactly the
// receptors that trigger those rules.
export const UNIT_RECEPTOR_RADIUS_M = 500;

export interface ReceptorWithinRadius {
  id: string;
  name: string;
  receptorType: SensitiveReceptorType;
  distanceM: number;
}

// Returns all sensitive receptors within a given radius of a unit
// (crusher/batching plant), sorted nearest-first. Unlike
// nearestReceptorDistancesM, which returns only the nearest distance, this
// returns the full list for display purposes.
export function receptorsWithinRadiusM(
  lat: number | null,
  lng: number | null,
  receptors: SensitiveReceptor[],
  radiusM: number = UNIT_RECEPTOR_RADIUS_M
): ReceptorWithinRadius[] {
  if (lat === null || lng === null) return [];

  return receptors
    .map((receptor) => ({
      id: receptor.id,
      name: receptor.name,
      receptorType: receptor.receptorType,
      distanceM: haversineDistanceM(lat, lng, receptor.lat, receptor.lng),
    }))
    .filter((r) => r.distanceM <= radiusM)
    .sort((a, b) => a.distanceM - b.distanceM);
}
