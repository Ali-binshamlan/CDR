import { NextResponse, type NextRequest } from 'next/server';
import { requireUserId } from '@/app/lib/apiAuth';
import { fetchDustWeather } from '@/app/utils/dust-engine/weather';

// Live weather/air quality readings for a single location (wind speed, direction, PM10, PM2.5) —
// used by the hover card in the projects map (ProjectsMap.tsx) to display instantaneous readings
// at the project marker. Intentional exception to the strict rule in dust-engine/types.ts
// ("Do not display raw numbers to the user") — this provides a general overview on the map rather
// than an operational decision screen for a specific activity, making raw readings useful for monitoring.
// Lazy-fetched on hover only (not called all at once for every map project) — avoiding flooding
// Open-Meteo with dozens of concurrent requests on initial map load.
//
// IQAir was evaluated as an alternative for PM10/PM2.5 (AQI index only) but reverted: its free tier
// rate limit (~2-3 requests/minute before 429) caused second hovers to fail silently within seconds —
// unsuitable for interactive map usage.
export async function GET(request: NextRequest) {
  const auth = await requireUserId(request);
  if ('error' in auth) return auth.error;

  const lat = Number(request.nextUrl.searchParams.get('lat'));
  const lng = Number(request.nextUrl.searchParams.get('lng'));
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return NextResponse.json({ error: 'lat و lng مطلوبان وصالحان' }, { status: 400 });
  }

  const weather = await fetchDustWeather(lat, lng);
  return NextResponse.json({ data: weather });
}