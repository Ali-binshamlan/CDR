import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { requireUserId } from '@/app/lib/apiAuth';
import { safeErrorResponse } from '@/app/lib/apiError';

/*
 * Replaces direct `supabase.from('alerts').select(count)` calls from `Sidebar.tsx`.
 * Counts unread, active alerts (`state != CLOSED`) for the current user's projects.
 * Explicit user requirement: "Implement read/unread tracking so badge count decrements upon viewing."
 * Separated from `alerts.state` via `alert_reads` junction table (see `migration 202608200001` for full rationale).
 * Explicitly joins `projects.user_id` rather than relying solely on RLS policies.
 * 
 * Special Handling for Regulatory Monitors (`account_role === 'viewer'`):
 * Since regulatory viewers do not own projects directly, filtering by `user_id` would yield a 0 count despite active system alerts.
 * Therefore, `viewer` roles bypass `user_id` filtering but are restricted to regulatory violations (`COMPLIANCE_VIOLATION`) 
 * and their associated status updates (`PM10_IMPROVED`). This aligns the sidebar badge counter with the exact rows rendered 
 * in `AllAlertsTable` (`app/api/admin/alerts/route.ts`).
 * 
 * Bug Fix Reference: Addressed external code review finding ("Outbox confuses mandatory and precautionary shutdowns"; 
 * see `migration 202608110020`). Filter logic remains valid; core fix was applied in `persist_activity_decision_atomic`.
 */
export async function GET(request: NextRequest) {
  const auth = await requireUserId(request);
  if ('error' in auth) return auth.error;
  const userId = auth.userId;

  const { data: authz } = await supabaseAdmin
    .from('user_authorizations')
    .select('account_role')
    .eq('user_id', userId)
    .maybeSingle();
  const isViewer = authz?.account_role === 'viewer';

  let query = supabaseAdmin
    .from('alerts')
    .select('id, projects!inner(user_id)')
    .neq('state', 'CLOSED');
  if (!isViewer) {
    query = query.eq('projects.user_id', userId);
  } else {
    query = query.in('kind', ['COMPLIANCE_VIOLATION', 'PM10_IMPROVED']);
  }
  const { data: activeAlerts, error } = await query;
  if (error) return NextResponse.json({ error: safeErrorResponse(error, 'alerts/count failed') }, { status: 500 });

  const activeIds = (activeAlerts || []).map((a: { id: string }) => a.id);
  if (activeIds.length === 0) return NextResponse.json({ count: 0 });

  /*
   * Subtracts alerts previously marked as read by this specific user.
   * Executed as a secondary query over `alert_reads` table to maintain decoupling. 
   * Low performance overhead as active active alert IDs are tightly bounded.
   */
  const { data: reads, error: readsError } = await supabaseAdmin
    .from('alert_reads')
    .select('alert_id')
    .eq('user_id', userId)
    .in('alert_id', activeIds);
  if (readsError) return NextResponse.json({ error: safeErrorResponse(readsError, 'alerts/count reads fetch failed') }, { status: 500 });

  const readIds = new Set((reads || []).map((r: { alert_id: string }) => r.alert_id));
  const unreadCount = activeIds.filter((id: string) => !readIds.has(id)).length;
  return NextResponse.json({ count: unreadCount });
}