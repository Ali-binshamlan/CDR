import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import type { NormalizedReading } from '@/app/lib/providers/types';
import { retryWithBackoff } from '@/app/lib/retryWithBackoff';
import { liveDataStore } from '@/app/lib/liveData/inMemoryStore';

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

// خطأ مكتشَف ومُصلَح (طلب صريح من المستخدم — مراجعة: "وقت الحقل القديم قد
// يصبح حديثاً بسبب حقل آخر... ومسار Pull لا يرفض timestamp مستقبلياً مثل
// Push"): devices/ingest/route.ts (مسار Push) يرفض observedAt مستقبلياً
// (أكثر من دقيقتين تسامحاً لانحراف الساعة) بـ400 *قبل* استدعاء
// writeDeviceReading — لكن provider-pull/route.ts (مسار Pull) يستدعي
// writeDeviceReading مباشرة بلا المرور عبر ذلك الفحص إطلاقاً، فقراءة
// بtimestamp مستقبلي من موصل خارجي (ساعة جهاز غير متزامنة، أو منصة تُعيد ts
// خاطئاً) كانت تُقبَل وتُكتَب بلا أي رفض. الفحص هنا (لا فقط في route.ts)
// يضمن أن كلا المسارين يخضعان لنفس القاعدة دائماً — نفس هامش التسامح
// (دقيقتان) المستخدَم أصلاً في ingest/route.ts.
const FUTURE_TIMESTAMP_TOLERANCE_MS = 2 * 60_000;

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

  // راجع تعليق FUTURE_TIMESTAMP_TOLERANCE_MS الكامل أعلاه — يطبَّق هنا (لا
  // في route.ts فقط) حتى يغطي مسار Pull أيضاً، لا Push وحده. نفس رسالة الخطأ
  // وهامش التسامح المستخدَمين في devices/ingest/route.ts بالضبط.
  if (observedAt.getTime() > receivedAt.getTime() + FUTURE_TIMESTAMP_TOLERANCE_MS) {
    return { success: false, error: 'observedAt في المستقبل — تحقق من ساعة الجهاز' };
  }

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
  // p_pm10_observed_at — يُستخدَم لإدراج pm10_readings_history *و*
  // project_devices.last_pm10/last_pm10_at (راجع migration 202608120006 —
  // last_pm10_at كانت تُحدَّث بـobservedAt المشترك عمداً سابقاً بحجة كونها
  // "سجل عام فقط"، لكن هذا كان يُظهر وقت حقل آخر بدل وقت PM10 الفعلي، فأُصلح
  // ليطابق فعلياً معنى اسم العمود). بقية الحقول (device_readings_history،
  // last_wind_*/last_pm25_*/إلخ) تبقى بمنطقها الحالي (observedAt المشترك)
  // بلا تغيير. غياب reading.fields.pm10 (مصادر push قديمة بلا fields) يعني
  // fallback لنفس observedAt المشترك — لا تغيير في ذلك المسار.
  const pm10ObservedAtIso = reading.fields?.pm10?.observedAtIso ?? null;

  // راجع تعليق FUTURE_TIMESTAMP_TOLERANCE_MS أعلاه — وقت PM10 المستقل (إن
  // وُجد) قد يختلف عن observedAt المشترك المفحوص أعلاه بالفعل، فيُفحَص هنا
  // بمعزل عنه (نفس ما تتحقق منه RPC نفسها دفاعاً ثانياً — migration
  // 202608120006).
  if (
    pm10ObservedAtIso &&
    new Date(pm10ObservedAtIso).getTime() > receivedAt.getTime() + FUTURE_TIMESTAMP_TOLERANCE_MS
  ) {
    return { success: false, error: 'observedAt في المستقبل — تحقق من ساعة الجهاز' };
  }

  // خطأ مكتشَف ومُصلَح (مراجعة كود خارجي — "الموصل Snapshot-only لا يصلح
  // لإثبات الاستمرارية"): reading.evidenceCapability (provider-pull/route.ts،
  // 'HISTORY_COMPLETE' لقراءات fetchReadingsSince، 'SNAPSHOT_ONLY' لسقوط
  // fetchLatestReading الاحتياطي) يُترجَم هنا لعلَم Boolean واحد يُمرَّر
  // لـpm10_readings_history عبر الـRPC — راجع migration 202608110017 الكامل
  // وstreakMinutesAbove في dustEvaluation.ts (يقطع سلسلة الاستمرار عند أي
  // صف isSnapshotOnly=true). غياب evidenceCapability كلياً (مصادر push
  // المباشرة عبر devices/ingest/route.ts — جهاز حقيقي يرسل مباشرة، لا لقطة
  // من موصل سحب) يُعامَل كـHISTORY_COMPLETE ضمنياً (isSnapshotOnly=false) —
  // لا تراجع في صرامة القراءات الحالية القادمة من مصادر push.
  const isSnapshotOnly = reading.evidenceCapability === 'SNAPSHOT_ONLY';

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

  // Live Data Layer (2026-08-08 — راجع app/lib/liveData/types.ts للسياق
  // الكامل): تحديث الحالة الحيّة يحدث هنا فوراً، *قبل* استدعاء Supabase —
  // لا بعده ولا بالتوازي معه — لأن الواجهة يجب ألا تنتظر اكتمال أي عملية
  // Supabase لعرض آخر قراءة (طلب صريح: "لا تجعل تحديث الواجهة ينتظر انتهاء
  // عملية Supabase"). القيمة المكتوبة هنا مبنية فقط من قيم مُتحقَّق منها
  // محلياً أعلاه (measurements) — لا تعتمد على نتيجة RPC إطلاقاً. خطر
  // القراءة المكررة النادر جداً (idempotency الحقيقي يبقى على مستوى RPC/DB
  // فقط، لا فحص هنا) مقبول: قراءة مكررة تُعرض للحظة على الـLive State لا
  // تُغيّر أي قرار امتثال (القرار الفعلي يبقى من current_dust_*_decisions
  // في Supabase، لا من هذا الـcache).
  //
  // خطأ مكتشَف ومُصلَح (طلب صريح من المستخدم — "عند تفعيل SSE، القراءة
  // المتأخرة تُعرض في الحالة الحية قبل نجاح RPC، رغم منعها من تغيير القرار
  // الرسمي في قاعدة البيانات"): isLate يُحسَب محلياً أعلاه (سطر 131) قبل
  // هذه النقطة بالفعل — لا حاجة لانتظار RPC لمعرفته. كان setSnapshot يُستدعى
  // بلا أي شرط على isLate، فتُعرَض القراءة المتأخرة فوراً عبر SSE
  // (liveDataStore → app/api/live/stream/route.ts) بينما RPC (بعد وصولها،
  // 202608060002_late_reading_history_no_state_mutation.sql) يرفض بصمت
  // تحديث project_devices.last_*/device_metric_latest لنفس القراءة —
  // فيتناقض ما يُعرَض حياً مع القرار الرسمي المخزَّن، بلا أي تصحيح لاحق على
  // liveDataStore (لا rollback بعد معرفة نتيجة RPC). الإصلاح: تخطّي التحديث
  // الحي كلياً لقراءة متأخرة — نفس القرار الذي تتخذه RPC، لكن محلياً وفوراً
  // بلا انتظارها.
  if (!isLate) {
    liveDataStore.setSnapshot({
      deviceId,
      projectId,
      windSpeedKmh: measurements.windSpeedKmh ?? null,
      windGustKmh: measurements.windGustKmh ?? null,
      windDirectionDeg: measurements.windDirectionDeg ?? null,
      pm10: measurements.pm10 ?? null,
      pm25: measurements.pm25 ?? null,
      visibilityM: measurements.visibilityM ?? null,
      relativeHumidityPercent: measurements.relativeHumidityPercent ?? null,
      temperatureC: measurements.temperatureC ?? null,
      observedAtIso: observedAt.toISOString(),
      updatedAtIso: new Date().toISOString(),
    });
  }

  // خطأ حرج مكتشَف ومُصلَح (مراجعة خبير خارجي — "الكتابتان ليستا عملية واحدة
  // ذرية؛ فشل V2 لا يُفشل العملية كلها، يُسجَّل في console فقط"): كان هذا
  // استدعاءين شبكة منفصلين (ingest_device_reading_atomic ثم ingest_device_
  // event_v2)، كل منهما معاملة SQL مستقلة — نجاح الأول لا يضمن نجاح الثاني،
  // فيتباعد pm10_readings_history (استمرار المخالفة) عن device_metric_latest
  // (القرار الحي) بصمت. استدعاء واحد الآن (ingest_device_reading_and_event_
  // atomic، 202608040027) يدمج كل الكتابات في معاملة SQL واحدة — تنجح معاً
  // أو تفشل معاً، بلا احتمال تناقض بين المصدرين.
  //
  // retryWithBackoff (2026-08-08): 3 محاولات كحد أقصى بـexponential backoff
  // (500ms/1s/2s) — يتحمّل انقطاعاً عابراً قصيراً في Supabase بلا حاجة
  // لقائمة/queue خارجية (Vercel serverless بلا ذاكرة مشتركة دائمة بين
  // الطلبات تجعل أي queue داخل memory غير موثوقة أصلاً — راجع نقاش القيد
  // الموثَّق في المحادثة؛ الحل المقبول هنا هو retry محدود لا queue وهمية).
  // لا retry لا نهائي — فشل نهائي يُرجَع للمستدعي كخطأ عادي (نفس السلوك
  // السابق تماماً)، لا صمت ولا تعليق.
  const rpcResult = await retryWithBackoff(async () => {
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
      p_is_snapshot_only: isSnapshotOnly,
    });
    if (error) return { ok: false, error: error.message };
    return { ok: true, value: data };
  });

  if (!rpcResult.ok) return { success: false, error: rpcResult.error };

  const data = rpcResult.value as { is_duplicate?: boolean }[] | null;
  return { success: true, duplicate: Boolean(data?.[0]?.is_duplicate), late: isLate };
}
