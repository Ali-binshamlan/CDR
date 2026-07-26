import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { requireUserId } from '@/app/lib/apiAuth';
import { computeDustResults, computeDustComplianceResults, computeUnifiedActivityDecision, riyadhLocalToUtcIso } from '@/app/lib/dustEvaluation';
import { buildSensitiveReceptor } from '@/app/utils/dust-compliance-engine';

// يجمع كل استعلامات المشاريع/التنبيهات/أنشطة اليوم/القرارات في نداء واحد
// لصفحة لوحة التحكم الرئيسية. نسخة DCR: غبار فقط، بلا رافعات/حرارة.
export async function GET(request: NextRequest) {
  const auth = await requireUserId(request);
  if ('error' in auth) return auth.error;
  const userId = auth.userId;

  const todayStr = new Date().toLocaleDateString('en-CA');

  const { data: projectsData, error: projectsError } = await supabaseAdmin
    .from('projects')
    .select('*')
    .eq('user_id', userId);
  if (projectsError) return NextResponse.json({ error: projectsError.message }, { status: 500 });

  const projectIds = (projectsData || []).map((p: any) => p.id);

  // state != 'CLOSED' يطابق تعريف "غير مغلق" المستخدم في مولّد التنبيهات
  // (alertExists) وباقي مسارات القراءة — لا عمود is_resolved في DCR.
  const { data: alerts, error: alertsError } = await supabaseAdmin
    .from('alerts')
    .select('*, projects!inner(name, city, user_id)')
    .neq('state', 'CLOSED')
    .eq('projects.user_id', userId)
    .order('created_at', { ascending: false });
  if (alertsError) return NextResponse.json({ error: alertsError.message }, { status: 500 });

  let dustData: any[] = [];
  let decisionsData: any[] = [];
  let liveActivityByProjectId: Record<string, { decisionLabelAr: string; shortReason: string; level: string; mandatoryStop: boolean }> = {};

  if (projectIds.length > 0) {
    const [dustRes, decisionsRes] = await Promise.all([
      supabaseAdmin.from('project_dust_profiles').select('*').in('project_id', projectIds).eq('planned_date', todayStr),
      supabaseAdmin.from('decision_records').select('*').in('project_id', projectIds).order('created_at', { ascending: false }),
    ]);
    dustData = dustRes.data || [];
    decisionsData = decisionsRes.data || [];

    // حالة النشاط الجاري الفعلية — تُحسب فقط للأنشطة الجارية الآن فعلياً
    // (لا كل أنشطة اليوم)، مشروع واحد على الأكثر لكل مشروع (أول نشاط جارٍ
    // يُعثر عليه)، لتلوين نقطة الخريطة بحالته الحية بدل أخطر تنبيه فقط.
    const nowMs = Date.now();
    const projectById = new Map((projectsData || []).map((p: any) => [p.id, p]));
    const runningRowsByProject = new Map<string, any>();
    for (const row of dustData) {
      if (runningRowsByProject.has(row.project_id)) continue;
      const startIso = riyadhLocalToUtcIso(row.planned_date, row.planned_time);
      if (!startIso) continue;
      const durationHours = Math.max(1, Math.round(row.duration_hours || 1));
      const endMs = new Date(startIso).getTime() + durationHours * 3600000;
      if (nowMs >= new Date(startIso).getTime() && nowMs <= endMs) {
        runningRowsByProject.set(row.project_id, row);
      }
    }

    // مستقبِلات حساسة — نفس مصدر [projectId]/route.ts، مطلوبة لمحرك
    // الامتثال (مسافة الكسارة/الأكوام) حتى تطابق حالة نقطة الخريطة تماماً
    // "القرار الموحد للنشاط" المعروض في صفحة تفاصيل المشروع.
    const { data: sensitiveReceptorRows } = await supabaseAdmin
      .from('sensitive_receptors')
      .select('id, name, receptor_type, lat, lng');
    const sensitiveReceptors = (sensitiveReceptorRows || []).map(buildSensitiveReceptor);

    const liveResults = await Promise.all(
      Array.from(runningRowsByProject.entries()).map(async ([projectId, row]) => {
        const project = projectById.get(projectId);
        if (!project) return null;
        try {
          const dustResults = await computeDustResults([row], project, supabaseAdmin);
          const result = dustResults[0];
          if (!result) return null;
          const complianceResults: any[] = await computeDustComplianceResults([row], project, dustResults, sensitiveReceptors, supabaseAdmin);
          const compliance = complianceResults[0]?.result ?? null;
          const unified = computeUnifiedActivityDecision(result.windowEval.worst, compliance);
          return { projectId, ...unified };
        } catch {
          return null;
        }
      })
    );
    liveActivityByProjectId = Object.fromEntries(
      liveResults.filter((r): r is NonNullable<typeof r> => !!r).map((r) => [r.projectId, r])
    );
  }

  return NextResponse.json({
    projects: projectsData || [],
    alerts: alerts || [],
    dustActivities: dustData,
    decisions: decisionsData,
    executionWindows: [],
    liveActivityByProjectId,
  });
}
