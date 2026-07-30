// تقييم الغبار والامتثال التنظيمي المشترك — نسخة DCR من craneEvaluation.ts
// الأصلي في مرقاب، مقتصرة على الدوال الخاصة بالغبار (DVI)/الامتثال
// التنظيمي/AEI فقط. لا رافعات ولا حرارة في DCR إطلاقاً.
import { evaluateDustVisibilityWindow, evaluateDustVisibilityWorkDayHourly } from '@/app/utils/dust-engine';
import type { DustEngineInput, DustWindowEvaluation } from '@/app/utils/dust-engine/types';
import { evaluateAei } from '@/app/utils/aei-engine';
import type { AeiEvaluationResult } from '@/app/utils/aei-engine/types';
import { AEI_RESTRICT_CAP } from '@/app/utils/aei-engine/tables';
import { evaluateDustCompliance, buildComplianceContext, isRegulatoryWindGateActive, BATCHING_PM10_FILTER_MIN_PERCENT } from '@/app/utils/dust-compliance-engine';
import { receptorsWithinRadiusM, UNIT_RECEPTOR_RADIUS_M } from '@/app/utils/dust-compliance-engine/geo';
import type { ReceptorWithinRadius } from '@/app/utils/dust-compliance-engine/geo';
import type { DustComplianceResult } from '@/app/utils/dust-compliance-engine/types';
import { decideFinal, buildFinalDecisionInput } from '@/app/utils/final-decision-engine';
import type { FinalDecision } from '@/app/utils/final-decision-engine';
import type { DviEvaluationResult } from '@/app/utils/dust-engine/types';

/** مجموعة المستقبِلات الحساسة حول وحدة واحدة (كسارة/خلاطة) ضمن نصف قطرها
 * التنظيمي — راجع computeUnitReceptors أدناه. */
export interface UnitReceptorGroup {
  unitType: 'CRUSHER' | 'BATCHING_PLANT';
  unitLabelAr: string;
  lat: number;
  lng: number;
  radiusM: number;
  /** هل تُفعِّل مسافة هذه الوحدة قاعدة إيقاف فعلية (الكسارة فقط حالياً)؟ */
  hasBindingDistanceRule: boolean;
  receptors: ReceptorWithinRadius[];
}

export const RIYADH_UTC_OFFSET_MINUTES = 180;

export function riyadhLocalToUtcIso(dateStr?: string | null, timeStr?: string | null): string | undefined {
  if (!dateStr || !timeStr) return undefined;
  const [y, m, d] = dateStr.split('-').map(Number);
  const timeParts = timeStr.split(':').map(Number);
  const hh = timeParts[0] ?? 0;
  const mm = timeParts[1] ?? 0;
  if (!y || !m || !d) return undefined;
  const utcMs = Date.UTC(y, m - 1, d, hh, mm, 0) - RIYADH_UTC_OFFSET_MINUTES * 60000;
  return new Date(utcMs).toISOString();
}

// يحوّل صفوف project_shifts الخام (project.shifts، مرفقة في GET
// /api/projects/[projectId] من جدول project_shifts) إلى الشكل الذي يقبله
// DustEngineInput.shifts — undefined إن لم تُعرَّف أي ورديات، فيسلك المحرك
// مساره القديم (نافذة work_hours واحدة).
function buildEngineShifts(project: any): { startTime: string; endTime: string }[] | undefined {
  if (!Array.isArray(project?.shifts) || project.shifts.length === 0) return undefined;
  return project.shifts.map((s: any) => ({
    startTime: String(s.start_time).slice(0, 5),
    endTime: String(s.end_time).slice(0, 5),
  }));
}

// قراءة جهاز حديثة يجهّزها resolveFreshProjectDevice أدناه — شكل مبسّط
// (الحقول last_* المهمة فقط) يُمرَّر لـ buildDustInput.
export interface FreshDeviceReading {
  last_wind_speed_kmh: number | null;
  last_wind_gust_kmh: number | null;
  last_wind_direction_deg: number | null;
  last_pm10: number | null;
  last_pm25: number | null;
  last_visibility_m: number | null;
  last_relative_humidity_percent: number | null;
  last_temperature_c: number | null;
  // وقت آخر إرسال فعلي للمحطة (ISO) — لا يُستخدم لإسقاط القراءة بعد الآن
  // (راجع resolveFreshProjectDevice أدناه)، فقط لعرض "قِدم القراءة" في
  // الواجهة عندما تتجاوز DEVICE_READING_FRESHNESS_MINUTES.
  last_reading_at: string;
  // وقت آخر وصول PM10 تحديداً (ISO) — عمود منفصل عن last_reading_at لأن
  // الأخير يتحدّث عند أي push جزئي حتى بلا PM10 (راجع last_pm10_at في
  // project_devices migration). null إن لم تُرسِل المحطة PM10 قط.
  last_pm10_at: string | null;
}

export function buildDustInput(row: any, project: any, freshDevice?: FreshDeviceReading | null): DustEngineInput {
  return {
    activityType: row.activity_type,
    // موقع النشاط المستقل (محدد يدوياً داخل zone المشروع) له الأولوية على
    // موقع المشروع المركزي — يُستخدم فعلياً في جلب طقس هذه النقطة تحديداً.
    // fallback لموقع المشروع فقط لأنشطة قديمة محفوظة قبل هذه الميزة.
    latitude: typeof row.activity_lat === 'number' ? row.activity_lat : project.latitude,
    longitude: typeof row.activity_lng === 'number' ? row.activity_lng : project.longitude,
    site: {
      hasEarthworks: row.has_earthworks,
      internalDirtRoads: row.internal_dirt_roads,
      heavyEquipmentMovement: row.heavy_equipment_movement,
      looseMaterials: row.loose_materials,
      largeExposedArea: row.large_exposed_area,
      drySurface: row.dry_surface,
      surfaceWet: row.surface_wet,
      wateringAvailable: row.watering_available,
      stockpilesCovered: row.stockpiles_covered,
      speedLimitApplied: row.speed_limit_applied,
      wheelWashAvailable: row.wheel_wash_available,
      dustScreensAvailable: row.dust_screens_available,
      fieldMonitoringAvailable: row.field_monitoring_available,
      receptorType: row.receptor_type,
      receptorDistance: row.receptor_distance,
      receptorIsDownwind: row.receptor_is_downwind,
      visibleDustPlumeReported: row.visible_dust_plume_reported,
      openConcretePour: row.open_concrete_pour,
    },
    onsiteVisibilityM: row.onsite_visibility_m ?? null,
    onsitePm10: row.onsite_pm10 ?? null,
    onsitePm25: row.onsite_pm25 ?? null,
    // hasDeviceLink يعكس اختيار المستخدم الفعلي (device_id على النشاط)،
    // لا مجرد توفر freshDevice — هذا هو مفتاح العزل التام في
    // mergeDustReading (engine.ts): نشاط مرتبط بمحطة يعرض بياناتها حصراً
    // حتى لو freshDevice غاب تماماً (لا صف جهاز نشط إطلاقاً).
    hasDeviceLink: !!row.device_id,
    deviceLastReadingAt: freshDevice?.last_reading_at ?? null,
    devicePm10LastReadingAt: freshDevice?.last_pm10_at ?? null,
    deviceWindSpeedKmh: freshDevice?.last_wind_speed_kmh ?? null,
    deviceWindGustKmh: freshDevice?.last_wind_gust_kmh ?? null,
    deviceWindDirectionDeg: freshDevice?.last_wind_direction_deg ?? null,
    devicePm10: freshDevice?.last_pm10 ?? null,
    devicePm25: freshDevice?.last_pm25 ?? null,
    deviceVisibilityM: freshDevice?.last_visibility_m ?? null,
    deviceRelativeHumidityPercent: freshDevice?.last_relative_humidity_percent ?? null,
    deviceTemperatureC: freshDevice?.last_temperature_c ?? null,
    workDaysList: Array.isArray(project.work_days_list) ? project.work_days_list : undefined,
    workHoursStart: project.work_hours_start ?? undefined,
    workHoursEnd: project.work_hours_end ?? undefined,
    shifts: buildEngineShifts(project),
  };
}

// يُلحق وسم بوابة الرياح التنظيمية (>25 كم/س، القسم "بروتوكول الملحق أ" في
// rulebook.ts) على تقييم ساعة واحدة، دون تشغيل محرك الامتثال الكامل لكل
// ساعة — فقط نفس شرط GATE-WIND-ABOVE-25-004: نشاط مكشوف ومولّد للغبار.
function annotateHourWithRegulatoryGate<T extends { effectiveWindKmh: number | null }>(
  hour: T,
  isDustGenerating: boolean,
  isEnclosedOperation: boolean
): T & { regulatoryWindGateActive: boolean } {
  return {
    ...hour,
    regulatoryWindGateActive: isRegulatoryWindGateActive(hour.effectiveWindKmh, isDustGenerating, isEnclosedOperation),
  };
}

// عتبة "حداثة" القراءة — لم تعد تُستخدم لإسقاط القراءة في هذه الدالة (راجع
// التعليق أدناه)، فقط كمرجع للواجهة (buildStalenessAdvisory في
// Compliancewidgetcard.tsx) لتحديد متى تُعرض بطاقة تحذير "قراءة قديمة".
export const DEVICE_READING_FRESHNESS_MINUTES = 20;

// يجلب آخر قراءة معروفة لجهاز مشروع معيّن. مع تمرير deviceId (النشاط
// مرتبط بمحطة محددة يختارها المستخدم عند الإضافة، راجع AddActivityModal)
// يُقيَّد الاستعلام بذلك الجهاز تحديداً بدل أي جهاز آخر بالمشروع. بلا
// deviceId: أحدث جهاز نشط بالمشروع (last_reading_at تنازلياً) — مسار
// احتياطي للاستدعاءات القديمة/الاختبارات فقط، لا يُستخدم في التقييم الحي
// بعد ربط كل نشاط بمحطته الخاصة.
//
// بطلب صريح من المستخدم ("لا شيء يعوض الآخر"): القراءة القديمة (أقدم من
// DEVICE_READING_FRESHNESS_MINUTES) أو حتى المعدومة تماماً **لا تُسقَط
// هنا بعد الآن** — تُرجَع كما هي دائماً طالما وُجد صف جهاز نشط، والواجهة
// هي من تقرر عرض تحذير "قراءة قديمة" بدل الفشل الصامت والانتقال لـAPI
// الطقس كما كان يحدث سابقاً. يرجع null فقط عند عدم وجود أي صف جهاز نشط
// بقراءة واحدة مسجَّلة إطلاقاً (لا صف قابل للعرض أصلاً).
export async function resolveFreshProjectDevice(
  supabaseAdmin: any,
  projectId: string,
  deviceId?: string | null
): Promise<FreshDeviceReading | null> {
  let query = supabaseAdmin
    .from('project_devices')
    .select('last_reading_at, last_wind_speed_kmh, last_wind_gust_kmh, last_wind_direction_deg, last_pm10, last_pm25, last_visibility_m, last_relative_humidity_percent, last_temperature_c, last_pm10_at')
    .eq('project_id', projectId)
    .eq('is_active', true)
    .not('last_reading_at', 'is', null);

  query = deviceId
    ? query.eq('id', deviceId)
    : query.order('last_reading_at', { ascending: false });

  const { data } = await query.limit(1).maybeSingle();

  if (!data?.last_reading_at) return null;

  return {
    last_wind_speed_kmh: data.last_wind_speed_kmh ?? null,
    last_wind_gust_kmh: data.last_wind_gust_kmh ?? null,
    last_wind_direction_deg: data.last_wind_direction_deg ?? null,
    last_pm10: data.last_pm10 ?? null,
    last_pm25: data.last_pm25 ?? null,
    last_visibility_m: data.last_visibility_m ?? null,
    last_relative_humidity_percent: data.last_relative_humidity_percent ?? null,
    last_temperature_c: data.last_temperature_c ?? null,
    last_pm10_at: data.last_pm10_at ?? null,
    last_reading_at: data.last_reading_at,
  };
}

// -----------------------------------------------------------------------
// استمرار PM10 الزمني — يحقق 3 قواعد كانت مستحيلة التطبيق من تقييم لحظة
// واحدة: RCRC-PM10-340-VIOLATION-011 (أكثر من دقيقتين ≥340 = مخالفة
// مؤكدة)، MRQ-PM10-BLACK-PENDING-104 (أقل من دقيقتين = معلَّق فقط)،
// RCRC-PM10-30M-SUSPENSION-012 (30 دقيقة متواصلة ≥250 = تعليق النشاط).
// -----------------------------------------------------------------------

export interface Pm10SustainedStatus {
  // أعلى عتبة استمرت القراءة الحالية عندها بلا انقطاع حتى الآن (340 أو 250
  // أو null إن كانت القراءة الحالية دون 250 أصلاً — لا استمرار ليُقاس).
  currentReadingUgM3: number | null;
  sustainedMinutesAbove340: number;
  sustainedMinutesAbove250: number;
  isConfirmedViolation340: boolean; // ≥340 لأكثر من دقيقتين متتاليتين، بمصدر جهاز فقط
  isPendingViolation340: boolean;   // ≥340 الآن لكن أقل من دقيقتين بعد، أو مصدرها غير جهاز
  isSuspended250For30Min: boolean;  // ≥250 لمدة 30 دقيقة متواصلة أو أكثر، بمصدر جهاز فقط
}

const PM10_SUSTAINED_VIOLATION_THRESHOLD = 340;
const PM10_SUSTAINED_WARNING_THRESHOLD = 250;
const PM10_VIOLATION_CONFIRM_MINUTES = 2;
const PM10_SUSPENSION_MINUTES = 30;
// هامش استمرار: لو مضت أكثر من هذي المدة بين قراءتين متتاليتين، لا نعتبر
// الفجوة "استمراراً بلا انقطاع" — يطابق دورة إرسال الجهاز الفعلية (كل
// دقيقتين، طلب صريح من المستخدم) بهامش تحمّل بسيط (تأخر شبكة/إعادة محاولة)
// بدل الهامش القديم الفضفاض (15 دقيقة) الذي كان يسمح بقراءة معزولة واحدة
// قديمة نسبياً أن تُحسب "استمراراً" كاملاً بلا أي دليل فعلي على القراءات
// بينها. راجع أيضاً PM10_LAST_READING_FRESHNESS_MINUTES أدناه لضمان أن
// "الآن" نفسه ليس بعيداً عن آخر قراءة فعلية.
const PM10_READING_GAP_TOLERANCE_MINUTES = 4;
// أقصى عمر لآخر قراءة حتى تبقى "حالة حية" — لو توقف الجهاز عن الإرسال
// وتجاوز عمر آخر قراءة هذه العتبة، لا يجوز اعتبار الاستمرار "حياً حتى
// الآن" (كان النظام سابقاً يُبقي isConfirmedViolation340/isSuspended250For30Min
// صحيحة إلى الأبد طالما لم تتجاوز الفجوة القديمة 15 دقيقة، حتى لو توقف
// الجهاز فعلياً عن الإرسال منذ ساعات — ثغرة اكتُشفت في مراجعة أمنية: تجمّد
// حالة "مخالفة مستمرة" أو "معلَّق" بلا أي دليل حي، بدل التنبيه لانقطاع
// الاتصال). القراءة نفسها تبقى ظاهرة (لا تُخفى)، فقط لا تُستخدم لإثبات
// استمرار "حتى الآن" إن كانت أقدم من هذا الحد.
const PM10_LAST_READING_FRESHNESS_MINUTES = 4;

// دالة حسابية بحتة (بلا I/O) — تأخذ قراءات مرتّبة تنازلياً (الأحدث أولاً،
// نفس ترتيب استعلام Supabase الطبيعي بـ order desc) وتحسب مدة الاستمرار
// فوق كل عتبة بدءاً من أحدث قراءة رجوعاً للماضي، متوقفة عند أول قراءة دون
// العتبة أو أول فجوة زمنية كبيرة بين قراءتين.
//
// source (اختياري لكل قراءة): 'device' | 'manual' | 'open-meteo'. الحالة
// "المؤكَّدة" (isConfirmedViolation340) و"المعلَّقة الطويلة"
// (isSuspended250For30Min) تُقصَران على مصدر 'device' فقط — قراءات API
// الجوي (open-meteo) تقديرات ساعية من نموذج طقس عالمي، لا قياس محلي
// مستمر، فلا تصلح دليلاً على "استمرار دقيقة بدقيقة" لقرار إيقاف إلزامي.
// قراءة بمصدر غير device تبقى "معلَّقة" (isPendingViolation340) دائماً
// بصرف النظر عن طول مدة التجاوز الظاهرية. قراءة بلا source (استدعاءات
// قديمة/اختبارات) تُعامَل كـ'device' توافقياً (فشل آمن، لا كسر سلوك حالي).
// ملاحظة: 'open-meteo' لم تعد تصل هذه الدالة عملياً بعد فصل التوقعات إلى
// weather_forecasts (راجع computeDustComplianceResults أدناه) — تبقى في
// النوع دفاعياً فقط لأي صف قديم قد يبقى قبل تطبيق migration الترحيل.
export function computeSustainedPm10Status(
  readings: { pm10UgM3: number; recordedAt: string; source?: 'device' | 'manual' | 'open-meteo' }[],
  now: number = Date.now()
): Pm10SustainedStatus {
  if (readings.length === 0) {
    return {
      currentReadingUgM3: null,
      sustainedMinutesAbove340: 0,
      sustainedMinutesAbove250: 0,
      isConfirmedViolation340: false,
      isPendingViolation340: false,
      isSuspended250For30Min: false,
    };
  }

  const sorted = [...readings].sort(
    (a, b) => new Date(b.recordedAt).getTime() - new Date(a.recordedAt).getTime()
  );
  const currentReadingUgM3 = sorted[0].pm10UgM3;
  const currentSource = sorted[0].source ?? 'device';
  const latestReadingAgeMinutes = (now - new Date(sorted[0].recordedAt).getTime()) / 60000;
  const isLatestReadingFresh = latestReadingAgeMinutes <= PM10_LAST_READING_FRESHNESS_MINUTES;
  const isCurrentSourceDevice = currentSource === 'device';

  // خطأ مكتشَف ومُصلَح: كانت الحلقة تمتد عبر قراءات مختلطة المصدر بلا فحص
  // (device مع open-meteo/manual معاً)، ويُكتفى بفحص مصدر آخر قراءة وحدها
  // (isCurrentSourceDevice) لتقرير "مؤكَّدة". فنشاط بلا جهاز يتجاوز 3 دقائق
  // بقراءات open-meteo تقديرية، ثم يُربط بجهاز وتصل منه قراءة واحدة ≥340
  // خلال هامش الفجوة (4 دقائق)، كانت السلسلة تمتد للخلف عبر قراءات الطقس
  // فيصل sustainedMinutesAbove340 لأكثر من دقيقتين، وتتأكد "مخالفة تنظيمية
  // مؤكدة" بدليل استمرار مصدره فعلياً توقّع طقس لا قياس جهاز متواصل.
  // الإصلاح: السلسلة تنقطع عند أول قراءة يختلف مصدرها عن مصدر أحدث قراءة —
  // فالاستمرار المُثبَت يبقى دائماً من مصدر واحد متجانس، لا خليط.
  //
  // خطأ مكتشَف ومُصلَح (مراجعة كود مدير — ملاحظة #3): كانت المدة تُحسب
  // (now - streakStartMs) — أي منذ "أقدم قراءة بالسلسلة" وحتى اللحظة
  // الحالية، لا حتى "أحدث قراءة فعلية". فقراءة جهاز واحدة فقط بقيمة 350
  // (streakStartMs = وقت تلك القراءة نفسها، i=0 فقط) تُنتج "3 دقائق استمرار"
  // بمجرد مرور 3 دقائق منذ وصولها — بلا أي قراءة ثانية تثبت بقاء التركيز
  // مرتفعاً طوال تلك المدة؛ عدم وصول عينة جديدة لا يعني أن التركيز بقي كما
  // هو، وقد يعني توقف الجهاز عن الإرسال. الإصلاح: (1) تُشترط عينتان على
  // الأقل بالسلسلة، وإلا فلا استمرار مُثبَت (صفر)، (2) المدة تُحسب بين أقدم
  // وأحدث عينة فعلية بالسلسلة (streakEndMs - streakStartMs)، لا بين أقدم
  // عينة والآن. حداثة "الآن" نفسه (هل توقف الجهاز مؤخراً؟) تبقى مسؤولية
  // isLatestReadingFresh المنفصلة أدناه — فصل واضح بين "هل الاستمرار مُثبَت
  // فعلياً بين عينتين" و"هل آخر عينة لا تزال حية الآن"، بلا خلط الاثنين.
  function streakMinutesAbove(threshold: number): number {
    if (sorted[0].pm10UgM3 < threshold) return 0;
    let streakStartMs = new Date(sorted[0].recordedAt).getTime();
    const streakEndMs = streakStartMs;
    let sampleCount = 0;
    for (let i = 0; i < sorted.length; i++) {
      if (sorted[i].pm10UgM3 < threshold) break;
      if ((sorted[i].source ?? 'device') !== currentSource) break;
      const currentMs = new Date(sorted[i].recordedAt).getTime();
      if (i > 0) {
        const prevMs = new Date(sorted[i - 1].recordedAt).getTime();
        const gapMinutes = (prevMs - currentMs) / 60000;
        if (gapMinutes > PM10_READING_GAP_TOLERANCE_MINUTES) break;
      }
      streakStartMs = currentMs;
      sampleCount++;
    }
    // عينة واحدة فقط بالسلسلة = لا استمرار مُثبَت بين عينتين فعليتين، بصرف
    // النظر عن قِدمها — فشل آمن نحو "صفر" لا "منذ وصولها وحتى الآن".
    if (sampleCount < 2) return 0;
    return (streakEndMs - streakStartMs) / 60000;
  }

  const sustainedMinutesAbove340 = streakMinutesAbove(PM10_SUSTAINED_VIOLATION_THRESHOLD);
  const sustainedMinutesAbove250 = streakMinutesAbove(PM10_SUSTAINED_WARNING_THRESHOLD);

  // خطأ مكتشَف ومُصلَح (مراجعة كود مدير — "حد PM10 ما زال خاطئاً"): كان
  // isAbove340Now يستخدم `>=` بينما النص التنظيمي يقول "تجاوز 340"
  // (exceeds)، أي `>` صراحة — نفس عتبة pm10ThresholdRule في rulebook.ts
  // بالضبط (>PM10_VIOLATION_STOP_UG_M3، لا >=). قراءة 340.000 بالضبط تبقى
  // "تحذير/تنبيه استباقي" لا "مخالفة"، بنفس معاملة محرك الامتثال تماماً —
  // بقاء `>=` هنا كان يجعل هذه الدالة (المصدر الوحيد لـpm10ConfirmedViolation340
  // الذي يقرأه pm10ThresholdRule) تُقرّر "أعلى من 340 الآن" لقيمة لا يعتبرها
  // pm10ThresholdRule نفسه تجاوزاً أصلاً، فيتناقض المصدر مع المستهلك على
  // نفس القيمة بالضبط.
  const isAbove340Now = currentReadingUgM3 > PM10_SUSTAINED_VIOLATION_THRESHOLD;
  // "مؤكَّدة" تتطلب معاً: أكثر من دقيقتين استمرار فعلي + قراءة حية (ليست
  // قديمة) + مصدرها جهاز رصد حقيقي — أي شرط يفشل يُبقي الحالة "معلَّقة"
  // فقط، أبداً "مؤكَّدة" بلا دليل كافٍ.
  //
  // خطأ مكتشَف ومُصلَح (مراجعة كود مدير): كان `>=` — المرجع التنظيمي يشترط
  // "أكثر من دقيقتين" (المُوثَّق في تعليقات هذا الملف نفسه أعلاه)، أي `>`
  // صراحة لا `>=`. استمرار دقيقتين بالضبط (120.000 ثانية تماماً، لا أكثر)
  // كان يُصنَّف "مؤكَّدة" خلافاً للمرجع الذي يشترط تجاوز تلك المدة فعلياً.
  const isConfirmedViolation340 =
    isAbove340Now &&
    sustainedMinutesAbove340 > PM10_VIOLATION_CONFIRM_MINUTES &&
    isLatestReadingFresh &&
    isCurrentSourceDevice;
  const isPendingViolation340 = isAbove340Now && !isConfirmedViolation340;
  const isSuspended250For30Min =
    currentReadingUgM3 >= PM10_SUSTAINED_WARNING_THRESHOLD &&
    sustainedMinutesAbove250 >= PM10_SUSPENSION_MINUTES &&
    isLatestReadingFresh &&
    isCurrentSourceDevice;

  return {
    currentReadingUgM3,
    sustainedMinutesAbove340,
    sustainedMinutesAbove250,
    isConfirmedViolation340,
    isPendingViolation340,
    isSuspended250For30Min,
  };
}

// يجلب سجل قراءات PM10 الأخيرة (آخر 40 دقيقة كافية لكل القواعد الحالية:
// أقصاها 30 دقيقة + هامش) لنشاط معيّن، مفضِّلاً activity_group_id (أدق،
// قراءات يدوية مرتبطة بنشاط محدد) مع دمج قراءات الجهاز المحدد لهذا النشاط
// تحديداً (لا أي جهاز بالمشروع) — كلاهما يُعتبر جزءاً من نفس الاستمرار
// الزمني الفعلي لهذا الموقع.
//
// خطأ مكتشَف ومُصلَح (مراجعة كود مدير — ملاحظة #4): كان الاستعلام يجلب كل
// قراءات المشروع (project_id فقط، بلا فلترة device_id) — فمشروع فيه جهازان
// A وB (A مرتبط بنشاط 1، B مرتبط بنشاط 2) كان يخلط قراءاتهما معاً عند حساب
// استمرار أي نشاط، فقراءات جهاز B قد "تُثبت" جزئياً استمراراً لنشاط 1 غير
// مرتبط به إطلاقاً. الإصلاح: deviceId (اختياري، من project_dust_profiles.
// device_id الخاص بهذا النشاط تحديداً) يُقصر قراءات source='device' على هذا
// الجهاز فقط. نشاط بلا جهاز مرتبط (deviceId=null) لا يستقبل أي قراءة
// device إطلاقاً — فقط manual الخاصة بـactivity_group_id نفسه (open-meteo
// لم يعد يُسجَّل في هذا الجدول إطلاقاً، راجع weather_forecasts أدناه).
export async function fetchPm10SustainedStatus(
  supabaseAdmin: any,
  projectId: string,
  activityGroupId: string,
  deviceId?: string | null
): Promise<Pm10SustainedStatus> {
  const sinceIso = new Date(Date.now() - (PM10_SUSPENSION_MINUTES + 10) * 60000).toISOString();
  try {
    const { data } = await supabaseAdmin
      .from('pm10_readings_history')
      .select('pm10_ug_m3, recorded_at, activity_group_id, source, device_id')
      .eq('project_id', projectId)
      .gte('recorded_at', sinceIso)
      .order('recorded_at', { ascending: false });

    const relevant = (data || []).filter((row: any) => {
      if (row.activity_group_id === activityGroupId) return true;
      // قراءة جهاز على مستوى المشروع (activity_group_id=null): تخص هذا
      // النشاط فقط لو device_id يطابق جهازه المحدد فعلياً — لا أي جهاز آخر.
      if (row.activity_group_id === null) return !!deviceId && row.device_id === deviceId;
      return false;
    });
    const readings = relevant.map((row: any) => ({
      pm10UgM3: Number(row.pm10_ug_m3),
      recordedAt: row.recorded_at,
      source: row.source as 'device' | 'manual' | 'open-meteo' | undefined,
    }));
    return computeSustainedPm10Status(readings);
  } catch {
    // فشل الاستعلام لا يُسقط التقييم — نفس مبدأ resolveFreshProjectDevice.
    return computeSustainedPm10Status([]);
  }
}

// يجلب كل أجهزة مشروع دفعة واحدة (استعلام واحد بدل استعلام لكل نشاط) ويبني
// Map<deviceId, FreshDeviceReading|null> — يُستخدم في computeDustResults
// لحلّ جهاز كل نشاط (row.device_id) محلياً بدل استدعاء الشبكة لكل صف.
// نفس مبدأ resolveFreshProjectDevice: لا إسقاط للقراءة القديمة هنا — كل
// جهاز نشط له last_reading_at يُضاف للخريطة بصرف النظر عن عمره؛ الواجهة
// تقرر عرض تحذير القِدم.
async function resolveProjectDeviceMap(
  supabaseAdmin: any,
  projectId: string
): Promise<Map<string, FreshDeviceReading | null>> {
  const map = new Map<string, FreshDeviceReading | null>();
  const { data } = await supabaseAdmin
    .from('project_devices')
    .select('id, last_reading_at, last_wind_speed_kmh, last_wind_gust_kmh, last_wind_direction_deg, last_pm10, last_pm25, last_visibility_m, last_relative_humidity_percent, last_temperature_c, last_pm10_at')
    .eq('project_id', projectId)
    .eq('is_active', true);

  for (const d of data || []) {
    if (!d.last_reading_at) continue;
    map.set(d.id, {
      last_wind_speed_kmh: d.last_wind_speed_kmh ?? null,
      last_wind_gust_kmh: d.last_wind_gust_kmh ?? null,
      last_wind_direction_deg: d.last_wind_direction_deg ?? null,
      last_pm10: d.last_pm10 ?? null,
      last_pm25: d.last_pm25 ?? null,
      last_visibility_m: d.last_visibility_m ?? null,
      last_relative_humidity_percent: d.last_relative_humidity_percent ?? null,
      last_temperature_c: d.last_temperature_c ?? null,
      last_reading_at: d.last_reading_at,
      last_pm10_at: d.last_pm10_at ?? null,
    });
  }
  return map;
}

// تشغيل محرك الغبار لكل نشاط غبار، مع دمج AEI، وإرجاع شكل يطابق props
// بطاقة DustWidgetCard (windowEval + aei + معرفات الربط).
// supabaseAdmin اختياري: بلا تمريره (استدعاءات قديمة/اختبارات) يتجاهل
// المسار مسار الجهاز بالكامل ويسلك onsite_*/الطقس كما كان دائماً — إضافة
// تراكمية بحتة، بلا أي كسر توافقي.
export async function computeDustResults(dustRows: any[], project: any, supabaseAdmin?: any) {
  // كل نشاط قد يكون مرتبطاً بمحطة مختلفة (device_id، راجع AddActivityModal) —
  // لم يعد ممكناً استخدام "أحدث جهاز واحد بالمشروع" لكل الأنشطة كما كان
  // سابقاً. نجلب كل أجهزة المشروع دفعة واحدة، ثم نحلّ جهاز كل نشاط محلياً
  // حسب row.device_id داخل الحلقة أدناه (أنشطة قديمة بلا device_id تحصل
  // على null كما كان سلوكها سابقاً تماماً — فشل آمن).
  const deviceMap = supabaseAdmin && project?.id
    ? await resolveProjectDeviceMap(supabaseAdmin, project.id).catch(() => new Map<string, FreshDeviceReading | null>())
    : new Map<string, FreshDeviceReading | null>();

  const results = await Promise.all(
    (dustRows || []).map(async (row) => {
      try {
        const freshDevice = row.device_id ? deviceMap.get(row.device_id) ?? null : null;
        const input = buildDustInput(row, project, freshDevice);
        const startIso = riyadhLocalToUtcIso(row.planned_date, row.planned_time);
        const durationHours = Math.max(1, Math.round(row.duration_hours || 1));
        if (!startIso) return null;

        const windowEval: DustWindowEvaluation = await evaluateDustVisibilityWindow(
          input,
          startIso,
          durationHours
        );
        const aei: AeiEvaluationResult = evaluateAei(windowEval.worst, input.activityType as any);

        // توقعات ساعية عبر كامل ساعات دوام *يوم النشاط المجدول* (startIso)،
        // لا يوم فتح الصفحة؛ فشلها لا يُسقط تقييم النشاط بأكمله.
        const workDayHourly = await evaluateDustVisibilityWorkDayHourly(input, startIso).catch(() => []);

        // وسم كل ساعة (نافذة النشاط + كامل يوم الدوام) ببوابة الرياح
        // التنظيمية حتى تتماشى شبكة "توقعات الطقس طوال فترة الدوام" مع
        // قرار الامتثال، بدل الاعتماد فقط على عتبات DVI الفيزيائي المختلفة.
        const isDustGenerating = row.is_dust_generating ?? true;
        // خطأ مكتشَف ومُصلَح: كان يُستخدَم row.is_enclosed_operation الخام
        // مباشرة هنا، بينما محطة الخلط (BATCHING_PLANT) مستثناة عمداً من
        // اشتراطه إطلاقاً في محرك القرار الفعلي (isEnclosedExemptFromHighWind
        // في dust-compliance-engine/engine.ts) — صوامع مغلقة + فلتر PM10
        // ≥99% يكفيان، بصرف النظر عن إغلاق المحطة فيزيائياً. بلا هذا الإصلاح،
        // شارة "بوابة الرياح التنظيمية" على بطاقات التوقعات الساعية كانت
        // تظهر "مفعَّلة" لمحطة خلط مكشوفة فعلياً معفاة، رغم أن قرار الامتثال
        // الفعلي (evaluateDustCompliance) لا يوقفها — تناقض مربك بين الشارة
        // الإعلامية والقرار الملزم الفعلي لنفس النشاط.
        const isBatchingPm10Exempt =
          (row.regulatory_activity ?? 'OTHER') === 'BATCHING_PLANT' &&
          row.silos_sealed === true &&
          typeof row.pm10_filter_efficiency_percent === 'number' &&
          row.pm10_filter_efficiency_percent >= BATCHING_PM10_FILTER_MIN_PERCENT;
        const isEnclosedOperation = isBatchingPm10Exempt ? true : (row.is_enclosed_operation ?? false);
        const annotatedWindowEval: DustWindowEvaluation = {
          ...windowEval,
          worst: annotateHourWithRegulatoryGate(windowEval.worst, isDustGenerating, isEnclosedOperation),
          hourly: windowEval.hourly.map((h) => annotateHourWithRegulatoryGate(h, isDustGenerating, isEnclosedOperation)),
          bestWindowWorst: windowEval.bestWindowWorst
            ? annotateHourWithRegulatoryGate(windowEval.bestWindowWorst, isDustGenerating, isEnclosedOperation)
            : null,
          avoidWindowWorst: windowEval.avoidWindowWorst
            ? annotateHourWithRegulatoryGate(windowEval.avoidWindowWorst, isDustGenerating, isEnclosedOperation)
            : null,
        };
        const annotatedWorkDayHourly = workDayHourly.map((h) =>
          annotateHourWithRegulatoryGate(h, isDustGenerating, isEnclosedOperation)
        );

        return {
          activityGroupId: row.activity_group_id || `dust-${row.id}`,
          activityId: String(row.id),
          activityType: input.activityType,
          windowEval: annotatedWindowEval,
          aei,
          hourlyForecasts: annotatedWorkDayHourly,
        };
      } catch (error) {
        console.error(`فشل تقييم الغبار للنشاط ${row.id}:`, error);
        return null;
      }
    })
  );
  return results.filter(Boolean);
}

// -----------------------------------------------------------------------
// تخزين تقييمات الغبار — نفس نمط persistCraneEvaluations في مرقاب الأصلي،
// مبسّط (بلا لقطة طقس منفصلة أو منطق استقرار إعادة تشغيل، غير مطلوبين هنا).
// الحد الأدنى بالدقائق بين تخزين تقييمين متتاليين لنفس النشاط بنفس القرار
// — يمنع تراكم صفوف مكررة في dust_evaluations من مجرد فتح/تحديث صفحة
// المشروع. لا يُطبَّق هذا التأخير إطلاقاً إن تغيّر القرار فعلياً.
const MIN_MINUTES_BETWEEN_UNCHANGED_EVALUATIONS = 5;

export function shouldSkipPersist(
  previousDecision: string | null | undefined,
  previousUpdatedAt: string | null | undefined,
  newDecision: string
): boolean {
  if (!previousDecision || !previousUpdatedAt) return false;
  if (previousDecision !== newDecision) return false;
  const minutesSinceLast = (Date.now() - new Date(previousUpdatedAt).getTime()) / 60000;
  return minutesSinceLast < MIN_MINUTES_BETWEEN_UNCHANGED_EVALUATIONS;
}

export async function persistDustEvaluations(
  supabaseAdmin: any,
  projectId: string,
  dustResults: any[],
  triggeredBy: string
) {
  await Promise.all(
    dustResults.map(async (r) => {
      try {
        const worst = r.windowEval?.worst;
        if (!worst) return;

        const newDecision = worst.decisionCategory ?? 'UNKNOWN';

        const { data: existing } = await supabaseAdmin
          .from('current_dust_decisions')
          .select('decision, updated_at')
          .eq('activity_group_id', r.activityGroupId)
          .maybeSingle();

        if (shouldSkipPersist(existing?.decision, existing?.updated_at, newDecision)) return;

        const { data: inserted } = await supabaseAdmin
          .from('dust_evaluations')
          .insert({
            project_id: projectId,
            dust_profile_id: r.activityId,
            activity_group_id: r.activityGroupId,
            result: worst,
            triggered_by: triggeredBy,
          })
          .select('id')
          .single();

        const evaluationId = (inserted as any)?.id;
        if (!evaluationId) return;

        // كتابة محميّة من التزامن (compare-and-swap): كان upsert أعمى يستبدل
        // الصف بلا شرط، فطلبان متزامنان لنفس النشاط (مثال: التحديث الدوري كل
        // دقيقتين + طلب onCountdownElapsed بنفس اللحظة) يقرآن نفس existing ثم
        // يكتبان معاً، فيفوز الذي يصل متأخراً للخادم لا الأحدث حساباً — فقد
        // يستقر النظام على قرار محسوب من بيانات أقدم. الآن نشترط أن يكون
        // updated_at لم يتغيّر منذ القراءة (eq على القيمة المقروءة)؛ إن تغيّر
        // فطلب آخر كتب بالفعل ونتخطى الكتابة (فوز الأحدث فعلياً، لا الأبطأ).
        const nowIso = new Date().toISOString();
        const decisionRow = {
          activity_group_id: r.activityGroupId,
          project_id: projectId,
          latest_evaluation_id: evaluationId,
          decision: newDecision,
          triggered_rules: worst.triggeredRules ?? [],
          short_reason: worst.shortReason ?? null,
          updated_at: nowIso,
        };
        if (existing?.updated_at) {
          await supabaseAdmin
            .from('current_dust_decisions')
            .update(decisionRow)
            .eq('activity_group_id', r.activityGroupId)
            .eq('updated_at', existing.updated_at);
        } else {
          // لا صف سابق — insert عادي. تصادم نادر (طلبان أولان متزامنان تماماً)
          // يفشل أحدهما على قيد المفتاح الأساسي، وهو السلوك الصحيح هنا.
          await supabaseAdmin.from('current_dust_decisions').insert(decisionRow);
        }
      } catch (error) {
        console.error(`فشل حفظ تقييم الغبار للنشاط ${r.activityId}:`, error);
      }
    })
  );
}

// -----------------------------------------------------------------------
// المستقبِلات الحساسة حول وحدة الكسارة/الخلاطة تحديداً (500م من موقع
// الوحدة نفسها)، لا من حدود المشروع. المستقبِلات المعروضة على مستوى
// المشروع (1كم من الحدود) لا تكفي هنا: الكسارة قد تكون في طرف موقع كبير،
// فالمستقبِل الذي يُفعّل CRUSHER-DISTANCE-500-002C هو الأقرب لها هي، وقد
// يختلف تماماً عن الأقرب لحدود المشروع. عرضها منفصلة يجعل سبب القاعدة
// مرئياً للمستخدم بدل رقم مسافة مجرّد.
//
// تُبنى فقط للأنشطة التنظيمية التي لها موقع وحدة فعلي (CRUSHER عبر
// crusher_lat/lng، BATCHING_PLANT عبر batching_lat/lng) — بقية الأنشطة
// لا تملك نقطة وحدة مستقلة عن الموقع فتُترك فارغة.
export function computeUnitReceptors(
  dustRows: any[],
  dustResults: any[],
  sensitiveReceptors: any[] = []
): Map<string, UnitReceptorGroup[]> {
  const rowsById = new Map<string, any>((dustRows || []).map((row) => [String(row.id), row]));
  const byActivityId = new Map<string, UnitReceptorGroup[]>();

  (dustResults || []).forEach((r) => {
    const row = rowsById.get(r.activityId);
    if (!row) return;

    const groups: UnitReceptorGroup[] = [];
    const regulatoryActivity = row.regulatory_activity ?? 'OTHER';

    if (regulatoryActivity === 'CRUSHER') {
      const lat = typeof row.crusher_lat === 'number' ? row.crusher_lat : null;
      const lng = typeof row.crusher_lng === 'number' ? row.crusher_lng : null;
      if (lat !== null && lng !== null) {
        groups.push({
          unitType: 'CRUSHER',
          unitLabelAr: 'الكسارة',
          lat,
          lng,
          radiusM: UNIT_RECEPTOR_RADIUS_M,
          // الكسارة وحدها لها حد تنظيمي مُلزم عند 500م
          // (CRUSHER-DISTANCE-500-002C) — أي مستقبِل سكني/مدرسي/صحي في هذه
          // القائمة يعني إيقافاً إلزامياً فعلياً، لا تنبيهاً توعوياً.
          hasBindingDistanceRule: true,
          receptors: receptorsWithinRadiusM(lat, lng, sensitiveReceptors),
        });
      }
    }

    if (regulatoryActivity === 'BATCHING_PLANT') {
      const lat = typeof row.batching_lat === 'number' ? row.batching_lat : null;
      const lng = typeof row.batching_lng === 'number' ? row.batching_lng : null;
      if (lat !== null && lng !== null) {
        groups.push({
          unitType: 'BATCHING_PLANT',
          unitLabelAr: 'محطة الخلط الخرساني',
          lat,
          lng,
          radiusM: UNIT_RECEPTOR_RADIUS_M,
          // لا توجد قاعدة مسافة مُلزمة لمحطة الخلط في الدليل التنظيمي
          // الحالي (راجع batchingPlantRules) — تُعرض للوعي بالجوار الحساس
          // فقط، ولا يجوز تقديمها للمستخدم كأنها تُفعّل إيقافاً.
          hasBindingDistanceRule: false,
          receptors: receptorsWithinRadiusM(lat, lng, sensitiveReceptors),
        });
      }
    }

    if (groups.length > 0) byActivityId.set(r.activityId, groups);
  });

  return byActivityId;
}

// -----------------------------------------------------------------------
// طبقة الامتثال التنظيمي (Riyadh Dust Compliance) — تُستهلك نتيجة DVI
// الجاهزة من computeDustResults (windowEval.worst) كمُدخل قراءة فقط، بلا
// أي إعادة حساب لـ DVI هنا. dustRows هو نفس مصفوفة project_dust_profiles
// الخام الممرَّرة أصلاً لـ computeDustResults، تُستخدم هنا فقط لقراءة
// أعمدة أدلة الامتثال (regulatory_activity, dust_suppression_system_...
// إلخ) التي لا يحتاجها محرك DVI نفسه.
//
// supabaseAdmin اختياري: بلا تمريره (استدعاءات قديمة/اختبارات) يتجاهل
// المسار جلب "القرار السابق" بالكامل، فيسلك محرك الامتثال مساره القديم
// بلا قيد استئناف — إضافة تراكمية بحتة، بلا أي كسر توافقي (نفس نمط
// resolveFreshProjectDevice في computeDustResults).
//
// أمن الأدلة (مراجعة كود خبير خارجي): هذه الدالة تُستدعى من مسارات GET
// (project/[projectId]، dashboard/global، viewer/dashboard) *وأيضاً* من
// POST /evaluate الكاتب فعلياً. كانت تُدرِج قراءة PM10 في
// pm10_readings_history كأثر جانبي دائم بصرف النظر عن الاستدعاء — أي فتح
// لصفحة GET كان يضيف عينة استمرار زمني حقيقية، فيُطيل مدة إثبات
// "المخالفة المستمرة" (RCRC-PM10-340-VIOLATION-011) خلافاً لدلالة GET
// (idempotent، بلا أثر جانبي، نفس مبدأ التعليق في route.ts). الآن الإدراج
// مشروط بـpersistPm10Reading (افتراضياً false): GET يبقى قراءة بحتة دائماً
// (fetchPm10SustainedStatus لا تزال تُقرأ من السجل الحالي كما هو)، وPOST
// /evaluate فقط (المسار الكاتب المُصرَّح صراحة من الواجهة) يُمرِّر true
// ليُسجِّل العينة الجديدة فعلياً — لا كتابة أدلة بلا فعل مستخدم صريح.
export async function computeDustComplianceResults(
  dustRows: any[],
  project: any,
  dustResults: any[],
  sensitiveReceptors: any[] = [],
  supabaseAdmin?: any,
  persistPm10Reading: boolean = false
): Promise<DustComplianceResult[]> {
  const rowsById = new Map<string, any>((dustRows || []).map((row) => [String(row.id), row]));

  // جلب مجمَّع لآخر قرار مسجَّل لكل activity_group_id ذي صلة — نداء واحد
  // بدل نداء لكل نشاط، بنفس روح تجميع resolveFreshProjectDevice. يُستخدم
  // فقط لتغذية منع الاستئناف التلقائي الفوري بعد إيقاف في engine.ts —
  // غيابه (لا supabaseAdmin، أو فشل الاستعلام) يعني ببساطة عدم تطبيق أي
  // قيد، لا خطأً.
  //
  // pending_resume_since (لا stopped_since/updated_at) هو المصدر الصحيح
  // لـ"منذ متى أصبحت القراءة جيدة فعلياً" — راجع
  // supabase-add-compliance-pending-resume-since-migration.sql للسبب
  // الكامل: stopped_since يقيس "منذ متى بدأ الإيقاف" (سؤال مختلف تماماً)،
  // واستخدامه هنا كان يسمح باستئناف فوري إن تجاوزت مدة الإيقاف الكلية 10
  // دقائق ولو لم تتراكم دقيقة فعلية واحدة من القراءة الجيدة بعد.
  let previousDecisionsByGroup = new Map<
    string,
    { decision: string; updated_at: string; pending_resume_since: string | null; deciding_rule_code: string | null }
  >();
  if (supabaseAdmin) {
    const groupIds = Array.from(
      new Set((dustResults || []).map((r) => r.activityGroupId).filter(Boolean))
    );
    if (groupIds.length > 0) {
      try {
        const { data } = await supabaseAdmin
          .from('current_dust_compliance_decisions')
          .select('activity_group_id, decision, updated_at, stopped_since, pending_resume_since, deciding_rule_code')
          .in('activity_group_id', groupIds);
        previousDecisionsByGroup = new Map(
          (data || []).map((row: any) => [
            row.activity_group_id,
            {
              decision: row.decision,
              updated_at: row.stopped_since ?? row.updated_at,
              pending_resume_since: row.pending_resume_since ?? null,
              deciding_rule_code: row.deciding_rule_code ?? null,
            },
          ])
        );
      } catch {
        // فشل الاستعلام لا يُسقط التقييم — نفس مبدأ resolveFreshProjectDevice.
      }
    }
  }

  const results = await Promise.all(
    (dustResults || []).map(async (r) => {
      try {
        const row = rowsById.get(r.activityId);
        const dviResult = r.windowEval?.worst;
        if (!row || !dviResult) return null;

        const previousDecision = previousDecisionsByGroup.get(r.activityGroupId) ?? null;

        // بناء أولي لقراءة pm10UgM3/dataSource فقط (بلا استمرار بعد) — يلزم
        // معرفة القراءة الحالية قبل تسجيلها في السجل التاريخي وجلب استمرارها.
        const preliminaryCtx = buildComplianceContext(project, row, dviResult, sensitiveReceptors, previousDecision);

        // تسجيل قراءة PM10 — يُستخدم لحساب استمرار القراءة (دقيقتين/30
        // دقيقة). قراءات الأجهزة تُسجَّل مرة واحدة عند الاستقبال
        // (devices/ingest/route.ts)، لا هنا، لتفادي تكرار نفس القراءة في كل
        // تقييم صفحة/cron.
        //
        // قراءة onsite (يدوية، دليل ميداني حقيقي) تُسجَّل في
        // pm10_readings_history — نفس الجدول الذي يقرأ منه
        // fetchPm10SustainedStatus لإثبات "استمرار مخالفة".
        //
        // توقّع open-meteo (نموذج طقس عالمي، دقة ساعية، بلا محطة معتمدة) لا
        // يُسجَّل في ذلك الجدول إطلاقاً — يُسجَّل في weather_forecasts
        // المنفصل تماماً (evidence_eligible=false دائماً، راجع
        // supabase-add-weather-forecasts-table-migration.sql). فصل بنيوي لا
        // منطقي فقط: fetchPm10SustainedStatus أدناه يستعلم pm10_readings_
        // history حصراً، فلا سبيل لتوقّع طقس أن "يُثبت استمراراً" لقرار
        // إلزامي (MANDATORY_STOP) بصرف النظر عن أي تعديل مستقبلي على شروط
        // الفلترة — التصنيف يحدث عند الكتابة، لا عند القراءة فقط.
        // نتيجة ذلك: نشاط بلا جهاز/قراءة يدوية يعتمد فقط على توقّع الطقس
        // يبقى "معلَّق" (isPendingViolation340) إلى الأبد، لا "مخالفة
        // مؤكدة" — وهذا هو السلوك الصحيح المقصود (توقّع لا يصلح دليلاً).
        //
        // خطأ مكتشَف ومُصلَح: كان الشرط يعتمد على preliminaryCtx.dataSource
        // (تلخيص عام لأعلى مصدر فاز بأي حقل من كل حقول القراءة، device
        // يفوز أولاً) بدل preliminaryCtx.pm10Source (مصدر PM10 تحديداً). في
        // حالة رياح من الجهاز وPM10 من الطقس معاً، dataSource يصبح 'device'
        // فيفشل الشرط (لا onsite ولا open-meteo)، فلا يُسجَّل PM10 هذا في أي
        // مكان (ليس قراءة جهاز فعلية تُسجَّل عند الاستقبال، ولا onsite/
        // open-meteo تُسجَّل هنا) — فتنقطع سلسلة إثبات الاستمرار لتلك
        // القراءة كلياً. pm10Source (من merged.sources.pm10 مباشرة) يعكس
        // مصدر PM10 الفعلي بصرف النظر عن مصدر بقية الحقول.
        // خطأ مكتشَف ومُصلَح (مراجعة كود مدير): كان هذا المتغيّر يُعلَن بنوع
        // مُجرَّد يستقطع فقط الرقمين (sustainedMinutesAbove340/250) من الكائن
        // الكامل Pm10SustainedStatus — فيضيع isConfirmedViolation340/
        // isSuspended250For30Min (المحسوبتان بكل الأدلة: المصدر، حداثة
        // القراءة) قبل ما تصل حتى لـbuildComplianceContext، مضطرّاً
        // pm10ThresholdRule لإعادة اشتقاق القرار من الدقائق الخام بمعزل عن
        // تلك الأدلة. النوع الكامل الآن يبقى سليماً من fetchPm10SustainedStatus
        // حتى buildComplianceContext.
        let pm10Sustained: Pm10SustainedStatus | null = null;
        if (supabaseAdmin && r.activityGroupId && project?.id) {
          if (persistPm10Reading && preliminaryCtx.pm10UgM3 !== null) {
            if (preliminaryCtx.pm10Source === 'onsite') {
              // قراءة يدوية فعلية (onsite_pm10) — دليل ميداني حقيقي، تُسجَّل
              // في pm10_readings_history كما هي دائماً.
              try {
                await supabaseAdmin.from('pm10_readings_history').insert({
                  activity_group_id: r.activityGroupId,
                  project_id: project.id,
                  pm10_ug_m3: preliminaryCtx.pm10UgM3,
                  source: 'manual',
                });
              } catch {
                // فشل التسجيل لا يُسقط التقييم — نفس مبدأ resolveFreshProjectDevice.
              }
            } else if (preliminaryCtx.pm10Source === 'weather') {
              // توقّع Open-Meteo — نموذج طقس عالمي بدقة ساعية، بلا محطة رصد
              // معتمدة ولا معايرة، ليس قياساً ميدانياً. يُسجَّل في جدول
              // منفصل تماماً (weather_forecasts، evidence_eligible=false
              // دائماً) بدل pm10_readings_history — لا يجوز خلطه مع أدلة
              // ميدانية حقيقية قد تُبنى عليها مخالفة/إيقاف إلزامي (راجع
              // supabase-add-weather-forecasts-table-migration.sql).
              // fetchPm10SustainedStatus أدناه يقرأ من pm10_readings_history
              // فقط، فلا سبيل لهذا التوقّع أن "يُثبت استمراراً" لقرار ملزم.
              try {
                await supabaseAdmin.from('weather_forecasts').insert({
                  activity_group_id: r.activityGroupId,
                  project_id: project.id,
                  provider: 'open-meteo',
                  forecast_valid_at: new Date().toISOString(),
                  pm10_ug_m3: preliminaryCtx.pm10UgM3,
                  evidence_eligible: false,
                });
              } catch {
                // فشل التسجيل لا يُسقط التقييم — نفس مبدأ resolveFreshProjectDevice.
              }
            }
          }
          pm10Sustained = await fetchPm10SustainedStatus(supabaseAdmin, project.id, r.activityGroupId, row.device_id ?? null);
        }

        const ctx = buildComplianceContext(project, row, dviResult, sensitiveReceptors, previousDecision, pm10Sustained);
        const result = evaluateDustCompliance(ctx);
        return {
          activityGroupId: r.activityGroupId,
          activityId: r.activityId,
          dustProfileId: row.id,
          result,
        };
      } catch (error) {
        console.error(`فشل تقييم امتثال الغبار للنشاط ${r.activityId}:`, error);
        return null;
      }
    })
  );
  return results.filter(Boolean) as any[];
}

// -----------------------------------------------------------------------
// امتثال ساعي — نفس مبدأ computeDustComplianceResults أعلاه لكن يُشغَّل
// لكل ساعة من hourlyForecasts (توقعات DVI طوال ساعات دوام اليوم، محسوبة
// مسبقاً في computeDustResults) بدل ساعة واحدة فقط (windowEval.worst).
// كل ساعة تحمل rawWeatherSample الخاصة بها فتُبنى لها DustComplianceContext
// مستقلة عبر buildComplianceContext (المُصمَّمة أصلاً لتقبل أي
// DviHourlyEvaluation)، ثم evaluateDustCompliance (دالة نقية بلا I/O) —
// لا إعادة حساب لـ DVI نفسه، فقط تكرار محرك الامتثال (نفسه بالضبط) على كل
// ساعة جاهزة. الهدف: عرض "هل أقدر أشتغل الساعة الفلانية؟" حسب الامتثال.
//
// كل ساعة تحمل أيضاً aei خاصاً بها (evaluateAei على DVI تلك الساعة، ثم
// applyComplianceGateToAei بنفس منطق البوابة الإجمالية) — بطلب صريح بدمج
// كل قرارات الامتثال في مؤشر AEI الموحّد بدل عرضها كقرار امتثال خام منفصل
// لكل ساعة في الواجهة (راجع applyComplianceGateToAei أدناه).
export function computeDustComplianceHourly(
  dustRows: any[],
  project: any,
  dustResults: any[],
  sensitiveReceptors: any[] = []
): Map<string, any[]> {
  const rowsById = new Map<string, any>((dustRows || []).map((row) => [String(row.id), row]));
  const byActivityId = new Map<string, any[]>();

  (dustResults || []).forEach((r) => {
    try {
      const row = rowsById.get(r.activityId);
      if (!row) return;

      // نفس fallback الموجود أصلاً في DustWidgetCard (hasWorkDayHourly ?
      // hourlyForecasts : windowEval.hourly): توقعات ساعات الدوام كاملة إن
      // توفرت (الحالة الشائعة)، وإلا نافذة النشاط المجدولة فقط — بدل ترك
      // الشبكة فارغة بصمت متى فشل جلب توقعات كامل اليوم أو وقعت خارج
      // ساعات الدوام الافتراضية بينما نافذة النشاط نفسها متوفرة.
      const hourly: any[] =
        r.hourlyForecasts && r.hourlyForecasts.length > 0
          ? r.hourlyForecasts
          : (r.windowEval?.hourly ?? []);
      if (hourly.length === 0) return;

      const hourlyCompliance = hourly.map((hour) => {
        const ctx = buildComplianceContext(project, row, hour, sensitiveReceptors);
        const result = evaluateDustCompliance(ctx);
        const rawAei = evaluateAei(hour, r.activityType);
        // mode='PLANNING' — نفس ساعة توقّع بلا استمرار PM10/استقرار استئناف
        // (لم تُمرَّر previousDecision/pm10Sustained لـbuildComplianceContext
        // أعلاه أصلاً)، راجع FinalDecisionMode في final-decision-engine/types.ts.
        const decision = decideFinal(buildFinalDecisionInput(`${r.activityId}:${hour.time}`, hour, result, rawAei, 'PLANNING'));
        const hourAei = applyFinalDecisionToAei(rawAei, decision, result);
        return { time: hour.time, result, aei: hourAei };
      });
      byActivityId.set(r.activityId, hourlyCompliance);
    } catch (error) {
      console.error(`فشل تقييم الامتثال الساعي للنشاط ${r.activityId}:`, error);
    }
  });

  return byActivityId;
}

// خطأ معماري مكتشَف ومُصلَح (مراجعة كود خبير خارجي — "لا يوجد
// FinalDecisionEngine مستقل فعلياً"): applyComplianceGateToAei وcompute
// UnifiedActivityDecision كانتا نسختين مستقلتين يدوياً لدمج DVI + الامتثال
// في قرار واحد — بمنطق أولوية مكرَّر (متى يفوز الامتثال، متى pendingConfirmation
// يُخفَّف) قابل للتناقض بينهما (وقد تناقض فعلياً مع مولّد التنبيهات، نسخة
// ثالثة مستقلة تماماً في alerts/generate/route.ts). كلتاهما الآن أغلفة
// رقيقة حول decideFinal (app/utils/final-decision-engine) — المصدر الوحيد
// المسموح له بقراءة dvi.mandatoryStop/compliance.decisionCategory معاً.

// يحوّل FinalDecision.operationalDecision/level الجاهزين إلى تعديل AEI —
// يستبدل منطق applyComplianceGateToAei اليدوي القديم (AEI_COMPLIANCE_
// CLOSED_DECISIONS/AEI_COMPLIANCE_RESTRICTED_DECISIONS) بقراءة قرار decideFinal
// المُجمَّع فعلياً، بدل إعادة اشتقاق نفس الأولويات هنا مرة أخرى.
function applyFinalDecisionToAei(aei: AeiEvaluationResult, decision: FinalDecision, compliance: DustComplianceResult | null): AeiEvaluationResult {
  // خطأ مكتشَف ومُصلَح (طلب صريح من المستخدم — "لا زالت المشكلة"، بعد أول
  // إصلاح لهذا الفرع): هذا الفحص كان يأتي *بعد* شرط aei.closedByGate أدناه
  // — فحين dvi.mandatoryStop=true (PM10 لحظي تقديري من Open-Meteo تجاوز
  // 340 بلا جهاز حقيقي)، evaluateAei الأساسية (aei-engine/engine.ts) تضبط
  // aei.closedByGate=true *قبل* وصول القرار لهذه الدالة أصلاً، فيُرجَع aei
  // كما هو بالسطر التالي (return aei محكومة بـclosedByGate) قبل حتى الوصول
  // لفحص HOLD_FOR_VERIFICATION تحته — فتبقى بطاقة AEI "مغلق" بثقة كاملة
  // وعدّاد تنازلي فعلي، رغم أن نفس تلك القراءة (1229.3) مصدرها تقدير طقس لا
  // قراءة جهاز حقيقية. الإصلاح: HOLD_FOR_VERIFICATION يُفحَص أولاً، قبل أي
  // إفلات مبكر آخر — غياب الأدلة الحقيقية يُبطل حتى إغلاق DVI نفسه المبني
  // على نفس تلك القراءة التقديرية، لا فقط قرارات الامتثال الأخف.
  if (decision.operationalDecision === 'HOLD_FOR_VERIFICATION') {
    return {
      ...aei,
      status: 'RESTRICT',
      statusLabelAr: 'بانتظار تحقق ميداني — بيانات غير كافية',
      color: 'ORANGE',
      score: Math.min(aei.score, AEI_RESTRICT_CAP),
      cappedByGate: true,
      gateReasonAr: `⏳ ${decision.shortReasonAr}`,
      shortReasonAr: decision.shortReasonAr,
      recommendationAr: 'لا يوجد جهاز رصد يرسل قراءة حقيقية لهذا النشاط — تحقّق ميدانياً قبل الاعتماد على أي قرار آلي (مسموح أو موقوف).',
      isHoldForVerification: true,
    };
  }

  // نفس شرط الإفلات المبكر في applyComplianceGateToAei القديمة تماماً —
  // لا قرار امتثال إطلاقاً، أو ALLOW نظيف. operationalDecision/regulatoryFinding
  // لا يكفيان وحدهما هنا (RESTRICT_ACTIVITY/PRECAUTION كلاهما regulatoryFinding=
  // COMPLIANT رغم حاجتهما لتعديل AEI فعلي) — decisionCategory الخام هو الفحص
  // الصحيح لـ"هل يوجد أي شيء لنعدّله أصلاً؟". يأتي بعد فحص HOLD_FOR_VERIFICATION
  // أعلاه عمداً (راجع تعليقه) — لا قبله.
  if (!compliance || compliance.decisionCategory === 'ALLOW') return aei;
  if (aei.closedByGate) return aei; // بوابة DVI أوقفته أصلاً (بأدلة حقيقية، إذ تجاوزنا فحص HOLD_FOR_VERIFICATION فوق)، لا داعي للتكرار

  if (decision.operationalDecision === 'MANDATORY_STOP') {
    return {
      ...aei,
      status: 'CLOSED',
      statusLabelAr: 'بيئة العمل غير آمنة (مغلق) — إيقاف تنظيمي',
      color: 'BLACK',
      score: 0,
      closedByGate: true,
      gateReasonAr: `⛔ إيقاف إلزامي بموجب الامتثال التنظيمي: ${decision.shortReasonAr}`,
      shortReasonAr: decision.shortReasonAr,
      recommendationAr: 'يُمنع اعتماد تنفيذ هذا النشاط حتى استيفاء شروط الامتثال التنظيمي أو تحسّن الظروف الموجبة للإيقاف.',
    };
  }

  if (decision.operationalDecision === 'PROTECTIVE_STOP') {
    // pendingConfirmation=true (مثال: MRQ-PM10-BLACK-PENDING-104) يعني
    // القرار موقوف احترازياً بانتظار تأكيد استمرار القراءة، لا مخالفة
    // مؤكَّدة — لا AeiStatus "معلَّق" منفصل موجود أصلاً، فنستخدم RESTRICT
    // بنص مختلف بدل اختراع حالة جديدة تحتاج تعديل كل مكان يتحقق من AeiStatus.
    // STOP_AFFECTED_ACTIVITY مؤكَّد (pendingConfirmation=false) يُعامَل بنفس
    // درجة الإغلاق (CLOSED) — النشاط متوقف فعلياً بقرار تنظيمي مؤكَّد.
    if (decision.pendingConfirmation) {
      return {
        ...aei,
        status: 'RESTRICT',
        statusLabelAr: 'معلَّق مؤقتاً (بانتظار تأكيد) — امتثال تنظيمي',
        color: 'RED',
        score: Math.min(aei.score, AEI_RESTRICT_CAP),
        cappedByGate: true,
        gateReasonAr: `⏳ إيقاف مؤقت بانتظار التأكيد: ${decision.shortReasonAr}`,
        shortReasonAr: decision.shortReasonAr,
        recommendationAr: 'راقب القراءة الآن — سيتحول القرار تلقائياً إلى إيقاف إلزامي إن استمر التجاوز، أو يعود آمناً إن انخفض.',
      };
    }
    return {
      ...aei,
      status: 'CLOSED',
      statusLabelAr: 'بيئة العمل غير آمنة (مغلق) — إيقاف تنظيمي',
      color: 'BLACK',
      score: 0,
      closedByGate: true,
      gateReasonAr: `⛔ إيقاف إلزامي بموجب الامتثال التنظيمي: ${decision.shortReasonAr}`,
      shortReasonAr: decision.shortReasonAr,
      recommendationAr: 'يُمنع اعتماد تنفيذ هذا النشاط حتى استيفاء شروط الامتثال التنظيمي أو تحسّن الظروف الموجبة للإيقاف.',
    };
  }

  if (decision.operationalDecision === 'RESTRICT' && aei.score > AEI_RESTRICT_CAP) {
    return {
      ...aei,
      status: 'RESTRICT',
      statusLabelAr: 'تقييد تشغيلي وضوابط إضافية — امتثال تنظيمي',
      color: 'RED',
      score: AEI_RESTRICT_CAP,
      cappedByGate: true,
      gateReasonAr: `⚠️ تنبيه: تم تقييد النشاط بسبب الامتثال التنظيمي (${decision.decisionLabelAr}): ${decision.shortReasonAr}`,
      shortReasonAr: decision.shortReasonAr,
      recommendationAr: 'استوفِ شروط الامتثال التنظيمي المذكورة أدناه قبل اعتماد تنفيذ هذا النشاط دون قيود.',
    };
  }

  // PRECAUTION (نطاق PM10 150-250): طلب صريح من المستخدم (مُحدَّث) — يجب أن
  // تعكس بطاقة AEI نفس حالة الاحتراز الصفراء المعروضة في بانر الامتثال، لا
  // درجة/لون مستقلة قد تُظهر "قابل للتنفيذ" أخضر رغم بانر احتراز أصفر أعلاه.
  // القرار السابق (لا تقييد إطلاقاً) عُكس صراحة: الآن نوحّد الحالة كـMONITOR
  // الأصفر بنفس نص decisionLabelAr الظاهر في بطاقة الامتثال، دون المساس
  // بالدرجة الرقمية نفسها (تبقى للاستخدام الداخلي فقط، الواجهة لا تعرضها).
  if (compliance.decisionCategory === 'PRECAUTION') {
    return {
      ...aei,
      status: 'MONITOR',
      statusLabelAr: compliance.decisionLabelAr,
      color: 'YELLOW',
      shortReasonAr: decision.shortReasonAr,
      recommendationAr: 'زِد وتيرة المراقبة ومتابعة القراءة — لا يتطلب إجراءً تصحيحياً فورياً ما لم يستمر الارتفاع.',
    };
  }

  if (decision.operationalDecision === 'MONITOR' && aei.score > AEI_RESTRICT_CAP) {
    // ALLOW_WITH_CONTROLS/FIELD_VERIFICATION_REQUIRED (تقييد فعلي) — نفس
    // سقف RESTRICT أعلاه.
    return {
      ...aei,
      status: 'RESTRICT',
      statusLabelAr: 'تقييد تشغيلي وضوابط إضافية — امتثال تنظيمي',
      color: 'RED',
      score: AEI_RESTRICT_CAP,
      cappedByGate: true,
      gateReasonAr: `⚠️ تنبيه: تم تقييد النشاط بسبب الامتثال التنظيمي (${decision.decisionLabelAr}): ${decision.shortReasonAr}`,
      shortReasonAr: decision.shortReasonAr,
      recommendationAr: 'استوفِ شروط الامتثال التنظيمي المذكورة أدناه قبل اعتماد تنفيذ هذا النشاط دون قيود.',
    };
  }

  // كل decisionCategory غير ALLOW مغطاة بفروع صريحة أعلاه (MANDATORY_STOP/
  // STOP_AFFECTED_ACTIVITY عبر PROTECTIVE_STOP/MANDATORY_STOP، RESTRICT_
  // ACTIVITY، ALLOW_WITH_CONTROLS/FIELD_VERIFICATION_REQUIRED عبر MONITOR،
  // PRECAUTION صراحة أعلاه) — لا يبقى مسار فعلي يصل هنا، فشل آمن يُرجع aei
  // كما هو بلا تعديل.
  return aei;
}

// بديل آمن حين يغيب windowEval.worst (لا يحدث في مسار الإنتاج الفعلي —
// dustResults من computeDustResults يحمله دائماً — لكن applyComplianceGatesToDustAei
// دالة عامة قد تُستدعى باختبارات/مسارات مستقبلية بحمولة {activityId, aei,
// compliance} مبسَّطة، تماماً كما كان applyComplianceGateToAei القديمة تقبل
// compliance وحدها بلا أي DVI إطلاقاً). قيم ALLOW محايدة تماماً تضمن أن
// decideFinal يعتمد على compliance وحدها كمصدر قرار حاسم هنا — نفس السلوك
// الفعلي القديم بالضبط.
const NEUTRAL_DVI_FALLBACK: DviEvaluationResult = {
  indicatorType: 'DVI',
  dviBase: 0,
  score: 0,
  level: 'GREEN',
  causeClassification: 'DUST',
  decisionCategory: 'ALLOW',
  decisionLabelAr: 'مسموح — تشغيل اعتيادي',
  mandatoryStop: false,
  overridable: true,
  channels: {} as any,
  multipliers: {} as any,
  visibilityKm: null,
  effectiveWindKmh: null,
  visibilityConstraint: false,
  mandatoryVisibilityStop: false,
  respiratoryPPERequired: false,
  dustExposureHigh: false,
  outdoorWorkRestriction: false,
  triggeredRules: [],
  requiredActions: [],
  shortReason: '',
  topRiskDrivers: [],
  riskReducers: [],
  caveatsAr: [],
  confidenceScore: 100,
  confidenceLabel: 'عالية',
  validUntil: new Date().toISOString(),
};

// يحوّل صفاً مخزَّناً من final_decisions إلى الحقول الأربعة الوحيدة التي
// تقرأها applyFinalDecisionToAei فعلياً من decision (operationalDecision/
// shortReasonAr/decisionLabelAr/pendingConfirmation) — لا حاجة لبناء
// FinalDecision كامل هنا، فقط الحقول المُستهلَكة فعلياً.
function storedRowToPartialFinalDecision(row: any): Pick<FinalDecision, 'operationalDecision' | 'shortReasonAr' | 'decisionLabelAr' | 'pendingConfirmation'> {
  return {
    operationalDecision: row.operational_decision,
    shortReasonAr: row.short_reason_ar,
    decisionLabelAr: row.decision_label_ar,
    pendingConfirmation: row.pending_confirmation,
  };
}

// يُطبَّق بعد ربط compliance بكل عنصر dustResults في route.ts — يعدّل aei
// في مكانه (mutate) لتفادي إعادة بناء مصفوفة dustResults بالكامل هناك.
//
// خطأ معماري مكتشَف ومُصلَح (مراجعة كود خبير خارجي — "القرار النهائي لا
// يُحفظ كقرار رسمي واحد غير قابل للتعديل... البطاقة والخريطة والتنبيهات
// تعيد حساب القرار بمعرّفات مختلفة"): كانت هذه الدالة (تغذّي بطاقة AEI في
// صفحة المشروع) تستدعي decideFinal محلياً بمعزل تام — بمعرّف snapshotId
// مبني من activityGroupId/activityId، مختلف عن الصف الذي كتبه evaluate/
// route.ts فعلياً في final_decisions لنفس النشاط بنفس اللحظة تقريباً. بقية
// المسارات (summaryFromStoredDecision في [projectId]/route.ts، dashboard/
// global، viewer/dashboard، alerts/generate) هُوجِّرت جميعها لقراءة الصف
// المخزَّن بدل إعادة الحساب — بطاقة AEI وحدها بقيت الاستثناء الخامس.
//
// finalDecisionsByGroup اختياري: عند توفره (المسار الفعلي في [projectId]/
// route.ts بعد إضافة fetchLatestFinalDecisions قبل هذا الاستدعاء)، يُقرَأ
// القرار المخزَّن لكل activity_group_id بدل استدعاء decideFinal محلياً.
// عند غيابه (اختبارات هذا الملف، أو نشاط جديد لم يُقيَّم بعد عبر evaluate/
// route.ts فيغيب صفه المخزَّن) يبقى fallback الحساب المحلي كما كان — فشل
// آمن، لا يُسقِط تعديل AEI بأكمله.
export function applyComplianceGatesToDustAei(dustResults: any[], finalDecisionsByGroup?: Map<string, any>): void {
  (dustResults || []).forEach((r: any) => {
    if (!r?.aei) return;
    const storedRow = finalDecisionsByGroup?.get(r.activityGroupId);
    let decision: Pick<FinalDecision, 'operationalDecision' | 'shortReasonAr' | 'decisionLabelAr' | 'pendingConfirmation'>;
    if (storedRow) {
      decision = storedRowToPartialFinalDecision(storedRow);
    } else {
      const dvi: DviEvaluationResult = r.windowEval?.worst ?? NEUTRAL_DVI_FALLBACK;
      const finalInput = buildFinalDecisionInput(r.activityGroupId ?? r.activityId ?? 'unknown', dvi, r.compliance ?? null, r.aei);
      decision = decideFinal(finalInput);
    }
    r.aei = applyFinalDecisionToAei(r.aei, decision as FinalDecision, r.compliance ?? null);
  });
}

// -----------------------------------------------------------------------
// "القرار الموحد للنشاط" — غلاف رقيق حول decideFinal يحافظ على شكل
// UnifiedActivityDecision القديم (decisionLabelAr/shortReason/level/
// mandatoryStop/pendingConfirmation) لمستهلكيه الحاليين (summaryFromDust في
// app/api/projects/[projectId]/route.ts، حساب حالة نقطة الخريطة في
// dashboard/global وviewer/dashboard) بلا حاجة لتعديلهم — القرار الفعلي
// محسوب الآن بالكامل داخل decideFinal، لا هنا.
export interface UnifiedActivityDecision {
  decisionLabelAr: string;
  shortReason: string;
  level: string;
  mandatoryStop: boolean;
  overridable: boolean;
  // true فقط عند STOP_AFFECTED_ACTIVITY "معلَّق" بانتظار تأكيد استمرار
  // (compliance.pendingConfirmation)، لا مخالفة مؤكَّدة. تُستخدم في الواجهة
  // (MultiIndicatorActivityBox، Dustwidgetcard) لعرض حالة مؤقتة (برتقالي/
  // معلَّق) بدل "إيقاف إلزامي نظامي" القطعية (أسود) — القرار قد يتحول
  // تلقائياً لـALLOW أو MANDATORY_STOP بمجرد التقييم التالي.
  pendingConfirmation: boolean;
}

// ترتيب شدة موحَّد بين FinalDecision.level (6 درجات) وAeiColor (5 درجات،
// بلا DARK_RED) — يسمح بمقارنة مباشرة "أيهما أشد" بين المصدرين.
const UNIFIED_LEVEL_WEIGHT: Record<string, number> = {
  GREEN: 0,
  YELLOW: 1,
  ORANGE: 2,
  RED: 3,
  DARK_RED: 4,
  BLACK: 5,
};

export function computeUnifiedActivityDecision(
  dviWorst: DviEvaluationResult,
  compliance: DustComplianceResult | null,
  // خطأ مكتشَف ومُصلَح (مراجعة مستخدم — "تناقض بين البطاقات التي تصدر
  // قرارات: فوق تشغيل اعتيادي وتحت مع مراقبة"): decideFinal تبني level/
  // decisionLabelAr من dvi.level/dvi.decisionLabelAr مباشرة (لا aei إطلاقاً
  // — aei لا تُستهلَك داخل decideFinal نفسها). لكن evaluateAei (aei-engine)
  // تحسب safetyScore/qualityScore من dvi.score الرقمي المستمر بمعزل عن
  // dvi.decisionCategory الثنائي — فنشاط قد يكون DVI فيه 'ALLOW' نصياً
  // (decisionLabelAr='مسموح — تشغيل اعتيادي') بينما dvi.score>0 يكفي لخفض
  // AEI إلى MONITOR/'قابل للتنفيذ مع مراقبة' فعلياً. العنوان الأعلى
  // ("القرار الموحد للنشاط"، عبر summaryFromDust في route.ts) كان يعرض نص
  // decideFinal وحده بلا اطّلاع على aei، فيظهر "مسموح" أخضر فوق بطاقة AEI
  // "مع مراقبة" صفراء لنفس النشاط مباشرة — تناقض ظاهري صريح بين "بطاقتين
  // تصدران قرارات" رغم أن كليهما صحيح فعلياً من منظوره الخاص (تنظيمي مقابل
  // تشغيلي فيزيائي دقيق).
  //
  // الإصلاح: aei معامل ثالث اختياري — عند توفره، "الأشد يحكم" يُطبَّق بين
  // level النهائي من decideFinal وaei.color معاً (لا decideFinal وحدها)،
  // ونص/سبب aei يحل محل نص decideFinal إن كان aei هو الأشد فعلياً. غياب aei
  // (استدعاءات قديمة: dashboard/global، viewer/dashboard) يبقي السلوك بلا
  // تغيير تماماً — فشل آمن نحو الاعتماد على decideFinal وحدها كما كان.
  aei?: AeiEvaluationResult | null
): UnifiedActivityDecision {
  const decision = decideFinal(buildFinalDecisionInput('unified', dviWorst, compliance, aei ?? null));

  if (
    aei &&
    !decision.mandatoryStop &&
    !decision.pendingConfirmation &&
    UNIFIED_LEVEL_WEIGHT[aei.color] > UNIFIED_LEVEL_WEIGHT[decision.level]
  ) {
    return {
      decisionLabelAr: aei.statusLabelAr,
      shortReason: aei.shortReasonAr,
      level: aei.color,
      mandatoryStop: decision.mandatoryStop,
      overridable: decision.overridable,
      pendingConfirmation: decision.pendingConfirmation,
    };
  }

  return {
    decisionLabelAr: decision.decisionLabelAr,
    shortReason: decision.shortReasonAr,
    level: decision.level,
    mandatoryStop: decision.mandatoryStop,
    overridable: decision.overridable,
    pendingConfirmation: decision.pendingConfirmation,
  };
}

const STOPPED_DECISIONS = new Set(['MANDATORY_STOP', 'STOP_AFFECTED_ACTIVITY']);

// يحسب stopped_since الجديد بناءً على القرار السابق المخزَّن وقرار هذه
// اللحظة — بعكس updated_at (يتحدّث في كل كتابة، حتى لو نفس القرار)، هذا
// الحقل يبقى ثابتاً طالما النشاط ما زال موقِفاً بلا انقطاع، ولا يتغيّر إلا
// عند دخول/خروج فعلي من حالة الإيقاف:
// - لم يكن موقِفاً سابقاً والآن موقِف → بداية إيقاف جديدة (الآن).
// - كان موقِفاً وما زال موقِفاً → يبقى كما هو (previousStoppedSince).
// - غير موقِف الآن (تحسّن أو لم يكن أصلاً) → null (لا إيقاف مستمر).
export function computeStoppedSince(
  previousDecision: string | null | undefined,
  previousStoppedSince: string | null | undefined,
  newDecision: string
): string | null {
  const isNowStopped = STOPPED_DECISIONS.has(newDecision);
  if (!isNowStopped) return null;

  const wasStoppedBefore = previousDecision ? STOPPED_DECISIONS.has(previousDecision) : false;
  if (wasStoppedBefore && previousStoppedSince) return previousStoppedSince;

  return new Date().toISOString();
}

// يحسب pending_resume_since الجديد — منفصل تماماً عن stopped_since (راجع
// supabase-add-compliance-pending-resume-since-migration.sql للسبب
// الكامل). القرار المخزَّن (newDecision) يبقى STOP_AFFECTED_ACTIVITY طوال
// فترة الاستقرار (resumeHoldApplied=true)، فلا يمكن الاعتماد على تغيّر
// القرار نفسه لرصد بداية التحسّن — resumeHoldApplied هو الإشارة الوحيدة:
// - resumeHoldApplied=true ولا قيمة previous مسجَّلة → بداية استقرار جديدة (الآن).
// - resumeHoldApplied=true وقيمة previous موجودة → تبقى كما هي (لا تُعاد).
// - resumeHoldApplied=false → null (إما استؤنف فعلاً، أو ساءت القراءة من جديد،
//   أو لا قيد أصلاً — في كل الحالات لا "استقرار معلَّق" قائم الآن).
export function computePendingResumeSince(
  previousPendingResumeSince: string | null | undefined,
  resumeHoldApplied: boolean
): string | null {
  if (!resumeHoldApplied) return null;
  if (previousPendingResumeSince) return previousPendingResumeSince;
  return new Date().toISOString();
}

export async function persistDustComplianceEvaluations(
  supabaseAdmin: any,
  projectId: string,
  complianceResults: any[],
  triggeredBy: string
) {
  await Promise.all(
    (complianceResults || []).map(async (r) => {
      try {
        const newDecision = r.result?.decisionCategory ?? 'UNKNOWN';
        const resumeHoldApplied = Boolean(r.result?.resumeHoldApplied);

        const { data: existing } = await supabaseAdmin
          .from('current_dust_compliance_decisions')
          .select('decision, updated_at, stopped_since, pending_resume_since')
          .eq('activity_group_id', r.activityGroupId)
          .maybeSingle();

        const pendingResumeSince = computePendingResumeSince(existing?.pending_resume_since, resumeHoldApplied);
        // لا نتخطى الكتابة إن تغيّر pending_resume_since (بداية/نهاية استقرار
        // معلَّق) حتى لو بقي newDecision نفسه (STOP_AFFECTED_ACTIVITY طوال
        // فترة الاستقرار) — وإلا لن يُسجَّل بدء الاستقرار أبداً، فيبقى عداد
        // الـ10 دقائق بلا نقطة بداية صحيحة (نفس الخلل الذي نُصلحه هنا).
        const pendingResumeChanged = (existing?.pending_resume_since ?? null) !== pendingResumeSince;
        if (!pendingResumeChanged && shouldSkipPersist(existing?.decision, existing?.updated_at, newDecision)) return;

        const { data: inserted } = await supabaseAdmin
          .from('dust_compliance_evaluations')
          .insert({
            project_id: projectId,
            dust_profile_id: r.dustProfileId,
            activity_group_id: r.activityGroupId,
            result: r.result,
            rulebook_version: r.result?.rulebookVersion,
            triggered_by: triggeredBy,
          })
          .select('id')
          .single();

        const evaluationId = (inserted as any)?.id;
        if (!evaluationId) return;

        const stoppedSince = computeStoppedSince(existing?.decision, existing?.stopped_since, newDecision);

        // كتابة محميّة من التزامن (compare-and-swap) — نفس علة upsert الأعمى
        // المشروحة في persistDustEvaluations أعلاه، وأخطر هنا لأن الصف يحمل
        // stopped_since/pending_resume_since (عدّادات الإيقاف والاستئناف):
        // كتابة متأخرة من طلب أقدم كانت قد تُرجِع عدّاداً لقيمة سابقة.
        const nowIso = new Date().toISOString();
        const complianceRow = {
          activity_group_id: r.activityGroupId,
          project_id: projectId,
          latest_evaluation_id: evaluationId,
          decision: newDecision,
          triggered_rules: r.result?.triggeredRules ?? [],
          short_reason: r.result?.shortReasonAr ?? null,
          updated_at: nowIso,
          stopped_since: stoppedSince,
          pending_resume_since: pendingResumeSince,
          // كود القاعدة الفعلية التي بنت newDecision (راجع previousDecidingRuleCode
          // في types.ts) — يمكّن التقييم التالي من معرفة *سبب* هذا الإيقاف
          // بدقة، لا فئته العامة فقط (STOP_AFFECTED_ACTIVITY تُنتَج من عشرات
          // القواعد المختلفة، لا بوابة الرياح فقط).
          deciding_rule_code: r.result?.decidingRuleCode ?? null,
          stop_cause: r.result?.decidingRuleMessageAr ?? null,
        };
        if (existing?.updated_at) {
          await supabaseAdmin
            .from('current_dust_compliance_decisions')
            .update(complianceRow)
            .eq('activity_group_id', r.activityGroupId)
            .eq('updated_at', existing.updated_at);
        } else {
          await supabaseAdmin.from('current_dust_compliance_decisions').insert(complianceRow);
        }
      } catch (error) {
        console.error(`فشل حفظ تقييم امتثال الغبار للنشاط ${r.activityId}:`, error);
      }
    })
  );
}

// -----------------------------------------------------------------------
// final_decisions — لقطة واحدة موثوقة لكل قرار decideFinal (خطأ معماري
// مكتشَف ومُصلَح، مراجعة كود مدير — "FinalDecisionEngine ليس المصدر
// التشغيلي الوحيد فعلياً"): decideFinal كانت تُستدعى بمعزل تام من 4 مسارات
// (البانر عبر computeUnifiedActivityDecision، dashboard/global/route.ts،
// viewer/dashboard/route.ts، alerts/generate/route.ts) — كل مسار يُعيد
// بناء dvi/compliance/aei ويستدعيها بنفسه بمعرّف snapshotId مختلف تماماً،
// بلا أي تخزين للنتيجة الفعلية ولا decisionId واحد يربط كل تلك الواجهات
// بنفس القرار بالضبط. أربع إعادات حساب مستقلة = أربع نقاط تناقض محتملة.
//
// الإصلاح: نقطة كتابة واحدة هنا (تُستدعى من evaluate/route.ts فقط، بعد
// persistDustComplianceEvaluations مباشرة) تحسب decideFinal مرة واحدة لكل
// مجموعة نشاط وتخزّنها في final_decisions (append-only). id الصف المُدرَج
// يصبح decisionId الموحَّد؛ المسارات الأربعة تُحوَّل (راجع استدعاءاتها) لتقرأ
// آخر صف مخزَّن هنا بدل إعادة الحساب محلياً — قراءة واحدة بدل 4 حسابات.
export async function persistFinalDecisions(
  supabaseAdmin: any,
  projectId: string,
  dustResults: any[],
  complianceResults: any[]
) {
  const complianceByActivityId = new Map<string, any>(
    (complianceResults || []).map((r: any) => [r.activityId, r])
  );

  await Promise.all(
    (dustResults || []).map(async (r: any) => {
      try {
        if (!r?.aei) return;
        const complianceEntry = complianceByActivityId.get(r.activityId);
        const compliance: DustComplianceResult | null = complianceEntry?.result ?? null;
        const dvi: DviEvaluationResult = r.windowEval?.worst ?? NEUTRAL_DVI_FALLBACK;

        const finalInput = buildFinalDecisionInput(
          r.activityGroupId ?? r.activityId ?? 'unknown',
          dvi,
          compliance,
          r.aei
        );
        const decision = decideFinal(finalInput);

        await supabaseAdmin.from('final_decisions').insert({
          project_id: projectId,
          activity_group_id: r.activityGroupId,
          dust_profile_id: r.activityId ?? null,
          mode: decision.mode,
          operational_decision: decision.operationalDecision,
          regulatory_finding: decision.regulatoryFinding,
          mandatory_stop: decision.mandatoryStop,
          overridable: decision.overridable,
          short_reason_ar: decision.shortReasonAr,
          decision_label_ar: decision.decisionLabelAr,
          level: decision.level,
          pending_confirmation: decision.pendingConfirmation,
          reason_codes: decision.reasonCodes,
          evidence_quality: decision.evidenceQuality,
          rule_bundle_version: decision.ruleBundleVersion,
          evaluated_at: finalInput.evaluatedAt,
        });
      } catch (error) {
        console.error(`فشل حفظ القرار النهائي للنشاط ${r.activityId}:`, error);
      }
    })
  );
}

// يجلب آخر قرار نهائي مخزَّن لكل activity_group_id مطلوب — القراءة
// الموحَّدة الوحيدة التي يجب أن تستخدمها كل الواجهات (البانر، الخريطة
// العامة، لوحة المراقب، مولّد التنبيهات) بدل إعادة استدعاء decideFinal
// محلياً بمدخلات قد تختلف طفيفاً بين مسار وآخر. يُرجع خريطة فارغة بصمت عند
// أي فشل استعلام (فشل آمن — المستدعي يتعامل مع الغياب كـ"لا قرار مخزَّن
// بعد"، لا خطأً قاطعاً).
export async function fetchLatestFinalDecisions(
  supabaseAdmin: any,
  activityGroupIds: string[]
): Promise<Map<string, any>> {
  const map = new Map<string, any>();
  const ids = Array.from(new Set((activityGroupIds || []).filter(Boolean)));
  if (ids.length === 0) return map;

  try {
    const { data } = await supabaseAdmin
      .from('final_decisions')
      .select('*')
      .in('activity_group_id', ids)
      .order('created_at', { ascending: false });
    for (const row of data || []) {
      if (!map.has(row.activity_group_id)) map.set(row.activity_group_id, row);
    }
  } catch {
    // فشل الاستعلام لا يُسقط المستدعي — نفس مبدأ resolveFreshProjectDevice.
  }
  return map;
}
