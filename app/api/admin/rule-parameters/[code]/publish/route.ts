import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { requireSuperAdmin } from '@/app/lib/apiAuth';
import { safeErrorResponse } from '@/app/lib/apiError';

/*
 * Publishes a new version of a configurable rule parameter.
 * Fully delegated to `publish_rule_parameter_version` (Atomic RPC, migration 202608060003):
 * Validates the safe range (min/max), marks the current `PUBLISHED` version as `SUPERSEDED`, 
 * and inserts the new `PUBLISHED` version atomically.
 * 
 * Execution timing: Does not alter active evaluations immediately. Changes apply starting from 
 * the next evaluation cycle (`refreshRuleParameters` is invoked at the start of `evaluateProject`).
 * This aligns with system core principles: no live configuration shifts mid-evaluation.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ code: string }> }
) {
  const auth = await requireSuperAdmin(request);
  if ('error' in auth) return auth.error;

  const { code } = await params;
  const body = await request.json().catch(() => null);

  const value = typeof body?.value === 'number' && Number.isFinite(body.value) ? body.value : NaN;
  if (Number.isNaN(value)) {
    return NextResponse.json({ error: 'value إلزامي ويجب أن يكون رقماً صالحاً' }, { status: 400 });
  }

  const changeReasonAr = typeof body?.changeReasonAr === 'string' ? body.changeReasonAr.trim() : '';
  if (!changeReasonAr) {
    return NextResponse.json({ error: 'سبب النشر (changeReasonAr) إلزامي — سجل تدقيق: لماذا تغيّرت هذه القيمة؟' }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin.rpc('publish_rule_parameter_version', {
    p_parameter_code: code,
    p_value: value,
    p_published_by: auth.userId,
    p_change_reason_ar: changeReasonAr,
  });

  if (error) {
    /*
     * RPC Validation Errors: Range check and unknown parameter failures raised directly by the RPC 
     * are exposed to the user as-is. They contain clear Arabic messages formatted inside `publish_rule_parameter_version` 
     * (e.g., "Value 500 exceeds maximum safe threshold 100") rather than generic PostgREST errors.
     * 
     * `safeErrorResponse` remains reserved for unexpected internal DB/network failures, 
     * bypassing these two explicit validation error codes (`22023`, `23503`).
     */
    if (error.code === '22023' || error.code === '23503') {
      console.error('rule-parameter publish validation failed:', error.message);
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json({ error: safeErrorResponse(error, 'rule-parameter publish failed') }, { status: 500 });
  }

  return NextResponse.json({ version: data });
}