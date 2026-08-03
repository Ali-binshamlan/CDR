import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import {
  computeDustResults,
  computeDustComplianceResults,
  persistActivityDecisionsAtomic,
} from '@/app/lib/dustEvaluation';
import { buildSensitiveReceptor } from '@/app/utils/dust-compliance-engine';

// منطق إعادة تقييم مشروع كامل (DVI + Compliance + FinalDecision) — مُستخرَج
// من app/api/projects/[projectId]/evaluate/route.ts ليُستدعى من مصدرين:
// (أ) POST /evaluate نفسه (بعد requireUserId/verifyProjectOwnership، طلب
// من متصفح مستخدم مسجَّل)، (ب) app/api/cron/provider-pull/route.ts مباشرة
// (استدعاء داخلي من كود خادم موثوق بعد سحب قراءة جديدة بنجاح — لا جلسة
// مستخدم متاحة في سياق الـcron، ولا حاجة لها: projectId هنا مصدره صف
// provider_connections الموجود فعلاً بقاعدة البيانات، لا مدخل عميل).
//
// بلا أي تحقق مصادقة/ملكية هنا عمداً — هذه مسؤولية المستدعي (route.ts
// لطلبات المستخدم، أو التحقق الضمني عبر provider_connections.project_id
// للـcron، الذي لا يقبل أصلاً project_id من أي مدخل خارجي).
export interface EvaluateProjectResult {
  success: boolean;
  persisted: number;
  failedActivityIds?: string[];
  // failedActivityIds المحصورة في تعارض CAS (كود 40001 — راجع تعليق
  // persist_activity_decision_atomic) وحده، بلا أي فشل حقيقي آخر معها.
  // دورة تقييم لاحقة (refresh المستخدم أو الـcron) تحلّها تلقائياً بإعادة
  // قراءة current_dust_decisions/current_dust_compliance_decisions من
  // جديد؛ لا تستحق نفس درجة الخطورة أو نفس معالجة الفشل الحقيقي في route.ts.
  conflictActivityIds?: string[];
  error?: string;
}

export async function evaluateProject(projectId: string): Promise<EvaluateProjectResult> {
  try {
    const { data: project } = await supabaseAdmin
      .from('projects')
      .select('*')
      .eq('id', projectId)
      .maybeSingle();
    if (!project) {
      return { success: false, persisted: 0, error: 'المشروع غير موجود' };
    }

    const [{ data: dustProfiles }, { data: projectShifts }] = await Promise.all([
      // archived_at is null — نشاط مؤرشَف (راجع DELETE في app/api/activities/
      // route.ts، الأرشفة حلّت محل الحذف الفعلي) يجب ألا يدخل دورة تقييم حية
      // جديدة، رغم بقاء أدلته التاريخية قابلة للقراءة دائماً في مكان آخر.
      supabaseAdmin.from('project_dust_profiles').select('*').eq('project_id', projectId).is('archived_at', null),
      supabaseAdmin.from('project_shifts').select('*').eq('project_id', projectId).order('sort_order', { ascending: true }),
    ]);
    project.shifts = projectShifts || [];

    const dustResults = await computeDustResults(dustProfiles || [], project, supabaseAdmin);
    if (dustResults.length === 0) {
      return { success: true, persisted: 0 };
    }

    const { data: sensitiveReceptorRows, error: sensitiveReceptorsError } = await supabaseAdmin
      .from('sensitive_receptors')
      .select('id, name, receptor_type, lat, lng');
    if (sensitiveReceptorsError) {
      return { success: false, persisted: 0, error: sensitiveReceptorsError.message };
    }
    const sensitiveReceptors = (sensitiveReceptorRows || []).map(buildSensitiveReceptor);

    const dustComplianceResults = await computeDustComplianceResults(
      dustProfiles || [],
      project,
      dustResults,
      sensitiveReceptors,
      supabaseAdmin,
      true
    );

    const persistResults = await persistActivityDecisionsAtomic(
      supabaseAdmin,
      projectId,
      dustResults,
      dustComplianceResults,
      'user_refresh',
      'user_refresh'
    );

    const allFailedActivityIds = persistResults.filter((r) => r.failed).map((r) => r.activityId);
    if (allFailedActivityIds.length > 0) {
      const conflictActivityIds = persistResults.filter((r) => r.failed && r.conflict).map((r) => r.activityId);
      const nonConflictFailedActivityIds = persistResults.filter((r) => r.failed && !r.conflict).map((r) => r.activityId);
      return {
        success: false,
        persisted: dustResults.length - allFailedActivityIds.length,
        failedActivityIds: nonConflictFailedActivityIds,
        conflictActivityIds,
        error:
          nonConflictFailedActivityIds.length > 0
            ? 'فشل حفظ سلسلة القرار كاملة لبعض الأنشطة'
            : 'تعارض CAS لبعض الأنشطة — أعد المحاولة',
      };
    }

    return { success: true, persisted: dustResults.length };
  } catch (error) {
    return { success: false, persisted: 0, error: error instanceof Error ? error.message : String(error) };
  }
}
