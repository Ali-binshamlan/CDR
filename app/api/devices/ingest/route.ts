import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { requireDeviceApiKey } from '@/app/lib/apiAuth';

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
] as const;

const COLUMN_BY_FIELD: Record<(typeof MEASUREMENT_FIELDS)[number], string> = {
  windSpeedKmh: 'last_wind_speed_kmh',
  windGustKmh: 'last_wind_gust_kmh',
  windDirectionDeg: 'last_wind_direction_deg',
  pm10: 'last_pm10',
  pm25: 'last_pm25',
  visibilityM: 'last_visibility_m',
};

function validateValue(field: (typeof MEASUREMENT_FIELDS)[number], value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return `${field} يجب أن يكون رقماً`;
  if (field === 'windDirectionDeg') {
    if (value < 0 || value > 360) return 'windDirectionDeg يجب أن يكون بين 0 و360';
    return null;
  }
  if (value < 0) return `${field} لا يمكن أن يكون سالباً`;
  return null;
}

export async function POST(request: NextRequest) {
  const auth = await requireDeviceApiKey(request);
  if ('error' in auth) return auth.error;

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

  updates.last_reading_at = new Date().toISOString();

  const { error } = await supabaseAdmin
    .from('project_devices')
    .update(updates)
    .eq('id', auth.deviceId);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // تسجيل PM10 في السجل التاريخي المنفصل (pm10_readings_history) — يُستخدم
  // لاحقاً لحساب استمرار القراءة عبر الزمن (RCRC-PM10-340-VIOLATION-011:
  // أكثر من دقيقتين، RCRC-PM10-30M-SUSPENSION-012: 30 دقيقة)، بمعزل عن
  // توقيت تقييمات dust_compliance_evaluations المتقطّع. project_id فقط
  // (لا activity_group_id) لأن الجهاز مرتبط بالمشروع ككل، لا نشاط محدد —
  // راجع computeSustainedPm10 في app/lib/dustEvaluation.ts.
  if (typeof updates.last_pm10 === 'number') {
    await supabaseAdmin.from('pm10_readings_history').insert({
      project_id: auth.projectId,
      pm10_ug_m3: updates.last_pm10,
      source: 'device',
      recorded_at: updates.last_reading_at,
    });
  }

  return NextResponse.json({ success: true, receivedAt: updates.last_reading_at });
}
