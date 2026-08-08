import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import type { NormalizedReading } from '@/app/lib/providers/types';

// منطق الكتابة المشترك لأي قراءة جهاز/محطة — مُستخرَج من
// app/api/devices/ingest/route.ts (مسار push) ليُستخدَم أيضاً من مسار
// السحب الدوري (app/api/cron/provider-pull/route.ts, pull). التحقق من
// القيم يبقى هنا بـTypeScript؛ الكتابة الفعلية تُفوَّض بالكامل لـRPC ذرّي
// واحد (ingest_device_reading_and_event_atomic، راجع supabase/migrations/
// 202608040027_merge_device_ingest_atomic.sql) — أي تعديل مستقبلي على منطق
// الكتابة (لا التحقق) يكون هناك، لا هنا.
//
// خطأ حرج مكتشَف ومُصلَح (مراجعة خبير خارجي — "الكتابتان ليستا عملية واحدة
// ذرية؛ يمكن أن يتحول PM10 قديم إلى دليل حديث زائف، وفشل V2 لا يُفشل
// العملية كلها"): كانت هذه الدالة تستدعي ingest_device_reading_atomic ثم
// ingest_device_event_v2 كاستدعاءين شبكة منفصلين، كل منهما معاملة SQL
// خاصة — نجاح الأول (يغذّي device_readings_history/pm10_readings_history/
// project_devices.last_*) لم يكن يضمن نجاح الثاني (device_metric_latest،
// مصدر resolveFreshProjectDevice للقرار الحي)، وفشل الثاني كان يُسجَّل فقط
// بـconsole.error بلا rollback وبلا إشارة فشل تصل للمستدعي. الآن استدعاء
// واحد ذرّي يدمج كل الكتابات في معاملة SQL واحدة — تنجح معاً أو تفشل معاً.

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

// خطأ مكتشَف ومُصلَح (مراجعة خبير خارجي — "القراءات المتأخرة أكثر من 40
// دقيقة تُرفض بالكامل؛ الأفضل: حفظها في السجل التاريخي، تعليمها LATE، منعها
// من تغيير الحالة التشغيلية الحالية، الاحتفاظ بها للتدقيق"): كان ingest/route.ts
// يرفض (400) أي observedAt أقدم من هذه النافذة رفضاً كاملاً بلا أي كتابة.
// نفس النافذة (40 دقيقة) تُستخدَم الآن هنا لتصنيف القراءة late بدل رفضها —
// راجع migration 202608060002_late_reading_history_no_state_mutation.sql.
const MAX_LIVE_OBSERVED_AGE_MS = 40 * 60_000;

export type WriteDeviceReadingResult =
  | { success: true; duplicate?: boolean; late?: boolean }
  | { success: false; error: string };

export async function writeDeviceReading(params: WriteDeviceReadingParams): Promise<WriteDeviceReadingResult> {
  const { deviceId, projectId, reading, externalEventId = null, sequence: sequenceParam = null } = params;

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
  // observedAtIso أصبح إلزامياً في مسار devices/ingest/route.ts (عقد الحدث
  // الكامل)، ويبقى مُرسَلاً دائماً من كل مصادر pull أيضاً — غيابه هنا نظرياً
  // فقط (fallback دفاعي لأي استدعاء لا يمر عبر أي من المسارين). لا receivedAt
  // أبداً حين observedAtIso متوفر — بخلاف السلوك السابق الذي كان يستخدم
  // receivedAt دائماً.
  const observedAt = reading.observedAtIso ? new Date(reading.observedAtIso) : receivedAt;

  // القسم 5.10/P0-8 من "دليل الإصلاح الجذري لمنظومة مرقاب" — "عقد الحدث
  // كامل فقط في Push": مسار Push (devices/ingest/route.ts) يفرض sequence
  // رقماً صحيحاً غير سالب إلزامياً من العميل، لكن Provider Pull (موصلات مثل
  // ThingsBoard) لا تملك مفهوم "sequence" أصلاً — تعطي فقط observedAtIso لكل
  // حقل. بدل ترك sequence_no فارغاً (كان يمر null إلى الجدول والـRPC بلا أي
  // رفض)، يُشتَق رقم بديل حتمي من observedAt نفسه (طابع Unix بالمللي ثانية)
  // متى لم يُمرَّر sequence صراحةً — يبقى غير سالب دائماً (Date.getTime() لأي
  // تاريخ حقيقي بعد 1970 موجب)، ويحافظ على ترتيب زمني صحيح بين قراءات نفس
  // الجهاز (نفس الغرض من sequence الحقيقي: كشف late events عبر المقارنة، لا
  // فقط الفرادة).
  const sequence = sequenceParam ?? observedAt.getTime();

  // القراءة "متأخرة" إن كانت observedAt أقدم من نافذة القبول الحية وقت
  // الوصول الفعلي (receivedAt) — لا وقت التنفيذ الحالي لاحقاً. تُكتَب رغم
  // ذلك في device_readings_history/pm10_readings_history للتدقيق، بوسم
  // is_late=true، لكن الـRPC يتجاهر عندها تحديث project_devices.last_*/
  // device_metric_latest (القرار الحي) بالكامل — راجع تعليق p_is_late في
  // ingest_device_reading_and_event_atomic.
  const isLate = receivedAt.getTime() - observedAt.getTime() > MAX_LIVE_OBSERVED_AGE_MS;

  // خطأ مكتشَف ومُصلَح (مراجعة خبير خارجي — "ThingsBoard ما زال يعيد تأريخ
  // PM10 القديم كقراءة حديثة"): observedAt أعلاه هو الوقت المشترك للحمولة
  // كلها (أحدث حقل — راجع fetchLatestReading في thingsboardConnector.ts)،
  // لا وقت PM10 المستقل تحديداً. pm10_readings_history (مصدر computeSustainedPm10Status
  // الوحيد لحساب استمرار المخالفة) كانت تُكتَب بهذا الوقت المشترك دائماً —
  // فحرارة حديثة كانت تجعل PM10 قديماً يبدو حديثاً في سجل الاستمرار. الآن
  // يُمرَّر وقت PM10 الفردي (reading.fields.pm10.observedAtIso، إن وُجد) عبر
  // p_pm10_observed_at — يُستخدَم حصراً لإدراج pm10_readings_history، ويبقى
  // observedAt المشترك كما هو لبقية الجداول (device_readings_history/
  // project_devices، سجل عام لا يعتمد عليه حساب الاستمرار). غياب
  // reading.fields.pm10 (مصادر push قديمة بلا fields) يعني fallback لنفس
  // observedAt المشترك — لا تغيير في ذلك المسار.
  const pm10ObservedAtIso = reading.fields?.pm10?.observedAtIso ?? null;

  // نفس القياسات بصيغة V2 ({value, observedAtIso} مستقل لكل حقل) — يُبنى
  // هنا فقط للحقول التي فعلياً تملك fields مستقلة (reading.fields)، لا لكل
  // حقل بلا استثناء؛ الـRPC نفسه يبني fallback بـp_observed_at المشتركة لأي
  // حقل غائب عن هذا الكائن (راجع تعليق p_measurements_v2 في الهجرة).
  const measurementsV2: Record<string, { value: number; observedAtIso: string }> = {};
  for (const field of Object.keys(measurements)) {
    const point = reading.fields?.[field as keyof NonNullable<NormalizedReading['fields']>];
    if (point?.observedAtIso) {
      measurementsV2[field] = { value: measurements[field], observedAtIso: point.observedAtIso };
    }
  }

  // خطأ حرج مكتشَف ومُصلَح (مراجعة خبير خارجي — "الكتابتان ليستا عملية واحدة
  // ذرية؛ فشل V2 لا يُفشل العملية كلها، يُسجَّل في console فقط"): كان هذا
  // استدعاءين شبكة منفصلين (ingest_device_reading_atomic ثم ingest_device_
  // event_v2)، كل منهما معاملة SQL مستقلة — نجاح الأول لا يضمن نجاح الثاني،
  // فيتباعد pm10_readings_history (استمرار المخالفة) عن device_metric_latest
  // (القرار الحي) بصمت. استدعاء واحد الآن (ingest_device_reading_and_event_
  // atomic، 202608040027) يدمج كل الكتابات في معاملة SQL واحدة — تنجح معاً
  // أو تفشل معاً، بلا احتمال تناقض بين المصدرين.
  const { data, error } = await supabaseAdmin.rpc('ingest_device_reading_and_event_atomic', {
    p_project_id: projectId,
    p_device_id: deviceId,
    p_external_event_id: externalEventId,
    p_sequence_no: sequence,
    p_observed_at: observedAt.toISOString(),
    p_received_at: receivedAt.toISOString(),
    p_measurements: measurements,
    p_pm10_observed_at: pm10ObservedAtIso,
    p_measurements_v2: measurementsV2,
    p_is_late: isLate,
  });

  if (error) return { success: false, error: error.message };

  return { success: true, duplicate: Boolean(data?.[0]?.is_duplicate), late: isLate };
}
