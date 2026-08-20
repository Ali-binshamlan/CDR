import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { requireSuperAdmin } from '@/app/lib/apiAuth';
import { safeErrorResponse } from '@/app/lib/apiError';

/*
 * Fetches all registered users (`profiles`) with email addresses (retrieved from `auth.users` without a direct FK join) 
 * and active project counts per user.
 * 
 * Optimized to prevent N+1 queries:
 * 1. Single paginated call loop to `supabaseAdmin.auth.admin.listUsers` (handles >1000 users).
 * 2. Single aggregated query to fetch authorization levels (`user_authorizations`).
 * 3. Lightweight query to count non-archived projects mapped by user ID.
 */
export async function GET(request: NextRequest) {
  const auth = await requireSuperAdmin(request);
  if ('error' in auth) return auth.error;

  const { data: profiles, error: profilesError } = await supabaseAdmin
    .from('profiles')
    .select('id, company_name, username, phone_number, role, created_at')
    .order('created_at', { ascending: false });
  if (profilesError) return NextResponse.json({ error: safeErrorResponse(profilesError, 'admin/users profiles fetch failed') }, { status: 500 });

  /*
   * `is_super_admin` flag is decoupled from `profiles` (managed via `user_authorizations`; see `apiAuth.ts`).
   * Fetched in a separate query to avoid direct PostgREST joins between tables lacking foreign keys.
   */
  const { data: authzRows, error: authzError } = await supabaseAdmin
    .from('user_authorizations')
    .select('user_id, is_super_admin');
  if (authzError) return NextResponse.json({ error: safeErrorResponse(authzError, 'admin/users authorizations fetch failed') }, { status: 500 });
  const isSuperAdminByUserId = new Map<string, boolean>(
    (authzRows || []).map((a: { user_id: string; is_super_admin: boolean }) => [a.user_id, a.is_super_admin])
  );

  const emailByUserId = new Map<string, string>();
  let page = 1;
  const perPage = 1000;
  while (true) {
    const { data: page_, error: listError } = await supabaseAdmin.auth.admin.listUsers({ page, perPage });
    if (listError) return NextResponse.json({ error: safeErrorResponse(listError, 'admin/users listUsers failed') }, { status: 500 });
    for (const u of page_.users) {
      if (u.email) emailByUserId.set(u.id, u.email);
    }
    if (page_.users.length < perPage) break;
    page++;
  }

  /*
   * Filter (`archived_at IS NULL`): Project count reflects active operational projects only.
   * Including archived projects inflates figures without operational value.
   */
  const { data: projectRows, error: projectsError } = await supabaseAdmin
    .from('projects')
    .select('user_id')
    .is('archived_at', null);
  if (projectsError) return NextResponse.json({ error: safeErrorResponse(projectsError, 'admin/users projects fetch failed') }, { status: 500 });

  const projectCountByUserId = new Map<string, number>();
  for (const row of projectRows || []) {
    projectCountByUserId.set(row.user_id, (projectCountByUserId.get(row.user_id) || 0) + 1);
  }

  const data = (profiles || []).map((p: {
    id: string;
    username: string | null;
    company_name: string | null;
    phone_number: string | null;
    role: string | null;
    created_at: string;
  }) => ({
    id: p.id,
    username: p.username,
    companyName: p.company_name,
    phoneNumber: p.phone_number,
    role: p.role,
    isSuperAdmin: isSuperAdminByUserId.get(p.id) ?? false,
    createdAt: p.created_at,
    email: emailByUserId.get(p.id) || null,
    projectCount: projectCountByUserId.get(p.id) || 0,
  }));

  return NextResponse.json({ data });
}