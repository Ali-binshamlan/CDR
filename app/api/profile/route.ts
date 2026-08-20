import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { requireUserId } from '@/app/lib/apiAuth';
import { safeErrorResponse } from '@/app/lib/apiError';
import { normalizeProfileRole } from '@/app/lib/profileRoles';

/*
 * User Profile Management Endpoint:
 * Handles fetching (GET) and updating (PATCH) user profile attributes. Session identity 
 * is derived strictly from server-side token validation (`requireUserId`).
 *
 * Security & Architecture Highlights:
 * 1. Authorization Isolation: Decouples `is_super_admin` and `account_role` into a restricted 
 *    `user_authorizations` table to prevent client tampering, merging these fields server-side 
 *    for backward compatibility with existing UI readers.
 * 2. Immutable Email Source: Resolves the user's primary email address directly from `supabaseAdmin.auth.admin` 
 *    rather than storing or accepting client updates to mutable text fields.
 * 3. Input Normalization: Enforces role validation on update via `normalizeProfileRole` to guarantee 
 *    schema consistency across registration and settings flows.
 */

export async function GET(request: NextRequest) {
  const auth = await requireUserId(request);
  if ('error' in auth) return auth.error;

  /*
   * Parallel retrieval of profile metadata and elevated authorization scopes
   */
  const [{ data: profile }, { data: authz }] = await Promise.all([
    supabaseAdmin
      .from('profiles')
      .select('company_name, username, phone_number, role')
      .eq('id', auth.userId)
      .single(),
    supabaseAdmin
      .from('user_authorizations')
      .select('is_super_admin, account_role')
      .eq('user_id', auth.userId)
      .maybeSingle(),
  ]);

  /*
   * Fetch authenticated user's primary email from identity provider
   */
  const { data: userRes } = await supabaseAdmin.auth.admin.getUserById(auth.userId);
  const email = userRes?.user?.email ?? '';

  return NextResponse.json({
    data: {
      ...(profile ?? {}),
      is_super_admin: authz?.is_super_admin ?? false,
      account_role: authz?.account_role ?? 'user',
      email,
    },
  });
}

export async function PATCH(request: NextRequest) {
  const auth = await requireUserId(request);
  if ('error' in auth) return auth.error;

  const body = await request.json().catch(() => ({}));

  /*
   * Extract and sanitize allowed profile attributes
   */
  const updates: Record<string, string> = {};
  if (typeof body.companyName === 'string') updates.company_name = body.companyName;
  if (typeof body.username === 'string') updates.username = body.username;
  if (typeof body.phoneNumber === 'string') updates.phone_number = body.phoneNumber;
  if (typeof body.role === 'string') updates.role = normalizeProfileRole(body.role);

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'لا توجد حقول صالحة للتحديث' }, { status: 400 });
  }

  /*
   * Update profile attributes scoped to authenticated session
   */
  const { error } = await supabaseAdmin.from('profiles').update(updates).eq('id', auth.userId);
  if (error) {
    if (error.code === '23505') {
      return NextResponse.json({ error: 'اسم المستخدم مسجّل مسبقاً، اختر اسماً آخر.' }, { status: 400 });
    }
    return NextResponse.json({ error: safeErrorResponse(error, 'profile update failed') }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}