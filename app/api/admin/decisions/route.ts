import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { requireSuperAdmin } from '@/app/lib/apiAuth';
import { safeErrorResponse } from '@/app/lib/apiError';

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
  if (decisionsError) return NextResponse.json({ error: safeErrorResponse(decisionsError, 'admin/decisions fetch failed') }, { status: 500 });

  const { data: profiles } = await supabaseAdmin.from('profiles').select('id, username, company_name');
  const profileByUserId = new Map((profiles || []).map((p: { id: string; username: string | null; company_name: string | null }) => [p.id, p]));

  // activity_id نص حر يقارَن بـ project_dust_profiles.id (لا FK رسمي) —
  // نجلب regulatory_activity (النشاط التنظيمي المختار فعلياً) لعرضه بدل
  // activity_type الفيزيائي الداخلي، نفس نمط admin/alerts.
  const activityIds = [...new Set((decisions || []).map((d: { activity_id: string }) => d.activity_id).filter(Boolean))];
  const { data: dustProfiles } = activityIds.length > 0
    ? await supabaseAdmin.from('project_dust_profiles').select('id, activity_type, regulatory_activity').in('id', activityIds)
    : { data: [] as { id: string; activity_type: string | null; regulatory_activity: string | null }[] };
  const dustProfileById = new Map((dustProfiles || []).map((p: { id: string; activity_type: string | null; regulatory_activity: string | null }) => [p.id, p]));

  const data = (decisions || []).map((decision: { activity_id: string; projects?: { user_id: string; name: string | null; city: string | null } }) => {
    const owner = profileByUserId.get(decision.projects?.user_id ?? '');
    const dustProfile = dustProfileById.get(decision.activity_id);
    return {
      ...decision,
      projectName: decision.projects?.name || null,
      projectCity: decision.projects?.city || null,
      ownerUsername: owner?.username || null,
      ownerCompany: owner?.company_name || null,
      activityType: dustProfile?.activity_type || null,
      regulatoryActivity: dustProfile?.regulatory_activity || null,
    };
  });

  return NextResponse.json({ data });
}
