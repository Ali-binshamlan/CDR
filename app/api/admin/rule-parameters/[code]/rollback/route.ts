import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { requireSuperAdmin } from '@/app/lib/apiAuth';
import { safeErrorResponse } from '@/app/lib/apiError';

/*
 * Rolls back to a previous parameter version. Delegated to `rollback_rule_parameter_version` 
 * (RPC, migration 202608060003): Re-publishes the value of a historical version (`versionId`, 
 * any status—typically `SUPERSEDED`) as a brand-new `PUBLISHED` version (strictly append-only, 
 * no retrospective mutations on the old row; see full function comment in migration file).
 * 
 * Note: "Rollback" in this architecture means "re-publish the previous value as a new version" 
 * rather than deleting/mutating historical records—complete audit history is preserved.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ code: string }> }
) {
  const auth = await requireSuperAdmin(request);
  if ('error' in auth) return auth.error;

  /*
   * `code` parameter in URL is extracted for validation/route consistency only.
   * The underlying RPC relies exclusively on `versionId` (which already embeds `parameter_code` on its row).
   */
  await params;

  const body = await request.json().catch(() => null);
  const versionId = typeof body?.versionId === 'string' && body.versionId.trim() ? body.versionId.trim() : '';
  if (!versionId) {
    return NextResponse.json({ error: 'versionId إلزامي — معرّف النسخة المطلوب التراجع إليها' }, { status: 400 });
  }

  const changeReasonAr = typeof body?.changeReasonAr === 'string' ? body.changeReasonAr.trim() : '';
  if (!changeReasonAr) {
    return NextResponse.json({ error: 'سبب التراجع (changeReasonAr) إلزامي — سجل تدقيق' }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin.rpc('rollback_rule_parameter_version', {
    p_version_id: versionId,
    p_published_by: auth.userId,
    p_change_reason_ar: changeReasonAr,
  });

  if (error) {
    if (error.code === '22023' || error.code === '23503') {
      console.error('rule-parameter rollback validation failed:', error.message);
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json({ error: safeErrorResponse(error, 'rule-parameter rollback failed') }, { status: 500 });
  }

  return NextResponse.json({ version: data });
}