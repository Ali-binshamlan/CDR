import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import type { NormalizedReading } from '@/app/lib/providers/types';

// منطق الكتابة المشترك لأي قراءة جهاز/محطة — مُستخرَج من
// app/api/devices/ingest/route.ts (مسار push) ليُستخدَم أيضاً من مسار
// السحب الدوري (app/api/cron/provider-pull/route.ts, pull). التحقق من
// القيم يبقى هنا بـTypeScript؛ الكتابة الفعلية تُفوَّض بالكامل لـRPC ذرّي
// واحد (ingest_device_reading_atomic، راجع supabase/migrations/
// 202608020004_atomic_device_ingest.sql) — أي تعديل مستقبلي على منطق
// الكتابة (لا التحقق) يكون هناك، لا هنا.

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

function validateValue(field: (typeof MEASUREMENT_FIELDS)[number], value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return `${field} يجب أن يكون رقماً`;
  if (field === 'windDirectionDeg') {
    if (value < 0 || value > 360) return 'windDirectionDeg يجب أن يكون بين 0 و360';
    return null;
  }
  if (field === 'relativeHumidityPercent') {
    if (value < 0 || value > 100) return 'relativeHumidityPercent يجب أن يكون بين 0 و100';
    return null;
  }
  if (field === 'temperatureC') {
    if (value < -20 || value > 70) return 'temperatureC يجب أن يكون بين -20 و70';
    return null;
  }
  if (value < 0) return `${field} لا يمكن أن يكون سالباً`;
  return null;
}

export interface WriteDeviceReadingParams {
  deviceId: string;
  projectId: string;
  // Partial: مصدر push (ingest/route.ts) قد لا يرسل observedAtIso إطلاقاً —
  // writeDeviceReading تتعامل مع غيابه بنفس منطق الأصل (تستخدم وقت وصول
  // الخادم بدلاً منه). مصادر pull الجديدة يجب أن ترسله دائماً فعلياً.
  reading: Partial<NormalizedReading>;
  // idempotency key — بنفس دور eventId في ingest/route.ts. للمصادر pull
  // يُبنى عادة كـ`${provider}:${vendorStationId}:${observedAtIso}`.
  externalEventId?: string | null;
  sequence?: number | null;
}

export type WriteDeviceReadingResult = { success: true; duplicate?: boolean } | { success: false; error: string };

export async function writeDeviceReading(params: WriteDeviceReadingParams): Promise<WriteDeviceReadingResult> {
  const { deviceId, projectId, reading, externalEventId = null, sequence = null } = params;

  const rawValues: Record<(typeof MEASUREMENT_FIELDS)[number], number | undefined> = {
    windSpeedKmh: reading.windSpeedKmh,
    windGustKmh: reading.windGustKmh,
    windDirectionDeg: reading.windDirectionDeg,
    pm10: reading.pm10,
    pm25: reading.pm25,
    visibilityM: reading.visibilityM,
    relativeHumidityPercent: reading.relativeHumidityPercent,
    temperatureC: reading.temperatureC,
  };

  const measurements: Record<string, number> = {};
  for (const field of MEASUREMENT_FIELDS) {
    const value = rawValues[field];
    if (value === undefined || value === null) continue;
    const validationError = validateValue(field, value);
    if (validationError) return { success: false, error: validationError };
    measurements[field] = value;
  }

  if (Object.keys(measurements).length === 0) {
    return { success: false, error: 'يجب توفير قيمة واحدة على الأقل من حقول القياس' };
  }

  const receivedAt = new Date();
  // observedAtIso غائب فقط من مصادر push قديمة لا ترسله بعد — نستخدم وقت
  // وصول الخادم بدلاً منه في تلك الحالة فقط (فشل آمن معروف ومقصود). أي
  // مصدر يرسل observedAtIso فعلياً (push حديث أو أي pull) يُستخدَم حصراً
  // لتحديث لقطة project_devices الحية — لا receivedAt أبداً حين يتوفر،
  // بخلاف السلوك السابق الذي كان يستخدم receivedAt دائماً.
  const observedAt = reading.observedAtIso ? new Date(reading.observedAtIso) : receivedAt;

  // كتابة ذرّية واحدة (RPC، معاملة SQL واحدة) — راجع
  // supabase/migrations/202608020004_atomic_device_ingest.sql. يستبدل 3
  // استدعاءات شبكة منفصلة (تحديث project_devices، إدراج device_readings_
  // history، إدراج pm10_readings_history) كانت تسمح بنجاح جزئي (فشل صامت
  // في console.error فقط) لو فشل استدعاء لاحق بعد نجاح سابق.
  const { data, error } = await supabaseAdmin.rpc('ingest_device_reading_atomic', {
    p_project_id: projectId,
    p_device_id: deviceId,
    p_external_event_id: externalEventId,
    p_sequence_no: sequence,
    p_observed_at: observedAt.toISOString(),
    p_received_at: receivedAt.toISOString(),
    p_measurements: measurements,
  });

  if (error) return { success: false, error: error.message };

  return { success: true, duplicate: Boolean(data?.[0]?.is_duplicate) };
}
