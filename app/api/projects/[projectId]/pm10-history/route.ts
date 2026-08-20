import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { requireUserId, verifyProjectOwnership } from '@/app/lib/apiAuth';
import { safeErrorResponse } from '@/app/lib/apiError';
import { displayActivityLabel } from '@/app/lib/activityLabels';
import { riyadhLocalToUtcIso } from '@/app/lib/dustEvaluation';

// Maximum time window allowed via hours= parameter — simple upper bound to prevent
// requests fetching months/years of historical data at once (no practical benefit,
// unnecessary load on the database).
const MAX_HOURS = 24 * 14; // 2 weeks
const DEFAULT_HOURS = 6;

// Explicit final user requirement ("Readings start with activity start and end with activity
// end — remove the 2-hour margin completely", see matching fix in
// device-readings-history/route.ts) — previously used ACTIVITY_LIVE_MARGIN_MS (2 hours)
// which accepted readings received prior to planned_time; removed entirely to align exactly
// with the decision window (isActivityLiveForDevice in dustEvaluation.ts).

// Fetches historical PM10 readings (pm10_readings_history) for a project, grouped by
// activity_group_id, formatted for charts — each activity maintains its own time series.
// Device readings (source='device', activity_group_id=null) are merged into each active
// activity with a linked device using the same logic as fetchPm10SustainedStatus in
// app/lib/dustEvaluation.ts (devices attach to the project globally, not a specific activity).
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  try {
    const auth = await requireUserId(request);
    if ('error' in auth) return auth.error;

    const { projectId: rawProjectId } = await params;
    const projectId = rawProjectId.trim();

    const owns = await verifyProjectOwnership(projectId, auth.userId);
    if (!owns) return NextResponse.json({ error: 'لا تملك هذا المشروع' }, { status: 403 });

    const hoursParam = Number(request.nextUrl.searchParams.get('hours'));
    const hours = Number.isFinite(hoursParam) && hoursParam > 0
      ? Math.min(hoursParam, MAX_HOURS)
      : DEFAULT_HOURS;
    const sinceIso = new Date(Date.now() - hours * 3600000).toISOString();

    // All activities (not just active ones) — completed activities still retain historical
    // records valuable for auditing; time-window filtering for display remains the responsibility of hours=.
    const { data: profiles, error: profilesError } = await supabaseAdmin
      .from('project_dust_profiles')
      .select('id, activity_group_id, regulatory_activity, device_id, planned_date, planned_time, duration_hours')
      .eq('project_id', projectId);
    if (profilesError) {
      return NextResponse.json({ error: safeErrorResponse(profilesError, 'pm10-history profiles fetch failed') }, { status: 500 });
    }

    // Discovered and fixed bug (same device used across sequential activities inherited
    // previous activity readings entirely): windowStartMs/windowEndMs scope merged device
    // readings for each activity strictly within its actual window (from planned_date/planned_time
    // through planned_start+duration_hours, or now if still active) — matching the exact startIso
    // used in computeDustResults (dustEvaluation.ts) for calculating DVI for this exact activity,
    // avoiding discrepancies between activity "start time" here and there.
    //
    // Unique activity_group_id per actual activity — same fallback pattern used in
    // DELETE /api/activities (activity_group_id || `dust-${id}`) so group aggregation keys
    // match what is actually stored in pm10_readings_history.
    const groups = new Map<
      string,
      { activityGroupId: string; label: string; hasDeviceLink: boolean; windowStartMs: number | null; windowEndMs: number }
    >();
    for (const row of profiles || []) {
      const groupId = row.activity_group_id || `dust-${row.id}`;
      if (groups.has(groupId)) continue;
      const startIso = riyadhLocalToUtcIso(row.planned_date, row.planned_time);
      const rawStartMs = startIso ? new Date(startIso).getTime() : null;
      const startMs = rawStartMs;
      const durationHours = Math.max(1, Math.round(row.duration_hours || 1));
      const endMs = rawStartMs !== null ? rawStartMs + durationHours * 3600000 : Date.now();
      groups.set(groupId, {
        activityGroupId: groupId,
        label: displayActivityLabel(row),
        hasDeviceLink: !!row.device_id,
        windowStartMs: startMs,
        // Ongoing activity (planned window has not ended yet) accepts readings up to current
        // time rather than theoretical planned end — keeping chart stream live during active
        // execution instead of cutting off at scheduled limit.
        windowEndMs: Math.max(endMs, Date.now()),
      });
    }

    const { data: readings, error: readingsError } = await supabaseAdmin
      .from('pm10_readings_history')
      .select('pm10_ug_m3, recorded_at, activity_group_id, source')
      .eq('project_id', projectId)
      .gte('recorded_at', sinceIso)
      .order('recorded_at', { ascending: true });
    if (readingsError) {
      return NextResponse.json({ error: safeErrorResponse(readingsError, 'pm10-history readings fetch failed') }, { status: 500 });
    }

    // Device readings (activity_group_id=null) are cloned for every activity explicitly
    // linked to a device — matching fetchPm10SustainedStatus merging strategy so chart displays
    // complete series per device-enabled activity (avoiding empty series despite existing readings).
    const deviceReadings = (readings || []).filter((r: { activity_group_id: string | null }) => r.activity_group_id === null);
    const series = new Map<string, { time: string; pm10: number; source: string }[]>();
    for (const g of groups.values()) series.set(g.activityGroupId, []);

    for (const row of readings || []) {
      const point = { time: row.recorded_at, pm10: Number(row.pm10_ug_m3), source: row.source };
      if (row.activity_group_id !== null) {
        if (!series.has(row.activity_group_id)) series.set(row.activity_group_id, []);
        series.get(row.activity_group_id)!.push(point);
      }
    }
    if (deviceReadings.length > 0) {
      for (const g of groups.values()) {
        if (!g.hasDeviceLink) continue;
        const arr = series.get(g.activityGroupId)!;
        for (const row of deviceReadings) {
          const recordedMs = new Date(row.recorded_at).getTime();
          // Device reading is included for this activity only if it falls within its active
          // execution window (planned start to planned end/now) — see windowStartMs comment
          // above regarding prevention of new activities inheriting old device readings.
          if (g.windowStartMs !== null && recordedMs < g.windowStartMs) continue;
          if (recordedMs > g.windowEndMs) continue;
          arr.push({ time: row.recorded_at, pm10: Number(row.pm10_ug_m3), source: row.source });
        }
        arr.sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
      }
    }

    const activities = Array.from(groups.values())
      .map((g) => ({
        activityGroupId: g.activityGroupId,
        label: g.label,
        hasDeviceLink: g.hasDeviceLink,
        readings: series.get(g.activityGroupId) || [],
      }))
      // Activities with zero readings across requested time window offer no visual value — filtered out
      // instead of rendering empty chart lines.
      .filter((a) => a.readings.length > 0);

    return NextResponse.json({ activities, hours });
  } catch (error) {
    return NextResponse.json({ error: safeErrorResponse(error, 'pm10-history failed') }, { status: 500 });
  }
}