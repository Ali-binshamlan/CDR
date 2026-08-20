import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { requireUserId } from '@/app/lib/apiAuth';
import { safeErrorResponse } from '@/app/lib/apiError';
import { checkRateLimit } from '@/app/lib/rateLimit';
import { checkDustActivities } from '../generate/route';

/*
 * Per-user rate limiting configuration.
 * The frontend dashboard layout polls this route automatically every minute, which is allowed.
 * Rate limiting prevents authenticated users from triggering manual rapid loops 
 * (which would unnecessarily duplicate Open-Meteo/Overpass requests and DVI/compliance recalculations).
 */
const GENERATE_MINE_MAX_REQUESTS_PER_WINDOW = 6;
const GENERATE_MINE_WINDOW_MS = 60_000;

/*
 * Generates alerts upon user sign-in/dashboard initialization.
 * Evaluates activities exclusively for projects owned by the currently authenticated user 
 * (unlike `/api/alerts/generate` which evaluates all system projects via cron).
 * Reuses the core `checkDustActivities` routine scoped tightly to the user's project IDs.
 */
export async function POST(request: NextRequest) {
  const auth = await requireUserId(request);
  if ('error' in auth) return auth.error;

  if (!checkRateLimit(`generate-mine:${auth.userId}`, GENERATE_MINE_MAX_REQUESTS_PER_WINDOW, GENERATE_MINE_WINDOW_MS)) {
    return NextResponse.json({ error: 'محاولات كثيرة جداً، الرجاء الانتظار قليلاً' }, { status: 429 });
  }

  /*
   * Filter (`archived_at IS NULL`): Prevents passing archived project IDs to the evaluation pipeline.
   * While `checkDustActivities` applies a defense-in-depth filter internally, 
   * filtering upfront avoids passing obsolete project references to the core engine.
   */
  const { data: projects } = await supabaseAdmin
    .from('projects')
    .select('id')
    .eq('user_id', auth.userId)
    .is('archived_at', null);

  const projectIds = (projects || []).map((p: { id: string }) => p.id);
  if (projectIds.length === 0) {
    return NextResponse.json({ ok: true, generated: false, reason: 'no projects' });
  }

  try {
    await checkDustActivities(projectIds);
    return NextResponse.json({ ok: true, generated: true, checkedAt: new Date().toISOString() });
  } catch (error) {
    return NextResponse.json({ ok: false, error: safeErrorResponse(error, 'generate-mine failed') }, { status: 500 });
  }
}