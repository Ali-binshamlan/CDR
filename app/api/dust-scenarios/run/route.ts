import { NextResponse, type NextRequest } from 'next/server';
import { requireSuperAdmin } from '@/app/lib/apiAuth';
import { startScenarioRun, getActiveRun } from '@/app/lib/dustScenarioRunner';
import { findDustScenario } from '@/app/lib/dustScenarios';

// بدء تشغيل سيناريو اختبار — يرسل telemetry حقيقية إلى جهاز ThingsBoard
// فعلي (THINGSBOARD_DEVICE_TOKEN من بيئة السيرفر، لا يظهر أبداً للمتصفح).
// مقصورة على سوبر أدمن: أداة تشغيلية تكتب قراءات حقيقية على جهاز حي، لا
// أداة عرض عامة.
export async function POST(request: NextRequest) {
  const auth = await requireSuperAdmin(request);
  if ('error' in auth) return auth.error;

  const deviceToken = process.env.THINGSBOARD_DEVICE_TOKEN;
  if (!deviceToken) {
    return NextResponse.json(
      { error: 'THINGSBOARD_DEVICE_TOKEN غير مُعرَّف في بيئة السيرفر — لا يمكن تشغيل السيناريوهات' },
      { status: 500 }
    );
  }
  const baseUrl = process.env.THINGSBOARD_BASE_URL || 'https://thingsboard.cloud';

  const body = await request.json().catch(() => null);
  const scenarioId = (body as { scenarioId?: string } | null)?.scenarioId;
  if (!scenarioId || typeof scenarioId !== 'string') {
    return NextResponse.json({ error: 'scenarioId إلزامي' }, { status: 400 });
  }
  if (!findDustScenario(scenarioId)) {
    return NextResponse.json({ error: 'سيناريو غير معروف' }, { status: 404 });
  }

  const active = getActiveRun();
  if (active && active.status === 'RUNNING') {
    return NextResponse.json(
      { error: `يوجد سيناريو قيد التشغيل بالفعل (${active.scenarioTitleAr}) — أوقفه أولاً`, activeRun: active },
      { status: 409 }
    );
  }

  // فاصل الإرسال اختياري (اختبار سريع)؛ الحد الأدنى 5 ثوانٍ يمنع إغراق
  // جهاز ThingsBoard الفعلي بطلبات كثيفة عبر تلاعب بالجسم المُرسَل.
  const rawInterval = (body as { sendIntervalMs?: number } | null)?.sendIntervalMs;
  const sendIntervalMs =
    typeof rawInterval === 'number' && Number.isFinite(rawInterval)
      ? Math.max(5_000, Math.min(rawInterval, 60_000))
      : 60_000;

  const result = startScenarioRun({ scenarioId, baseUrl, deviceToken, sendIntervalMs });
  if ('error' in result) {
    return NextResponse.json({ error: result.error }, { status: 409 });
  }

  return NextResponse.json({ data: result });
}
