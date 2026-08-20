// تقييم الغبار والامتثال التنظيمي المشترك — نسخة DCR من craneEvaluation.ts
// الأصلي في مرقاب، مقتصرة على الدوال الخاصة بالغبار (DVI)/الامتثال
// التنظيمي/AEI فقط. لا رافعات ولا حرارة في DCR إطلاقاً.
import { createHash } from 'node:crypto';
import {
  evaluateDustVisibilityWindow,
  evaluateDustVisibilityWorkDayHourly,
  evaluateLiveOperationalDecision,
} from '@/app/utils/dust-engine';
import type { DustEngineInput, DustWindowEvaluation } from '@/app/utils/dust-engine/types';
import { evaluateAei } from '@/app/utils/aei-engine';
import type { AeiEvaluationResult } from '@/app/utils/aei-engine/types';
import { AEI_RESTRICT_CAP } from '@/app/utils/aei-engine/tables';
import { evaluateDustCompliance, buildComplianceContext, isRegulatoryWindGateActive, BATCHING_PM10_FILTER_MIN_PERCENT } from '@/app/utils/dust-compliance-engine';
import { ACTIVE_RULE_BUNDLE } from '@/app/utils/rule-bundles/riyadh-dust';
import { LIVE_FIELD_FRESHNESS_MS, DEVICE_CONNECTION_FRESHNESS_MS } from '@/app/utils/rule-bundles/field-freshness';
import { receptorsWithinRadiusM, UNIT_RECEPTOR_RADIUS_M } from '@/app/utils/dust-compliance-engine/geo';
import type { ReceptorWithinRadius } from '@/app/utils/dust-compliance-engine/geo';
import type { SensitiveReceptor } from '@/app/utils/dust-compliance-engine/types';
import type { DustComplianceResult, WindDirectionEvidence } from '@/app/utils/dust-compliance-engine/types';
import { decideFinal, buildFinalDecisionInput } from '@/app/utils/final-decision-engine';
import type { FinalDecision } from '@/app/utils/final-decision-engine';
import type { DviEvaluationResult, DviHourlyEvaluation } from '@/app/utils/dust-engine/types';
import type { SupabaseClient } from '@supabase/supabase-js';

// صف project الخام (Supabase select('*'), لا Database types مُولَّدة في هذا
// المشروع) — الحقول الفعلية المقروءة عبر مستهلكي هذا الملف (مثال:
// ProjectHeader.tsx). [key: string]: unknown يستوعب أي عمود إضافي بلا حاجة
// لتعداد كل عمود project هنا.
export interface ProjectRow {
  id: string;
  name?: string | null;
  city?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  terrain_type?: string | null;
  dust_causing_activities?: unknown;
  exposed_dust_area_size?: unknown;
  unpaved_roads_length?: unknown;
  heavy_machinery_count?: unknown;
  trucks_per_day?: unknown;
  is_near_public_road?: unknown;
  is_near_sensitive_areas?: unknown;
  dust_mitigation_measures?: unknown;
  has_concrete_curing_plan?: unknown;
  can_advance_pouring_time?: unknown;
  work_hours_start?: unknown;
  work_hours_end?: unknown;
  shifts?: unknown;
  work_days_list?: unknown;
  zone_type?: unknown;
  zone_polygon?: unknown;
  zone_radius_m?: unknown;
  [key: string]: unknown;
}

// صف project_dust_profiles الخام (Supabase select('*') مع فلترة زمنية/
// نشاط لاحقة عبر مستهلكي هذا الملف) — الحقول الفعلية المقروءة عبر
// buildDustInput/computeDustResults/computeDustComplianceResults وبقية
// دوال هذا الملف. [key: string]: unknown يستوعب أي عمود إضافي (مثال: أعمدة
// محطة الكسارة/الخلط المشروطة بـregulatory_activity) بلا تعداد كامل هنا —
// نفس فلسفة ProjectRow أعلاه بالضبط.
export interface DustActivityRow {
  id: string | number;
  project_id?: string;
  activity_group_id?: string | null;
  created_at?: string;
  activity_lat?: number | null;
  activity_lng?: number | null;
  device_id?: string | null;
  planned_date?: string | null;
  planned_time?: string | null;
  duration_hours?: number | null;
  /** ساعات الدوام اليومي وحدها (بمعزل عن duration_hours الإجمالية عبر كل
   * أيام النشاط) — راجع migration 202608110012 وisDustProfileWithinDailyWindow
   * أدناه. null لصفوف قديمة/أنشطة بيوم واحد حيث لا فرق عن duration_hours. */
  daily_duration_hours?: number | null;
  is_dust_generating?: boolean;
  is_enclosed_operation?: boolean;
  regulatory_activity?: string;
  silos_sealed?: boolean;
  pm10_filter_efficiency_percent?: number | null;
  crusher_lat?: number | null;
  crusher_lng?: number | null;
  batching_lat?: number | null;
  batching_lng?: number | null;
  [key: string]: unknown;
}

// عنصر نتيجة محرك الغبار الفعلي المُعاد من computeDustResults أدناه —
// راجع return { ... } داخل تلك الدالة لنفس الشكل بالضبط.
export interface DustResultItem {
  activityGroupId: string;
  activityId: string;
  regulatoryActivity: DustEngineInput['regulatoryActivity'];
  windowEval: DustWindowEvaluation;
  aei: AeiEvaluationResult;
  hourlyForecasts: unknown[];
  startIso: string;
  compliance?: DustComplianceResult | null;
  unitReceptors?: unknown[];
  complianceHourly?: unknown[];
  [key: string]: unknown;
}

// شكل عنصر النتيجة المُعاد من computeDustComplianceResults أدناه
// (activityGroupId/activityId/dustProfileId + النتيجة الجاهزة).
export interface DustComplianceResultItem {
  activityGroupId?: string;
  activityId: string;
  dustProfileId?: string | number;
  result: DustComplianceResult;
}

// صف final_decisions المخزَّن (Supabase select('*')) — الحقول الفعلية
// المقروءة منه عبر مستهلكي fetchLatestFinalDecisions فقط، [key: string]:
// unknown يستوعب أي عمود إضافي بلا تعداد كامل هنا.
export interface StoredFinalDecisionRow {
  activity_group_id: string;
  decision_label_ar: string;
  level: string;
  short_reason_ar?: string | null;
  operational_decision: FinalDecision['operationalDecision'];
  pending_confirmation: boolean;
  mandatory_stop: boolean;
  [key: string]: unknown;
}

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

// نفس ترتيب/تسمية WEEK_DAY_IDS في AddActivityModal/index.tsx (مصدر الحقيقة
// الوحيد لهذا الترتيب) — مُعاد تعريفها هنا محلياً (لا استيراد مباشر بين
// خادم/واجهة، نفس اتفاقية field-freshness.ts) لتحديد يوم الأسبوع (0=أحد)
// المطابق لـ project.work_days_list.
const WEEK_DAY_IDS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

// يحوّل تاريخ نصي YYYY-MM-DD إلى معرّف يوم أسبوع ('sun'..'sat') — مبني على
// Date.UTC صراحة (لا new Date(dateStr) الذي يعتمد على منطقة زمنية النظام
// المُشغِّل) حتى يُعطي نفس النتيجة بصرف النظر عن منطقة سيرفر Vercel الزمنية.
function weekDayIdFromDateStr(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  return WEEK_DAY_IDS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

function addDaysToDateStr(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + days));
  return next.toISOString().slice(0, 10);
}

// خطأ مكتشَف ومُصلَح (المستخدم سأل: "نشاط 3 أيام بدوام 8 ساعات، هل يُحتسب
// من وقت العمل فقط؟"): كل مكان كان يحسب "متى ينتهي النشاط" كـ
// planned_date+planned_time + duration_hours الإجمالية كفترة واحدة متصلة
// بلا انقطاع ليلي — نشاط 8ص-4م لثلاثة أيام (duration_hours=24) كان يُعتبر
// "جارياً" طوال الليل بين الأيام أيضاً، لا فقط خلال ساعات الدوام الفعلية.
// هذه الدالة تحسب النافذة اليومية المتكررة الصحيحة: تُشتق أيام النشاط
// الفعلية من duration_hours÷daily_duration_hours (عدد أيام العمل التي
// حُسبت أصلاً وقت الإنشاء، راجع computeDurationHours في
// AddActivityModal/index.tsx)، ثم يُحسَب آخر يوم عمل فعلي بعدّ الأيام ضمن
// work_days_list ابتداءً من planned_date؛ أخيراً يُتحقَّق أن "الآن" يقع
// ضمن مدى [planned_date, آخر يوم] وأن اليوم الحالي من أيام العمل وأن
// الوقت الحالي (بتوقيت الرياض) يقع ضمن [planned_time, planned_time+
// daily_duration_hours] لهذا اليوم تحديداً.
//
// fallback آمن لكل الحالات الناقصة (daily_duration_hours غياب/=0،
// work_days_list فارغة، إلخ): يُعامَل النشاط كفترة واحدة متصلة من
// planned_date+planned_time بطول duration_hours كاملة — نفس السلوك القديم
// بلا تغيير، مطابق تماماً لكل الأنشطة الحالية في الإنتاج (كلها يوم واحد).
export function isDustProfileWithinDailyWindow(
  row: { planned_date?: string | null; planned_time?: string | null; duration_hours?: number | null; daily_duration_hours?: number | null },
  workDaysList: string[] | null | undefined,
  nowMs: number
): boolean {
  const { planned_date, planned_time, duration_hours, daily_duration_hours } = row;
  if (!planned_date || !planned_time || !duration_hours) return true; // بيانات ناقصة — فشل آمن نحو عدم الاستبعاد

  // fallback: بلا daily_duration_hours صالحة، أو أيام عمل غير معرَّفة —
  // فترة متصلة واحدة (السلوك القديم بلا تغيير).
  if (!daily_duration_hours || daily_duration_hours <= 0 || !Array.isArray(workDaysList) || workDaysList.length === 0) {
    const startIso = riyadhLocalToUtcIso(planned_date, planned_time);
    if (!startIso) return true;
    const endMs = new Date(startIso).getTime() + duration_hours * 3600000;
    return nowMs >= new Date(startIso).getTime() && nowMs <= endMs;
  }

  const activeDaysCount = Math.max(1, Math.round(duration_hours / daily_duration_hours));

  // يوم الأسبوع الحالي بتوقيت الرياض — nowMs هو UTC epoch، نضيف أوفست
  // الرياض قبل استخراج تاريخ اليوم المحلي منه.
  const nowRiyadhDateStr = new Date(nowMs + RIYADH_UTC_OFFSET_MINUTES * 60000).toISOString().slice(0, 10);

  // نمشي يوماً بيوم من planned_date، نعدّ أيام العمل فقط، حتى نجمع
  // activeDaysCount يوماً — نتحقق في كل يوم عمل هل هو نفس يوم "الآن"
  // بالرياض، وإن كان كذلك نفحص النافذة الساعية لذلك اليوم تحديداً.
  let countedDays = 0;
  const maxDaysToScan = 370; // نفس حد الأمان في countActiveDaysInRange بالواجهة
  for (let i = 0; i < maxDaysToScan && countedDays < activeDaysCount; i++) {
    const dateStr = addDaysToDateStr(planned_date, i);
    if (!workDaysList.includes(weekDayIdFromDateStr(dateStr))) continue;
    countedDays++;
    if (dateStr !== nowRiyadhDateStr) continue;
    const dayStartIso = riyadhLocalToUtcIso(dateStr, planned_time);
    if (!dayStartIso) return false;
    const dayStartMs = new Date(dayStartIso).getTime();
    const dayEndMs = dayStartMs + daily_duration_hours * 3600000;
    return nowMs >= dayStartMs && nowMs <= dayEndMs;
  }
  return false; // "الآن" لا يقع في أي يوم عمل ضمن مدى النشاط
}

// يحسب تاريخ آخر يوم عمل فعلي للنشاط (نهاية مداه الكلي عبر كل الأيام)،
// بعدّ activeDaysCount يوم عمل ضمن work_days_list ابتداءً من planned_date
// — نفس منطق عدّ الأيام في isDustProfileWithinDailyWindow أعلاه، لكن بلا
// حاجة لمطابقة "الآن" (يُستخدَم فقط لمعرفة "متى ينتهي مدى النشاط بالكامل"،
// لا "هل جارٍ الآن بالضبط"). null إن تعذّر الحساب (بيانات ناقصة).
function computeLastActiveDateStr(
  plannedDate: string,
  durationHours: number,
  dailyDurationHours: number,
  workDaysList: string[]
): string | null {
  const activeDaysCount = Math.max(1, Math.round(durationHours / dailyDurationHours));
  let countedDays = 0;
  const maxDaysToScan = 370;
  for (let i = 0; i < maxDaysToScan; i++) {
    const dateStr = addDaysToDateStr(plannedDate, i);
    if (!workDaysList.includes(weekDayIdFromDateStr(dateStr))) continue;
    countedDays++;
    if (countedDays === activeDaysCount) return dateStr;
  }
  return null;
}

// خطأ مكتشَف ومُصلَح (تكملة لنفس الإصلاح أعلاه — لكن لغرض مختلف: استبعاد
// نشاط انتهى مداه الكلي بالكامل من دورة تقييم evaluateProject، لا مطابقة
// "جارٍ الآن بالضبط"): نشاط 8ص-4م لثلاثة أيام يجب أن يبقى مؤهَّلاً للتقييم
// طوال الأيام الثلاثة (حتى في الساعة 11م بين يومين، سيُستأنف صباحاً)، لا
// يُستبعَد إلا بعد انتهاء آخر يوم عمل فعلياً. fallback لكل الحالات الناقصة
// مطابق تماماً لـisDustProfileWithinDailyWindow (فترة متصلة واحدة).
export function hasDustProfileWindowEnded(
  row: { planned_date?: string | null; planned_time?: string | null; duration_hours?: number | null; daily_duration_hours?: number | null },
  workDaysList: string[] | null | undefined,
  nowMs: number
): boolean {
  const { planned_date, planned_time, duration_hours, daily_duration_hours } = row;
  if (!planned_date || !planned_time || !duration_hours) return false;

  if (!daily_duration_hours || daily_duration_hours <= 0 || !Array.isArray(workDaysList) || workDaysList.length === 0) {
    const startIso = riyadhLocalToUtcIso(planned_date, planned_time);
    if (!startIso) return false;
    const endMs = new Date(startIso).getTime() + duration_hours * 3600000;
    return nowMs > endMs;
  }

  const lastActiveDateStr = computeLastActiveDateStr(planned_date, duration_hours, daily_duration_hours, workDaysList);
  if (!lastActiveDateStr) return false; // تعذّر الحساب — فشل آمن نحو عدم الاستبعاد
  const lastDayStartIso = riyadhLocalToUtcIso(lastActiveDateStr, planned_time);
  if (!lastDayStartIso) return false;
  const lastDayEndMs = new Date(lastDayStartIso).getTime() + daily_duration_hours * 3600000;
  return nowMs > lastDayEndMs;
}

// يحوّل صفوف project_shifts الخام (project.shifts، مرفقة في GET
// /api/projects/[projectId] من جدول project_shifts) إلى الشكل الذي يقبله
// DustEngineInput.shifts — undefined إن لم تُعرَّف أي ورديات، فيسلك المحرك
// مساره القديم (نافذة work_hours واحدة).
function buildEngineShifts(project: ProjectRow): { startTime: string; endTime: string }[] | undefined {
  const shifts = project.shifts;
  if (!Array.isArray(shifts) || shifts.length === 0) return undefined;
  return shifts.map((s: { start_time: unknown; end_time: unknown }) => ({
    startTime: String(s.start_time).slice(0, 5),
    endTime: String(s.end_time).slice(0, 5),
  }));
}

// قراءة جهاز حديثة يجهّزها resolveFreshProjectDevice أدناه — شكل مبسّط
// (الحقول last_* المهمة فقط) يُمرَّر لـ buildDustInput.
export interface FreshDeviceReading {
  // خطأ حرج مكتشَف ومُصلَح (مراجعة كود خارجي — "اتجاه الرياح يُستخدم دون
  // توثيق الشمال الحقيقي"): معرّف الجهاز نفسه، مطلوب لبناء
  // WindDirectionEvidence (resolveWindDirectionEvidence أدناه) — يحتاج
  // معرفة أي جهاز بالذات أنتج last_wind_direction_deg ليقرأ توثيق معايرته
  // الخاص (true_north_* على project_devices)، لا مجرد القيمة الخام بمعزل
  // عن مصدرها.
  deviceId: string;
  // توثيق معايرة الشمال الحقيقي لهذا الجهاز تحديداً (migration
  // 202608190002) — يُقرأ من project_devices مباشرة، لا من device_metric_
  // latest (القيم التالية ثابتة على الجهاز، لا مقياساً متغيراً بمرور
  // الوقت). undefined فقط لاستدعاءات قديمة/اختبارات لا تمرر هذه الحقول
  // (توافقي — resolveWindDirectionEvidence تُعامله كـUNVERIFIED، فشل آمن).
  trueNorthAlignmentDocumented?: boolean | null;
  trueNorthAlignmentType?: 'TRUE_NORTH' | 'MAGNETIC_NORTH' | null;
  trueNorthVerificationMethod?: string | null;
  trueNorthVerifiedBy?: string | null;
  trueNorthVerifiedAt?: string | null;
  trueNorthDeviationDeg?: number | null;
  trueNorthEvidenceUrl?: string | null;
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
  // خطأ مكتشَف ومُصلَح (مراجعة كود خبير خارجي — H-05: "حداثة القياسات
  // مشتركة جزئياً"): نفس مبدأ last_pm10_at بالضبط، مطبَّق على بقية الحقول —
  // راجع supabase-add-device-per-field-timestamps-migration.sql. تُستهلَك
  // الآن أيضاً في buildDustInput أدناه (تمرَّر لـDustEngineInput.device*At
  // فتدخل بوابة الحداثة الفعلية في dust-engine/engine.ts — راجع مراجعة خبير
  // خارجي لاحقة: "PM2.5/الحرارة/الرطوبة قد تدخل القرار دون نفس الاستبعاد")،
  // لا للعرض فقط كما كانت (باستثناء last_pm10_at نفسه، الذي يبقى للعرض فقط
  // — PM10 له آلية حداثة/استمرار مستقلة تماماً، راجع devicePm10LastReadingAt
  // في dust-engine/types.ts).
  last_wind_speed_at: string | null;
  last_wind_gust_at: string | null;
  last_wind_direction_at: string | null;
  last_visibility_at: string | null;
  last_pm25_at: string | null;
  last_relative_humidity_at: string | null;
  last_temperature_at: string | null;
}

// خطأ حرج مكتشَف ومُصلَح (مراجعة كود خارجي — "اتجاه الرياح يُستخدم دون
// توثيق الشمال الحقيقي"): يبني WindDirectionEvidence من الجهاز المرتبط
// (إن وُجد) واتجاه الرياح الخام المدموج (merged.windDirectionDeg) — يفصل
// صراحة "القيمة الخام كما وردت" عن "القيمة المستخدَمة فعلياً في تحليل
// الانتشار المكاني"، التي تبقى null إلا حين تكون المحاذاة موثَّقة فعلياً
// (TRUE_NORTH موثَّق ومطبَّق، لا مجرد "موجود"). لا تستبدل اتجاهاً غير موثَّق
// تلقائياً بتقدير Open-Meteo أو أي مصدر آخر — تعيد null صراحة، فتُعطِّل
// nearestDownwindReceptorDistanceM (geo.ts) تفعيل قاعدة المستقبل باتجاه
// الرياح بدل تفعيلها بقيمة قد تكون خاطئة.
function normalizeDirectionDeg(value: number): number {
  return ((value % 360) + 360) % 360;
}

export function resolveWindDirectionEvidence(
  device: FreshDeviceReading | null,
  rawDeg: number | null,
  // مصدر الاتجاه الفعلي كما دمجه mergeDustReading (dust-engine/engine.ts:
  // merged.sources.windDirectionDeg) — 'device' فقط يعني أن هذا الجهاز
  // تحديداً هو من أنتج rawDeg، فتوثيقه ذو صلة. مصدر آخر (weather/onsite) لا
  // علاقة له بمعايرة أي جهاز إطلاقاً، حتى لو وُجد جهاز مرتبط بالنشاط.
  source: 'device' | 'weather' | 'onsite' | 'none' = 'none'
): WindDirectionEvidence {
  if (rawDeg === null) {
    return {
      rawDeg: null,
      directionForAnalysisDeg: null,
      quality: 'UNAVAILABLE',
      source: 'NONE',
      deviceId: null,
      trueNorthDocumented: false,
      alignmentType: null,
      verifiedAt: null,
      verifiedBy: null,
      verificationMethod: null,
      deviationDeg: null,
      evidenceUrl: null,
    };
  }

  const isFromDevice = source === 'device';
  const verified =
    isFromDevice &&
    device?.trueNorthAlignmentDocumented === true &&
    device?.trueNorthAlignmentType === 'TRUE_NORTH' &&
    typeof device?.trueNorthVerifiedAt === 'string';

  const evidenceSource: WindDirectionEvidence['source'] =
    source === 'device' ? 'DEVICE' : source === 'weather' ? 'FORECAST' : source === 'onsite' ? 'MANUAL' : 'NONE';

  return {
    rawDeg: normalizeDirectionDeg(rawDeg),
    directionForAnalysisDeg: verified ? normalizeDirectionDeg(rawDeg) : null,
    quality: verified ? 'VERIFIED' : 'UNVERIFIED',
    source: evidenceSource,
    deviceId: isFromDevice ? device?.deviceId ?? null : null,
    trueNorthDocumented: verified,
    alignmentType: isFromDevice && (device?.trueNorthAlignmentType === 'TRUE_NORTH' || device?.trueNorthAlignmentType === 'MAGNETIC_NORTH')
      ? device.trueNorthAlignmentType
      : null,
    verifiedAt: isFromDevice ? device?.trueNorthVerifiedAt ?? null : null,
    verifiedBy: isFromDevice ? device?.trueNorthVerifiedBy ?? null : null,
    verificationMethod: isFromDevice ? device?.trueNorthVerificationMethod ?? null : null,
    deviationDeg: isFromDevice ? device?.trueNorthDeviationDeg ?? null : null,
    evidenceUrl: isFromDevice ? device?.trueNorthEvidenceUrl ?? null : null,
  };
}

// طلب مستخدم صريح (توحيد كامل): التسعة قيم هي الوحيدة الممكنة لـ
// regulatory_activity الآن — الواجهة (AddActivityModal) وschema الـAPI
// (app/api/dust-profiles/route.ts) يفرضان الاختيار من REGULATORY_ACTIVITY_
// OPTIONS قبل أي إنشاء، ولا توجد صفوف قديمة ناقصة لهذا الحقل. لا حاجة لفحص/
// fallback بعد الآن — يُقرأ مباشرة كقيمة مضمونة من التسعة.
function toRegulatoryDustActivityKey(value: string | undefined): DustEngineInput['regulatoryActivity'] {
  return value as DustEngineInput['regulatoryActivity'];
}

// طلب مستخدم صريح: hasEarthworks/internalDirtRoads/looseMaterials
// (DustSiteInputs) لا مسار واجهة فعلي يملأها — قسم "إجراءات التحكم
// المتوفرة" في DustStep.tsx معطَّل بالكامل (SHOW_CONTROL_MEASURES_SECTION
// = false) ولا يضم أصلاً checkbox لهذه الثلاثة تحديداً (DUST_CONTROL_
// CHECKBOXES تغطي إجراءات التخفيف الستة فقط: رش/تغطية/سرعة/غسيل/شاشات/
// مراقبة، لا مصادر الغبار الداخلية هذه). القيمة كانت دائماً false ثابتة من
// project_dust_profiles، فيتعطل عملياً الشرط الثاني لـDVI-PM10-ACTION-003
// (pm10≥150 مع مصدر غبار داخلي واضح) لكل الأنشطة التسعة. الحل: اشتقاق
// تلقائي من regulatory_activity نفسه (نوع النشاط يحدد طبيعة مصدر الغبار
// بدقة أعلى من هذه الفئات العامة الثلاث أصلاً) — بلا حاجة لسؤال المستخدم:
//   EARTHWORKS: حفريات مباشرة (حفر/ردم/تسوية) — تعريفه الحرفي.
//   SITE_TRAFFIC: شاحنات على طرق داخلية غالباً غير مسفلتة.
//   MATERIAL_HANDLING_STOCKPILE/CD_WASTE_TRANSPORT: أكوام/حمولة مكشوفة —
//     نفس تعليق "حمولة مكشوفة" في ACTIVITY_SENSITIVITY (tables.ts) لكلا النشاطين.
//   الباقي (CRUSHER/DEMOLITION/BATCHING_PLANT/STONE_CUTTING/IDLE_SURFACE):
//     مصدر غبارهم مغطى أصلاً بحساسية النشاط الخاصة بهم (ACTIVITY_SENSITIVITY)،
//     لا علاقة له بحفريات/طرق ترابية/مواد سائبة عامة.
// || مع قيمة العمود الخام: لا يُسقِط أي قيمة true يدوية مستقبلية لو أُضيف
// مسار واجهة لاحقاً لهذه الحقول تحديداً — فقط يضمن حداً أدنى منطقياً الآن.
//
// طلب مستخدم صريح (نفس الفجوة، حقل رابع): heavyEquipmentMovement (حركة
// معدات ثقيلة كثيفة) لا مسار واجهة له هو الآخر — بخلاف largeExposedArea/
// drySurface (خصائص موقع فيزيائية بحتة، حُذفتا نهائياً من siteDustGenerationRisk
// لعدم إمكانية اشتقاقهما منطقياً من نوع النشاط)، حركة المعدات الثقيلة صفة
// حقيقية لطبيعة نشاط معيّن — الأنشطة التي تتضمن معدات ثقيلة كثيفة فعلياً:
//   CRUSHER: معدات تكسير ثقيلة تعمل باستمرار.
//   DEMOLITION: معدات هدم ثقيلة (حفارات هدم، شاحنات نقل ركام).
//   EARTHWORKS: حفارات/بلدوزرات — معدات ثقيلة بطبيعة العمل الترابي.
//   CD_WASTE_TRANSPORT: شاحنات نقل ثقيلة.
//   MATERIAL_HANDLING_STOCKPILE: لوادر/رافعات لمناولة الأكوام.
// الباقي (SITE_TRAFFIC/BATCHING_PLANT/STONE_CUTTING/IDLE_SURFACE) بلا حركة
// معدات ثقيلة كثيفة مميِّزة لطبيعة النشاط نفسه.
export function deriveInternalDustSourceFromActivity(regulatoryActivity: DustEngineInput['regulatoryActivity']) {
  return {
    hasEarthworksFromActivity: regulatoryActivity === 'EARTHWORKS',
    internalDirtRoadsFromActivity: regulatoryActivity === 'SITE_TRAFFIC',
    looseMaterialsFromActivity:
      regulatoryActivity === 'MATERIAL_HANDLING_STOCKPILE' || regulatoryActivity === 'CD_WASTE_TRANSPORT',
    heavyEquipmentMovementFromActivity:
      regulatoryActivity === 'CRUSHER' ||
      regulatoryActivity === 'DEMOLITION' ||
      regulatoryActivity === 'EARTHWORKS' ||
      regulatoryActivity === 'CD_WASTE_TRANSPORT' ||
      regulatoryActivity === 'MATERIAL_HANDLING_STOCKPILE',
  };
}

export function buildDustInput(row: DustActivityRow, project: ProjectRow, freshDevice?: FreshDeviceReading | null): DustEngineInput {
  const regulatoryActivity = toRegulatoryDustActivityKey(row.regulatory_activity);
  const {
    hasEarthworksFromActivity,
    internalDirtRoadsFromActivity,
    looseMaterialsFromActivity,
    heavyEquipmentMovementFromActivity,
  } = deriveInternalDustSourceFromActivity(regulatoryActivity);
  return {
    regulatoryActivity,
    // موقع النشاط المستقل (محدد يدوياً داخل zone المشروع) له الأولوية على
    // موقع المشروع المركزي — يُستخدم فعلياً في جلب طقس هذه النقطة تحديداً.
    // fallback لموقع المشروع فقط لأنشطة قديمة محفوظة قبل هذه الميزة.
    latitude: typeof row.activity_lat === 'number' ? row.activity_lat : (project.latitude ?? 0),
    longitude: typeof row.activity_lng === 'number' ? row.activity_lng : (project.longitude ?? 0),
    site: {
      hasEarthworks: !!row.has_earthworks || hasEarthworksFromActivity,
      internalDirtRoads: !!row.internal_dirt_roads || internalDirtRoadsFromActivity,
      heavyEquipmentMovement: !!row.heavy_equipment_movement || heavyEquipmentMovementFromActivity,
      looseMaterials: !!row.loose_materials || looseMaterialsFromActivity,
      surfaceWet: !!row.surface_wet,
      receptorType: row.receptor_type as DustEngineInput['site']['receptorType'],
      receptorDistance: row.receptor_distance as DustEngineInput['site']['receptorDistance'],
      // تدقيق مكتشَف (مراجعة كود خارجي — "اتجاه الرياح يُستخدم دون توثيق
      // الشمال الحقيقي"، البند ح): row.receptor_is_downwind تصنيف يدوي/
      // تخطيطي بحت — إقرار ثابت وحيد من المستخدم وقت إنشاء النشاط (حقل
      // project_dust_profiles.receptor_is_downwind، لا حساب حي)، وليس
      // إقراراً بأن "المستقبل باتجاه الرياح الآن" بالمعنى اللحظي. لا صلة له
      // إطلاقاً بـWindDirectionEvidence/resolveWindDirectionEvidence (محرك
      // الامتثال، dust-compliance-engine) — الأخير مستقل تماماً ويُقيَّد
      // فعلاً بجودة التوثيق (VERIFIED/UNVERIFIED). هذا الحقل يُمرَّر إلى DVI
      // فقط (مضاعف حساسية المستقبل + نص أسباب الخطر، dust-engine/engine.ts)
      // ولا يُشتَق أو يُحدَّث تلقائياً من last_wind_direction_deg أي محطة —
      // لا خطر حالياً أن "يتسرب" اتجاه غير موثَّق إليه. تحذير لأي تعديل
      // مستقبلي: إن رُبط هذا الحقل يوماً بقراءة محطة حية بدل الإدخال اليدوي،
      // يجب حينها ضبطه صراحة إلى false عند quality!=='VERIFIED' (راجع
      // WindDirectionEvidence في dust-compliance-engine/types.ts) — لا يجوز
      // لاتجاه محطة غير موثَّق أن يُنتج receptorIsDownwind=true أبداً.
      receptorIsDownwind: !!row.receptor_is_downwind,
      visibleDustPlumeReported: !!row.visible_dust_plume_reported,
      openConcretePour: !!row.open_concrete_pour,
    },
    onsiteVisibilityM: (row.onsite_visibility_m as number | null | undefined) ?? null,
    onsitePm10: (row.onsite_pm10 as number | null | undefined) ?? null,
    onsitePm25: (row.onsite_pm25 as number | null | undefined) ?? null,
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
    // القسم 5.3/18.3: وقت رصد مستقل لكل حقل حاسم — يُستهلَك في
    // buildDeviceMergedReading (dust-engine/engine.ts) لإسقاط قيمة أقدم من
    // 4 دقائق بمعزل عن حداثة أي حقل آخر (راجع last_wind_speed_at/
    // last_visibility_at في METRIC_LATEST_FIELD_MAP أعلاه — كانا يُجلَبان
    // مسبقاً لكن يُستهلَكان للعرض فقط قبل هذا الإصلاح).
    deviceWindSpeedAt: freshDevice?.last_wind_speed_at ?? null,
    deviceWindGustAt: freshDevice?.last_wind_gust_at ?? null,
    deviceWindDirectionAt: freshDevice?.last_wind_direction_at ?? null,
    deviceVisibilityAt: freshDevice?.last_visibility_at ?? null,
    // خطأ مكتشَف ومُصلَح (مراجعة خبير خارجي — "حداثة البيانات ما زالت
    // جزئية"): PM2.5/الحرارة/الرطوبة كانت تصل بقيمتها الخام دائماً بلا فحص
    // عمر فردي، بخلاف الرياح/الرؤية أعلاه — الآن تدخل نفس بوابة الحداثة في
    // buildDeviceMergedReading (dust-engine/engine.ts).
    devicePm25At: freshDevice?.last_pm25_at ?? null,
    deviceRelativeHumidityAt: freshDevice?.last_relative_humidity_at ?? null,
    deviceTemperatureAt: freshDevice?.last_temperature_at ?? null,
    workDaysList: Array.isArray(project.work_days_list) ? (project.work_days_list as string[]) : undefined,
    workHoursStart: (project.work_hours_start as string | undefined) ?? undefined,
    workHoursEnd: (project.work_hours_end as string | undefined) ?? undefined,
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
// مُنقول من app/utils/rule-bundles/field-freshness.ts (DEVICE_CONNECTION_
// FRESHNESS_MS) — راجع تعليقه الكامل لسبب اختلافها عمداً عن عتبة PM10
// اللحظية (4 دقائق، LIVE_FIELD_FRESHNESS_MS).
export const DEVICE_READING_FRESHNESS_MINUTES = DEVICE_CONNECTION_FRESHNESS_MS / 60_000;

// خريطة metric (device_metric_latest/NormalizedReading) → زوج حقلي
// FreshDeviceReading (value/at) — تُستخدم لتحويل صفوف device_metric_latest
// المحورة (صف واحد لكل مقياس) إلى الشكل المسطَّح الذي يستهلكه buildDustInput.
const METRIC_LATEST_FIELD_MAP: Record<
  string,
  { valueKey: keyof FreshDeviceReading; atKey: keyof FreshDeviceReading }
> = {
  windSpeedKmh: { valueKey: 'last_wind_speed_kmh', atKey: 'last_wind_speed_at' },
  windGustKmh: { valueKey: 'last_wind_gust_kmh', atKey: 'last_wind_gust_at' },
  windDirectionDeg: { valueKey: 'last_wind_direction_deg', atKey: 'last_wind_direction_at' },
  pm10: { valueKey: 'last_pm10', atKey: 'last_pm10_at' },
  pm25: { valueKey: 'last_pm25', atKey: 'last_pm25_at' },
  visibilityM: { valueKey: 'last_visibility_m', atKey: 'last_visibility_at' },
  relativeHumidityPercent: { valueKey: 'last_relative_humidity_percent', atKey: 'last_relative_humidity_at' },
  temperatureC: { valueKey: 'last_temperature_c', atKey: 'last_temperature_at' },
};

// يبني FreshDeviceReading من صفوف device_metric_latest (Projection —
// القسم 8.3 من "دليل الإصلاح الجذري لمنظومة مرقاب") لجهاز واحد محدَّد —
// مصدر الحقيقة الجديد لمسار القرار الحي، بدل قراءة project_devices.last_*
// مباشرة (تلك تبقى مُحدَّثة أيضاً — راجع deviceReadingWriter.ts — لكن
// device_metric_latest هي ما يُقرَأ هنا الآن، لأنها تحمل وقت رصد مستقل
// حقيقي لكل حقل جاء من ingest_device_event_v2، لا وقتاً مشتركاً واحداً).
async function fetchDeviceMetricLatest(
  supabaseAdmin: SupabaseClient,
  projectId: string,
  deviceId: string
): Promise<Partial<FreshDeviceReading>> {
  const { data } = await supabaseAdmin
    .from('device_metric_latest')
    .select('metric, value, observed_at')
    .eq('project_id', projectId)
    .eq('device_id', deviceId);

  const result: Partial<FreshDeviceReading> = {};
  for (const row of data || []) {
    const mapping = METRIC_LATEST_FIELD_MAP[row.metric];
    if (!mapping) continue;
    (result as Record<string, unknown>)[mapping.valueKey] = row.value ?? null;
    (result as Record<string, unknown>)[mapping.atKey] = row.observed_at ?? null;
  }
  return result;
}

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
//
// القيم/الأوقات الفعلية (last_wind_speed_kmh/last_pm10_at/إلخ) تُقرأ الآن
// من device_metric_latest (fetchDeviceMetricLatest أعلاه) — الاستعلام على
// project_devices هنا يبقى فقط لتحديد *أي جهاز* (نشط، يطابق deviceId إن
// وُجد، أو الأحدث last_reading_at) واستخدام last_reading_at كعلامة "هل
// يوجد أي قراءة على الإطلاق" (نفس دلالة السلوك السابق تماماً).
export async function resolveFreshProjectDevice(
  supabaseAdmin: SupabaseClient,
  projectId: string,
  deviceId?: string | null
): Promise<FreshDeviceReading | null> {
  let query = supabaseAdmin
    .from('project_devices')
    .select(
      'id, last_reading_at, true_north_alignment_documented, true_north_alignment_type, true_north_verification_method, true_north_verified_by, true_north_verified_at, true_north_deviation_deg, true_north_evidence_url'
    )
    .eq('project_id', projectId)
    .eq('is_active', true)
    .not('last_reading_at', 'is', null);

  query = deviceId
    ? query.eq('id', deviceId)
    : query.order('last_reading_at', { ascending: false });

  const { data } = await query.limit(1).maybeSingle();

  if (!data?.last_reading_at) return null;

  const metricLatest = await fetchDeviceMetricLatest(supabaseAdmin, projectId, data.id);

  return {
    deviceId: data.id,
    trueNorthAlignmentDocumented: data.true_north_alignment_documented ?? null,
    trueNorthAlignmentType: data.true_north_alignment_type ?? null,
    trueNorthVerificationMethod: data.true_north_verification_method ?? null,
    trueNorthVerifiedBy: data.true_north_verified_by ?? null,
    trueNorthVerifiedAt: data.true_north_verified_at ?? null,
    trueNorthDeviationDeg: data.true_north_deviation_deg ?? null,
    trueNorthEvidenceUrl: data.true_north_evidence_url ?? null,
    last_wind_speed_kmh: metricLatest.last_wind_speed_kmh ?? null,
    last_wind_gust_kmh: metricLatest.last_wind_gust_kmh ?? null,
    last_wind_direction_deg: metricLatest.last_wind_direction_deg ?? null,
    last_pm10: metricLatest.last_pm10 ?? null,
    last_pm25: metricLatest.last_pm25 ?? null,
    last_visibility_m: metricLatest.last_visibility_m ?? null,
    last_relative_humidity_percent: metricLatest.last_relative_humidity_percent ?? null,
    last_temperature_c: metricLatest.last_temperature_c ?? null,
    last_pm10_at: metricLatest.last_pm10_at ?? null,
    last_wind_speed_at: metricLatest.last_wind_speed_at ?? null,
    last_wind_gust_at: metricLatest.last_wind_gust_at ?? null,
    last_wind_direction_at: metricLatest.last_wind_direction_at ?? null,
    last_visibility_at: metricLatest.last_visibility_at ?? null,
    last_pm25_at: metricLatest.last_pm25_at ?? null,
    last_relative_humidity_at: metricLatest.last_relative_humidity_at ?? null,
    last_temperature_at: metricLatest.last_temperature_at ?? null,
    last_reading_at: data.last_reading_at,
  };
}

// -----------------------------------------------------------------------
// استمرار PM10 الزمني — يحقق 3 قواعد كانت مستحيلة التطبيق من تقييم لحظة
// واحدة: RCRC-PM10-340-VIOLATION-011 (دقيقتان فأكثر >340 = مخالفة مؤكدة)،
// MRQ-PM10-BLACK-PENDING-104 (أقل من دقيقتين = معلَّق فقط)،
// RCRC-PM10-30M-SUSPENSION-012 (30 دقيقة متواصلة >340 حصراً = تعليق
// النشاط — راجع تعليق القرار التنظيمي، الجولة الثانية، أعلى streakMinutesAbove
// لسبب اقتصار عدّاد الـ30 دقيقة على >340 دون نطاق التحذير [250,340]).
// -----------------------------------------------------------------------

export interface Pm10SustainedStatus {
  // أعلى عتبة استمرت القراءة الحالية عندها بلا انقطاع حتى الآن (340 أو 250
  // أو null إن كانت القراءة الحالية دون 250 أصلاً — لا استمرار ليُقاس).
  currentReadingUgM3: number | null;
  sustainedMinutesAbove340: number;
  // الاسم "Above250" تاريخي فقط — القيمة الفعلية الآن مدة الاستمرار >340
  // حصراً (above340Streak)، لا استمراراً موحَّداً من 250. راجع تعليق القرار
  // التنظيمي (الجولة الثانية) في computeSustainedPm10Status.
  sustainedMinutesAbove250: number;
  isConfirmedViolation340: boolean; // ≥340 لدقيقتين متتاليتين فأكثر، بمصدر جهاز فقط
  isPendingViolation340: boolean;   // ≥340 الآن لكن أقل من دقيقتين بعد، أو مصدرها غير جهاز
  isSuspended250For30Min: boolean;  // الاسم تاريخي — فعلياً: >340 متواصلة لـ30 دقيقة فأكثر، بمصدر جهاز فقط
  // خطأ مكتشَف ومُصلَح (مراجعة خبير خارجي — "لا قدرة Replay كاملة: القرار
  // المخزَّن لا يحمل معرّفات القراءات الفعلية التي أثبتت الاستمرار — فقط
  // القيم المجمَّعة (الدقائق/الحالة المنطقية)"): evidenceReadingIds تحمل
  // معرّفات صفوف pm10_readings_history (id عمود، لا external_event_id)
  // المكوِّنة فعلياً للسلسلة التي أنتجت sustainedMinutesAbove340 — تسمح
  // لاحقاً بإثبات "هذه القراءات بالذات، بهذا الترتيب، أنتجت هذا القرار"
  // بدل الاكتفاء بالقيمة المجمَّعة النهائية. فارغة إن لم تُثبَت أي سلسلة
  // (sampleCount<2 في streakMinutesAbove، راجع تعليقها).
  evidenceReadingIds: string[];
}

// خطأ توثيقي مكتشَف ومُصلَح (مراجعة كود خارجي — "حزمة القواعد نفسها ما
// زالت تحمل السياسة القديمة"): هذه الثوابت الثلاثة كانت أرقاماً مستقلة
// مكتوبة يدوياً هنا، بمعزل تام عن ACTIVE_RULE_BUNDLE.pm10.regulatory رغم
// وجود حقول مطابقة لها هناك (كانت 2026.2 تعرّفها لكن لا يقرأها أي كود حي
// إطلاقاً) — القيم الفعلية لم تتغيّر (340/2 دقيقة/30 دقيقة تبقى كما هي
// بالضبط)، فقط أصبحت تُقرأ من الحزمة النشطة بدل تكرارها هنا، فلا يعود
// ممكناً أن تنحرف الحزمة (التوثيق الرسمي) عن الكود الفعلي مرة أخرى.
const PM10_SUSTAINED_VIOLATION_THRESHOLD = ACTIVE_RULE_BUNDLE.pm10.regulatory.violationThresholdExclusive;
const PM10_VIOLATION_CONFIRM_MINUTES = ACTIVE_RULE_BUNDLE.pm10.regulatory.violationDurationMsInclusive / 60_000;
const PM10_SUSPENSION_MINUTES = ACTIVE_RULE_BUNDLE.pm10.regulatory.activityStopDurationMsInclusive / 60_000;
// خطأ مكتشَف ومُصلَح (مراجعة خبير خارجي — "استمرارية الدليل نفسها غير
// صحيحة؛ يمكن لعينتين متباعدتين أكثر من المسموح إثبات مخالفة"): كان هذا
// الثابت رقماً مستقلاً (4 دقائق) مبنياً على افتراض دورة إرسال الجهاز (كل
// دقيقتين + هامش)، بمعزل تام عن ACTIVE_RULE_BUNDLE.pm10.evidence.
// maxContinuityGapMs (90 ثانية) — القيمة الفعلية المشتقة من المرجع
// التنظيمي الرسمي (الملحق ب، صفحة 82: دورية تسجيل معتمدة لا تتجاوز دقيقة
// + هامش منطقي). فجوة حتى 4 دقائق كانت تُقبَل كـ"استمرار بلا انقطاع" رغم
// أن حزمة القواعد النشطة نفسها (2026.2 أو 2026.3، كلتاهما 90 ثانية) تقول
// إن أي فجوة أطول من 90 ثانية لا تثبت استمراراً فعلياً — عينتان بفارق
// دقيقتين إلى أربع دقائق كانتا تُحتسَبان "سلسلة واحدة متصلة" بلا أي دليل
// حقيقي على ما جرى بينهما. الإصلاح: يُقرأ الحد من حزمة القواعد النشطة
// مباشرة، فيتبع تلقائياً أي حزمة (بما فيها حزم مستقبلية) بدل رقم ثابت
// منفصل قد يتعارض معها.
const PM10_READING_GAP_TOLERANCE_MINUTES = ACTIVE_RULE_BUNDLE.pm10.evidence.maxContinuityGapMs / 60_000;
// أقصى عمر لآخر قراءة حتى تبقى "حالة حية" — لو توقف الجهاز عن الإرسال
// وتجاوز عمر آخر قراءة هذه العتبة، لا يجوز اعتبار الاستمرار "حياً حتى
// الآن" (كان النظام سابقاً يُبقي isConfirmedViolation340/isSuspended250For30Min
// صحيحة إلى الأبد طالما لم تتجاوز الفجوة القديمة 15 دقيقة، حتى لو توقف
// الجهاز فعلياً عن الإرسال منذ ساعات — ثغرة اكتُشفت في مراجعة أمنية: تجمّد
// حالة "مخالفة مستمرة" أو "معلَّق" بلا أي دليل حي، بدل التنبيه لانقطاع
// الاتصال). القراءة نفسها تبقى ظاهرة (لا تُخفى)، فقط لا تُستخدم لإثبات
// استمرار "حتى الآن" إن كانت أقدم من هذا الحد.
//
// خطأ مكتشَف ومُصلَح (مراجعة خبير خارجي — البند 3: "تصنيف حداثة مركزي لكل
// Metric"): مُنقول الآن من app/utils/rule-bundles/field-freshness.ts
// (LIVE_FIELD_FRESHNESS_MS) — نفس القيمة (4 دقائق) بالضبط، لا تغيير سلوكي.
// عمداً لا يُستخدَم DEVICE_READING_FRESHNESS_MINUTES (10 دقائق، مصدَّر أدناه
// لغرض مختلف تماماً — عرض قِدم اتصال المحطة، لا حسم استمرار مخالفة PM10) —
// راجع تعليق field-freshness.ts الكامل لسبب الفصل المتعمَّد بين القيمتين.
const PM10_LAST_READING_FRESHNESS_MINUTES = LIVE_FIELD_FRESHNESS_MS / 60_000;

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
  readings: {
    pm10UgM3: number;
    recordedAt: string;
    source?: 'device' | 'manual' | 'open-meteo';
    id?: string;
    // خطأ مكتشَف ومُصلَح (مراجعة كود خارجي — "الموصل Snapshot-only لا يصلح
    // لإثبات الاستمرارية"): راجع تعليق streakMinutesAbove أدناه وmigration
    // 202608110017 الكامل. اختياري: قراءات manual/تاريخية بلا هذا الحقل
    // تُعامَل كـfalse (HISTORY_COMPLETE ضمنياً) — لا تراجع في صرامة القراءات
    // الحالية.
    isSnapshotOnly?: boolean;
  }[],
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
      evidenceReadingIds: [],
    };
  }

  // خطأ مكتشَف ومُصلَح (مراجعة كود خبير خارجي — H-03.1: "مصدر مجهول يتحول
  // إلى device"): كان `source ?? 'device'` يفترض أن أي قراءة بلا حقل source
  // مسجَّل (صفوف قديمة قبل إضافة العمود، أو بيانات تالفة) هي من جهاز رصد
  // حقيقي — أعلى درجة ثقة ممكنة، رغم أن الغياب الفعلي لا يثبت شيئاً عن
  // المصدر الحقيقي. هذا يخالف مباشرة الفلسفة الصارمة المطبَّقة في كل مكان
  // آخر بهذا الملف (لا قرار حي واثق بلا دليل جهاز حقيقي مُثبَت صراحة).
  // الإصلاح: مصدر مجهول يُعامَل كأضعف درجة ثقة ممكنة ('open-meteo' — تقدير
  // غير موثوق)، لا كأقواها — فيبقى isCurrentSourceDevice=false تلقائياً،
  // مما يُبقي أي قراءة كهذه "معلَّقة" (isPendingViolation340) فقط، أبداً
  // "مؤكَّدة"، تماماً كما لو وصلت فعلاً من توقّع طقس. الكتّاب الثلاثة
  // الفعليون لهذا الجدول (ingest/route.ts، alerts/generate/route.ts،
  // dustEvaluation.ts نفسها) يمرّرون source صراحة دائماً — هذا المسار لا
  // يُطبَّق إلا على صفوف تاريخية/تالفة فعلياً.
  const sorted = [...readings].sort(
    (a, b) => new Date(b.recordedAt).getTime() - new Date(a.recordedAt).getTime()
  );
  const currentReadingUgM3 = sorted[0].pm10UgM3;
  const currentSource = sorted[0].source ?? 'open-meteo';
  const latestReadingAgeMinutes = (now - new Date(sorted[0].recordedAt).getTime()) / 60000;
  // خطأ مكتشَف ومُصلَح (مراجعة كود خبير خارجي — H-03.2: "قراءة بوقت مستقبلي
  // لا تُرفض"): latestReadingAgeMinutes سالبة (recordedAt في المستقبل، مثال:
  // ساعة جهاز غير متزامنة) كانت تمر بصمت — أي رقم سالب يحقق `<= 4` دائماً،
  // فتُعامَل القراءة كـ"حديثة جداً" رغم أنها بيانات فاسدة منطقياً (لا يمكن
  // لقراءة أن تصل قبل وقوعها). الإصلاح: عمر سالب (قراءة مستقبلية) يُبطل
  // الحداثة صراحة بدل قبولها كأفضل حالة ممكنة.
  const isLatestReadingFresh = latestReadingAgeMinutes >= 0 && latestReadingAgeMinutes <= PM10_LAST_READING_FRESHNESS_MINUTES;
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
  // خطأ مكتشَف ومُصلَح (مراجعة كود خبير خارجي — H-03.3: "قراءة =340 تُحتسب
  // ضمن سلسلة >340"): كانت هذه الدالة تقطع السلسلة بشرط موحَّد (`< threshold`)
  // لكل العتبات — صحيح لعتبة 250 (النص التنظيمي "≥250" فعلاً، راجع
  // PM10_WARNING_UG_M3 في rulebook.ts)، لكن خاطئ لعتبة 340 التي يشترط
  // النص التنظيمي فيها تجاوزاً صريحاً "أكثر من 340" (>340 لا >=340، نفس
  // عتبة pm10ThresholdRule وisAbove340Now أدناه بالضبط). فقراءة تساوي 340
  // بالضبط كانت لا تُقطَع بها السلسلة (لأنها ليست "أقل من" العتبة)، فتُسهم
  // في sustainedMinutesAbove340 رغم أنها لا تمثّل تجاوزاً فعلياً حسب نفس
  // التعريف التنظيمي المستخدَم لتأكيد المخالفة (isAbove340Now). الإصلاح:
  // strict (افتراضي true) يجعل شرط القطع `<= threshold` بدل `< threshold`
  // — أي قراءة تساوي العتبة بالضبط تُعامَل كأنها لم تتجاوزها، فتقطع السلسلة
  // تماماً كأي قراءة أقل منها. يُمرَّر false صراحة فقط لعتبة 250 (حيث
  // المساواة تُحتسب ضمن النطاق فعلاً حسب النص التنظيمي).
  //
  // قرار تنظيمي مُعاد النظر فيه مرتين (طلب صريح من المستخدم في كل مرة):
  //
  // الجولة الأولى (مُلغاة الآن): وحَّدت sustainedMinutesAbove250 عبر
  // [250,340] و>340 معاً (بلا upperExclusiveBound) — أي قراءة ≥250، سواء
  // داخل نطاق التحذير أو نطاق المخالفة، كانت تُسهم في نفس عداد الـ30 دقيقة.
  //
  // الجولة الثانية (الحالية — طلب صريح: "الـ30 دقيقة من وقت فوق 340 فقط"):
  // تُلغي التوحيد أعلاه — عداد الإيقاف الفعلي (الـ30 دقيقة) يُحتسَب الآن من
  // زمن التجاوز الفعلي فوق 340 حصراً (above340Streak)، لا من الاستمرار
  // الموحَّد فوق 250. زمن نطاق التحذير [250,340] لا يُسهم إطلاقاً في عدّاد
  // الإيقاف — 25 دقيقة تحذير + 5 دقائق مخالفة لم يعد يساوي 30 دقيقة إيقاف؛
  // يلزم 30 دقيقة متواصلة فوق 340 فعلياً لوحدها. sustainedMinutesAbove250
  // (الاسم يبقى كما هو لتفادي تغيير واجهة عامة عبر عدة طبقات — النوع/
  // adapters.ts/rulebook.ts) يحمل الآن قيمة above340Streak.minutes حرفياً،
  // لا above250Streak.minutes — القراءة الصحيحة لهذا الحقل أصبحت "مدة
  // التجاوز المتواصل فوق 340"، رغم بقاء الاسم القديم. above340Streak نفسها
  // (المستخدَمة أيضاً لتأكيد مخالفة الدقيقتين، isConfirmedViolation340)
  // تبقى المصدر الوحيد لكلا الحسابين الآن — لا حساب منفصل مطلوب.
  function streakMinutesAbove(
    threshold: number,
    strict: boolean = true,
    upperExclusiveBound?: number
  ): { minutes: number; ids: string[] } {
    const isBelow = (value: number) => (strict ? value <= threshold : value < threshold);
    const isAboveUpperBound = (value: number) => upperExclusiveBound !== undefined && value > upperExclusiveBound;
    if (isBelow(sorted[0].pm10UgM3) || isAboveUpperBound(sorted[0].pm10UgM3)) return { minutes: 0, ids: [] };
    let streakStartMs = new Date(sorted[0].recordedAt).getTime();
    const streakEndMs = streakStartMs;
    let sampleCount = 0;
    const streakIds: string[] = [];
    for (let i = 0; i < sorted.length; i++) {
      if (isBelow(sorted[i].pm10UgM3) || isAboveUpperBound(sorted[i].pm10UgM3)) break;
      if ((sorted[i].source ?? 'open-meteo') !== currentSource) break;
      const currentMs = new Date(sorted[i].recordedAt).getTime();
      if (i > 0) {
        const prevMs = new Date(sorted[i - 1].recordedAt).getTime();
        const gapMinutes = (prevMs - currentMs) / 60000;
        if (gapMinutes > PM10_READING_GAP_TOLERANCE_MINUTES) break;
      }
      streakStartMs = currentMs;
      sampleCount++;
      if (sorted[i].id) streakIds.push(sorted[i].id as string);
      // خطأ مكتشَف ومُصلَح (مراجعة كود خارجي — "الموصل Snapshot-only لا
      // يصلح لإثبات الاستمرارية"، راجع migration 202608110017 وتعليق
      // EvidenceCapability الكامل في types.ts): صف isSnapshotOnly=true وصل
      // كنقطة لحظية وحيدة (fetchLatestReading الاحتياطي) — لا "قبل" ولا
      // "بعد" فعلي له ضمن نفس طلب السحب، فلا يجوز أن يُمدِّد السلسلة إلى ما
      // قبله رياضياً (قد تكون هناك فجوة زمنية حقيقية غير مُثبَتة بينه وبين
      // العينة السابقة له في sorted، حتى لو كان فارق recordedAt نفسه صغيراً
      // — العينة اللحظية لا تثبت استمراراً، توجد فقط). العينة نفسها تدخل
      // السلسلة (sampleCount++/streakIds أعلاه — تصلح "آخر نقطة معروفة"
      // للعرض/isAbove340Now) لكن الحلقة تتوقف فور معالجتها — تماماً كما
      // تتوقف عند فجوة زمنية تتجاوز الحد المسموح.
      if (sorted[i].isSnapshotOnly) break;
    }
    // عينة واحدة فقط بالسلسلة = لا استمرار مُثبَت بين عينتين فعليتين، بصرف
    // النظر عن قِدمها — فشل آمن نحو "صفر" لا "منذ وصولها وحتى الآن".
    if (sampleCount < 2) return { minutes: 0, ids: [] };
    return { minutes: (streakEndMs - streakStartMs) / 60000, ids: streakIds };
  }

  const above340Streak = streakMinutesAbove(PM10_SUSTAINED_VIOLATION_THRESHOLD, true);
  const sustainedMinutesAbove340 = above340Streak.minutes;
  // خطأ سابق مُصحَّح (راجع تعليق القرار التنظيمي أعلى هذه الدالة — الجولة
  // الثانية): كان يُحسَب من above250Streak (استمرار موحَّد فوق 250) — أصبح
  // الآن above340Streak.minutes حرفياً، نفس السلسلة المستخدَمة لتأكيد
  // مخالفة الدقيقتين. لا حساب above250Streak منفصل بعد الآن — غير مستخدَم
  // في أي مكان آخر.
  const sustainedMinutesAbove250 = above340Streak.minutes;

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
  // "مؤكَّدة" تتطلب معاً: دقيقتان استمرار فعلي على الأقل + قراءة حية (ليست
  // قديمة) + مصدرها جهاز رصد حقيقي — أي شرط يفشل يُبقي الحالة "معلَّقة"
  // فقط، أبداً "مؤكَّدة" بلا دليل كافٍ.
  //
  // قرار تنظيمي مُعاد النظر فيه (طلب صريح من المستخدم — "في حال استمر
  // دقيقتين بالضبط يتم تسجيل مخالفة"): يُلغي القرار السابق الموثَّق هنا
  // (`>` صراحة، بناءً على مرجع كان يشترط "أكثر من دقيقتين"). التوجيه
  // الجديد صريح: اكتمال الدقيقتين (≥2) كافٍ لتسجيل المخالفة، لا يشترط
  // تجاوزهما. `>=` بدل `>`.
  const isConfirmedViolation340 =
    isAbove340Now &&
    sustainedMinutesAbove340 >= PM10_VIOLATION_CONFIRM_MINUTES &&
    isLatestReadingFresh &&
    isCurrentSourceDevice;
  const isPendingViolation340 = isAbove340Now && !isConfirmedViolation340;
  // خطأ سابق مُصحَّح (الجولة الثانية من القرار التنظيمي أعلاه): الشرط
  // `currentReadingUgM3 >= 250` كان يطابق above250Streak القديمة (استمرار
  // من 250). الآن يُحكَم بـisAbove340Now (>340 صراحة) ليطابق المصدر الفعلي
  // (above340Streak) — القراءة الحالية جزء من سلسلة تُشترَط بالكامل >340
  // أصلاً (streakMinutesAbove(340, strict=true))، فهذا الشرط توثيقي/دفاعي
  // متسق مع المصدر، لا شرطاً فعلياً إضافياً مستقلاً.
  const isSuspended250For30Min =
    isAbove340Now &&
    sustainedMinutesAbove250 >= PM10_SUSPENSION_MINUTES &&
    isLatestReadingFresh &&
    isCurrentSourceDevice;

  // مصدر الأدلة الوحيد الآن هو above340Streak — كلا الحالتين (مؤكَّدة
  // دقيقتين، أو موقوفة 30 دقيقة) تُبنيان من نفس السلسلة (راجع تعليق القرار
  // التنظيمي أعلاه، الجولة الثانية).
  const evidenceReadingIds = isConfirmedViolation340 || isSuspended250For30Min ? above340Streak.ids : [];

  return {
    currentReadingUgM3,
    sustainedMinutesAbove340,
    sustainedMinutesAbove250,
    isConfirmedViolation340,
    isPendingViolation340,
    isSuspended250For30Min,
    evidenceReadingIds,
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
// خطأ مكتشَف ومُصلَح (مراجعة كود خارجي — "التقييم بحسب وقت المعالجة قد
// يفوّت مخالفة كاملة"، راجع migration 202608110019 وتعليق computeDustComplianceResults
// الكاملين): nowMs اختياري (افتراضياً Date.now()، نفس السلوك السابق تماماً)
// — يحدد "الآن" الذي تُحسَب بالنسبة له نافذة الاستعلام (sinceIso) وnow
// الممرَّرة لـcomputeSustainedPm10Status. حد أعلى صريح (untilIso، جديد)
// يمنع الاستعلام من رؤية أي صف observedAt بعد nowMs — بدونه، تمرير nowMs
// تاريخية (لإعادة بناء "كما كانت الحالة عند لحظة رصد سابقة") كان سيبقى
// يجلب كل الصفوف حتى الوقت الفعلي الحالي (لا حد أعلى قط سابقاً)، فتظل
// القراءة اللاحقة (100 في مثال التقرير) مرئية وتُسقِط الاستمرار تماماً كما
// كان الخطأ الأصلي — الحد الأعلى هو ما يجعل "إعادة البناء كما كانت" ذات
// معنى فعلياً، لا مجرد تمرير رقم مختلف لدالة حساب بلا تغيير فعلي في البيانات
// المُستعلَمة.
// خطأ حرج مكتشَف ومُصلَح (مراجعة كود خارجي — "فشل استعلام سلسلة PM10 يتحول
// إلى سلسلة فارغة"): كانت هذه الدالة تُرجع Pm10SustainedStatus مباشرة —
// `const { data } = await ...` بلا قراءة error، فحين يفشل الاستعلام فعلياً
// (RLS/timeout/شبكة، Supabase لا يرمي استثناءً على هذه الأخطاء، يُعيد
// {data: null, error: {...}} بصمت — نفس النمط الموثَّق أعلى previousDecision
// QueryFailed في هذا الملف) كانت (data as ...) || [] تتحول لمصفوفة فارغة،
// فتنتج بالضبط نفس النتيجة (sustainedMinutesAbove340=0،
// isConfirmedViolation340=false، isSuspended250For30Min=false) كحالة "لا
// توجد قراءات فعلاً" — رغم اختلاف السببين جذرياً: الأول يعني "لا مخالفة"،
// الثاني يعني "لا نعرف". فشل عابر لقاعدة البيانات كان يمكن أن يُسقط صمتاً
// تسجيل مخالفة مؤكَّدة (120 ثانية) أو إيقاف نشاط مستحق (30 دقيقة).
//
// الإصلاح: عقد جديد (Pm10SustainedFetchResult) يفصل الحالتين صراحة —
// queryFailed=true فقط عند فشل استعلام حقيقي (error من Supabase، أو
// استثناء JS)، لا عند نجاح الاستعلام بصفر صفوف. المستدعي (أدناه في هذا
// الملف) يمرر queryFailed لمحرك الامتثال (pm10HistoryQueryFailed في
// DustComplianceContext)، الذي يصدر FIELD_VERIFICATION_REQUIRED صريحاً
// بدل COMPLIANT صامت عند الفشل — نفس مبدأ previousDecisionQueryFailed
// الموثَّق أعلاه بالضبط، مطبَّقاً هنا على سلسلة PM10 التاريخية.
export interface Pm10SustainedFetchResult {
  status: Pm10SustainedStatus | null;
  queryFailed: boolean;
  failureCode: 'PM10_HISTORY_QUERY_FAILED' | null;
  // خطأ حرج مكتشَف ومُصلَح (مراجعة كود خارجي — تفصيل تنفيذ
  // pm10TemporalEvidenceState في DustComplianceResult.evidence، types.ts):
  // عدد الصفوف الفعلية (بعد فلترة is_late/device_id) التي وجدها هذا
  // الاستعلام — التمييز الوحيد الدقيق بين "الاستعلام نجح بصفر صفوف"
  // (NO_READINGS) و"وُجدت قراءات فعلية" (AVAILABLE). status وحده (Pm10Sustained
  // Status) لا يكفي: currentReadingUgM3 يبقى null أيضاً حتى لو وُجدت قراءات
  // حقيقية دون 250، فلا يميّز "صفر قراءات" عن "قراءات موجودة لكن منخفضة".
  // 0 عند queryFailed=true (لا معنى للعدّ حينها).
  readingCount: number;
}

// طلب مستخدم صريح ("سجل الأعطال والتدقيق"): فشل استعلام سلسلة PM10
// التاريخية يجب أن يُنشئ حدث Telemetry حقيقي (جدول technical_fault_events،
// راجع الهجرة 202608190003)، لا الاكتفاء بـconsole.error. لا نمرر نص خطأ
// Supabase/PostgreSQL نفسه ولا Stack trace ولا بيانات اتصال قاعدة البيانات
// إلى هذا الجدول أو لاحقاً للواجهة — فقط الحقول المُقرَّرة صراحة (النوع،
// المشروع، النشاط، الجهاز، معرّف التقييم إن وُجد، وقت التقييم، عدد
// المحاولات). أي تفصيل تشخيصي أعمق من "فشل الاستعلام" يبقى في سجلات
// الخادم (console.error، غير مقروء من الواجهة) فقط.
//
// idempotency: dedupe_key مستقر لكل (project_id, activity_group_id) ضمن
// دقيقة واحدة — نفس مبدأ project_evaluation_jobs.dedupe_key الموثَّق في
// evaluateProject.ts:enqueueEvaluationRetryJob بالضبط (حادثة إنتاج سابقة:
// مفتاح فريد لكل استدعاء لا يمنع شيئاً عملياً تحت فشل متكرر كل دقيقة).
// القيد الفريد على الجدول (project_id, dedupe_key) يرفض الإدراج المكرر
// بصمت لنفس العطل غير المتغيّر ضمن نفس الدقيقة، فلا يتراكم حدث Telemetry
// جديد كل دورة تقييم إذا كان الفشل مستمراً بلا تغيّر.
async function logPm10HistoryQueryFailureTelemetry(
  supabaseAdmin: SupabaseClient,
  projectId: string,
  activityGroupId: string,
  deviceId: string | null,
  evaluatedAtMs: number,
  retryCount: number = 0
): Promise<void> {
  try {
    const minuteBucket = Math.floor(evaluatedAtMs / 60_000);
    await supabaseAdmin.from('technical_fault_events').insert({
      event_type: 'PM10_HISTORY_QUERY_FAILED',
      project_id: projectId,
      activity_group_id: activityGroupId,
      device_id: deviceId,
      evaluation_id: null,
      retry_count: retryCount,
      evaluated_at: new Date(evaluatedAtMs).toISOString(),
      dedupe_key: `pm10-history-query-failed:${activityGroupId}:${minuteBucket}`,
    });
  } catch (err) {
    // فشل تسجيل حدث Telemetry نفسه لا يجوز أن يُسقط تقييم الامتثال الأصلي
    // (نفس مبدأ enqueueEvaluationRetryJob) — يُسجَّل فقط في سجلات الخادم.
    console.error(`logPm10HistoryQueryFailureTelemetry: فشل تسجيل حدث تقني لمشروع ${projectId}:`, err);
  }
}

export async function fetchPm10SustainedStatus(
  supabaseAdmin: SupabaseClient,
  projectId: string,
  activityGroupId: string,
  deviceId?: string | null,
  nowMs: number = Date.now()
): Promise<Pm10SustainedFetchResult> {
  const sinceIso = new Date(nowMs - (PM10_SUSPENSION_MINUTES + 10) * 60000).toISOString();
  const untilIso = new Date(nowMs).toISOString();
  try {
    const { data, error } = await supabaseAdmin
      .from('pm10_readings_history')
      .select('id, pm10_ug_m3, recorded_at, activity_group_id, source, device_id, is_late, is_snapshot_only')
      .eq('project_id', projectId)
      .gte('recorded_at', sinceIso)
      .lte('recorded_at', untilIso)
      .order('recorded_at', { ascending: false });

    // خطأ مكتشَف ومُصلَح: Supabase (postgrest-js) لا يرمي استثناءً عند فشل
    // الاستعلام على مستوى القاعدة (RLS/شبكة/timeout) — يُعيد {data: null,
    // error: {...}} بصمت، فيمر عبر try بلا الدخول لـcatch إطلاقاً. الفحص
    // الصريح لـerror هنا هو ما يكتشف الفشل فعلياً، لا بنية try/catch وحدها
    // (نفس النمط الموثَّق في previousDecisionQueryFailed أعلاه).
    if (error) {
      await logPm10HistoryQueryFailureTelemetry(supabaseAdmin, projectId, activityGroupId, deviceId ?? null, nowMs);
      return { status: null, queryFailed: true, failureCode: 'PM10_HISTORY_QUERY_FAILED', readingCount: 0 };
    }

    type Pm10HistoryRow = {
      id: string;
      pm10_ug_m3: number;
      recorded_at: string;
      activity_group_id: string | null;
      source?: 'device' | 'manual' | 'open-meteo';
      device_id: string | null;
      is_late?: boolean | null;
      is_snapshot_only?: boolean | null;
    };
    const relevant = ((data as Pm10HistoryRow[]) || []).filter((row) => {
      // خطأ مكتشَف ومُصلَح (مراجعة خبير خارجي — "القراءات المتأخرة يجب أن
      // تُمنَع من تغيير الحالة التشغيلية الحالية"): قراءة وصلت متأخرة بأكثر
      // من نافذة القبول الحية (is_late=true، راجع deviceReadingWriter.ts)
      // لا يجوز أن "تُثبت" استمرار مخالفة/تعليق — قد لا تعكس الوضع الفعلي
      // الآن إطلاقاً رغم بقائها في السجل التاريخي للتدقيق.
      if (row.is_late) return false;
      if (row.activity_group_id === activityGroupId) return true;
      // قراءة جهاز على مستوى المشروع (activity_group_id=null): تخص هذا
      // النشاط فقط لو device_id يطابق جهازه المحدد فعلياً — لا أي جهاز آخر.
      if (row.activity_group_id === null) return !!deviceId && row.device_id === deviceId;
      return false;
    });
    const readings = relevant.map((row) => ({
      pm10UgM3: Number(row.pm10_ug_m3),
      recordedAt: row.recorded_at,
      source: row.source,
      id: row.id,
      isSnapshotOnly: row.is_snapshot_only ?? false,
    }));
    return { status: computeSustainedPm10Status(readings, nowMs), queryFailed: false, failureCode: null, readingCount: readings.length };
  } catch {
    // استثناء JS فعلي (شبكة معطوبة تماماً، لا مجرد error من Supabase) —
    // نفس معاملة الفشل أعلاه: queryFailed=true، لا سلسلة فارغة صامتة.
    await logPm10HistoryQueryFailureTelemetry(supabaseAdmin, projectId, activityGroupId, deviceId ?? null, nowMs);
    return { status: null, queryFailed: true, failureCode: 'PM10_HISTORY_QUERY_FAILED', readingCount: 0 };
  }
}

// يجلب كل أجهزة مشروع دفعة واحدة (استعلام واحد بدل استعلام لكل نشاط) ويبني
// Map<deviceId, FreshDeviceReading|null> — يُستخدم في computeDustResults
// لحلّ جهاز كل نشاط (row.device_id) محلياً بدل استدعاء الشبكة لكل صف.
// نفس مبدأ resolveFreshProjectDevice: لا إسقاط للقراءة القديمة هنا — كل
// جهاز نشط له last_reading_at يُضاف للخريطة بصرف النظر عن عمره؛ الواجهة
// تقرر عرض تحذير القِدم.
async function resolveProjectDeviceMap(
  supabaseAdmin: SupabaseClient,
  projectId: string
): Promise<Map<string, FreshDeviceReading | null>> {
  const map = new Map<string, FreshDeviceReading | null>();
  const { data } = await supabaseAdmin
    .from('project_devices')
    .select(
      'id, last_reading_at, true_north_alignment_documented, true_north_alignment_type, true_north_verification_method, true_north_verified_by, true_north_verified_at, true_north_deviation_deg, true_north_evidence_url'
    )
    .eq('project_id', projectId)
    .eq('is_active', true);

  type ProjectDeviceRow = {
    id: string;
    last_reading_at: string | null;
    true_north_alignment_documented: boolean | null;
    true_north_alignment_type: 'TRUE_NORTH' | 'MAGNETIC_NORTH' | null;
    true_north_verification_method: string | null;
    true_north_verified_by: string | null;
    true_north_verified_at: string | null;
    true_north_deviation_deg: number | null;
    true_north_evidence_url: string | null;
  };
  const deviceRows = (data as ProjectDeviceRow[]) || [];
  const activeDeviceIds = deviceRows.filter((d) => d.last_reading_at).map((d) => d.id);
  if (activeDeviceIds.length === 0) return map;

  // استعلام واحد لكل مقاييس كل الأجهزة النشطة معاً (بدل استعلام منفصل لكل
  // جهاز) — نفس مبدأ "دفعة واحدة" الذي بُنيت لأجله هذه الدالة أصلاً.
  const { data: metricRows } = await supabaseAdmin
    .from('device_metric_latest')
    .select('device_id, metric, value, observed_at')
    .eq('project_id', projectId)
    .in('device_id', activeDeviceIds);

  const metricsByDevice = new Map<string, Partial<FreshDeviceReading>>();
  for (const row of metricRows || []) {
    const mapping = METRIC_LATEST_FIELD_MAP[row.metric];
    if (!mapping) continue;
    const bucket = metricsByDevice.get(row.device_id) ?? {};
    (bucket as Record<string, unknown>)[mapping.valueKey] = row.value ?? null;
    (bucket as Record<string, unknown>)[mapping.atKey] = row.observed_at ?? null;
    metricsByDevice.set(row.device_id, bucket);
  }

  for (const d of deviceRows) {
    if (!d.last_reading_at) continue;
    const metricLatest = metricsByDevice.get(d.id) ?? {};
    map.set(d.id, {
      deviceId: d.id,
      trueNorthAlignmentDocumented: d.true_north_alignment_documented ?? null,
      trueNorthAlignmentType: d.true_north_alignment_type ?? null,
      trueNorthVerificationMethod: d.true_north_verification_method ?? null,
      trueNorthVerifiedBy: d.true_north_verified_by ?? null,
      trueNorthVerifiedAt: d.true_north_verified_at ?? null,
      trueNorthDeviationDeg: d.true_north_deviation_deg ?? null,
      trueNorthEvidenceUrl: d.true_north_evidence_url ?? null,
      last_wind_speed_kmh: metricLatest.last_wind_speed_kmh ?? null,
      last_wind_gust_kmh: metricLatest.last_wind_gust_kmh ?? null,
      last_wind_direction_deg: metricLatest.last_wind_direction_deg ?? null,
      last_pm10: metricLatest.last_pm10 ?? null,
      last_pm25: metricLatest.last_pm25 ?? null,
      last_visibility_m: metricLatest.last_visibility_m ?? null,
      last_relative_humidity_percent: metricLatest.last_relative_humidity_percent ?? null,
      last_temperature_c: metricLatest.last_temperature_c ?? null,
      last_reading_at: d.last_reading_at,
      last_pm10_at: metricLatest.last_pm10_at ?? null,
      last_wind_speed_at: metricLatest.last_wind_speed_at ?? null,
      last_wind_gust_at: metricLatest.last_wind_gust_at ?? null,
      last_wind_direction_at: metricLatest.last_wind_direction_at ?? null,
      last_visibility_at: metricLatest.last_visibility_at ?? null,
      last_pm25_at: metricLatest.last_pm25_at ?? null,
      last_relative_humidity_at: metricLatest.last_relative_humidity_at ?? null,
      last_temperature_at: metricLatest.last_temperature_at ?? null,
    });
  }
  return map;
}

// يجلب لقطات forecast_snapshots لكل أنشطة مشروع دفعة واحدة — القسم 9 من
// "دليل الإصلاح الجذري لمنظومة مرقاب". لا fetch هنا إطلاقاً؛ قراءة جدول
// مخزَّن مسبقاً فقط (يملؤه refreshForecastSnapshots أدناه بمسار منفصل).
async function resolveForecastSnapshotMap(
  supabaseAdmin: SupabaseClient,
  projectId: string
): Promise<Map<string, DviHourlyEvaluation[]>> {
  const map = new Map<string, DviHourlyEvaluation[]>();
  const { data } = await supabaseAdmin
    .from('forecast_snapshots')
    .select('activity_group_id, hourly')
    .eq('project_id', projectId);

  for (const row of data || []) {
    if (Array.isArray(row.hourly)) map.set(row.activity_group_id, row.hourly as DviHourlyEvaluation[]);
  }
  return map;
}

// مسار الإثراء المنفصل (Forecast Worker، القسم 9.2 من "دليل الإصلاح الجذري
// لمنظومة مرقاب") — يجلب Open-Meteo لكل نشاط دوام قادم ويخزّن النتيجة في
// forecast_snapshots. لا علاقة له بمسار القرار الحي إطلاقاً: يُستدعى من
// endpoint/cron منفصل (app/api/cron/forecast-refresh/route.ts)، لا من
// evaluateProject/computeDustResults. فشل نشاط واحد لا يوقف البقية.
export async function refreshForecastSnapshots(
  supabaseAdmin: SupabaseClient,
  projectId: string,
  dustRows: DustActivityRow[],
  project: ProjectRow
): Promise<{ refreshed: number; failed: number }> {
  let refreshed = 0;
  let failed = 0;

  for (const row of dustRows || []) {
    try {
      const startIso = riyadhLocalToUtcIso(row.planned_date, row.planned_time);
      if (!startIso) continue;

      const input = buildDustInput(row, project, null);
      const workDayHourly = await evaluateDustVisibilityWorkDayHourly(input, startIso);
      const activityGroupId = row.activity_group_id || `dust-${row.id}`;

      const { error } = await supabaseAdmin.from('forecast_snapshots').upsert(
        {
          project_id: projectId,
          activity_group_id: activityGroupId,
          hourly: workDayHourly,
          activity_start_iso: startIso,
          fetched_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'project_id,activity_group_id' }
      );
      if (error) {
        failed++;
        console.error(`refreshForecastSnapshots: فشل تخزين لقطة النشاط ${row.id}:`, error.message);
        continue;
      }
      refreshed++;
    } catch (error) {
      failed++;
      console.error(`refreshForecastSnapshots: فشل جلب توقعات النشاط ${row.id}:`, error);
    }
  }

  return { refreshed, failed };
}

// تشغيل محرك الغبار لكل نشاط غبار، مع دمج AEI، وإرجاع شكل يطابق props
// بطاقة DustWidgetCard (windowEval + aei + معرفات الربط).
// supabaseAdmin اختياري: بلا تمريره (استدعاءات قديمة/اختبارات) يتجاهل
// المسار مسار الجهاز بالكامل ويسلك onsite_*/الطقس كما كان دائماً — إضافة
// تراكمية بحتة، بلا أي كسر توافقي.
export async function computeDustResults(
  dustRows: DustActivityRow[],
  project: ProjectRow,
  supabaseAdmin?: SupabaseClient
): Promise<DustResultItem[]> {
  // كل نشاط قد يكون مرتبطاً بمحطة مختلفة (device_id، راجع AddActivityModal) —
  // لم يعد ممكناً استخدام "أحدث جهاز واحد بالمشروع" لكل الأنشطة كما كان
  // سابقاً. نجلب كل أجهزة المشروع دفعة واحدة، ثم نحلّ جهاز كل نشاط محلياً
  // حسب row.device_id داخل الحلقة أدناه (أنشطة قديمة بلا device_id تحصل
  // على null كما كان سلوكها سابقاً تماماً — فشل آمن).
  const deviceMap = supabaseAdmin && project?.id
    ? await resolveProjectDeviceMap(supabaseAdmin, project.id).catch(() => new Map<string, FreshDeviceReading | null>())
    : new Map<string, FreshDeviceReading | null>();

  // لقطات التوقعات الساعية المخزَّنة مسبقاً (forecast_snapshots، القسم 9 من
  // "دليل الإصلاح الجذري لمنظومة مرقاب") — تُقرأ دفعة واحدة هنا، لا تُجلَب
  // من الشبكة إطلاقاً ضمن هذه الدالة. نشاط حي بجهاز مرتبط يستهلك هذه اللقطة
  // (إن وُجدت) لملء hourlyForecasts بدل استدعاء evaluateDustVisibilityWorkDayHourly
  // مباشرة (الذي يستدعي Open-Meteo) — راجع refreshForecastSnapshots أدناه
  // لمسار الإثراء المنفصل الذي يملأ هذا الجدول فعلياً.
  const forecastSnapshotMap = supabaseAdmin && project?.id
    ? await resolveForecastSnapshotMap(supabaseAdmin, project.id).catch(() => new Map<string, unknown[]>())
    : new Map<string, unknown[]>();

  const results = await Promise.all(
    (dustRows || []).map(async (row) => {
      try {
        const freshDevice = row.device_id ? deviceMap.get(row.device_id) ?? null : null;

        // خطأ مكتشَف ومُصلَح: كان يُستخدَم row.is_enclosed_operation الخام
        // مباشرة هنا، بينما محطة الخلط (BATCHING_PLANT) مستثناة عمداً من
        // اشتراطه إطلاقاً في محرك القرار الفعلي (isEnclosedExemptFromHighWind
        // في dust-compliance-engine/engine.ts) — صوامع مغلقة + فلتر PM10
        // ≥99% يكفيان، بصرف النظر عن إغلاق المحطة فيزيائياً. بلا هذا الإصلاح،
        // شارة "بوابة الرياح التنظيمية" على بطاقات التوقعات الساعية كانت
        // تظهر "مفعَّلة" لمحطة خلط مكشوفة فعلياً معفاة، رغم أن قرار الامتثال
        // الفعلي (evaluateDustCompliance) لا يوقفها — تناقض مربك بين الشارة
        // الإعلامية والقرار الملزم الفعلي لنفس النشاط.
        //
        // نُحسَب هنا (قبل buildDustInput) لتمريرها لمحرك DVI الفيزيائي نفسه
        // أيضاً عبر input.isEnclosedDustExempt — طلب صريح من المستخدم:
        // "محطة الخلط لا تنتج غبار". قبل هذا، الاستثناء كان يؤثر فقط على
        // شارة بوابة الرياح المعروضة (isEnclosedOperation أدناه)، لا على
        // score/level الأساسي لمحرك DVI نفسه — فمحطة خلط معفاة فعلياً كانت
        // لا تزال تُقاس بمضاعف حساسية CONCRETE_POURING (0.55) كأي نشاط صب
        // خرسانة مكشوف عادي، فتظهر "قابل للتنفيذ مع مراقبة" رغم طقس ممتاز
        // ونشاط لا ينتج غباراً فعلياً (راجع computeDviResult في dust-engine/
        // engine.ts للتفصيل الكامل).
        const isBatchingPm10Exempt =
          (row.regulatory_activity ?? 'OTHER') === 'BATCHING_PLANT' &&
          row.silos_sealed === true &&
          typeof row.pm10_filter_efficiency_percent === 'number' &&
          row.pm10_filter_efficiency_percent >= BATCHING_PM10_FILTER_MIN_PERCENT();

        const input = buildDustInput(row, project, freshDevice);
        if (isBatchingPm10Exempt) input.isEnclosedDustExempt = true;

        const startIso = riyadhLocalToUtcIso(row.planned_date, row.planned_time);
        const durationHours = Math.max(1, Math.round(row.duration_hours || 1));
        if (!startIso) return null;

        // القسم 9 من "دليل الإصلاح الجذري لمنظومة مرقاب" — "لا تستدعِ
        // Open-Meteo قبل القرار الحي؛ احفظ قرار الجهاز فوراً، ثم اجلب
        // التوقعات في مسار إثراء منفصل لا يستطيع إسقاط القرار الحي أو
        // تأخيره". لنشاط حي (LIVE_OPERATIONAL، ضمن هامش ساعتين من بدايته)
        // مرتبط بجهاز: worst يُبنى فوراً عبر evaluateLiveOperationalDecision
        // (دالة نقية، صفر fetch، بلا await)، وshبكة hourly/bestWindow/
        // avoidWindow التوقّعية لا تُجلَب إطلاقاً لهذا المسار — تبقى فارغة/
        // null (نفس شكل buildAwaitingEvaluationWindow)، فلا يوجد أي مسار
        // شبكة يمكن أن يؤخر أو يُسقِط القرار المحفوظ. نشاط توقّعي بحت
        // (PLANNING) أو حي بلا جهاز يبقى بمساره القديم كاملاً
        // (evaluateDustVisibilityWindow، شبكة Open-Meteo الكاملة).
        const isLiveActivity = determineFinalDecisionMode(startIso) === 'LIVE_OPERATIONAL';
        const isLiveWithDevice = isLiveActivity && input.hasDeviceLink;

        const windowEval: DustWindowEvaluation = isLiveWithDevice
          ? {
              worst: evaluateLiveOperationalDecision(input),
              hourly: [],
              windowStartIso: startIso,
              windowEndIso: new Date(new Date(startIso).getTime() + durationHours * 3600000).toISOString(),
              durationHours,
              bestWindowStartIso: null,
              bestWindowWorst: null,
              avoidWindowStartIso: null,
              avoidWindowWorst: null,
            }
          : await evaluateDustVisibilityWindow(input, startIso, durationHours);
        const aei: AeiEvaluationResult = evaluateAei(windowEval.worst, input.regulatoryActivity);

        // توقعات ساعية عبر كامل ساعات دوام *يوم النشاط المجدول* (startIso)،
        // لا يوم فتح الصفحة. نشاط حي بجهاز مرتبط لا يستدعي الشبكة إطلاقاً
        // (نفس بوابة "صفر fetch" أعلاه بالضبط) — يقرأ بدلاً من ذلك لقطة
        // forecast_snapshots المخزَّنة مسبقاً (قد تكون فارغة إن لم يُشغَّل
        // مسار الإثراء بعد لهذا النشاط، فشل آمن نحو "لا شبكة توقعات معروضة"
        // بدل استدعاء الشبكة هنا). فشل جلب الشبكة لأي نشاط توقّعي/بلا جهاز
        // لا يُسقط تقييم النشاط بأكمله.
        const workDayHourly = isLiveWithDevice
          ? ((forecastSnapshotMap.get(row.activity_group_id || `dust-${row.id}`) ?? []) as DviHourlyEvaluation[])
          : await evaluateDustVisibilityWorkDayHourly(input, startIso).catch(() => []);

        // وسم كل ساعة (نافذة النشاط + كامل يوم الدوام) ببوابة الرياح
        // التنظيمية حتى تتماشى شبكة "توقعات الطقس طوال فترة الدوام" مع
        // قرار الامتثال، بدل الاعتماد فقط على عتبات DVI الفيزيائي المختلفة.
        const isDustGenerating = row.is_dust_generating ?? true;
        // خطأ مكتشَف ومُصلَح: كان row.is_enclosed_operation الخام يُمرَّر مباشرة
        // لأي نشاط غير محطة خلط، فتظهر شارة "بوابة الرياح غير مفعّلة" لأي
        // نشاط مغلق (هدم، حفر، إلخ) — نفس التناقض الموثَّق أعلاه، لكن بالاتجاه
        // المعاكس، بعد أن أصبح isEnclosedExemptFromHighWind في engine.ts
        // يقتصر الإعفاء فعلياً على محطة الخلط وحدها. isEnclosedOperation هنا
        // (اسم المتغيّر مضلِّل تاريخياً — فعلياً "هل معفى من بوابة الرياح؟")
        // الآن false لأي نشاط ليس محطة خلط معفاة، بصرف النظر عن إغلاقه
        // الفيزيائي، ليطابق قرار الامتثال الفعلي تماماً.
        const isEnclosedOperation = isBatchingPm10Exempt;
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
          regulatoryActivity: input.regulatoryActivity,
          windowEval: annotatedWindowEval,
          aei,
          hourlyForecasts: annotatedWorkDayHourly,
          // خطأ مكتشَف ومُصلَح (مراجعة كود خبير خارجي — C-06: "توقّع مستقبلي
          // قد يُحفظ بصفة LIVE"): startIso لازم في persistFinalDecisions
          // لتحديد mode الصحيح (LIVE_OPERATIONAL أو PLANNING) عند الحفظ —
          // نفس هامش ACTIVITY_LIVE_MARGIN_MS (30 دقيقة) المستخدَم داخل
          // dust-engine/engine.ts لتحديد isActivityLiveNow، لكن لم يكن هذا
          // الحقل مُصدَّراً هنا سابقاً فاعتمد persistFinalDecisions على
          // الافتراضي الدائم LIVE_OPERATIONAL بصرف النظر عن توقيت النشاط
          // الفعلي.
          startIso,
        };
      } catch (error) {
        console.error(`فشل تقييم الغبار للنشاط ${row.id}:`, error);
        return null;
      }
    })
  );
  return results.filter((r): r is NonNullable<typeof r> => r !== null);
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
  dustRows: DustActivityRow[],
  dustResults: { activityId: string }[],
  sensitiveReceptors: SensitiveReceptor[] = []
): Map<string, UnitReceptorGroup[]> {
  const rowsById = new Map<string, DustActivityRow>((dustRows || []).map((row) => [String(row.id), row]));
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
// شكل أدنى يكفي computeDustComplianceResults فعلياً (activityId/
// activityGroupId/startIso/windowEval.worst فقط — لا aei/hourlyForecasts
// التي يحملها DustResultItem الكامل) — نفس فلسفة AeiGateableActivity أعلاه.
export interface ComplianceEvaluatableActivity {
  activityId: string;
  activityGroupId?: string;
  startIso?: string;
  windowEval?: Pick<DustWindowEvaluation, 'worst'>;
}

// خطأ مكتشَف ومُصلَح (مراجعة كود خارجي — "التقييم بحسب وقت المعالجة قد
// يفوّت مخالفة كاملة"، راجع migration 202608110019 وتعليق evaluateProject.ts
// الكاملين): evaluationAtMs اختياري — يستبدل Date.now() الداخلي أدناه
// (evaluatedAtMs) حين يُمرَّر، ويُمرَّر أيضاً لـfetchPm10SustainedStatus
// (نافذة استعلام pm10_readings_history + computeSustainedPm10Status) —
// يسمح بإعادة بناء "ما كانت عليه حالة استمرار PM10 عند لحظة رصد محدَّدة"
// بدل "الآن الفعلي وقت تنفيذ هذه الدالة" فقط. previousDecisionsByGroup/
// RESUME-STABILITY-HOLD أعلاه في هذه الدالة (قراءة current_dust_compliance_
// decisions الحالية) تبقيان بلا تغيير عمداً — نطاق مضيَّق صريح، راجع تعليق
// evaluateProject.ts للسبب الكامل.
export async function computeDustComplianceResults(
  dustRows: DustActivityRow[],
  project: ProjectRow,
  dustResults: ComplianceEvaluatableActivity[],
  sensitiveReceptors: SensitiveReceptor[] = [],
  supabaseAdmin?: SupabaseClient,
  persistPm10Reading: boolean = false,
  evaluationAtMs?: number
): Promise<DustComplianceResultItem[]> {
  const rowsById = new Map<string, DustActivityRow>((dustRows || []).map((row) => [String(row.id), row]));

  // خطأ مكتشَف ومُصلَح (مراجعة خبير خارجي — "لا نظام إدارة قواعد حقيقي؛ لا
  // نشر، لا rollback"): getRuleParameters() (ruleParameters.ts) يُحدَّث مرة
  // واحدة فقط في بداية evaluateProject.ts (لا هنا أيضاً — قبل computeDustResults
  // وcomputeDustComplianceResults معاً، حتى لا يتباعد DVI عن Compliance في
  // نفس دورة التقييم). مسارات مستقلة تستدعي هذه الدالة مباشرة بلا المرور
  // عبر evaluateProject (نادرة، إن وُجدت) تعتمد على آخر قيم مُحدَّثة سابقاً
  // أو الافتراضي — نفس فشل آمن معتاد في هذا الملف.

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
    {
      decision: string;
      updated_at: string;
      raw_updated_at: string | null;
      pending_resume_since: string | null;
      deciding_rule_code: string | null;
    }
  >();
  // خطأ مكتشَف ومُصلَح (مراجعة كود خارجي — "فشل قراءة القرار السابق يُبتلع
  // ويزيل حماية الاستئناف"): previousDecisionsByGroup فارغة (Map جديدة) هي
  // الحالة الطبيعية لـ"لا نشاط مرتبط بأي قرار سابق بعد" — لا وسيلة قبل هذا
  // الإصلاح للتمييز بينها وبين "الاستعلام فشل فعلياً" (شبكة/قاعدة بيانات).
  // كلا الحالتين كانتا تُنتجان نفس الأثر: previousDecisionCategory=null لكل
  // نشاط، فيسقط previousWasStopped في engine.ts إلى false، وأي نشاط كان
  // موقوفاً فعلياً يُعامَل كأنه لم يُوقَف قط — يفقد حماية RESUME-STABILITY-HOLD
  // بالكامل بمجرد فشل شبكي عابر. previousDecisionQueryFailed أدناه يُميّز
  // الحالتين صراحة؛ يُستهلَك لاحقاً لكل نشاط لإجبار حالة HOLD بدل السماح
  // بقرار قد يكون استئنافاً زائفاً (راجع الاستهلاك أسفل هذه الدالة).
  let previousDecisionQueryFailed = false;
  if (supabaseAdmin) {
    const groupIds = Array.from(
      new Set((dustResults || []).map((r) => r.activityGroupId).filter(Boolean))
    );
    if (groupIds.length > 0 && project?.id) {
      try {
        // خطأ أمني معماري مكتشَف ومُصلَح (القسم 5.7/12.2 من "دليل الإصلاح
        // الجذري لمنظومة مرقاب" — "العزل بين المشاريع غير مكتمل"): كان هذا
        // الاستعلام يفلتر بـactivity_group_id وحده — قيمة حرة من العميل قد
        // تتصادم بين مشروعين، فيُقرأ "القرار السابق" لنشاط من مشروع مختلف
        // تماماً هنا (يؤثر على منطق استئناف/استقرار الإيقاف في engine.ts).
        // project.id ثابت طوال هذه الدالة (استدعاء واحد لمشروع واحد فقط)،
        // فإضافة .eq('project_id', ...) كافية ولا تحتاج مفتاحاً مركّباً هنا.
        const { data, error } = await supabaseAdmin
          .from('current_dust_compliance_decisions')
          .select('activity_group_id, decision, updated_at, stopped_since, pending_resume_since, deciding_rule_code')
          .eq('project_id', project.id)
          .in('activity_group_id', groupIds);
        // خطأ مكتشَف ومُصلَح: Supabase (postgrest-js) لا يرمي استثناءً عند
        // فشل الاستعلام على مستوى القاعدة (RLS/شبكة/timeout) — يُعيد
        // {data: null, error: {...}} بصمت، فيمر عبر try بلا الدخول لـcatch
        // إطلاقاً. الفحص الصريح لـerror هنا هو ما يكتشف الفشل فعلياً، لا
        // بنية try/catch وحدها.
        if (error) throw error;
        type PreviousComplianceDecisionRow = {
          activity_group_id: string;
          decision: string;
          updated_at: string;
          stopped_since: string | null;
          pending_resume_since: string | null;
          deciding_rule_code: string | null;
        };
        previousDecisionsByGroup = new Map(
          ((data as PreviousComplianceDecisionRow[]) || []).map((row) => [
            row.activity_group_id,
            {
              decision: row.decision,
              updated_at: row.stopped_since ?? row.updated_at,
              raw_updated_at: row.updated_at,
              pending_resume_since: row.pending_resume_since ?? null,
              deciding_rule_code: row.deciding_rule_code ?? null,
            },
          ])
        );
      } catch {
        // لا نُسقط التقييم بالكامل (نفس مبدأ resolveFreshProjectDevice) — لكن
        // نُسجِّل الفشل صراحة عبر previousDecisionQueryFailed بدل ابتلاعه
        // بصمت، ليُستهلَك أدناه ويمنع أي استئناف زائف لنشاط قد يكون موقوفاً
        // فعلياً بقرار لم نستطع قراءته.
        previousDecisionQueryFailed = true;
      }
    }
  }

  // خطأ حرج مكتشَف ومُصلَح (مراجعة كود خارجي — "اتجاه الرياح يُستخدم دون
  // توثيق الشمال الحقيقي"): جلب مجمَّع لتوثيق معايرة كل جهاز نشط بالمشروع —
  // نفس مبدأ previousDecisionsByGroup أعلاه (نداء واحد بدل نداء لكل نشاط).
  // يُستخدَم أدناه لبناء WindDirectionEvidence لكل نشاط عبر
  // resolveWindDirectionEvidence — راجع تعليقها الكامل لسبب عدم استخدام
  // last_wind_direction_deg الخام مباشرة في تحليل الانتشار المكاني بلا هذا
  // التوثيق. فشل الاستعلام (catch داخل resolveProjectDeviceMap نفسها غير
  // موجود — تعتمد على استعلامين منفصلين بلا try/catch) يعني ببساطة خريطة
  // فارغة، فتُعامَل كل الأجهزة كـUNVERIFIED (فشل آمن: لا اتجاه يدخل التحليل
  // المكاني بلا توثيق مؤكَّد).
  const deviceTrueNorthMap = supabaseAdmin && project?.id
    ? await resolveProjectDeviceMap(supabaseAdmin, project.id).catch(() => new Map<string, FreshDeviceReading | null>())
    : new Map<string, FreshDeviceReading | null>();

  const results = await Promise.all(
    (dustResults || []).map(async (r) => {
      try {
        const row = rowsById.get(r.activityId);
        const dviResult = r.windowEval?.worst;
        if (!row || !dviResult) return null;

        const linkedDevice = row.device_id ? deviceTrueNorthMap.get(row.device_id) ?? null : null;
        const mergedForWindSource = (dviResult as Partial<DviHourlyEvaluation>).mergedReading;
        const windDirectionEvidence = resolveWindDirectionEvidence(
          linkedDevice,
          mergedForWindSource?.windDirectionDeg ?? null,
          mergedForWindSource?.sources.windDirectionDeg ?? 'none'
        );

        // لحظة تقييم واحدة موحَّدة لكل هذا النشاط — تُمرَّر صراحة لكل من
        // buildComplianceContext (بوابة حداثة PM10) وevaluateDustCompliance
        // (now) بدل استدعاءين منفصلين لـ Date.now() قد يقعان نظرياً على
        // جانبين مختلفين من حد الحداثة (راجع تعليق evaluatedAtMs الكامل في
        // adapters.ts) — يضمن قابلية إعادة حساب نفس القرار لاحقاً بنفس
        // النتيجة تماماً.
        //
        // خطأ مكتشَف ومُصلَح (مراجعة كود خارجي — "التقييم بحسب وقت المعالجة
        // قد يفوّت مخالفة كاملة"): evaluatedAtMs يبقى Date.now() الفعلي عمداً
        // — يغذّي بوابة حداثة الجهاز (buildComplianceContext) وevaluateDustCompliance
        // (RESUME-STABILITY-HOLD وغيرها)، وهذه تبقى خارج نطاق evaluationAtMs
        // (قرار نطاق صريح، راجع تعليق evaluateProject.ts). pm10SustainedLookupMs
        // منفصل تماماً — يُستخدَم حصراً لاستدعاء fetchPm10SustainedStatus
        // أدناه (نافذة استمرار PM10 التاريخية)، فيعيد بناء "ما كانت عليه
        // حالة الاستمرار عند لحظة الرصد الفعلية" بمعزل عن حداثة الجهاز
        // الحالية أو حالة الاستئناف الحالية، اللتين تبقيان تُقاسان بالآن
        // الفعلي كما كانتا دائماً.
        const evaluatedAtMs = Date.now();
        const pm10SustainedLookupMs = evaluationAtMs ?? evaluatedAtMs;

        // طلب مستخدم صريح: نشاط PLANNING (توقّع طقس لوقت بدء لم يحن بعد، لا
        // قراءة جهاز — راجع ACTIVITY_LIVE_MARGIN_MS في dust-engine/engine.ts)
        // لا يجوز أن تُطبَّق عليه قاعدة RESUME-STABILITY-HOLD (استقرار 10
        // دقائق قبل الاستئناف بعد إيقاف سابق) — تلك القاعدة مصمَّمة لقراءات
        // متتابعة زمنياً حقيقية، لا نقطة توقّع مستقبلية واحدة. previousDecision
        // = null هنا يمنع تطبيقها ضمنياً (راجع تعليق previousDecision في
        // buildComplianceContext: غيابه يعني "لا قيد" لا خطأً) — بلا حاجة
        // لتعديل محرك الامتثال نفسه. سيناريو نادر لكن ممكن: نشاط عُدِّل موعده
        // ليصبح PLANNING بعد أن كان LIVE_OPERATIONAL وموقوفاً فعلياً؛ تجاهل
        // ذلك القرار السابق هنا صحيح لأن التقييم الحالي لا يمثّل استمراراً
        // فعلياً لتلك الحالة أصلاً (توقّع منفصل تماماً، لا مصدره جهاز).
        const mode = determineFinalDecisionMode(r.startIso);
        const previousDecision =
          mode === 'PLANNING' || !r.activityGroupId ? null : previousDecisionsByGroup.get(r.activityGroupId) ?? null;
        // نفس شرط previousDecision أعلاه بالضبط — PLANNING/بلا activityGroupId
        // لا معنى لهما لحماية استئناف أصلاً (raisin: لا previousDecision
        // مُطبَّق أصلاً في تلك الحالات)، فلا يجوز أن يفرض فشل الاستعلام حالة
        // HOLD على تقييم توقّعي بحت.
        const activityQueryFailed = mode !== 'PLANNING' && !!r.activityGroupId && previousDecisionQueryFailed;

        // بناء أولي لقراءة pm10UgM3/dataSource فقط (بلا استمرار بعد) — يلزم
        // معرفة القراءة الحالية قبل تسجيلها في السجل التاريخي وجلب استمرارها.
        const preliminaryCtx = buildComplianceContext(
          project,
          row,
          dviResult,
          sensitiveReceptors,
          previousDecision,
          null,
          evaluatedAtMs,
          activityQueryFailed,
          false,
          windDirectionEvidence
        );

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
        // خطأ حرج مكتشَف ومُصلَح (راجع تعليق Pm10SustainedFetchResult الكامل
        // أعلى fetchPm10SustainedStatus): queryFailed=true فقط عند فشل
        // استعلام حقيقي، لا عند نجاحه بصفر صفوف — يُمرَّر لمحرك الامتثال
        // ليصدر FIELD_VERIFICATION_REQUIRED صراحة بدل معاملة الفشل كـ"لا
        // مخالفة".
        let pm10HistoryQueryFailed = false;
        // خطأ حرج مكتشَف ومُصلَح (مراجعة كود خارجي — تفصيل تنفيذ
        // pm10HistoryFailureCode/pm10TemporalEvidenceState في types.ts):
        // يُبنيان معاً أدناه من pm10Fetch نفسه — نفس مصدر الحقيقة الوحيد
        // (لا اشتقاق مستقل).
        let pm10HistoryFailureCode: 'PM10_HISTORY_QUERY_FAILED' | null = null;
        let pm10TemporalEvidenceState: 'AVAILABLE' | 'NO_READINGS' | 'QUERY_FAILED' = 'NO_READINGS';
        if (supabaseAdmin && r.activityGroupId && project?.id) {
          // خطأ حرج مكتشَف ومُصلَح (مراجعة كود خارجي — "المسار القديم للتنبيهات
          // ينافس Outbox ويصنع قراءات PM10 وهمية"): كان الفرع 'onsite' هنا
          // يعيد إدراج onsite_pm10 (حقل ثابت على project_dust_profiles، لا
          // قراءة جديدة) في pm10_readings_history بوقت recorded_at جديد في كل
          // مرة يُستدعى فيها evaluateProject() — أي دورة تقييم حية (ingest
          // جهاز، إعادة محاولة مزوّد، تكة مجدول) عبر persistPm10Reading=true
          // (evaluateProject.ts) تحوّل قياساً يدوياً واحداً حقيقياً إلى سلسلة
          // زمنية تبدو مستمرة زوراً — بالضبط النمط الذي يبني عليه pm10ThresholdRule
          // "مخالفة مستمرة" (RCRC-PM10-340-VIOLATION-011) خطأً. القياس اليدوي
          // الحقيقي الآن يدخل حصراً عبر endpoint مستقل (POST /api/pm10-readings/
          // manual) يحمل observed_at/operator_id/idempotency_key الخاصين به —
          // لا كأثر جانبي لقراءة onsite_pm10 المعروضة فقط. فرع 'weather' أدناه
          // غير مرتبط بهذا الخلل (جدول منفصل evidence_eligible=false) ويبقى كما هو.
          if (persistPm10Reading && preliminaryCtx.pm10UgM3 !== null) {
            if (preliminaryCtx.pm10Source === 'weather') {
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
          const pm10Fetch = await fetchPm10SustainedStatus(
            supabaseAdmin,
            project.id,
            r.activityGroupId,
            row.device_id ?? null,
            pm10SustainedLookupMs
          );
          pm10Sustained = pm10Fetch.status;
          pm10HistoryQueryFailed = pm10Fetch.queryFailed;
          pm10HistoryFailureCode = pm10Fetch.failureCode;
          pm10TemporalEvidenceState = pm10Fetch.queryFailed
            ? 'QUERY_FAILED'
            : pm10Fetch.readingCount > 0
            ? 'AVAILABLE'
            : 'NO_READINGS';
        }

        const ctx = buildComplianceContext(
          project,
          row,
          dviResult,
          sensitiveReceptors,
          previousDecision,
          pm10Sustained,
          evaluatedAtMs,
          activityQueryFailed,
          pm10HistoryQueryFailed,
          windDirectionEvidence,
          pm10HistoryFailureCode,
          pm10TemporalEvidenceState
        );
        // isPlanning=true: طلب مستخدم صريح — نشاط PLANNING لا يُصدر أي قرار
        // امتثال إلزامي (STOP/تعليق) مهما بلغت قيم التوقّع، فقط نص "تصلح/لا
        // تصلح" (راجع buildPlanningForecastResult في engine.ts).
        const result = evaluateDustCompliance(ctx, evaluatedAtMs, mode === 'PLANNING');
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
  return results.filter((r): r is NonNullable<typeof r> => r !== null);
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
export interface HourlyComplianceEntry {
  time: string;
  result: DustComplianceResult;
  aei: AeiEvaluationResult;
}

export function computeDustComplianceHourly(
  dustRows: DustActivityRow[],
  project: ProjectRow,
  dustResults: DustResultItem[],
  sensitiveReceptors: SensitiveReceptor[] = []
): Map<string, HourlyComplianceEntry[]> {
  const rowsById = new Map<string, DustActivityRow>((dustRows || []).map((row) => [String(row.id), row]));
  const byActivityId = new Map<string, HourlyComplianceEntry[]>();

  (dustResults || []).forEach((r) => {
    try {
      const row = rowsById.get(r.activityId);
      if (!row) return;

      // نفس fallback الموجود أصلاً في DustWidgetCard (hasWorkDayHourly ?
      // hourlyForecasts : windowEval.hourly): توقعات ساعات الدوام كاملة إن
      // توفرت (الحالة الشائعة)، وإلا نافذة النشاط المجدولة فقط — بدل ترك
      // الشبكة فارغة بصمت متى فشل جلب توقعات كامل اليوم أو وقعت خارج
      // ساعات الدوام الافتراضية بينما نافذة النشاط نفسها متوفرة.
      const hourly: DviHourlyEvaluation[] =
        r.hourlyForecasts && r.hourlyForecasts.length > 0
          ? (r.hourlyForecasts as DviHourlyEvaluation[])
          : (r.windowEval?.hourly ?? []);
      if (hourly.length === 0) return;

      const hourlyCompliance = hourly.map((hour) => {
        const hourEvaluatedAtMs = Date.now();
        const ctx = buildComplianceContext(project, row, hour, sensitiveReceptors, null, null, hourEvaluatedAtMs);
        // isPlanning=true: كل ساعة هنا توقّع طقس بحت (شبكة hourly كاملة) —
        // نفس السبب بالضبط الذي يمنع STOP/تعليق إلزامي على PLANNING أعلاه
        // بـcomputeDustComplianceResults، راجع buildPlanningForecastResult.
        const result = evaluateDustCompliance(ctx, hourEvaluatedAtMs, true);
        const rawAei = evaluateAei(hour, toRegulatoryDustActivityKey(row.regulatory_activity));
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
export function applyFinalDecisionToAei(aei: AeiEvaluationResult, decision: FinalDecision, compliance: DustComplianceResult | null): AeiEvaluationResult {
  // خطأ مكتشَف ومُصلَح (طلب صريح من المستخدم — "ابغاه يطلع نفس كذا في
  // التوقعات المستقبلية... بدون قرار، فقط تنبيه إذا الأجواء مناسبة أو لا"):
  // decideFinal بوضع PLANNING (راجع الفرع الكامل أعلى الدالة في
  // final-decision-engine/engine.ts) يُنتج operationalDecision='ALLOW' أو
  // 'MONITOR' فقط (لا MANDATORY_STOP/RESTRICT إطلاقاً — توقّع طقس لساعة لم
  // تأتِ بعد لا يجوز أن يصدر قراراً ملزماً). بلا هذا الفرع هنا، حالة
  // "MONITOR" لتوقّع PLANNING غير مناسب كانت تسقط في فرع "MONITOR && score
  // > CAP" العام أدناه (نفس الفرع المخصَّص لتقييد امتثال تنظيمي حقيقي حي)،
  // فتُعرض بلون أحمر "تقييد تشغيلي — امتثال تنظيمي" بدل الأصفر التوعوي
  // الصحيح "تنبيه: أجواء متوقعة غير مناسبة" الظاهر فعلياً في البطاقة
  // الرئيسية لنفس النشاط عبر decision.shortReasonAr/decisionLabelAr نفسها
  // — تناقض بصري مباشر بين البطاقة الإجمالية وشبكة الساعات القادمة لنفس
  // النشاط ونفس decideFinal بالضبط. يُفحَص أولاً (قبل حتى HOLD_FOR_VERIFICATION
  // تحته) لأن "تحقق ميداني" لا معنى له لساعة توقّعية لم تبدأ بعد أصلاً.
  if (decision.mode === 'PLANNING') {
    const isFavorable = decision.operationalDecision === 'ALLOW';
    return {
      ...aei,
      status: isFavorable ? aei.status : 'MONITOR',
      statusLabelAr: decision.decisionLabelAr,
      color: isFavorable ? aei.color : 'YELLOW',
      shortReasonAr: decision.shortReasonAr,
      recommendationAr: isFavorable
        ? aei.recommendationAr
        : 'راجع توقعات الساعات القادمة قبل البدء — لا قرار ملزم على توقّع طقس، فقط تنبيه توعوي.',
    };
  }

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
export const NEUTRAL_DVI_FALLBACK: DviEvaluationResult = {
  indicatorType: 'DVI',
  dviBase: 0,
  score: 0,
  level: 'GREEN',
  causeClassification: 'DUST',
  decisionCategory: 'ALLOW',
  decisionLabelAr: 'مسموح — تشغيل اعتيادي',
  mandatoryStop: false,
  overridable: true,
  stopBasis: 'NONE',
  confirmationState: 'NOT_APPLICABLE',
  channels: {
    visibilityRisk: 0,
    particulateRisk: 0,
    windTransportRisk: 0,
    dustForecastRisk: 0,
    siteDustGenerationRisk: 0,
    adjustedSiteDustGenerationRisk: 0,
    externalHazard: 0,
    internalDustHazard: 0,
  },
  multipliers: {
    activitySensitivity: 0,
    activitySensitivityMultiplier: 1,
    receptorSensitivity: 0,
    downwindAlignment: 0,
    distanceFactor: 1,
    receptorImpact: 0,
    receptorSensitivityMultiplier: 1,
  },
  visibilityKm: null,
  effectiveWindKmh: null,
  // بديل ALLOW محايد تماماً (راجع تعليق الدالة أعلاه) — لا جهاز فعلي هنا
  // إطلاقاً، فلا معنى لـ"جهاز مرتبط لكن الرؤية غائبة" تحديداً.
  visibilityDataMissing: false,
  dustExposureHigh: false,
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

// يحوّل صفاً مخزَّناً من final_decisions (StoredFinalDecisionRow، راجع
// تعريفها أعلى الملف) إلى الحقول الخمسة الوحيدة التي تقرأها
// applyFinalDecisionToAei فعلياً من decision (operationalDecision/
// shortReasonAr/decisionLabelAr/pendingConfirmation/mandatoryStop) — لا
// حاجة لبناء FinalDecision كامل هنا، فقط الحقول المُستهلَكة فعلياً.
function storedRowToPartialFinalDecision(row: StoredFinalDecisionRow): Pick<FinalDecision, 'operationalDecision' | 'shortReasonAr' | 'decisionLabelAr' | 'pendingConfirmation' | 'mandatoryStop'> {
  return {
    operationalDecision: row.operational_decision,
    shortReasonAr: row.short_reason_ar ?? '',
    decisionLabelAr: row.decision_label_ar,
    pendingConfirmation: row.pending_confirmation,
    mandatoryStop: row.mandatory_stop,
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
//
// خطأ أمني معماري مكتشَف ومُصلَح (القسم 5.7/12.2 من "دليل الإصلاح الجذري
// لمنظومة مرقاب"): finalDecisionsByGroup مصدرها الآن fetchLatestFinalDecisions
// بمفتاح مركّب activityDecisionKey(projectId, activityGroupId) — projectId
// إلزامي هنا (لا اختياري) ليُبنى نفس المفتاح المركّب عند القراءة، فلا يُقرأ
// أبداً قرار من مشروع آخر ولو تصادف activityGroupId بين مشروعين.
// شكل أدنى يكفي applyComplianceGatesToDustAei فعلياً (لا تحتاج activityType/
// hourlyForecasts/unitReceptors التي يحملها DustResultItem الكامل) — يتيح
// لمستهلكين اختباريين بناء حمولة مبسَّطة (activityId/aei/compliance فقط)
// بلا اضطرار لملء كل حقول DustResultItem الإنتاجية غير المُستخدَمة هنا.
export interface AeiGateableActivity {
  activityId: string;
  activityGroupId?: string;
  startIso?: string;
  aei: AeiEvaluationResult;
  compliance?: DustComplianceResult | null;
  windowEval?: { worst: DviEvaluationResult };
}

export function applyComplianceGatesToDustAei(
  dustResults: AeiGateableActivity[],
  projectId: string,
  finalDecisionsByGroup?: Map<string, StoredFinalDecisionRow>
): void {
  (dustResults || []).forEach((r) => {
    if (!r?.aei) return;
    // خطأ مكتشَف ومُصلَح — طلب صريح من المستخدم: "شوف الفرق" (البانر العلوي
    // عرض "تنبيه: أجواء متوقعة غير مناسبة" أصفر بشكل صحيح، بينما بطاقة AEI
    // الرئيسية تحتها مباشرة — لنفس النشاط، نفس اللحظة، نفس PM10=1557.2 —
    // عرضت مرة "قابل للتنفيذ مع مراقبة" برتقالي ومرة "بيئة العمل غير آمنة
    // (مغلق)" أسود، بين تحميلين متتاليين لنفس الصفحة). السبب: mode لم تكن
    // تُحسَب هنا إطلاقاً (buildFinalDecisionInput تثبت دائماً على الافتراضي
    // LIVE_OPERATIONAL بصرف النظر عن توقيت النشاط الفعلي — نفس العلة
    // الموثَّقة في computeUnifiedActivityDecision أدناه، لم تُصلَح هنا سابقاً)،
    // وstoredRow (قرار final_decisions مخزَّن من دورة سابقة، قد تكون
    // LIVE_OPERATIONAL محسوبة قبل أن يدخل النشاط PLANNING أو بعده) كان
    // يُستخدَم مباشرة بلا أي فحص لتطابقه مع وضع النشاط الحالي — فيتذبذب
    // العرض بين "حساب حي PLANNING صحيح" و"قرار مخزَّن قديم مختلف السياق"
    // حسب توقيت الطلب فقط.
    const mode = determineFinalDecisionMode(r.startIso);
    const storedRow =
      mode === 'PLANNING' || !r.activityGroupId
        ? undefined
        : finalDecisionsByGroup?.get(activityDecisionKey(projectId, r.activityGroupId));
    let decision: Pick<FinalDecision, 'mode' | 'operationalDecision' | 'shortReasonAr' | 'decisionLabelAr' | 'pendingConfirmation' | 'mandatoryStop'>;
    if (storedRow) {
      decision = { ...storedRowToPartialFinalDecision(storedRow), mode };
    } else {
      const dvi: DviEvaluationResult = r.windowEval?.worst ?? NEUTRAL_DVI_FALLBACK;
      const finalInput = buildFinalDecisionInput(r.activityGroupId ?? r.activityId ?? 'unknown', dvi, r.compliance ?? null, r.aei, mode);
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

// خطأ معماري حرج مكتشَف ومُصلَح (مراجعة خبير خارجي — "القرار المعروض قد
// يختلف عن القرار المحفوظ"): كان الدمج بين decideFinal وaei ("الأشد يحكم"
// على level/النص) يحدث هنا فقط، حياً وقت العرض — بلا أي انعكاس على النتيجة
// المخزَّنة في final_decisions (persistFinalDecisions يستدعي decideFinal
// مباشرة بلا هذه الطبقة). فيبقى المخزَّن (وأي مسار يقرأه مباشرة —
// fetchLatestFinalDecisions، summaryFromStoredDecision، dashboard/global،
// alerts/generate) أخفّ دائماً مما تعرضه أي شاشة تستدعي هذه الدالة حياً لنفس
// النشاط في نفس اللحظة (مثال فعلي: ALLOW/GREEN محفوظ مقابل MONITOR/YELLOW
// معروض). الإصلاح: نفس منطق الدمج بالضبط نُقل إلى decideFinal نفسها (المصدر
// الوحيد المسموح له بإنتاج قرار، راجع types.ts) — decideFinal الآن تقرأ
// input.aei فعلياً وتُطبِّق "الأشد يحكم" داخلياً قبل إرجاع النتيجة، فتُحفَظ
// نتيجة الدمج نفسها في final_decisions ولا تختلف عن أي عرض حي لاحق. هذه
// الدالة أصبحت غلافاً رقيقاً بلا أي دمج AEI خاص بها.
export function computeUnifiedActivityDecision(
  dviWorst: DviEvaluationResult,
  compliance: DustComplianceResult | null,
  aei?: AeiEvaluationResult | null,
  // خطأ مكتشَف ومُصلَح (طلب مستخدم — "نشاط سيبدأ بعد 10 ساعات يظهر له
  // 'تعذّر اعتماد قرار واثق: بيانات قديمة'، رغم أن هذا متوقّع تماماً لنشاط
  // مستقبلي بعيد"): buildFinalDecisionInput كانت تُستدعى هنا بلا mode
  // إطلاقاً، فتثبت دائماً على الافتراضي LIVE_OPERATIONAL بصرف النظر عن توقيت
  // النشاط الفعلي — بعكس evaluateProject/persistFinalDecisions اللذين
  // يحسبان mode الصحيح عبر determineFinalDecisionMode(startIso) قبل الحفظ.
  // النتيجة: القرار *المخزَّن* بقاعدة البيانات صحيح (PLANNING)، لكن بانر
  // "القرار الموحد" بالواجهة (summaryFromLiveDecision في route.ts، يعيد
  // الحساب حياً بدل القراءة من المخزَّن) كان يفرض evidenceUnavailable خطأً
  // لأي نشاط مستقبلي له جهاز مرتبط. startIso اختياري هنا: تمريره يحسب mode
  // الصحيح عبر نفس determineFinalDecisionMode المستخدَمة بمسار الحفظ؛ غيابه
  // (استدعاءات قديمة لا تملك توقيت النشاط) يبقي LIVE_OPERATIONAL كافتراضي
  // آمن كما كان — بلا كسر توافقي.
  startIso?: string | null
): UnifiedActivityDecision {
  const mode = determineFinalDecisionMode(startIso);
  const decision = decideFinal(buildFinalDecisionInput('unified', dviWorst, compliance, aei ?? null, mode));

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
// خطأ مكتشَف ومُصلَح (مراجعة كود خبير خارجي — C-06: "توقّع مستقبلي قد
// يُحفظ بصفة LIVE"): buildFinalDecisionInput (عبر persistFinalDecisions
// أدناه) كانت تُستدعى دائماً بوضعها الافتراضي LIVE_OPERATIONAL، بصرف النظر
// عن كون windowEval.worst يمثّل قراءة جهاز حية فعلاً أم توقّع طقس مستقبلي
// (نشاط يبدأ بعد أكثر من ساعتين — راجع ACTIVITY_LIVE_MARGIN_MS/
// isActivityLiveNow في dust-engine/engine.ts، نفس الهامش بالضبط يُطبَّق
// هنا؛ كان 30 دقيقة، أصبح ساعتان بطلب صريح — "جهاز الرصد يتفعّل قبل ساعتين
// من بداية النشاط"). حفظ توقّع مستقبلي بصفة LIVE_OPERATIONAL في
// final_decisions يعني تسجيله كقرار تشغيلي حي رسمي رغم أنه لم يحدث بعد،
// ويُقرَأ لاحقاً (بانر/خريطة/تنبيهات) وكأنه القرار الفعلي الحالي.
//
// دالة نقية مستقلة (تقبل nowMs صراحة، لا Date.now() ضمنياً — نفس مبدأ H-07
// في dust-compliance-engine/engine.ts) لتبقى قابلة للاختبار بمعزل عن أي
// اتصال قاعدة بيانات.
//
// طلب مستخدم صريح (بلاغ مباشر: "لا تسجيل مخالفة قبل بدء النشاط فعلياً"):
// كان هامش ساعتين (ACTIVITY_LIVE_MARGIN_MS) يُطبَّق هنا أيضاً — بمعنى نشاط
// سيبدأ خلال ساعتين يُعامَل LIVE_OPERATIONAL فعلياً (مخالفات حقيقية ممكن
// تُسجَّل في final_decisions/current_dust_compliance_decisions)، رغم أنه
// لم يبدأ بعد. هذا الهامش (سبب وجوده أصلاً: "جهاز الرصد يتفعّل قبل ساعتين
// من بداية النشاط") يبقى مناسباً لعرض القراءات الحية في الرسوم البيانية
// (device-readings-history/pm10-history routes، WINDOW_START_MARGIN_MS)،
// لكنه غير مناسب هنا: قراءة سيئة تصل قبل البداية بساعتين لا يجوز أن تُنتج
// "مخالفة تنظيمية" رسمية لنشاط لم يبدأ. الإصلاح: PLANNING يبقى سارياً حتى
// اللحظة الفعلية لـplanned_time بالضبط (بلا هامش)، لا قبلها بساعتين —
// تسجيل المخالفات مقصور الآن على الأنشطة الجارية فعلياً فقط.
export function determineFinalDecisionMode(
  startIso: string | null | undefined,
  nowMs: number = Date.now()
): 'LIVE_OPERATIONAL' | 'PLANNING' {
  const startMs = startIso ? new Date(startIso).getTime() : NaN;
  return !Number.isNaN(startMs) && nowMs < startMs ? 'PLANNING' : 'LIVE_OPERATIONAL';
}

// =========================================================================
// خطأ معماري مكتشَف ومُصلَح (مراجعة كود خبير خارجي — C-04: "حفظ القرار غير
// ذري"): كانت هنا ثلاث دوال منفصلة (persistDustEvaluations/
// persistDustComplianceEvaluations/persistFinalDecisions)، كل واحدة تكتب
// جدولها الخاص بمعزل عن الأخرى — نفس شكل الفشل: فشل مرحلة وسطى يترك "DVI
// محفوظ بلا FinalDecision مقابل". حُذفت الثلاث نهائياً (طلب مستخدم صريح —
// فحص شامل لكل كود ميت بالمشروع؛ صفر مستدعٍ فعلي لأي منها في أي مكان،
// حتى الاختبارات، بعد أن حل محلها persistActivityDecisionsAtomic أدناه منذ
// فترة): تحسب بالضبط نفس ما كانت تحسبه الدوال الثلاث (نفس shouldSkipPersist/
// computeStoppedSince/computePendingResumeSince/decideFinal بلا أي تغيير في
// المنطق)، لكن تجمع نتيجة الحساب لكل نشاط في استدعاء واحد لدالة SQL
// persist_activity_decision_atomic (راجع 202607290007_atomic_decision_
// persist.sql) تكتب الجداول الثلاثة معاً ضمن معاملة PostgreSQL واحدة —
// فشل أي مرحلة يُرجع كل الكتابات الخمس لنفس النشاط لحالتها قبل الاستدعاء.
export interface ActivityDecisionPersistResult {
  activityId: string;
  // جديد (202608160004 — المشكلة 4: "React ما زالت تحسب DVI/AEI وتعرض
  // الحفظ كتقييم رسمي"): يسمح للمستدعي (POST /evaluate) بمطابقة القرار
  // الرسمي بنشاط محدد عبر activity_group_id، لا فقط activityId (صف
  // project_dust_profiles) — الواجهة تحتاج التحقق من نشاطها تحديداً.
  activityGroupId: string;
  dviPersisted: boolean;
  compliancePersisted: boolean;
  finalDecisionPersisted: boolean;
  // معرّف صف final_decisions المُدرَج فعلياً هذه الدورة — موجود فقط إذا
  // finalDecisionPersisted=true، وإلا null (لم يُصدَر قرار جديد هذه الدورة،
  // أو تخطّته shouldSkipPersist/v_skip_final).
  finalDecisionId: string | null;
  failed: boolean;
  // true فقط إذا كان الفشل تعارض CAS قابل لإعادة المحاولة (كود 40001 —
  // current_dust_decisions/current_dust_compliance_decisions تغيّرا منذ
  // قراءتهما في هذه الدورة)، لتمييزه عن فشل حقيقي (شبكة، قيد، إلخ) يحتاج
  // تدخلاً بدل إعادة محاولة بسيطة في الدورة التالية.
  conflict: boolean;
}

// القسم 20 (Definition of Done، بند 7) — بصمة SHA-256 حتمية لمدخلات
// decideFinal الفعلية (dvi + compliance + aei + mode) التي أنتجت هذا القرار
// بالضبط — لا تعتمد على ترتيب مفاتيح الكائن (JSON.stringify(input, sortedKeys))
// حتى تبقى نفس المدخلات تُنتج نفس البصمة دائماً بصرف النظر عن ترتيب بناء
// الكائن في الكود. لا تُخزَّن المدخلات الكاملة هنا (موجودة أصلاً كـjsonb في
// dust_evaluations/dust_compliance_evaluations) — فقط بصمة تسمح بإثبات
// التطابق لاحقاً.
//
// خطأ مكتشَف ومُصلَح (مراجعة خبير خارجي — "بصمة القرار لا تشمل AEI رغم أن
// AEI قد يغير القرار المعروض؛ قد يتغير القرار دون أن تتغير البصمة"): بعد
// دمج AEI داخل decideFinal نفسها (راجع تعليق aeiIsMoreSevere في
// final-decision-engine/engine.ts)، أصبح aei قادراً فعلياً على تغيير
// level/decisionLabelAr/shortReasonAr المخزَّنة في final_decisions — فكانت
// هذه البصمة (dvi+compliance+mode فقط) قد تبقى مطابقة تماماً بين تقييمَين
// نتج عنهما قراران مختلفان فعلياً (تغيّر aei وحده)، مبطلة الغرض الكامل من
// البصمة (إثبات "نفس المدخلات تنتج نفس القرار"). aei معامل رابع اختياري
// (لا يكسر أي استدعاء قديم) — تمريره الآن إلزامي عملياً من نقطة الاستدعاء
// الوحيدة الفعلية (persistActivityDecisionsAtomic أدناه).
//
// خطأ مكتشَف ومُصلَح (طلب صريح من المستخدم — "جودة الدليل تعتمد على
// Date.now() بدل وقت التقييم، بينما بصمة المدخلات لا تشمل evaluatedAt أو
// evidenceQuality؛ قد ينتج replay لاحق قراراً مختلفاً لنفس البصمة"): نفس
// المشكلة التي أدت لإضافة aei أعلاه — evidenceQuality (final-decision-engine/
// adapters.ts) قادرة فعلياً على قلب operationalDecision بين MANDATORY_STOP
// وHOLD_FOR_VERIFICATION (راجع evidenceUnavailable في engine.ts)، فبقيت
// البصمة قابلة للتطابق بين قرارين مختلفين فعلياً لو تغيّرت وحدها. evidenceQuality
// معامل خامس اختياري (لا يكسر أي استدعاء قديم)، تمريره الآن إلزامي عملياً
// من نقطة الاستدعاء الوحيدة الفعلية (decision.evidenceQuality بعد decideFinal
// مباشرة). evaluatedAt نفسه يبقى خارج البصمة عمداً — هو طابع زمني توثيقي
// لوقت الحفظ، لا مُدخلاً يغيّر القرار بذاته (بخلاف evidenceQuality المشتقة
// منه وتؤثر فعلياً)؛ تضمينه كان سيجعل البصمة تتغيّر لمجرد إعادة تشغيل نفس
// التقييم بالضبط في لحظة مختلفة، بلا أي تغيّر حقيقي في المدخلات المحسوبة.
export function computeInputSnapshotHash(
  dvi: DviEvaluationResult,
  compliance: DustComplianceResult | null,
  mode: string,
  aei: AeiEvaluationResult | null = null,
  evidenceQuality: string | null = null
): string {
  const sortedStringify = (value: unknown): string =>
    JSON.stringify(value, (_key, val) => {
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        return Object.keys(val)
          .sort()
          .reduce((acc: Record<string, unknown>, k) => {
            acc[k] = (val as Record<string, unknown>)[k];
            return acc;
          }, {});
      }
      return val;
    });
  const snapshot = sortedStringify({ dvi, compliance, aei, mode, evidenceQuality });
  return createHash('sha256').update(snapshot).digest('hex');
}

export async function persistActivityDecisionsAtomic(
  supabaseAdmin: SupabaseClient,
  projectId: string,
  dustResults: DustResultItem[],
  complianceResults: DustComplianceResultItem[],
  dviTriggeredBy: string,
  complianceTriggeredBy: string,
  // القسم 20، بند 7 — يُنسَخ حرفياً إلى final_decisions.evaluation_run_id
  // وdecision_alert_outbox.evaluation_run_id لكل نشاط يُحفَظ في هذه الدورة
  // (evaluateProject ينشئ صف evaluation_runs واحداً لكل دورة تقييم كاملة،
  // راجع evaluateProject.ts). null للاستدعاءات القديمة/الاختبارات التي لا
  // تُنشئ evaluation_runs بعد (توافقي، فشل آمن).
  evaluationRunId: string | null = null,
  // خطأ مكتشَف (مراجعة تدقيق — "لا تُحفظ معرفات نسخ المعاملات مع القرار"):
  // بصمة rule_parameter_versions.id لكل معامل PUBLISHED فعلياً وقت هذه
  // الدورة (من getActiveParameterVersionIds() بعد refreshRuleParameters في
  // evaluateProject.ts) — تُخزَّن حرفياً في final_decisions.rule_parameter_
  // version_snapshot لكل نشاط يُحفَظ. null للاستدعاءات القديمة/الاختبارات
  // (توافقي).
  ruleParameterVersionSnapshot: Record<string, string> | null = null
): Promise<ActivityDecisionPersistResult[]> {
  const complianceByActivityId = new Map<string, DustComplianceResultItem>(
    (complianceResults || []).map((r) => [r.activityId, r])
  );

  const results = await Promise.all(
    (dustResults || []).map(async (r): Promise<ActivityDecisionPersistResult> => {
      const base = { activityId: r.activityId, activityGroupId: r.activityGroupId, dviPersisted: false, compliancePersisted: false, finalDecisionPersisted: false, finalDecisionId: null, failed: false, conflict: false };
      try {
        // ------------------------------------------------------------
        // 1) DVI — نفس منطق shouldSkipPersist في persistDustEvaluations
        // ------------------------------------------------------------
        const worst = r.windowEval?.worst;
        let dviPayload: { result: DviEvaluationResult; expectedUpdatedAt: string | null } | null = null;
        if (worst) {
          const newDviDecision = worst.decisionCategory ?? 'UNKNOWN';
          const { data: existingDvi } = await supabaseAdmin
            .from('current_dust_decisions')
            .select('decision, updated_at')
            .eq('project_id', projectId)
            .eq('activity_group_id', r.activityGroupId)
            .maybeSingle();
          const skipDvi = shouldSkipPersist(existingDvi?.decision, existingDvi?.updated_at, newDviDecision);
          if (!skipDvi) {
            dviPayload = { result: worst, expectedUpdatedAt: existingDvi?.updated_at ?? null };
          }
        }

        // ------------------------------------------------------------
        // 2) Compliance — نفس منطق persistDustComplianceEvaluations
        //    (pendingResumeChanged يمنع التخطي حتى لو بقي newDecision نفسه)
        // ------------------------------------------------------------
        const complianceEntry = complianceByActivityId.get(r.activityId);
        let compliancePayload:
          | { result: DustComplianceResult; expectedUpdatedAt: string | null; stoppedSince: string | null; pendingResumeSince: string | null }
          | null = null;
        if (complianceEntry) {
          const newComplianceDecision = complianceEntry.result?.decisionCategory ?? 'UNKNOWN';
          const resumeHoldApplied = Boolean(complianceEntry.result?.resumeHoldApplied);
          const { data: existingCompliance } = await supabaseAdmin
            .from('current_dust_compliance_decisions')
            .select('decision, updated_at, stopped_since, pending_resume_since')
            .eq('project_id', projectId)
            .eq('activity_group_id', r.activityGroupId)
            .maybeSingle();

          const pendingResumeSince = computePendingResumeSince(existingCompliance?.pending_resume_since, resumeHoldApplied);
          const pendingResumeChanged = (existingCompliance?.pending_resume_since ?? null) !== pendingResumeSince;
          // خطأ مكتشَف ومُصلَح (مراجعة كود خارجي — "انقطاع البيانات يُحسب ضمن
          // مدة الاستقرار"، البند: "فجوة أكبر من 90 ثانية تصفّر العداد"):
          // كان skipCompliance يتخطى الكتابة (throttle 5 دقائق، shouldSkipPersist)
          // طوال نافذة الاستقرار كاملها طالما القرار لم يتغيّر، فيبقى updated_at
          // (المصدر الوحيد لاكتشاف فجوة تقييم فعلية في engine.ts عبر
          // previousEvaluationUpdatedAt) قديماً بتصميم لا بانقطاع حقيقي —
          // يجعل اكتشاف الفجوة (>90 ثانية) غير موثوق تماماً أثناء الاستقرار.
          // resumeHoldApplied=true يتجاوز الـthrottle الآن بالكامل (لا فقط
          // pendingResumeChanged عند بداية/نهاية الاستقرار) — updated_at يعكس
          // فعلياً "آخر دورة تقييم حقيقية" طوال نافذة الـ10 دقائق، فتصبح
          // مقارنة الفجوة في engine.ts موثوقة.
          const skipCompliance =
            !pendingResumeChanged &&
            !resumeHoldApplied &&
            shouldSkipPersist(existingCompliance?.decision, existingCompliance?.updated_at, newComplianceDecision);

          if (!skipCompliance) {
            const stoppedSince = computeStoppedSince(existingCompliance?.decision, existingCompliance?.stopped_since, newComplianceDecision);
            compliancePayload = {
              result: complianceEntry.result,
              expectedUpdatedAt: existingCompliance?.updated_at ?? null,
              stoppedSince,
              pendingResumeSince,
            };
          }
        }

        // ------------------------------------------------------------
        // 3) FinalDecision — نفس منطق persistFinalDecisions، يُحسب فقط إن
        //    وُجد AEI (نفس شرط `if (!r?.aei) return;` الأصلي)
        // ------------------------------------------------------------
        let finalDecisionPayload: { decision: FinalDecision; evaluatedAt: string; inputSnapshotHash: string } | null = null;
        if (r?.aei) {
          const compliance: DustComplianceResult | null = complianceEntry?.result ?? null;
          const dvi: DviEvaluationResult = r.windowEval?.worst ?? NEUTRAL_DVI_FALLBACK;
          const mode = determineFinalDecisionMode(r.startIso);
          const finalInput = buildFinalDecisionInput(r.activityGroupId ?? r.activityId ?? 'unknown', dvi, compliance, r.aei, mode);
          const decision = decideFinal(finalInput);
          finalDecisionPayload = {
            decision,
            evaluatedAt: finalInput.evaluatedAt,
            inputSnapshotHash: computeInputSnapshotHash(dvi, compliance, mode, r.aei, decision.evidenceQuality),
          };
        }

        if (!dviPayload && !compliancePayload && !finalDecisionPayload) return base;

        const { data, error } = await supabaseAdmin.rpc('persist_activity_decision_atomic', {
          p_project_id: projectId,
          p_activity_group_id: r.activityGroupId,
          p_activity_id: r.activityId,

          p_dvi_result: dviPayload?.result ?? null,
          p_dvi_triggered_by: dviTriggeredBy,
          p_dvi_expected_updated_at: dviPayload?.expectedUpdatedAt ?? null,

          p_compliance_result: compliancePayload?.result ?? null,
          p_compliance_rulebook_version: compliancePayload?.result?.rulebookVersion ?? null,
          p_compliance_triggered_by: complianceTriggeredBy,
          p_compliance_expected_updated_at: compliancePayload?.expectedUpdatedAt ?? null,
          p_compliance_dust_profile_id: complianceEntry?.dustProfileId ?? null,
          p_compliance_stopped_since: compliancePayload?.stoppedSince ?? null,
          p_compliance_pending_resume_since: compliancePayload?.pendingResumeSince ?? null,

          p_final_decision: finalDecisionPayload?.decision ?? null,
          p_final_evaluated_at: finalDecisionPayload?.evaluatedAt ?? null,

          p_evaluation_run_id: evaluationRunId,
          p_input_snapshot_hash: finalDecisionPayload?.inputSnapshotHash ?? null,
          // بلا معنى إن لم يُكتب final_decisions أصلاً هذه الدورة — نفس شرط
          // finalDecisionPayload المستخدَم لبقية حقول final_decisions أعلاه.
          p_rule_parameter_version_snapshot: finalDecisionPayload ? (ruleParameterVersionSnapshot ?? null) : null,

          // خطأ إعادة إنتاج مكتشَف ومُصلَح (migration 202608160002 — "روابط
          // DVI والامتثال قد تشير إلى تقييم سابق عندما لا تتغير فئة القرار
          // خلال خمس دقائق"): بخلاف p_dvi_result/p_compliance_result أعلاه
          // (قد يكونا null إن تخطّى shouldSkipPersist تحديث current_dust_
          // decisions/current_dust_compliance_decisions)، القيمتان أدناه
          // تُمرَّران دائماً — نفس worst/complianceEntry.result الطازجين
          // المُستخدَمين فعلياً لبناء finalDecisionPayload أعلاه بالضبط —
          // ليضمن RPC إدراج صف dust_evaluations/dust_compliance_evaluations
          // طازج كلما final_decisions تُكتَب فعلياً هذه الدورة (v_skip_final
          // داخل RPC)، بصرف النظر عن تقييد shouldSkipPersist المنفصل.
          p_dvi_raw_result: worst ?? null,
          p_compliance_raw_result: complianceEntry?.result ?? null,
        });

        if (error || !data?.[0]) {
          // كود 40001 (serialization_failure) يصل حصراً من فحص CAS داخل
          // persist_activity_decision_atomic عندما يتغيّر current_dust_decisions/
          // current_dust_compliance_decisions بين قراءته في هذه الدورة وكتابته —
          // تعارض تزامن طبيعي متوقّع الحدوث، تحله دورة التقييم التالية بقراءة
          // الحالة من جديد تلقائياً، وليس فشلاً حقيقياً (شبكة/قيد/إلخ) يستحق
          // نفس درجة الخطورة في السجلات.
          const isCasConflict = error?.code === '40001';
          if (!isCasConflict) {
            console.error(
              `فشل حفظ سلسلة القرار الذرية للنشاط ${r.activityId}:`,
              error ? JSON.stringify(error, null, 2) : 'RPC رجعت بلا صفوف (data فارغة)'
            );
          }
          return { ...base, failed: true, conflict: isCasConflict };
        }

        const row = data[0];
        return {
          activityId: r.activityId,
          activityGroupId: r.activityGroupId,
          dviPersisted: Boolean(row.dvi_persisted),
          compliancePersisted: Boolean(row.compliance_persisted),
          finalDecisionPersisted: Boolean(row.final_decision_persisted),
          // اسم عمود الإخراج تغيّر (migration 202608200002 — خطأ 42702 "column
          // reference final_decision_id is ambiguous": كان يتعارض مع عمود
          // decision_alert_outbox.final_decision_id المُستخدَم داخل نفس الدالة
          // في قوائم أعمدة insert/on conflict، بلا إمكانية تأهيل هناك).
          finalDecisionId: row.v_out_final_decision_id ?? null,
          failed: false,
          conflict: false,
        };
      } catch (error) {
        console.error(`فشل حفظ سلسلة القرار الذرية للنشاط ${r.activityId}:`, error);
        return { ...base, failed: true };
      }
    })
  );

  return results;
}

// مفتاح مركّب (project_id:activity_group_id) — القسم 12.2 من "دليل الإصلاح
// الجذري لمنظومة مرقاب": activity_group_id وحده غير كافٍ كمفتاح خريطة عبر
// مشاريع متعددة (يقبله العميل، فيمكن أن يتكرر بين مشروعين). يُصدَّر لأن
// المستدعيات (dashboard/global، viewer/dashboard، decisions/route.ts) تبني
// نفس المفتاح بنفسها لقراءة الخريطة المُعادة.
export function activityDecisionKey(projectId: string, activityGroupId: string): string {
  return `${projectId}:${activityGroupId}`;
}

// يجلب آخر قرار نهائي مخزَّن لكل (project_id, activity_group_id) مطلوب —
// القراءة الموحَّدة الوحيدة التي يجب أن تستخدمها كل الواجهات (البانر،
// الخريطة العامة، لوحة المراقب، مولّد التنبيهات) بدل إعادة استدعاء
// decideFinal محلياً بمدخلات قد تختلف طفيفاً بين مسار وآخر.
//
// خطأ أمني معماري مكتشَف ومُصلَح (القسم 5.7/12 من "دليل الإصلاح الجذري
// لمنظومة مرقاب" — "العزل بين المشاريع غير مكتمل بعد المفتاح المركب"):
// كانت هذه الدالة تفلتر بـ.in('activity_group_id', ids) وحده، بلا
// .eq('project_id', ...) — فمشروعان يشتركان بنفس activity_group_id (قيمة
// حرة من العميل، راجع api/dust-profiles/route.ts) كانا يمكن أن يتبادلا
// قرار أحدهما ضمن خريطة الآخر لدى أي مستدعٍ متعدد المشاريع (dashboard/
// global، viewer/dashboard، decisions/route.ts). الإصلاح: targets يحمل
// (projectId, activityGroupId) صراحة لكل عنصر، والخريطة المُعادة مفتاحها
// المركّب activityDecisionKey(projectId, activityGroupId) — لا يمكن لصف من
// مشروع آخر أن يُقرأ أو يُخلَط تحت مفتاح نشاط لا يخصه.
//
// يُرجع خريطة فارغة بصمت عند أي فشل استعلام (فشل آمن — المستدعي يتعامل مع
// الغياب كـ"لا قرار مخزَّن بعد"، لا خطأً قاطعاً).
export async function fetchLatestFinalDecisions(
  supabaseAdmin: SupabaseClient,
  targets: { projectId: string; activityGroupId: string }[]
): Promise<Map<string, StoredFinalDecisionRow>> {
  const map = new Map<string, StoredFinalDecisionRow>();
  const validTargets = (targets || []).filter((t) => t.projectId && t.activityGroupId);
  if (validTargets.length === 0) return map;

  const projectIds = Array.from(new Set(validTargets.map((t) => t.projectId)));
  const groupIds = Array.from(new Set(validTargets.map((t) => t.activityGroupId)));
  const wantedKeys = new Set(validTargets.map((t) => activityDecisionKey(t.projectId, t.activityGroupId)));

  try {
    const { data } = await supabaseAdmin
      .from('final_decisions')
      .select('*')
      .in('project_id', projectIds)
      .in('activity_group_id', groupIds)
      .order('created_at', { ascending: false });
    for (const row of (data ?? []) as (StoredFinalDecisionRow & { activity_group_id: string; project_id: string })[]) {
      const key = activityDecisionKey(row.project_id, row.activity_group_id);
      // .in() على العمودين معاً هو تقاطع (OR منطقي بين قيم كل عمود على
      // حدة، لا AND على الزوج) — التحقق من wantedKeys هنا يفرض تطابق
      // الزوج (project_id, activity_group_id) فعلياً معاً، لا أي تقاطع.
      if (wantedKeys.has(key) && !map.has(key)) map.set(key, row);
    }
  } catch {
    // فشل الاستعلام لا يُسقط المستدعي — نفس مبدأ resolveFreshProjectDevice.
  }
  return map;
}

// يجلب آخر DustComplianceResult كامل مخزَّن فعلياً (dust_compliance_evaluations.result،
// عبر current_dust_compliance_decisions.latest_evaluation_id) لكل
// activity_group_id مطلوب — خطأ معماري مكتشَف ومُصلَح (مراجعة كود خبير
// خارجي — C-05: "القرار المخزَّن ليس المصدر الوحيد؛ مولّد التنبيهات يعيد
// حساب DVI وCompliance"): alerts/generate/route.ts كان يستدعي
// evaluateDustCompliance محلياً بمعزل تام عن evaluate/route.ts (نقطة الكتابة
// الوحيدة الفعلية)، فقد ينتج requiredActions/shortReasonAr/decisionCategory
// من لقطة بيانات مختلفة عمّا يُعرض فعلياً في بطاقة/خريطة المشروع لنفس
// النشاط بنفس اللحظة تقريباً (نفس مبدأ fetchLatestFinalDecisions أعلاه، لكن
// لحقول compliance الكاملة التي لا يخزّنها final_decisions نفسه، مثل
// requiredActions/triggeredRules).
//
// current_dust_compliance_decisions هو "current pointer" الفعلي (مفتاحه
// الأساسي المركّب الآن project_id+activity_group_id، راجع 202608030006) —
// أسرع من ترتيب dust_compliance_evaluations بالكامل بـcreated_at، ونفس
// الصف الذي يقرأه resolveResumeState/computeDustComplianceResults كـ"القرار
// السابق". يُرجع خريطة فارغة بصمت عند أي فشل استعلام (فشل آمن — المستدعي
// يتعامل مع الغياب كـ"لا قرار مخزَّن بعد"، لا خطأً قاطعاً — نفس مبدأ
// fetchLatestFinalDecisions).
//
// خطأ أمني معماري مكتشَف ومُصلَح (نفس ثغرة fetchLatestFinalDecisions
// أعلاه بالضبط — القسم 5.7/12.2): targets يحمل (projectId, activityGroupId)
// صراحة، والخريطة المُعادة مفتاحها المركّب activityDecisionKey.
interface CurrentComplianceDecisionPointerRow {
  project_id: string;
  activity_group_id: string;
  latest_evaluation_id: string | null;
}

interface DustComplianceEvaluationRow {
  id: string;
  result: DustComplianceResult;
}

export async function fetchLatestStoredCompliance(
  supabaseAdmin: SupabaseClient,
  targets: { projectId: string; activityGroupId: string }[]
): Promise<Map<string, DustComplianceResult>> {
  const map = new Map<string, DustComplianceResult>();
  const validTargets = (targets || []).filter((t) => t.projectId && t.activityGroupId);
  if (validTargets.length === 0) return map;

  const projectIds = Array.from(new Set(validTargets.map((t) => t.projectId)));
  const groupIds = Array.from(new Set(validTargets.map((t) => t.activityGroupId)));
  const wantedKeys = new Set(validTargets.map((t) => activityDecisionKey(t.projectId, t.activityGroupId)));

  try {
    const { data: currentRows } = await supabaseAdmin
      .from('current_dust_compliance_decisions')
      .select('project_id, activity_group_id, latest_evaluation_id')
      .in('project_id', projectIds)
      .in('activity_group_id', groupIds);
    // .in() على عمودين معاً تقاطع (لا AND على الزوج) — نفس التحفظ الموثَّق
    // في fetchLatestFinalDecisions أعلاه؛ الفلترة الفعلية بالزوج تحدث عبر
    // wantedKeys أدناه.
    const rows = ((currentRows ?? []) as CurrentComplianceDecisionPointerRow[]).filter((r) =>
      wantedKeys.has(activityDecisionKey(r.project_id, r.activity_group_id))
    );
    const evaluationIds = Array.from(
      new Set(rows.map((r) => r.latest_evaluation_id).filter((id): id is string => Boolean(id)))
    );
    if (evaluationIds.length === 0) return map;

    const { data: evalRows } = await supabaseAdmin
      .from('dust_compliance_evaluations')
      .select('id, result')
      .in('id', evaluationIds);
    const resultById = new Map<string, DustComplianceResult>(
      ((evalRows ?? []) as DustComplianceEvaluationRow[]).map((r) => [r.id, r.result])
    );

    for (const row of rows) {
      const result = row.latest_evaluation_id ? resultById.get(row.latest_evaluation_id) : undefined;
      if (result) map.set(activityDecisionKey(row.project_id, row.activity_group_id), result);
    }
  } catch {
    // فشل الاستعلام لا يُسقط المستدعي — نفس مبدأ fetchLatestFinalDecisions.
  }
  return map;
}
