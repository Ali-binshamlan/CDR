import { NextResponse } from 'next/server';
import { requireUserId, verifyProjectOwnership } from '@/app/lib/apiAuth';
import { validateDustUnitPlacement } from '@/app/lib/dustPlacementValidation';

// طلب صريح من المستخدم — تحقق فوري قبل الحفظ عند تحديد موقع الكسارة على
// الخريطة، بدل انتظار محرك التقييم اللاحق (evaluateProject.ts) الذي يطبّق
// نفس القاعدتين فعلياً (CRUSHER-CATEGORY-001/CRUSHER-DISTANCE-*) لكن بعد
// حفظ النشاط. المنطق الفعلي (فئة المشروع + مسافة المستقبل الحساس + تحذير
// OSM) موحَّد الآن في app/lib/dustPlacementValidation.ts — يُستخدَم هنا،
// في batching-precheck، وفي نقطة الحفظ الفعلية app/api/dust-profiles/route.ts
// معاً، بلا أي تكرار منطقي قابل للانحراف عن بعضه.
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

  const result = await validateDustUnitPlacement({ projectId, lat, lng, activityType: 'CRUSHER' });

  // خطأ أمني يجب تجنبه (نفس نمط app/api/projects/[projectId]/route.ts):
  // فشل التحقق يجب ألا يتحول بصمت إلى "لا مستقبِلات" (مسافة Infinity = آمن
  // زوراً) — فشل صريح (503) بدل أمان كاذب.
  if (!result.verified) {
    return NextResponse.json({ error: 'PLACEMENT_NOT_VERIFIED', detail: result.error }, { status: 503 });
  }

  return NextResponse.json({
    blocked: result.blocked,
    reasonsAr: result.reasonsAr,
    riskClass: result.riskClass,
    nearestReceptorM: result.nearestReceptorM,
    nearestResidentialReceptorM: result.nearestResidentialReceptorM,
  });
}
