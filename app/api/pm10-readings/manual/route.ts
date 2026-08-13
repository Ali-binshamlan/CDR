// -------------------------------------------------------------
// المسار: app/api/pm10-readings/manual/route.ts
//
// نقطة الدخول الوحيدة الآن لتسجيل قراءة PM10 يدوية في pm10_readings_history
// (source='manual'). خطأ حرج مكتشَف ومُصلَح (مراجعة كود خارجي — "المسار
// القديم للتنبيهات ينافس Outbox ويصنع قراءات PM10 وهمية"): كان القياس
// اليدوي يدخل كأثر جانبي غير مباشر (نسخ project_dust_profiles.onsite_pm10
// الثابت بوقت جديد في كل تشغيل مولّد/تقييم — راجع alerts/generate/route.ts
// وdustEvaluation.ts للتفصيل الكامل المحذوف). الآن يدخل فقط عبر فعل مستخدم
// صريح واحد هنا، بثلاثة عناصر لا تتوفر في المسار القديم إطلاقاً:
//   • observed_at : وقت الرصد الميداني الفعلي (لا وقت الإدخال في النظام).
//   • operator_id  : مُشتَق من الجلسة على الخادم — لا حقل عميل (نفس مبدأ
//                    device_id في dust-profiles/route.ts).
//   • idempotency_key : يمنع تكرار نفس القياس عند إعادة إرسال الطلب (فشل
//                    شبكة/نقر مزدوج) — فريد ضمن (project_id,
//                    activity_group_id)، يُطبَّق ذرّياً عبر
//                    insert_manual_pm10_reading_atomic (migration
//                    202608120001).
// -------------------------------------------------------------

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { requireUserId, verifyProjectOwnership } from '@/app/lib/apiAuth';
import { safeErrorResponse } from '@/app/lib/apiError';

const ManualPm10ReadingSchema = z.object({
  project_id: z.string().uuid(),
  activity_group_id: z.string().min(1).max(200),
  pm10_ug_m3: z.number().finite().min(0),
  observed_at: z.string().datetime({ offset: true }),
  idempotency_key: z.string().min(1).max(200),
});

export async function POST(request: NextRequest) {
  const auth = await requireUserId(request);
  if ('error' in auth) return auth.error;

  const body = await request.json().catch(() => null);
  const parsed = ManualPm10ReadingSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'حمولة القراءة اليدوية غير صالحة', details: parsed.error.issues },
      { status: 400 }
    );
  }
  const { project_id, activity_group_id, pm10_ug_m3, observed_at, idempotency_key } = parsed.data;

  const owns = await verifyProjectOwnership(project_id, auth.userId);
  if (!owns) return NextResponse.json({ error: 'لا تملك هذا المشروع' }, { status: 403 });

  // observed_at لا يجوز أن يكون بالمستقبل — قياس ميداني يُدخَل بعد الرصد
  // الفعلي دائماً، لا قبله. هامش 5 دقائق يتحمّل فرق ساعة جهاز العميل الطفيف.
  if (new Date(observed_at).getTime() > Date.now() + 5 * 60000) {
    return NextResponse.json({ error: 'observed_at لا يمكن أن يكون بالمستقبل' }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin.rpc('insert_manual_pm10_reading_atomic', {
    p_project_id: project_id,
    p_activity_group_id: activity_group_id,
    p_operator_id: auth.userId,
    p_pm10_ug_m3: pm10_ug_m3,
    p_observed_at: observed_at,
    p_idempotency_key: idempotency_key,
  });
  if (error) {
    // activity_group_id غير موجود لهذا المشروع (راجع فحص FK اليدوي داخل
    // الدالة الذرية نفسها) — 404 يميّزه عن أخطاء الخادم العامة أدناه.
    if (error.message?.includes('activity_group_id not found')) {
      return NextResponse.json({ error: 'activity_group_id غير موجود لهذا المشروع' }, { status: 404 });
    }
    return NextResponse.json({ error: safeErrorResponse(error, 'manual pm10 reading insert failed') }, { status: 500 });
  }

  const result = (data as { is_duplicate?: boolean; reading_id?: string }[] | null)?.[0];
  return NextResponse.json({
    success: true,
    duplicate: Boolean(result?.is_duplicate),
    readingId: result?.reading_id ?? null,
  });
}
