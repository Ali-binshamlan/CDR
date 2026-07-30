import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { requireDeviceApiKey } from '@/app/lib/apiAuth';
import { safeErrorResponse } from '@/app/lib/apiError';
import { checkRateLimit } from '@/app/lib/rateLimit';

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
// أسماء/وحدات الحقول مطابقة لـ DustWeatherSample (app/utils/dust-engine/
// types.ts) لتفادي أي تحويل لاحقاً في مسار المحرك. كل حقل قياس اختياري
// فردياً — جهاز قد يملك مستشعراً واحداً فقط (رياح فقط، أو PM فقط). الكتابة
// جزئية: الحقول الغائبة من الحمولة تبقى بقيمتها المخزَّنة سابقاً، لا تُصفَّر.
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

const COLUMN_BY_FIELD: Record<(typeof MEASUREMENT_FIELDS)[number], string> = {
  windSpeedKmh: 'last_wind_speed_kmh',
  windGustKmh: 'last_wind_gust_kmh',
  windDirectionDeg: 'last_wind_direction_deg',
  pm10: 'last_pm10',
  pm25: 'last_pm25',
  visibilityM: 'last_visibility_m',
  relativeHumidityPercent: 'last_relative_humidity_percent',
  temperatureC: 'last_temperature_c',
};

function validateValue(field: (typeof MEASUREMENT_FIELDS)[number], value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return `${field} يجب أن يكون رقماً`;
  if (field === 'windDirectionDeg') {
    if (value < 0 || value > 360) return 'windDirectionDeg يجب أن يكون بين 0 و360';
    return null;
  }
  // نطاق رطوبة نسبية فيزيائي صارم (0-100%) — أي قيمة خارجه خطأ جهاز واضح،
  // بنفس منطق windDirectionDeg أعلاه.
  if (field === 'relativeHumidityPercent') {
    if (value < 0 || value > 100) return 'relativeHumidityPercent يجب أن يكون بين 0 و100';
    return null;
  }
  // نطاق حرارة معقول لمستشعر ميداني بموقع إنشاءات بالرياض: -20 إلى 70°م —
  // يغطي أي ظرف واقعي محلياً + هامش أخطاء جهاز، بلا رفض قراءات صيف شديدة
  // الحرارة حقيقية.
  if (field === 'temperatureC') {
    if (value < -20 || value > 70) return 'temperatureC يجب أن يكون بين -20 و70';
    return null;
  }
  if (value < 0) return `${field} لا يمكن أن يكون سالباً`;
  return null;
}

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

  const updates: Record<string, unknown> = {};

  for (const field of MEASUREMENT_FIELDS) {
    const value = (body as Record<string, unknown>)[field];
    if (value === undefined || value === null) continue;
    const validationError = validateValue(field, value);
    if (validationError) {
      return NextResponse.json({ error: validationError }, { status: 400 });
    }
    updates[COLUMN_BY_FIELD[field]] = value;
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json(
      { error: 'يجب إرسال قيمة واحدة على الأقل من: ' + MEASUREMENT_FIELDS.join('، ') },
      { status: 400 }
    );
  }

  const receivedAt = new Date().toISOString();
  updates.last_reading_at = receivedAt;
  // خطأ مكتشَف ومُصلَح: last_reading_at وحده لا يكفي لمعرفة "متى آخر قراءة
  // PM10 فعلية" — عمود مشترك لكل الحقول، فتحديث جزئي (حرارة فقط مثلاً) كان
  // يجعل last_reading_at "حديثاً" رغم أن last_pm10 لم يتغيّر منذ زمن طويل،
  // فيختفي تحذير قِدم PM10 زوراً. last_pm10_at يُحدَّث فقط عند وجود pm10
  // فعلياً في هذه الحمولة تحديداً.
  if (typeof updates.last_pm10 === 'number') {
    updates.last_pm10_at = receivedAt;
  }

  const { error } = await supabaseAdmin
    .from('project_devices')
    .update(updates)
    .eq('id', auth.deviceId);

  if (error) return NextResponse.json({ error: safeErrorResponse(error, 'devices/ingest update failed') }, { status: 500 });

  // تسجيل القراءة الكاملة (كل الحقول الثمانية معاً، لا PM10 وحده) في السجل
  // التاريخي العام device_readings_history — يُستخدم لرسم بياني تاريخي لكل
  // عنصر قياس على حدة داخل بطاقة تفاصيل النشاط (طلب صريح من المستخدم:
  // "مؤشر للقراءات حق النشاط، رسم بياني منفصل لكل عنصر"). منفصل تماماً عن
  // pm10_readings_history أدناه (ذاك مخصَّص لحساب استمرار مخالفة PM10 تحديداً
  // بمنطق صارم على مصدر/حداثة القراءة — لا يجوز خلط الغرضين في جدول واحد).
  // يُسجَّل فقط لو وصل حقل قياس واحد على الأقل فعلياً في هذه الحمولة (Object.keys(updates)
  // تحقق منه أعلاه بالفعل)، حتى لو كان حقلاً واحداً فقط (صف جزئي، بقية
  // الأعمدة null — نفس فلسفة الكتابة الجزئية في project_devices).
  const { error: fullHistoryError } = await supabaseAdmin.from('device_readings_history').insert({
    project_id: auth.projectId,
    device_id: auth.deviceId,
    wind_speed_kmh: updates.last_wind_speed_kmh ?? null,
    wind_gust_kmh: updates.last_wind_gust_kmh ?? null,
    wind_direction_deg: updates.last_wind_direction_deg ?? null,
    pm10_ug_m3: updates.last_pm10 ?? null,
    pm25_ug_m3: updates.last_pm25 ?? null,
    visibility_m: updates.last_visibility_m ?? null,
    relative_humidity_percent: updates.last_relative_humidity_percent ?? null,
    temperature_c: updates.last_temperature_c ?? null,
    recorded_at: updates.last_reading_at,
  });
  if (fullHistoryError) {
    console.error('device_readings_history insert failed:', fullHistoryError.message);
  }

  // تسجيل PM10 في السجل التاريخي المنفصل (pm10_readings_history) — يُستخدم
  // لاحقاً لحساب استمرار القراءة عبر الزمن (RCRC-PM10-340-VIOLATION-011:
  // أكثر من دقيقتين، RCRC-PM10-30M-SUSPENSION-012: 30 دقيقة)، بمعزل عن
  // توقيت تقييمات dust_compliance_evaluations المتقطّع. project_id فقط
  // (لا activity_group_id) لأن الجهاز مرتبط بالمشروع ككل، لا نشاط محدد —
  // راجع computeSustainedPm10 في app/lib/dustEvaluation.ts.
  //
  // خطأ مكتشَف ومُصلَح: كان عمود activity_group_id لا يزال not null بقاعدة
  // البيانات (راجع supabase-fix-pm10-history-nullable-activity-group-
  // migration.sql) رغم أن هذا الإدراج يمرّره null دائماً عمداً — فكان كل
  // إدراج قراءة جهاز يفشل بصمت منذ البداية (بلا فحص error هنا)، فلا تصل
  // أي قراءة جهاز لهذا الجدول إطلاقاً مهما استمر التجاوز، ولا يمكن لأي
  // قراءة جهاز الوصول لحالة "مخالفة مؤكدة" أبداً. الآن نسجّل الخطأ (لو
  // تكرر بسبب مشكلة أخرى مستقبلاً) بدل ابتلاعه صامتاً — لا نُسقِط الاستجابة
  // الناجحة بسببه (تحديث project_devices نجح فعلاً، وهو الأهم للمستخدم).
  if (typeof updates.last_pm10 === 'number') {
    // خطأ مكتشَف ومُصلَح (مراجعة كود مدير — ملاحظة #4): كان الإدراج يسجّل
    // project_id وsource='device' فقط، بلا device_id — فتُدمَج قراءات كل
    // أجهزة المشروع معاً بحساب الاستمرار الزمني (fetchPm10SustainedStatus)،
    // وقد "تُثبت" قراءات جهاز A متناوبة مع جهاز B استمراراً وهمياً لنشاط
    // مرتبط بأحدهما فقط. device_id يُشتق من هوية الجهاز نفسه (auth.deviceId
    // المشتقة من مفتاح API، لا من حقل يرسله العميل — نفس مبدأ requireDeviceApiKey).
    const { error: historyError } = await supabaseAdmin.from('pm10_readings_history').insert({
      project_id: auth.projectId,
      device_id: auth.deviceId,
      pm10_ug_m3: updates.last_pm10,
      source: 'device',
      recorded_at: updates.last_reading_at,
    });
    if (historyError) {
      console.error('pm10_readings_history insert failed:', historyError.message);
    }
  }

  return NextResponse.json({ success: true, receivedAt: updates.last_reading_at });
}
