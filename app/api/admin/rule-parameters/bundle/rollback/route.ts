import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { requireSuperAdmin } from '@/app/lib/apiAuth';
import { safeErrorResponse } from '@/app/lib/apiError';

/*
 * Rolls back an entire rule parameter bundle in a single atomic transaction.
 * Delegated to `rollback_rule_parameter_bundle` (RPC, migration 202608110003): Re-publishes 
 * the exact previous values for every member in the bundle (derived from each member's `supersedes_version_id`, 
 * rather than current active state) as brand-new `PUBLISHED` versions enclosed within a new rollback bundle (strictly append-only).
 * 
 * Atomicity Constraint: If any single member fails rollback validation (e.g., lacks a previous version or 
 * falls outside current safe range thresholds), the entire bundle rollback transaction aborts.
 */
export async function POST(request: NextRequest) {
  const auth = await requireSuperAdmin(request);
  if ('error' in auth) return auth.error;

  const body = await request.json().catch(() => null);
  const bundleId = typeof body?.bundleId === 'string' && body.bundleId.trim() ? body.bundleId.trim() : '';
  if (!bundleId) {
    return NextResponse.json({ error: 'bundleId إلزامي — معرّف المجموعة المطلوب التراجع عنها' }, { status: 400 });
  }

  const changeReasonAr = typeof body?.changeReasonAr === 'string' ? body.changeReasonAr.trim() : '';
  if (!changeReasonAr) {
    return NextResponse.json({ error: 'سبب التراجع (changeReasonAr) إلزامي — سجل تدقيق' }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin.rpc('rollback_rule_parameter_bundle', {
    p_bundle_id: bundleId,
    p_published_by: auth.userId,
    p_change_reason_ar: changeReasonAr,
  });

  if (error) {
    if (error.code === '22023' || error.code === '23503') {
      console.error('rule-parameter bundle rollback validation failed:', error.message);
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json({ error: safeErrorResponse(error, 'rule-parameter bundle rollback failed') }, { status: 500 });
  }

  return NextResponse.json({ versions: data });
}