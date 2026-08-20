import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { requireUserId } from '@/app/lib/apiAuth';
import { safeErrorResponse } from '@/app/lib/apiError';

/*
 * Explicit User Feature Request: "Enable read/unread functionality."
 * Records read states for one or more alerts specific to the currently authenticated user 
 * via the `alert_reads` junction table (see `migration 202608200001` for architectural context).
 * Triggered by the client UI upon opening an alert drawer or card ("mark-on-open").
 */
export async function POST(request: NextRequest) {
  const auth = await requireUserId(request);
  if ('error' in auth) return auth.error;
  const userId = auth.userId;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'جسم الطلب يجب أن يكون JSON صالحاً' }, { status: 400 });
  }
  const alertIds = (body as { alertIds?: unknown })?.alertIds;
  if (!Array.isArray(alertIds) || alertIds.length === 0 || !alertIds.every((id) => typeof id === 'string')) {
    return NextResponse.json({ error: 'alertIds يجب أن تكون مصفوفة نصوص غير فارغة' }, { status: 400 });
  }

  // Defensive threshold limit to prevent accidental or malicious large payloads
  if (alertIds.length > 200) {
    return NextResponse.json({ error: 'عدد alertIds يتجاوز الحد المسموح (200)' }, { status: 400 });
  }

  /*
   * Ownership & Authorization Validation:
   * Users can only mark alerts as read if they own the corresponding project,
   * or if they hold a regulatory observer role (`account_role === 'viewer'`).
   * Aligns with visibility boundaries applied in `alerts/count` and `admin/alerts`.
   */
  const { data: authz } = await supabaseAdmin
    .from('user_authorizations')
    .select('account_role')
    .eq('user_id', userId)
    .maybeSingle();
  const isViewer = authz?.account_role === 'viewer';

  const { data: targetAlerts, error: fetchError } = await supabaseAdmin
    .from('alerts')
    .select('id, projects!inner(user_id)')
    .in('id', alertIds);
  if (fetchError) return NextResponse.json({ error: safeErrorResponse(fetchError, 'alerts/mark-read fetch failed') }, { status: 500 });

  const allowedAlertIds = isViewer
    ? (targetAlerts || []).map((a: { id: string }) => a.id)
    : (targetAlerts || [])
        .filter((a: { projects: { user_id: string } | { user_id: string }[] }) => {
          const p = Array.isArray(a.projects) ? a.projects[0] : a.projects;
          return p?.user_id === userId;
        })
        .map((a: { id: string }) => a.id);

  if (allowedAlertIds.length === 0) {
    return NextResponse.json({ error: 'لا صلاحية على أي من التنبيهات المرسَلة' }, { status: 403 });
  }

  const rows = allowedAlertIds.map((alertId: string) => ({ alert_id: alertId, user_id: userId }));
  const { error: upsertError } = await supabaseAdmin
    .from('alert_reads')
    .upsert(rows, { onConflict: 'alert_id,user_id', ignoreDuplicates: true });
  if (upsertError) return NextResponse.json({ error: safeErrorResponse(upsertError, 'alerts/mark-read upsert failed') }, { status: 500 });

  return NextResponse.json({ markedCount: allowedAlertIds.length });
}