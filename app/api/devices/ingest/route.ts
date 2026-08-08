import { NextResponse, type NextRequest } from 'next/server';
import { requireDeviceApiKey } from '@/app/lib/apiAuth';
import { checkRateLimit } from '@/app/lib/rateLimit';
import { writeDeviceReading } from '@/app/lib/deviceReadingWriter';
import { evaluateProject, enqueueEvaluationRetryJob } from '@/app/lib/evaluateProject';
import type { NormalizedReading } from '@/app/lib/providers/types';

// حد معدّل الإرسال لكل جهاز — دورة الإرسال التصميمية دقيقتان، فـ30 طلباً
// في الدقيقة هامش واسع جداً (يستوعب إعادة المحاولة والاختبار اليدوي عبر
// Postman) بينما يوقف الإغراق من مفتاح مسرَّب فوراً. راجع app/lib/rateLimit.ts
// لحدود هذا الأسلوب على بيئة serverless.
const INGEST_MAX_REQUESTS_PER_WINDOW = 30;
const INGEST_WINDOW_MS = 60_000;

// نقطة استقبال قراءة لحظية واحدة من جهاز رصد فعلي. المصادقة عبر مفتاح
// الجهاز فقط (Authorization: Bearer <raw key>) — لا deviceId في الرابط ولا
// في الجسم؛ الهوية تُشتق من المفتاح حصراً (نفس مبدأ requireUserId)، فلا
// يقدر جهاز أن "يدّعي" هوية جهاز آخر بإرسال معرّف مختلف.
//
// منطق الكتابة الفعلي (تحقق القيم، تحديث project_devices، تسجيل
// device_readings_history/pm10_readings_history) مُستخرَج إلى
// app/lib/deviceReadingWriter.ts — مشترك مع مسار السحب الدوري
// (app/api/cron/provider-pull/route.ts) لمحطات pull الخارجية.
const MEASUREMENT_FIELDS = [
  'windSpeedKmh',
  'windGustKmh',
  'windDirectionDeg',
  'pm10',
  'pm25',
  'visibilityM',
  'relativeHumidityPercent',
  'temperatureC',
] as const;

export async function POST(request: NextRequest) {
  const auth = await requireDeviceApiKey(request);
  if ('error' in auth) return auth.error;

  // الحد يُطبَّق بعد التحقق من الهوية (على deviceId لا على IP): الأجهزة في
  // موقع واحد قد تتشارك مخرج شبكة واحداً، والهوية الفعلية هي المفتاح نفسه.
  if (!checkRateLimit(auth.deviceId, INGEST_MAX_REQUESTS_PER_WINDOW, INGEST_WINDOW_MS)) {
    return NextResponse.json(
      { error: 'تجاوزت الحد المسموح من الطلبات — حاول بعد قليل' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil(INGEST_WINDOW_MS / 1000)) } }
    );
  }

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'جسم الطلب يجب أن يكون JSON صالحاً' }, { status: 400 });
  }

  // عقد حدث الجهاز (خطأ معماري مكتشَف ومُصلَح — مراجعة كود خبير خارجي —
  // C-03: "عقد أحداث الجهاز غير منفذ"): eventId/sequence/observedAt جميعها
  // إلزامية الآن (طلب صريح — إلزام كامل فوري، لا فترة سماح): أي جهاز/سكربت
  // لا يرسل الحقول الثلاثة يُرفَض بـ400 صراحة بدل قبوله بصمت بلا عقد حدث.
  // راجع supabase/migrations/202607290005_device_event_contract.sql للأعمدة/القيد.
  const rawEventId = (body as Record<string, unknown>).eventId;
  if (typeof rawEventId !== 'string' || !rawEventId.trim()) {
    return NextResponse.json({ error: 'eventId إلزامي ويجب أن يكون نصاً غير فارغ' }, { status: 400 });
  }
  const eventId = rawEventId.trim();

  // sequence: رقم صحيح غير سالب فقط — يُرفَض السالب/الكسري صراحة (كان
  // مسموحاً سابقاً رغم عدم منطقيته: تسلسل حدث لا يكون سالباً أو كسرياً).
  const rawSequence = (body as Record<string, unknown>).sequence;
  if (
    typeof rawSequence !== 'number' ||
    !Number.isFinite(rawSequence) ||
    !Number.isInteger(rawSequence) ||
    rawSequence < 0
  ) {
    return NextResponse.json({ error: 'sequence إلزامي ويجب أن يكون رقماً صحيحاً غير سالب' }, { status: 400 });
  }
  const sequence = rawSequence;

  // observedAt: وقت رصد القراءة الفعلي من الجهاز نفسه، مستقل عن وقت وصول
  // الخادم (receivedAt أدناه) — بلا هذا، جهاز يعيد إرسال حمولة قديمة محفوظة
  // محلياً (بعد انقطاع اتصال) يُختم بوقت الآن، فيبدو وكأن القراءة القديمة
  // "حديثة" فعلاً في حساب استمرار PM10 (computeSustainedPm10Status). نفس
  // فحصي H-03.2 (رفض المستقبل) المطبَّقين على recordedAt في dustEvaluation.ts:
  // قراءة بوقت مستقبلي أو أقدم من نافذة الاستمرار الزمنية القصوى (40 دقيقة،
  // PM10_SUSPENSION_MINUTES+10) تُرفض صراحة بدل قبولها كدليل صالح.
  const rawObservedAt = (body as Record<string, unknown>).observedAt;
  if (typeof rawObservedAt !== 'string' || !rawObservedAt.trim()) {
    return NextResponse.json({ error: 'observedAt إلزامي ويجب أن يكون نصاً بصيغة ISO' }, { status: 400 });
  }
  const observedMs = new Date(rawObservedAt).getTime();
  if (Number.isNaN(observedMs)) {
    return NextResponse.json({ error: 'observedAt ليس تاريخاً صالحاً' }, { status: 400 });
  }
  const nowMs = Date.now();
  const CLOCK_SKEW_TOLERANCE_MS = 2 * 60_000;
  if (observedMs > nowMs + CLOCK_SKEW_TOLERANCE_MS) {
    return NextResponse.json({ error: 'observedAt في المستقبل — تحقق من ساعة الجهاز' }, { status: 400 });
  }
  // خطأ مكتشَف ومُصلَح (مراجعة خبير خارجي — "القراءات المتأخرة أكثر من 40
  // دقيقة تُرفض بالكامل؛ الأفضل: حفظها في السجل التاريخي، تعليمها LATE،
  // منعها من تغيير الحالة التشغيلية الحالية، الاحتفاظ بها للتدقيق"): كان
  // هذا الشرط يرفض (400) القراءة بالكامل بلا أي كتابة — جهاز يرسل فعلياً
  // لكن بتأخر شبكة/إعادة اتصال كانت قراءته تختفي بلا أثر. الآن writeDeviceReading
  // (deviceReadingWriter.ts) يحسب نفس هذه النافذة ويُمرِّر p_is_late=true
  // للـRPC — القراءة تُسجَّل في device_readings_history/pm10_readings_history
  // بوسم is_late للتدقيق، لكن project_devices.last_*/device_metric_latest
  // (القرار الحي) لا تتأثر إطلاقاً. راجع migration
  // 202608060002_late_reading_history_no_state_mutation.sql.
  const observedAtIso = new Date(observedMs).toISOString();

  const reading: Partial<NormalizedReading> = { observedAtIso };
  for (const field of MEASUREMENT_FIELDS) {
    const value = (body as Record<string, unknown>)[field];
    if (value === undefined || value === null) continue;
    (reading as Record<string, unknown>)[field] = value;
  }

  const result = await writeDeviceReading({
    deviceId: auth.deviceId,
    projectId: auth.projectId,
    reading,
    externalEventId: eventId,
    sequence,
  });

  if (!result.success) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  if (result.duplicate) {
    return NextResponse.json({ success: true, duplicate: true, receivedAt: new Date().toISOString() });
  }

  // قراءة late لم تُغيّر أي حالة حية (RPC تجاهر project_devices.last_*/
  // device_metric_latest بالكامل عند is_late=true) — إعادة تقييم المشروع هنا
  // عمل ضائع محض (لا مدخل تغيّر فعلياً)، فتُستبعَد صراحة.
  if (result.late) {
    return NextResponse.json({ success: true, late: true, receivedAt: new Date().toISOString() });
  }

  // خطأ مكتشَف (مراجعة تصحيح خارجية — "القرار الحي يعتمد على متصفح مفتوح"):
  // مسار push هذا لم يكن يُطلق إعادة تقييم للمشروع بعد كتابة قراءة جديدة
  // بنجاح إطلاقاً — فقط app/api/cron/provider-pull/route.ts (مصادر pull)
  // كان يستدعي evaluateProject. جهاز يدفع بياناته مباشرة عبر هذا المسار
  // كان قراره التشغيلي (DVI/Compliance/FinalDecision) لا يتحدّث إلا عند
  // فتح المستخدم للوحة المشروع يدوياً. يُنتظَر هنا (لا fire-and-forget) —
  // دالة serverless على Vercel قد تُنهى فور إرجاع الاستجابة، فوعد معلَّق
  // بلا await ليس مضموناً أن يكتمل. فشل إعادة التقييم لا يُسقِط نجاح
  // الكتابة نفسها (القراءة محفوظة فعلاً بغض النظر) — يُسجَّل فقط، نفس مبدأ
  // معالجة الفشل الجزئي في provider-pull/route.ts.
  const evalResult = await evaluateProject(auth.projectId, 'device_ingest').catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`ingest: evaluateProject failed for project ${auth.projectId}:`, message);
    return { success: false as const, persisted: 0, error: message };
  });
  if (!evalResult.success) {
    console.error(`ingest: evaluateProject unsuccessful for project ${auth.projectId}:`, evalResult.error);
    // خطأ مكتشَف ومُصلَح (مراجعة خبير خارجي — "لا مهمة إعادة محاولة مضمونة
    // تربط القراءة المحفوظة بنجاح بالتقييم الفاشل بعدها"): راجع تعليق
    // enqueueEvaluationRetryJob في evaluateProject.ts — تضمن مهمة صريحة في
    // نفس طابور project_evaluation_jobs الذي يعالجه scheduler-worker، بدل
    // الاعتماد فقط على console.error ودورة scheduler-tick العامة القادمة.
    await enqueueEvaluationRetryJob(auth.projectId, 'DEVICE_EVENT', evalResult.error ?? 'فشل تقييم غير محدَّد');
  }

  return NextResponse.json({ success: true, receivedAt: new Date().toISOString() });
}
