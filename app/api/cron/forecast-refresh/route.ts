import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { timingSafeStringEqual } from '@/app/lib/timingSafe';
import { refreshForecastSnapshots, type DustActivityRow } from '@/app/lib/dustEvaluation';

/*
 * Forecast Worker — Section 9.2 of the Mirqab Outbox & Forecast Specification:
 * Fetches hourly weather predictions (Open-Meteo API) for active shift windows and persists them
 * into `forecast_snapshots`.
 *
 * Operational Decoupling & Performance Optimizations:
 * 1. Isolation: Runs completely out-of-band relative to live decision evaluations (`evaluateLiveOperationalDecision`).
 * 2. Overlap Prevention: Employs `forecast_refresh_run_lock` with a 15-minute bucket window to block concurrent execution spikes.
 * 3. Query Optimization: Replaces per-project N+1 query patterns with batch `IN` queries for dust profiles and shifts,
 *    reducing database round-trips to O(1) regardless of total active projects.
 */
const RUN_BUCKET_SECONDS = 900; // 15-minute bucket window

export async function GET(request: Request) {
  if (!process.env.FORECAST_REFRESH_CRON_SECRET) {
    return NextResponse.json({ ok: false, error: 'FORECAST_REFRESH_CRON_SECRET غير مُعرَّف بالخادم' }, { status: 503 });
  }
  const authHeader = request.headers.get('authorization') || '';
  if (!timingSafeStringEqual(authHeader, `Bearer ${process.env.FORECAST_REFRESH_CRON_SECRET}`)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  // Single-worker execution window lock
  const runBucket = Math.floor(Date.now() / (RUN_BUCKET_SECONDS * 1000));
  const { error: lockError } = await supabaseAdmin
    .from('forecast_refresh_run_lock')
    .insert({ run_bucket: runBucket });
  if (lockError) {
    if (lockError.code === '23505') {
      return NextResponse.json(
        { ok: true, skipped: true, reason: 'previous forecast-refresh run still in window', runBucket },
        { status: 200 }
      );
    }
    return NextResponse.json({ ok: false, error: lockError.message }, { status: 500 });
  }

  /*
   * Batch Data Fetching: Retrieve all active projects, profiles, and shifts in unified batch queries
   */
  const { data: projects, error: fetchError } = await supabaseAdmin
    .from('projects')
    .select('*')
    .is('archived_at', null);

  if (fetchError) {
    return NextResponse.json({ ok: false, error: fetchError.message }, { status: 500 });
  }

  const projectIds = (projects || []).map((p) => p.id as string);

  const [{ data: allDustProfiles, error: dustProfilesError }, { data: allShifts, error: shiftsError }] =
    projectIds.length > 0
      ? await Promise.all([
          supabaseAdmin.from('project_dust_profiles').select('*').in('project_id', projectIds).is('archived_at', null),
          supabaseAdmin.from('project_shifts').select('*').in('project_id', projectIds).order('sort_order', { ascending: true }),
        ])
      : [{ data: [] as DustActivityRow[], error: null }, { data: [] as Array<{ project_id: string }>, error: null }];

  if (dustProfilesError) {
    return NextResponse.json({ ok: false, error: dustProfilesError.message }, { status: 500 });
  }
  if (shiftsError) {
    return NextResponse.json({ ok: false, error: shiftsError.message }, { status: 500 });
  }

  // Local lookup indexing by project_id
  const dustProfilesByProject = new Map<string, DustActivityRow[]>();
  for (const row of allDustProfiles || []) {
    const key = (row as DustActivityRow).project_id as string;
    if (!key) continue;
    const list = dustProfilesByProject.get(key) ?? [];
    list.push(row as DustActivityRow);
    dustProfilesByProject.set(key, list);
  }

  const shiftsByProject = new Map<string, Array<{ project_id: string }>>();
  for (const row of allShifts || []) {
    const key = row.project_id;
    if (!key) continue;
    const list = shiftsByProject.get(key) ?? [];
    list.push(row);
    shiftsByProject.set(key, list);
  }

  const results: Array<{ projectId: string; refreshed: number; failed: number; error?: string }> = [];

  /*
   * Sequential Processing Loop: Refreshes forecast data per project to avoid hitting external API rate limits
   */
  for (const project of projects || []) {
    try {
      const dustProfiles = dustProfilesByProject.get(project.id) ?? [];
      project.shifts = shiftsByProject.get(project.id) ?? [];

      const { refreshed, failed } = await refreshForecastSnapshots(
        supabaseAdmin,
        project.id,
        dustProfiles,
        project
      );
      results.push({ projectId: project.id, refreshed, failed });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`forecast-refresh failed for project ${project.id}:`, message);
      results.push({ projectId: project.id, refreshed: 0, failed: 0, error: message });
    }
  }

  const hasErrors = results.some((r) => r.error || r.failed > 0);

  return NextResponse.json(
    {
      ok: !hasErrors,
      checkedAt: new Date().toISOString(),
      total: results.length,
      results,
    },
    { status: 200 }
  );
}