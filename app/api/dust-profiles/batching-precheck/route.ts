import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { requireUserId, verifyProjectOwnership } from '@/app/lib/apiAuth';
import { safeErrorResponse } from '@/app/lib/apiError';
import {
  buildSensitiveReceptor,
  nearestReceptorDistancesM,
  refreshRuleParameters,
  getRuleParameters,
} from '@/app/utils/dust-compliance-engine';

// طلب صريح من المستخدم — نفس مبدأ crusher-precheck، لمحطة الخلط (batching_
// plant): تحقق فوري قبل الحفظ عند تحديد موقع وحدة خلط على الخريطة، بدل
// انتظار محرك التقييم اللاحق الذي يطبّق فعلياً BATCHING-DISTANCE-200
// (rulebook.ts) بعد الحفظ. بخلاف الكسارة، لا توجد قاعدة فئة مشروع لمحطة
// الخلط (لا مكافئ لـCRUSHER-CATEGORY-001) — فقط حد مسافة واحد (200م) عن
// أقرب مستقبل حساس **بصرف النظر عن نوعه** (سكني/مدرسي/صحي/مسجد/غيره)،
// نفس CRUSHER_GENERAL_RECEPTOR_DISTANCE_M المُعاد استخدامها حرفياً في
// BATCHING-DISTANCE-200 — لذا يُستخدَم nearestAnyM هنا حصراً، لا
// nearestResidentialM (ذاك حصري لحد الـ500م الأشد الخاص بالكسارة فقط).
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

  const { data: receptorRows, error: receptorsError } = await supabaseAdmin
    .from('sensitive_receptors')
    .select('id, name, receptor_type, lat, lng');

  // خطأ أمني يجب تجنبه (نفس نمط crusher-precheck): فشل الاستعلام يجب ألا
  // يتحول بصمت إلى "لا مستقبِلات" (مسافة Infinity = آمن زوراً).
  if (receptorsError) {
    return NextResponse.json(
      { error: safeErrorResponse(receptorsError, 'sensitive_receptors fetch failed') },
      { status: 500 }
    );
  }

  await refreshRuleParameters(supabaseAdmin);

  const sensitiveReceptors = (receptorRows || []).map(buildSensitiveReceptor);
  const { nearestAnyM } = nearestReceptorDistancesM(lat, lng, sensitiveReceptors);
  const { CRUSHER_GENERAL_RECEPTOR_DISTANCE_M } = getRuleParameters();

  const reasons: string[] = [];
  if (nearestAnyM !== null && nearestAnyM < CRUSHER_GENERAL_RECEPTOR_DISTANCE_M) {
    reasons.push(
      `الموقع المحدَّد على بُعد ${Math.round(nearestAnyM)} م فقط من أقرب مستقبل حساس (مدرسة/مستشفى/مسجد/منطقة سكنية) — أقل من الحد الأدنى (${CRUSHER_GENERAL_RECEPTOR_DISTANCE_M} م)`
    );
  }

  return NextResponse.json({
    blocked: reasons.length > 0,
    reasonsAr: reasons,
    nearestReceptorM: nearestAnyM === Infinity ? null : nearestAnyM,
  });
}
