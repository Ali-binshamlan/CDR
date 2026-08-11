import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { requireUserId, verifyProjectOwnership } from '@/app/lib/apiAuth';
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

// طلب صريح من المستخدم — تحقق فوري قبل الحفظ عند تحديد موقع الكسارة على
// الخريطة، بدل انتظار محرك التقييم اللاحق (evaluateProject.ts) الذي يطبّق
// نفس القاعدتين فعلياً (CRUSHER-CATEGORY-001/CRUSHER-DISTANCE-*) لكن بعد
// حفظ النشاط. هذا route لا يستدعي evaluateDustCompliance الكامل (لا حاجة
// لتشغيل المحرك بأكمله لأجل فحصين فقط) — يعيد استخدام نفس اللبنات المستخدَمة
// داخل crusherRules (rulebook.ts) مباشرة: classifyProject للفئة،
// nearestReceptorDistancesM (geo.ts) للمسافة، بنفس عتبتي 200م/500م القابلتين
// للنشر عبر rule_parameter_versions (CRUSHER_GENERAL_RECEPTOR_DISTANCE_M/
// CRUSHER_SENSITIVE_RECEPTOR_DISTANCE_M) — لا تكرار لأرقام أو منطق منفصل قد
// ينحرف عن القرار النهائي الفعلي.
//
// هذا Hard Block حقيقي في الواجهة (طلب صريح من المستخدم) — index.tsx يمنع
// الحفظ فعلياً إن كانت آخر نتيجة معروفة blocked=true لموقع الكسارة الحالي.
export async function POST(request: Request) {
  const auth = await requireUserId(request);
  if ('error' in auth) return auth.error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'جسم الطلب غير صالح' }, { status: 400 });
  }

  const { projectId, lat, lng } = (body ?? {}) as { projectId?: unknown; lat?: unknown; lng?: unknown };
  if (typeof projectId !== 'string' || !projectId) {
    return NextResponse.json({ error: 'projectId مطلوب' }, { status: 400 });
  }
  if (typeof lat !== 'number' || typeof lng !== 'number' || Number.isNaN(lat) || Number.isNaN(lng)) {
    return NextResponse.json({ error: 'lat/lng مطلوبان كأرقام صالحة' }, { status: 400 });
  }

  const isOwner = await verifyProjectOwnership(projectId, auth.userId);
  if (!isOwner) {
    return NextResponse.json({ error: 'غير مصرّح بالوصول لهذا المشروع' }, { status: 403 });
  }

  const [projectResult, receptorsResult] = await Promise.all([
    supabaseAdmin
      .from('projects')
      .select('site_area_m2, daily_truck_movements, has_onsite_crusher, has_onsite_batching_plant')
      .eq('id', projectId)
      .maybeSingle(),
    supabaseAdmin.from('sensitive_receptors').select('id, name, receptor_type, lat, lng'),
  ]);

  if (projectResult.error) {
    return NextResponse.json({ error: safeErrorResponse(projectResult.error, 'project fetch failed') }, { status: 500 });
  }
  // خطأ أمني يجب تجنبه (نفس نمط app/api/projects/[projectId]/route.ts):
  // فشل استعلام sensitive_receptors يجب ألا يتحول بصمت إلى "لا مستقبِلات"
  // (مسافة Infinity = آمن زوراً) — فشل صريح بدل أمان كاذب.
  if (receptorsResult.error) {
    return NextResponse.json(
      { error: safeErrorResponse(receptorsResult.error, 'sensitive_receptors fetch failed') },
      { status: 500 }
    );
  }

  await refreshRuleParameters(supabaseAdmin);

  const projectProfile = buildProjectComplianceProfile(projectResult.data);
  const { riskClass } = classifyProject(projectProfile);
  const sensitiveReceptors = (receptorsResult.data || []).map(buildSensitiveReceptor);
  const { nearestAnyM, nearestResidentialM } = nearestReceptorDistancesM(lat, lng, sensitiveReceptors);

  const { CRUSHER_GENERAL_RECEPTOR_DISTANCE_M, CRUSHER_SENSITIVE_RECEPTOR_DISTANCE_M } = getRuleParameters();

  const reasons: string[] = [];

  if (riskClass !== 'CATEGORY_III_HIGH') {
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

  // طلب صريح من المستخدم — ثغرة مكتشفة: جدول sensitive_receptors اليدوي
  // (المصدر الوحيد أعلاه) قد يبقى فارغاً بلا أي إدخال بشري، فتمر كسارة قرب
  // مسجد حقيقي بلا أي إيقاف رغم وجوده فعلياً على خرائط OpenStreetMap. لا
  // يجوز لاكتشاف OSM (مصدر مجتمعي مفتوح غير موثَّق الدقة) أن يُصدر إيقافاً
  // إلزامياً تلقائياً في القرار التنظيمي النهائي (الفصل الأصلي في
  // overpassReceptors.ts يبقى صحيحاً) — لكن هنا، في مرحلة *ما قبل الحفظ*
  // فقط، الأثر مختلف تماماً: لا نُصدر مخالفة، فقط نمنع المستخدم من إكمال
  // الحفظ دون تحقق يدوي (إما تأكيد المسافة يدوياً أو إدخال المستقبِل رسمياً
  // في sensitive_receptors). فشل الجلب من OSM يُعامَل بأمان (null، لا سبب
  // حظر جديد) — لا يُسقط هذا الفحص طلب precheck بأكمله.
  const osmWarning = await buildOsmProximityWarning(lat, lng, CRUSHER_SENSITIVE_RECEPTOR_DISTANCE_M);
  if (osmWarning) reasons.push(osmWarning);

  return NextResponse.json({
    blocked: reasons.length > 0,
    reasonsAr: reasons,
    riskClass,
    nearestReceptorM: nearestAnyM === Infinity ? null : nearestAnyM,
    nearestResidentialReceptorM: nearestResidentialM === Infinity ? null : nearestResidentialM,
  });
}
