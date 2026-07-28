import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { requireSuperAdmin } from '@/app/lib/apiAuth';
import { safeErrorResponse } from '@/app/lib/apiError';

// كل المستخدمين المسجَّلين (profiles) + البريد (من auth.users، لا FK مباشر)
// + عدد مشاريع كل مستخدم — بلا N+1: نداء واحد لـ listUsers (بحلقة تصفّح
// احتياطية لو تجاوز عدد المستخدمين 1000)، واستعلام واحد خفيف لعدّ المشاريع.
export async function GET(request: NextRequest) {
  const auth = await requireSuperAdmin(request);
  if ('error' in auth) return auth.error;

  const { data: profiles, error: profilesError } = await supabaseAdmin
    .from('profiles')
    .select('id, company_name, username, phone_number, role, is_super_admin, created_at')
    .order('created_at', { ascending: false });
  if (profilesError) return NextResponse.json({ error: safeErrorResponse(profilesError, 'admin/users profiles fetch failed') }, { status: 500 });

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

  const { data: projectRows, error: projectsError } = await supabaseAdmin.from('projects').select('user_id');
  if (projectsError) return NextResponse.json({ error: safeErrorResponse(projectsError, 'admin/users projects fetch failed') }, { status: 500 });

  const projectCountByUserId = new Map<string, number>();
  for (const row of projectRows || []) {
    projectCountByUserId.set(row.user_id, (projectCountByUserId.get(row.user_id) || 0) + 1);
  }

  const data = (profiles || []).map((p: any) => ({
    id: p.id,
    username: p.username,
    companyName: p.company_name,
    phoneNumber: p.phone_number,
    role: p.role,
    isSuperAdmin: p.is_super_admin,
    createdAt: p.created_at,
    email: emailByUserId.get(p.id) || null,
    projectCount: projectCountByUserId.get(p.id) || 0,
  }));

  return NextResponse.json({ data });
}
