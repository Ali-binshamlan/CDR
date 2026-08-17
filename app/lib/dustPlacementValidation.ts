import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { safeErrorResponse } from '@/app/lib/apiError';
import {
  buildProjectComplianceProfile,
  buildSensitiveReceptor,
  classifyProject,
  nearestReceptorDistancesM,
  refreshRuleParameters,
  getRuleParameters,
  withRuleParametersLock,
} from '@/app/utils/dust-compliance-engine';
import { buildOsmProximityWarning } from '@/app/utils/geo/overpassReceptors';
import type { DustRiskClass } from '@/app/utils/dust-compliance-engine/types';

// طلب صريح من المستخدم (تطبيق تقرير المراجعة الثاني) — منطق فحص موقع وحدة
// كسارة/محطة خلط كان مكرَّراً حرفياً بثلاث نسخ منفصلة (crusher-precheck،
// batching-precheck، ونقطة الحفظ الفعلية في app/api/dust-profiles/route.ts)
// قابلة للانحراف عن بعضها بمرور الوقت. هذه الخدمة المصدر الوحيد الآن؛ كل
// الثلاثة تستدعيها مباشرة بلا أي تكرار منطقي.
//
// PLACEMENT_NOT_VERIFIED (لا 'blocked: false' زائفة) يميّز صراحة بين "تحقّقنا
// والموقع سليم" و"تعذّر التحقق فعلياً" (فشل جلب sensitive_receptors من
// القاعدة) — الحالة الثانية يجب ألا تُعامَل كسماح ضمني بالحفظ.
export type PlacementValidationResult =
  | { verified: false; error: string }
  | {
      verified: true;
      blocked: boolean;
      reasonsAr: string[];
      riskClass?: DustRiskClass;
      nearestReceptorM: number | null;
      nearestResidentialReceptorM: number | null;
    };

type ValidatePlacementArgs = {
  projectId: string;
  lat: number;
  lng: number;
  activityType: 'CRUSHER' | 'BATCHING_PLANT';
};

export async function validateDustUnitPlacement({
  projectId,
  lat,
  lng,
  activityType,
}: ValidatePlacementArgs): Promise<PlacementValidationResult> {
  const receptorsQuery = supabaseAdmin.from('sensitive_receptors').select('id, name, receptor_type, lat, lng');
  const projectQuery =
    activityType === 'CRUSHER'
      ? supabaseAdmin
          .from('projects')
          .select('site_area_m2, daily_truck_movements, has_onsite_crusher, has_onsite_batching_plant')
          .eq('id', projectId)
          .maybeSingle()
      : null;

  const [receptorsResult, projectResult] = await Promise.all([
    receptorsQuery,
    projectQuery ?? Promise.resolve({ data: null, error: null }),
  ]);

  // خطأ أمني يجب تجنبه (نمط ثابت في كل نسخ هذا المنطق السابقة): فشل
  // الاستعلام يجب ألا يتحول بصمت إلى "لا مستقبِلات" (مسافة Infinity = آمن
  // زوراً) — verified:false صريح بدل أمان كاذب.
  if (receptorsResult.error) {
    return { verified: false, error: safeErrorResponse(receptorsResult.error, 'sensitive_receptors fetch failed') };
  }
  if (projectResult.error) {
    return { verified: false, error: safeErrorResponse(projectResult.error, 'project fetch failed') };
  }

  // خطأ تزامن مكتشَف ومُصلَح (مراجعة كود خبير ثانية — "القفل الجديد تحسن
  // جيد، لكن مسار فحص الموقع يستطيع تحديث الحالة العامة خارج القفل"):
  // refreshRuleParameters/getRuleParameters يقرآن ويكتبان current/
  // currentVersionIds المشتركتين على مستوى الـprocess (ruleParameters.ts)
  // — evaluateProject تُغلِّف نفس التسلسل بـwithRuleParametersLock تحديداً
  // لمنع دورة متزامنة من استبدال current تحت أقدام دورة قيد التنفيذ (راجع
  // تعليق ruleParameters.ts أعلى withRuleParametersLock للسبب الكامل).
  // هذا المسار (يُستدعى من نقطة الحفظ الفعلية وrusher/batching-precheck
  // الحيّين، قد يتزامن مع دورة evaluateProject مقفَلة على نفس الـinstance)
  // كان يستدعي refreshRuleParameters مباشرة بلا أي قفل — يستطيع استبدال
  // current بينما دورة evaluateProject مقفَلة لا تزال بين استدعائها
  // الخاص لـrefreshRuleParameters واستهلاكها الفعلي للقيم، فتحصل تلك
  // الدورة على قيم لا تطابق rule_parameter_version_snapshot التي التقطتها
  // فعلياً. تغليف نفس القسم بـwithRuleParametersLock هنا يُدخِله في نفس
  // طابور runQueue، فلا يعود ممكناً أن يتشابك مع أي دورة evaluateProject.
  const { nearestAnyM, nearestResidentialM, CRUSHER_GENERAL_RECEPTOR_DISTANCE_M, CRUSHER_SENSITIVE_RECEPTOR_DISTANCE_M } =
    await withRuleParametersLock(async () => {
      await refreshRuleParameters(supabaseAdmin);
      const sensitiveReceptors = (receptorsResult.data || []).map(buildSensitiveReceptor);
      const distances = nearestReceptorDistancesM(lat, lng, sensitiveReceptors);
      const params = getRuleParameters();
      return {
        nearestAnyM: distances.nearestAnyM,
        nearestResidentialM: distances.nearestResidentialM,
        CRUSHER_GENERAL_RECEPTOR_DISTANCE_M: params.CRUSHER_GENERAL_RECEPTOR_DISTANCE_M,
        CRUSHER_SENSITIVE_RECEPTOR_DISTANCE_M: params.CRUSHER_SENSITIVE_RECEPTOR_DISTANCE_M,
      };
    });

  const reasons: string[] = [];
  let riskClass: DustRiskClass | undefined;

  if (activityType === 'CRUSHER') {
    const { riskClass: computedRiskClass } = classifyProject(buildProjectComplianceProfile(projectResult.data));
    riskClass = computedRiskClass;
    if (computedRiskClass !== 'CATEGORY_III_HIGH') {
      reasons.push('الكسارات مسموحة فقط في مشاريع الفئة الثالثة (عالية المخاطر) — تصنيف هذا المشروع الحالي لا يستوفي الشرط');
    }
    if (nearestAnyM !== null && nearestAnyM < CRUSHER_GENERAL_RECEPTOR_DISTANCE_M) {
      reasons.push(
        `الموقع المحدَّد على بُعد ${Math.round(nearestAnyM)} م فقط من أقرب مستقبل حساس — أقل من الحد الأدنى (${CRUSHER_GENERAL_RECEPTOR_DISTANCE_M} م)`
      );
    }
    if (nearestResidentialM !== null && nearestResidentialM < CRUSHER_SENSITIVE_RECEPTOR_DISTANCE_M) {
      reasons.push(
        `الموقع المحدَّد على بُعد ${Math.round(nearestResidentialM)} م فقط من أقرب منطقة سكنية/مدرسة/مستشفى — أقل من الحد الأدنى (${CRUSHER_SENSITIVE_RECEPTOR_DISTANCE_M} م)`
      );
    }
  } else {
    if (nearestAnyM !== null && nearestAnyM < CRUSHER_GENERAL_RECEPTOR_DISTANCE_M) {
      reasons.push(
        `الموقع المحدَّد على بُعد ${Math.round(nearestAnyM)} م فقط من أقرب مستقبل حساس (مدرسة/مستشفى/مسجد/منطقة سكنية) — أقل من الحد الأدنى (${CRUSHER_GENERAL_RECEPTOR_DISTANCE_M} م)`
      );
    }
  }

  // اكتشاف OSM (مصدر مجتمعي مفتوح) — تنبيه نصي فقط، لا يمنع الحفظ. فشل
  // الجلب من Overpass fail-open بتصميم متعمَّد (راجع overpassReceptors.ts)
  // — لا يُسقط هذا الفحص بأكمله.
  const osmThresholdM = activityType === 'CRUSHER' ? CRUSHER_SENSITIVE_RECEPTOR_DISTANCE_M : CRUSHER_GENERAL_RECEPTOR_DISTANCE_M;
  const osmWarning = await buildOsmProximityWarning(lat, lng, osmThresholdM);
  if (osmWarning) reasons.push(osmWarning);

  // قرار مُعاد النظر فيه بالكامل (طلب صريح من المستخدم — "المستقبلات الحساسة
  // لا تدخل ضمن قرارات الإيقاف"، يشمل صراحة منع حفظ الموقع على الخريطة، لا
  // فقط القرار التشغيلي اللاحق): blocked أصبحت false دائماً — reasons تبقى
  // تُبنى وتُعاد كتنبيه نصي بحت (reasonsAr) يعرضه index.tsx للمستخدم، لكن
  // بلا منع فعلي للحفظ. لا حذف لمنطق حساب المسافة/التصنيف نفسه (لا يزال
  // مفيداً كتنبيه توعوي)، فقط أثره على blocked أُلغي.
  return {
    verified: true,
    blocked: false,
    reasonsAr: reasons,
    ...(activityType === 'CRUSHER' ? { riskClass } : {}),
    nearestReceptorM: nearestAnyM === Infinity ? null : nearestAnyM,
    nearestResidentialReceptorM: nearestResidentialM === Infinity ? null : nearestResidentialM,
  };
}
