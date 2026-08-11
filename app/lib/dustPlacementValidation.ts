import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { safeErrorResponse } from '@/app/lib/apiError';
import {
  buildProjectComplianceProfile,
  buildSensitiveReceptor,
  classifyProject,
  nearestReceptorDistancesM,
  refreshRuleParameters,
  getRuleParameters,
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

  await refreshRuleParameters(supabaseAdmin);

  const sensitiveReceptors = (receptorsResult.data || []).map(buildSensitiveReceptor);
  const { nearestAnyM, nearestResidentialM } = nearestReceptorDistancesM(lat, lng, sensitiveReceptors);
  const { CRUSHER_GENERAL_RECEPTOR_DISTANCE_M, CRUSHER_SENSITIVE_RECEPTOR_DISTANCE_M } = getRuleParameters();

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

  // طلب صريح من المستخدم — جدول sensitive_receptors اليدوي قد يبقى فارغاً
  // بلا إدخال بشري؛ اكتشاف OSM (مصدر مجتمعي مفتوح) هنا يمنع الحفظ فقط (لا
  // يُصدر مخالفة تنظيمية) عند وجود مستقبِل قريب لم يُدخَل يدوياً بعد. فشل
  // الجلب من Overpass fail-open بتصميم متعمَّد (راجع overpassReceptors.ts)
  // — لا يُسقط هذا الفحص بأكمله.
  const osmThresholdM = activityType === 'CRUSHER' ? CRUSHER_SENSITIVE_RECEPTOR_DISTANCE_M : CRUSHER_GENERAL_RECEPTOR_DISTANCE_M;
  const osmWarning = await buildOsmProximityWarning(lat, lng, osmThresholdM);
  if (osmWarning) reasons.push(osmWarning);

  return {
    verified: true,
    blocked: reasons.length > 0,
    reasonsAr: reasons,
    ...(activityType === 'CRUSHER' ? { riskClass } : {}),
    nearestReceptorM: nearestAnyM === Infinity ? null : nearestAnyM,
    nearestResidentialReceptorM: nearestResidentialM === Infinity ? null : nearestResidentialM,
  };
}
