import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { requireUserId, verifyProjectOwnership } from '@/app/lib/apiAuth';
import { safeErrorResponse } from '@/app/lib/apiError';

// Dedicated lightweight GET endpoint for project settings page (settings/page.tsx) — performance issue
// discovered: that page previously called GET /api/projects/[projectId] which is used
// in project dashboard and runs computeDustResults/computeDustComplianceResults/computeUnitReceptors/computeDustComplianceHourly
// completely (physical DVI + regulatory compliance + external network requests to Open-Meteo
// and Overpass/OSM per activity) — extremely heavy computation for a page that does not display any of these
// results in its UI at all, only simple form fields (name/location/shifts/
// etc). This endpoint fetches only the raw projects row + project_shifts, without any
// DVI/compliance/OSM computation — reducing settings page load time from seconds (waiting for
// unnecessary calculations) down to two simple database queries.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> }
) {
  try {
    const auth = await requireUserId(request);
    if ('error' in auth) return auth.error;

    const resolvedParams = await params;
    const projectId = resolvedParams.projectId.trim();

    const owns = await verifyProjectOwnership(projectId, auth.userId);
    if (!owns) return NextResponse.json({ error: 'لا تملك هذا المشروع' }, { status: 403 });

    const [{ data: project, error: projectError }, { data: projectShifts }] = await Promise.all([
      supabaseAdmin.from('projects').select('*').eq('id', projectId).maybeSingle(),
      supabaseAdmin.from('project_shifts').select('*').eq('project_id', projectId).order('sort_order', { ascending: true }),
    ]);

    if (projectError) {
      return NextResponse.json({ error: safeErrorResponse(projectError, 'project fetch failed') }, { status: 500 });
    }
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    // Same attached field name as in heavy GET (route.ts) — settings/page.tsx
    // reads project.shifts in the exact same format, so no UI modifications required
    // other than updating the requested URL endpoint.
    project.shifts = projectShifts || [];

    return NextResponse.json({ project });
  } catch (error) {
    return NextResponse.json({ error: safeErrorResponse(error, 'project settings-summary fetch failed') }, { status: 500 });
  }
}