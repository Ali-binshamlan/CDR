import { NextResponse } from 'next/server';
import { requireUserId, verifyProjectOwnership } from '@/app/lib/apiAuth';
import { validateDustUnitPlacement } from '@/app/lib/dustPlacementValidation';

// طلب صريح من المستخدم — نفس مبدأ crusher-precheck، لمحطة الخلط (batching_
// plant): تحقق فوري قبل الحفظ عند تحديد موقع وحدة خلط على الخريطة، بدل
// انتظار محرك التقييم اللاحق الذي يطبّق فعلياً BATCHING-DISTANCE-200
// (rulebook.ts) بعد الحفظ. المنطق الفعلي موحَّد في
// app/lib/dustPlacementValidation.ts (راجع التعليق الكامل في crusher-
// precheck/route.ts) — لا فئة مشروع لمحطة الخلط (لا مكافئ لـ
// CRUSHER-CATEGORY-001)، فقط حد مسافة واحد (200م) عن أقرب مستقبل حساس
// بصرف النظر عن نوعه.
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

  const result = await validateDustUnitPlacement({ projectId, lat, lng, activityType: 'BATCHING_PLANT' });

  // خطأ أمني يجب تجنبه (نفس نمط crusher-precheck): فشل التحقق يجب ألا
  // يتحول بصمت إلى "لا مستقبِلات" (مسافة Infinity = آمن زوراً).
  if (!result.verified) {
    return NextResponse.json({ error: 'PLACEMENT_NOT_VERIFIED', detail: result.error }, { status: 503 });
  }

  return NextResponse.json({
    blocked: result.blocked,
    reasonsAr: result.reasonsAr,
    nearestReceptorM: result.nearestReceptorM,
  });
}
