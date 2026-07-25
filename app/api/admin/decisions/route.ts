import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { requireSuperAdmin } from '@/app/lib/apiAuth';

// كل القرارات الموثَّقة (decision_records) عبر كل المشاريع — نفس نمط
// admin/alerts بالضبط (decision_records.project_id له FK حقيقي لـ
// projects.id، فـ embed !inner صالح). حد 200 صف موثّق كقيد معروف.
export async function GET(request: NextRequest) {
  const auth = await requireSuperAdmin(request);
  if ('error' in auth) return auth.error;

  const { data: decisions, error: decisionsError } = await supabaseAdmin
    .from('decision_records')
    .select('*, projects!inner(id, name, city, user_id)')
    .order('created_at', { ascending: false })
    .limit(200);
  if (decisionsError) return NextResponse.json({ error: decisionsError.message }, { status: 500 });

  const { data: profiles } = await supabaseAdmin.from('profiles').select('id, username, company_name');
  const profileByUserId = new Map((profiles || []).map((p: any) => [p.id, p]));

  // activity_id نص حر يقارَن بـ project_dust_profiles.id (لا FK رسمي) —
  // نجلب activity_type لعرضه مترجماً بدل رمز خام، نفس نمط admin/alerts.
  const activityIds = [...new Set((decisions || []).map((d: any) => d.activity_id).filter(Boolean))];
  const { data: dustProfiles } = activityIds.length > 0
    ? await supabaseAdmin.from('project_dust_profiles').select('id, activity_type').in('id', activityIds)
    : { data: [] as any[] };
  const activityTypeById = new Map((dustProfiles || []).map((p: any) => [p.id, p.activity_type]));

  const data = (decisions || []).map((decision: any) => {
    const owner = profileByUserId.get(decision.projects?.user_id);
    return {
      ...decision,
      projectName: decision.projects?.name || null,
      projectCity: decision.projects?.city || null,
      ownerUsername: owner?.username || null,
      ownerCompany: owner?.company_name || null,
      activityType: activityTypeById.get(decision.activity_id) || null,
    };
  });

  return NextResponse.json({ data });
}
