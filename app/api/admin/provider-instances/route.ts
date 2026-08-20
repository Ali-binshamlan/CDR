import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { requireSuperAdmin } from '@/app/lib/apiAuth';
import { safeErrorResponse } from '@/app/lib/apiError';
import { assertSafeExternalUrl } from '@/app/lib/providers/safeUrl';

/*
 * Approved Provider Registry Management (`provider_instances`, Section 15.1 of Mirqab Architecture Guide).
 * Admin-only route for creating and approving external provider instances. 
 * Regular users select from this registry (`provider-connection/route.ts`) rather than providing arbitrary `base_url` values.
 * `is_approved=true` can only be updated explicitly via `PATCH`—auto-approval on creation is strictly prohibited.
 */
export async function GET(request: NextRequest) {
  const auth = await requireSuperAdmin(request);
  if ('error' in auth) return auth.error;

  const { data, error } = await supabaseAdmin
    .from('provider_instances')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) return NextResponse.json({ error: safeErrorResponse(error, 'provider-instances fetch failed') }, { status: 500 });
  return NextResponse.json({ instances: data });
}

export async function POST(request: NextRequest) {
  const auth = await requireSuperAdmin(request);
  if ('error' in auth) return auth.error;

  const body = await request.json().catch(() => null);
  const provider = typeof body?.provider === 'string' ? body.provider.trim() : '';
  const origin = typeof body?.origin === 'string' ? body.origin.trim().replace(/\/+$/, '') : '';

  if (!provider) return NextResponse.json({ error: 'provider مطلوب' }, { status: 400 });
  if (!origin.startsWith('https://')) {
    return NextResponse.json({ error: 'origin يجب أن يبدأ بـ https:// فقط' }, { status: 400 });
  }

  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return NextResponse.json({ error: 'origin ليس رابطاً صالحاً' }, { status: 400 });
  }
  if (parsed.pathname !== '/' && parsed.pathname !== '') {
    return NextResponse.json({ error: 'origin يجب أن يكون جذر النطاق فقط (بلا مسار)' }, { status: 400 });
  }
  if (parsed.port && parsed.port !== '443') {
    return NextResponse.json({ error: 'المنفذ المسموح 443 فقط' }, { status: 400 });
  }

  /*
   * Executes the exact SSRF security checks used during runtime execution.
   * Validates URLs upfront at insertion time to fail fast for administrators, preventing issues before initial fetch attempts.
   */
  try {
    await assertSafeExternalUrl(origin);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'رابط غير آمن';
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin
    .from('provider_instances')
    .insert({
      provider,
      origin,
      hostname: parsed.hostname,
      port: 443,
      is_approved: false,
      is_active: true,
    })
    .select('*')
    .single();

  if (error) return NextResponse.json({ error: safeErrorResponse(error, 'provider-instances insert failed') }, { status: 500 });
  return NextResponse.json({ instance: data });
}

export async function PATCH(request: NextRequest) {
  const auth = await requireSuperAdmin(request);
  if ('error' in auth) return auth.error;

  const body = await request.json().catch(() => null);
  const id = typeof body?.id === 'string' ? body.id : '';
  if (!id) return NextResponse.json({ error: 'id مطلوب' }, { status: 400 });

  const update: Record<string, unknown> = {};
  if (typeof body?.isApproved === 'boolean') {
    update.is_approved = body.isApproved;
    update.approved_by = body.isApproved ? auth.userId : null;
    update.approved_at = body.isApproved ? new Date().toISOString() : null;
  }
  if (typeof body?.isActive === 'boolean') {
    update.is_active = body.isActive;
  }
  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: 'لا يوجد تعديل صالح (isApproved أو isActive)' }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin
    .from('provider_instances')
    .update(update)
    .eq('id', id)
    .select('*')
    .single();

  if (error) return NextResponse.json({ error: safeErrorResponse(error, 'provider-instances update failed') }, { status: 500 });
  return NextResponse.json({ instance: data });
}