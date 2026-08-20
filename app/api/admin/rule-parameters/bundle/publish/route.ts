import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { requireSuperAdmin } from '@/app/lib/apiAuth';
import { safeErrorResponse } from '@/app/lib/apiError';

/*
 * Publishes a set of interdependent rule parameters as a single atomic unit.
 * Fully delegated to `publish_rule_parameter_bundle` (Atomic RPC, migration 202608110003):
 * Creates a single `rule_parameter_publication_bundles` record, then publishes each parameter 
 * in the array within the exact same database transaction (eliminates N separate RPC calls to 
 * `publish_rule_parameter_version`—if any parameter fails validation, the entire bundle is rolled back).
 * 
 * References design specification: "Atomic Rule Parameter Publication Bundle."
 * Resolves the operational gap where updating multiple interdependent parameters previously required 
 * disjointed individual calls lacking unified correlation.
 */
export async function POST(request: NextRequest) {
  const auth = await requireSuperAdmin(request);
  if ('error' in auth) return auth.error;

  const body = await request.json().catch(() => null);

  const changesRaw = Array.isArray(body?.changes) ? body.changes : null;
  if (!changesRaw || changesRaw.length === 0) {
    return NextResponse.json({ error: 'changes إلزامية ويجب أن تكون مصفوفة غير فارغة من {code, value}' }, { status: 400 });
  }

  const changes: { code: string; value: number }[] = [];
  for (const item of changesRaw) {
    const code = typeof item?.code === 'string' ? item.code.trim() : '';
    const value = typeof item?.value === 'number' && Number.isFinite(item.value) ? item.value : NaN;
    if (!code || Number.isNaN(value)) {
      return NextResponse.json({ error: 'كل عنصر في changes يجب أن يحتوي code (نص) وvalue (رقم صالح)' }, { status: 400 });
    }
    changes.push({ code, value });
  }

  const changeReasonAr = typeof body?.changeReasonAr === 'string' ? body.changeReasonAr.trim() : '';
  if (!changeReasonAr) {
    return NextResponse.json({ error: 'سبب النشر المشترك (changeReasonAr) إلزامي — سجل تدقيق لكل المجموعة' }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin.rpc('publish_rule_parameter_bundle', {
    p_changes: changes,
    p_published_by: auth.userId,
    p_change_reason_ar: changeReasonAr,
  });

  if (error) {
    /*
     * Custom validation error handling: Preserves explicit Arabic error messages raised by the RPC 
     * while delegating unexpected internal DB/network failures to `safeErrorResponse`.
     * Matches validation logic in `[code]/publish/route.ts`.
     */
    if (error.code === '22023' || error.code === '23503') {
      console.error('rule-parameter bundle publish validation failed:', error.message);
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json({ error: safeErrorResponse(error, 'rule-parameter bundle publish failed') }, { status: 500 });
  }

  return NextResponse.json({ versions: data });
}