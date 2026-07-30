// -------------------------------------------------------------
// المسار: app/api/alerts/generate/route.ts
//
// مولّد التنبيهات — يُستدعى دورياً (عبر Cron، راجع vercel.json) ويفحص
// كل أنشطة الغبار المجدولة، ويقرر متى يجب إنشاء كل نوع تنبيه، ويكتبه
// فعلياً في قاعدة البيانات. نسخة DCR: غبار فقط، بلا حرارة أو رافعات.
//
// ============================================================
// قواعد ظهور كل نوع تنبيه (الإجابة المباشرة على: "متى تظهر؟")
// ============================================================
//
// تنبيهات "قبل التنفيذ" (BEFORE) — تذكير بموعد الأنشطة القادمة:
//   • BEFORE_2H     : يبقى على بدء النشاط 120 دقيقة أو أقل (ولم
//                     يبدأ بعد)، ولا يوجد تنبيه BEFORE_2H سابق لنفس
//                     النشاط.
//   • BEFORE_1H     : يبقى على البدء 60 دقيقة أو أقل، ولا يوجد
//                     تنبيه BEFORE_1H سابق لنفس النشاط.
//   • BEFORE_START  : وقت البدء المجدول حان فعلياً (خلال آخر 10
//                     دقائق من الوقت المجدول)، ولا يوجد تنبيه
//                     BEFORE_START سابق لنفس النشاط.
//   هذه الثلاثة "تذكيرات لمرة واحدة" لكل نشاط — تُنشأ مرة واحدة ولا
//   تتكرر (نتحقق من عدم وجودها مسبقاً بغض النظر عن حالتها الحالية).
//
// تنبيهات "أثناء التنفيذ" (DURING) — فقط أثناء تنفيذ النشاط فعلياً
// (الوقت الحالي بين وقت البداية ووقت النهاية المجدولين):
//   • DUST          : نشاط غبار ونتيجة evaluateDustVisibilityWindow
//                     الحيّة الآن ضمن نطاق "RED" وما فوق (score >= 65).
//   • SAFETY_BREACH : نتيجة الغبار الحيّة تفعّل mandatoryStop = true
//                     (تجاوز حد صارم لا يقبل تدرّجاً).
//   • PM10_APPROACHING_LIMIT : تركيز PM10 المدموج بين 300-339 (يقترب من
//                     حد المخالفة التنظيمي 340).
//   • FORECAST_WARNING : أيٌّ من الشروط الثلاثة أعلاه، لكن الساعة
//                     المسبِّبة (worst.time) لا تزال بالمستقبل ضمن نافذة
//                     النشاط (isWorstRightNow=false، هامش 30 دقيقة) — أي
//                     توقّع لا حالة حيّة فعلية الآن. نفس timing=DURING (لا
//                     تزال ضمن نافذة تنفيذ النشاط)، لكن kind مختلف بنيوياً
//                     حتى لا يظهر توقّع مستقبلي كأنه خطر قائم فعلاً هذه
//                     اللحظة (بند 7 من مراجعة الخبير الخارجي).
//   لتفادي الإغراق بتنبيهات مكررة: قبل إنشاء أي تنبيه DURING جديد،
//   نتحقق أولاً من عدم وجود تنبيه بنفس (activity_source, activity_id,
//   kind) في حالة غير مغلقة (state != CLOSED) مسبقاً.
// -------------------------------------------------------------

import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { timingSafeEqual } from 'crypto';
import { evaluateDustVisibilityWindow } from '@/app/utils/dust-engine';
import type { DustEngineInput } from '@/app/utils/dust-engine/types';
import { translateActivityType } from '@/app/lib/activityLabels';
import { REGULATORY_ACTIVITY_LABEL_AR } from '@/app/utils/dust-compliance-engine/rulebook';
import { evaluateDustCompliance, buildComplianceContext, buildSensitiveReceptor } from '@/app/utils/dust-compliance-engine';
import { resolveFreshProjectDevice, fetchPm10SustainedStatus, fetchLatestFinalDecisions, type FreshDeviceReading, type Pm10SustainedStatus } from '@/app/lib/dustEvaluation';
import { safeErrorResponse } from '@/app/lib/apiError';

// مقارنة آمنة زمنياً لسر الـCron — timingSafeEqual يتطلب طولاً متطابقاً
// للمخزنين، فنقارن الطول أولاً (تسريب طفيف لطول السر، غير حسّاس عملياً
// مقارنة بتسريب محتواه عبر توقيت المقارنة العادية !==).
function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// عميل Supabase بصلاحية Service Role: هذا المسار يعمل دون جلسة مستخدم
// (يُستدعى من Cron)، فيحتاج مفتاح الخدمة لتجاوز RLS والقراءة من كل
// المشاريع/الأنشطة.
const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string
);

// نفس دالة بناء مدخلات محرك الغبار المستخدمة في صفحة تفاصيل المشروع
// (منسوخة هنا لضمان تطابق الحساب - يفضّل نقلها لملف مشترك لاحقاً).
function buildDustEngineInputSrv(
  dbProfile: any,
  lat: number,
  lon: number,
  freshDevice?: FreshDeviceReading | null
): DustEngineInput {
  return {
    activityType: (dbProfile.activity_type as any) || 'GENERAL_OUTDOOR_WORK',
    latitude: lat,
    longitude: lon,
    site: {
      hasEarthworks: Boolean(dbProfile.has_earthworks),
      internalDirtRoads: Boolean(dbProfile.internal_dirt_roads),
      heavyEquipmentMovement: Boolean(dbProfile.heavy_equipment_movement),
      looseMaterials: Boolean(dbProfile.loose_materials),
      largeExposedArea: Boolean(dbProfile.large_exposed_area),
      drySurface: Boolean(dbProfile.dry_surface),
      surfaceWet: Boolean(dbProfile.surface_wet),
      wateringAvailable: Boolean(dbProfile.watering_available),
      stockpilesCovered: Boolean(dbProfile.stockpiles_covered),
      speedLimitApplied: Boolean(dbProfile.speed_limit_applied),
      wheelWashAvailable: Boolean(dbProfile.wheel_wash_available),
      dustScreensAvailable: Boolean(dbProfile.dust_screens_available),
      fieldMonitoringAvailable: Boolean(dbProfile.field_monitoring_available),
      receptorType: (dbProfile.receptor_type as any) || 'NONE_NEARBY',
      receptorDistance: (dbProfile.receptor_distance as any) || 'OVER_500M',
      receptorIsDownwind: Boolean(dbProfile.receptor_is_downwind),
      visibleDustPlumeReported: Boolean(dbProfile.visible_dust_plume_reported),
      openConcretePour: Boolean(dbProfile.open_concrete_pour),
    },
    onsiteVisibilityM: dbProfile.onsite_visibility_m ?? null,
    onsitePm10: dbProfile.onsite_pm10 ?? null,
    onsitePm25: dbProfile.onsite_pm25 ?? null,
    // نفس عزل المصدر التام المطبّق في computeDustResults (صفحة المشروع) —
    // بدونه كانت تنبيهات Cron (SAFETY_BREACH/DUST) تُقيَّم على بيانات
    // مختلفة صامتاً عمّا تعرضه صفحة المشروع لنفس النشاط.
    hasDeviceLink: !!dbProfile.device_id,
    deviceLastReadingAt: freshDevice?.last_reading_at ?? null,
    deviceWindSpeedKmh: freshDevice?.last_wind_speed_kmh ?? null,
    deviceWindGustKmh: freshDevice?.last_wind_gust_kmh ?? null,
    deviceWindDirectionDeg: freshDevice?.last_wind_direction_deg ?? null,
    devicePm10: freshDevice?.last_pm10 ?? null,
    devicePm25: freshDevice?.last_pm25 ?? null,
    deviceVisibilityM: freshDevice?.last_visibility_m ?? null,
    deviceRelativeHumidityPercent: freshDevice?.last_relative_humidity_percent ?? null,
    deviceTemperatureC: freshDevice?.last_temperature_c ?? null,
  };
}

function computeWindow(plannedDate: string | null, plannedTime: string | null, durationMinutes: number | null) {
  const now = new Date();
  const normalizedTime = plannedTime ? String(plannedTime).slice(0, 5) : now.toTimeString().slice(0, 5);
  const dateStr = plannedDate || now.toISOString().slice(0, 10);
  // planned_date/planned_time بتوقيت السعودية المحلي (+03:00) دائماً.
  // هذا المسار يعمل على الخادم (Cron) بتوقيت UTC افتراضياً، فلازم نثبّت
  // الإزاحة صراحة وإلا يُفهم "01:30" على إنها UTC بدل الرياض، فيظهر
  // النشاط لاحقاً بفارق 3 ساعات عن الوقت الفعلي المُدخل.
  const start = new Date(`${dateStr}T${normalizedTime}:00+03:00`);
  const startIso = !isNaN(start.getTime()) ? start.toISOString() : now.toISOString();
  const durMinutes = Number(durationMinutes) || 60;
  const endIso = new Date(new Date(startIso).getTime() + durMinutes * 60000).toISOString();
  return { startIso, endIso };
}

// هل يوجد تنبيه سابق لنفس النشاط بنفس النوع؟
// forBeforeAlerts=true  → أي حالة (تذكير لمرة واحدة، لا يتكرر أبداً)
// forBeforeAlerts=false → فقط غير المغلقة (DURING قد يُعاد فتحه لو
//                          أُغلق سابقاً وتكرر تجاوز الحد لاحقاً)
async function alertExists(activitySource: string, activityId: string, kind: string, onlyOpen: boolean) {
  let query = supabaseAdmin
    .from('alerts')
    .select('id, state')
    .eq('activity_source', activitySource)
    .eq('activity_id', activityId)
    .eq('kind', kind);
  const { data } = await query;
  if (!data || data.length === 0) return false;
  if (!onlyOpen) return true;
  return data.some((a: any) => a.state !== 'CLOSED');
}

// يُغلق تلقائياً أي تنبيه مفتوح من "أنواع القراءة الحية" (SAFETY_BREACH،
// DUST، PM10_APPROACHING_LIMIT، COMPLIANCE_VIOLATION/RESTRICTION/ADVISORY)
// إن لم يعد الشرط المسبب له قائماً في التقييم الحالي — طلب صريح من
// المستخدم: بطاقة الامتثال كانت تعرض بانراً أحمر "تنبيه أمني نشط" رغم أن
// القراءة الحية عادت آمنة (احتراز فقط)، لأن هذه الأنواع لم تكن تُغلق إلا
// يدوياً من صفحة التنبيهات. لا يشمل BEFORE_* عمداً — تلك تذكيرات لمرة واحدة
// بطبيعتها، لا حالة "تحسّنت" لها.
const LIVE_CONDITION_ALERT_KINDS = [
  'SAFETY_BREACH',
  'DUST',
  'PM10_APPROACHING_LIMIT',
  'FORECAST_WARNING',
  'COMPLIANCE_VIOLATION',
  'COMPLIANCE_RESTRICTION',
  'COMPLIANCE_ADVISORY',
] as const;

// خطأ أمني مكتشَف ومُصلَح (مراجعة كود خبير خارجي — "سجل القرارات والتنبيهات
// قابل للتعديل والحذف"): كان هذا يُنفِّذ UPDATE alerts SET state='CLOSED'
// مباشرة — مسار كتابة ثانٍ (بجانب PATCH /api/alerts/[alertId]) كان سيتجاوز
// أي إصلاح يقتصر على مسار الـPATCH وحده. الآن يكتب حدثاً في
// alert_state_events لكل صف يُغلَق (actor_user_id=null يعني تغييراً آلياً
// من هذا المولّد، لا فعل مستخدم بشري — راجع تعليق العمود في migration).
// trigger في قاعدة البيانات يزامن alerts.state تلقائياً بعد كل إدراج.
async function autoCloseResolvedAlerts(
  activitySource: 'dust',
  activityId: string,
  stillActiveKinds: Set<string>
) {
  const kindsToClose = LIVE_CONDITION_ALERT_KINDS.filter((k) => !stillActiveKinds.has(k));
  if (kindsToClose.length === 0) return;

  const { data: openAlerts } = await supabaseAdmin
    .from('alerts')
    .select('id, state')
    .eq('activity_source', activitySource)
    .eq('activity_id', activityId)
    .in('kind', kindsToClose)
    .neq('state', 'CLOSED');

  if (!openAlerts || openAlerts.length === 0) return;

  await supabaseAdmin.from('alert_state_events').insert(
    openAlerts.map((a: any) => ({
      alert_id: a.id,
      previous_state: a.state,
      new_state: 'CLOSED',
      actor_user_id: null,
    }))
  );
}

async function insertAlert(params: {
  projectId: string;
  activitySource: 'dust';
  activityId: string;
  timing: 'BEFORE' | 'DURING';
  kind: string;
  message: string;
  // نص رسمي بديل يُعرض لجهة الرصد (account_role='viewer') تحديداً بدل
  // message التقني الموجَّه لصاحب المشروع — يُملأ فقط لتنبيهات
  // COMPLIANCE_VIOLATION (طلب صريح من المستخدم). راجع app/api/admin/
  // alerts/route.ts لموقع الاستبدال الفعلي حسب هوية الطالب.
  viewerMessage?: string;
  metricLabel?: string;
  metricActual?: string;
  metricThreshold?: string;
  recommendedAction?: string;
}) {
  const { data: inserted, error } = await supabaseAdmin
    .from('alerts')
    .insert({
      project_id: params.projectId,
      activity_source: params.activitySource,
      activity_id: params.activityId,
      timing: params.timing,
      kind: params.kind,
      state: 'NEW',
      message: params.message,
      viewer_message: params.viewerMessage || null,
      metric_label: params.metricLabel || null,
      metric_actual: params.metricActual || null,
      metric_threshold: params.metricThreshold || null,
      recommended_action: params.recommendedAction || null,
    })
    .select('id')
    .single();
  if (error) {
    console.error(`insertAlert failed [${params.activitySource}/${params.kind}]:`, error.message);
    return;
  }

  // حدث الإنشاء الأولي في سجل الأحداث — يكتمل سجل التدقيق منذ ولادة
  // التنبيه (لا فجوة بين state='NEW' على الصف نفسه وأول حدث موثَّق).
  // actor_user_id=null (آلي، من هذا المولّد — راجع تعليق autoCloseResolvedAlerts).
  await supabaseAdmin.from('alert_state_events').insert({
    alert_id: inserted.id,
    previous_state: null,
    new_state: 'NEW',
    actor_user_id: null,
  });
}

// نفس منطق BEFORE_2H/BEFORE_1H/BEFORE_START — دالة واحدة مشتركة.
async function checkBeforeAlerts(
  projectId: string,
  activitySource: 'dust',
  activityId: string,
  activityLabel: string,
  startIso: string
) {
  const minutesUntilStart = (new Date(startIso).getTime() - Date.now()) / 60000;

  if (minutesUntilStart <= 120 && minutesUntilStart > -60) {
    if (!(await alertExists(activitySource, activityId, 'BEFORE_2H', false))) {
      await insertAlert({
        projectId, activitySource, activityId, timing: 'BEFORE', kind: 'BEFORE_2H',
        message: `يتبقى نحو ساعتين على بدء نشاط "${activityLabel}" — راجع الجاهزية والتوصية الحالية.`,
      });
    }
  }
  if (minutesUntilStart <= 60 && minutesUntilStart > -60) {
    if (!(await alertExists(activitySource, activityId, 'BEFORE_1H', false))) {
      await insertAlert({
        projectId, activitySource, activityId, timing: 'BEFORE', kind: 'BEFORE_1H',
        message: `يتبقى نحو ساعة على بدء نشاط "${activityLabel}" — راجع الجاهزية والتوصية الحالية.`,
      });
    }
  }
  if (minutesUntilStart <= 10 && minutesUntilStart > -10) {
    if (!(await alertExists(activitySource, activityId, 'BEFORE_START', false))) {
      await insertAlert({
        projectId, activitySource, activityId, timing: 'BEFORE', kind: 'BEFORE_START',
        message: `حان موعد بدء نشاط "${activityLabel}" حسب الجدول.`,
      });
    }
  }
}

// خطأ مكتشَف ومُصلَح (طلب صريح من المستخدم — "إذا كانت تنبيهات تخص
// الإجراءات فاحذفها"): تنبيه NO_DECISION_YET ("نشاط جارٍ بلا قرار موثّق")
// كان تذكيراً إجرائياً محضاً (يطالب المستخدم باتخاذ قرار) لا تنبيهاً فيزيائياً/
// تنظيمياً فعلياً — حُذفت الدالة (checkNoDecisionAlert) واستدعاؤها بالكامل.

// خطأ مكتشَف ومُصلَح (مراجعة كود خبير خارجي — "سجل القرارات والتنبيهات
// قابل للتعديل والحذف"، الجزء المتعلق بأرشفة المشاريع): كان هذا المسح
// الدوري (cron، كل الأنشطة عبر كل المشاريع) يُقيِّم ويُنبِّه حتى لأنشطة
// مشاريع أرشفها مستخدموها — عمل مهدور (طقس/جهاز/محرك امتثال كامل لكل
// نشاط)، وأسوأ من ذلك: تنبيهات جديدة مربكة (BEFORE_*/DUST/SAFETY_BREACH/
// COMPLIANCE_VIOLATION) على مشروع يظن صاحبه أنه "اختفى". projects!inner
// (بدل projects العادي) + .is('projects.archived_at', null) يستبعد هذه
// الأنشطة من الاستعلام نفسه (لا فلترة بعد الجلب) — يوفر كل العمل اللاحق
// لكل نشاط مستبعَد، لا فقط يُخفي نتيجته.
export async function checkDustActivities(projectIds?: string[]) {
  let q = supabaseAdmin.from('project_dust_profiles').select('*, projects!inner(*)').is('projects.archived_at', null);
  if (projectIds && projectIds.length > 0) q = q.in('project_id', projectIds);
  const { data: profiles } = await q;

  // مستقبِلات حساسة يدوية — نفس مصدر [projectId]/route.ts، مطلوبة لمحرك
  // الامتثال (مسافة الكسارة/الأكوام) حتى يطابق تنبيه COMPLIANCE_VIOLATION
  // هنا بالضبط قرار "القرار الموحد للنشاط" المعروض في صفحة المشروع لنفس
  // النشاط. استعلام واحد لكل تشغيل cron، لا لكل نشاط.
  //
  // خطأ أمني مكتشَف ومُصلَح (مراجعة كود مدير — "فشل استعلام المستقبلات
  // الحساسة يتحول إلى مصفوفة فارغة ثم Infinity؛ قد يظهر الموقع آمناً عند
  // تعطل البيانات"): فشل هذا الاستعلام هنا كان يعني معالجة *كل* أنشطة *كل*
  // المشاريع في هذه الدورة بقائمة مستقبِلات فارغة (مسافة Infinity، آمنة
  // زوراً) — لا COMPLIANCE_VIOLATION واحد يُطلَق لمخالفة مسافة كسارة حقيقية
  // طوال فشل الاستعلام. يرمي استثناءً الآن بدل المتابعة بأمان زائف — GET
  // أدناه يُرجع 500 صريحاً بدل "success" كاذب.
  const { data: sensitiveReceptorRows, error: sensitiveReceptorsError } = await supabaseAdmin
    .from('sensitive_receptors')
    .select('id, name, receptor_type, lat, lng');
  if (sensitiveReceptorsError) {
    throw new Error(`sensitive_receptors fetch failed: ${sensitiveReceptorsError.message}`);
  }
  const sensitiveReceptors = (sensitiveReceptorRows || []).map(buildSensitiveReceptor);

  for (const profile of profiles || []) {
    // خطأ مكتشَف ومُصلَح (مراجعة كود خبير خارجي — "مولّد التنبيهات يستخدم
    // مصادر ومواقع غير صحيحة"): كان هذا يستخدم دائماً مركز المشروع (بلا حتى
    // قراءة activity_lat/activity_lng)، ويسقط لإحداثيات الرياض الافتراضية
    // (24.7136, 46.6753) عند غياب إحداثيات المشروع — فينتج تنبيهات حيّة
    // (SAFETY_BREACH/DUST) مبنية على طقس موقع مختلف تماماً عن موقع النشاط
    // الفعلي، أو حتى موقع عشوائي بالرياض لمشروع خارجها بلا إحداثيات محفوظة.
    // الآن نطابق أولوية buildDustInput في dustEvaluation.ts بالضبط: موقع
    // النشاط المستقل (activity_lat/activity_lng) أولاً، ثم مركز المشروع، بلا
    // أي افتراضي جغرافي وهمي. الفحص هنا لا يُسقِط النشاط بالكامل (continue)
    // — تذكيرات BEFORE_* أسفل لا تحتاج إحداثيات إطلاقاً، فتبقى تعمل بصرف
    // النظر؛ فقط كتلة التقييم الحي (طقس/DVI/امتثال) تُتخطّى إن غابت
    // الإحداثيات فعلياً (راجع isWithinLiveCheckWindow/lat أدناه).
    const lat: number | undefined =
      typeof profile.activity_lat === 'number' ? profile.activity_lat : profile.projects?.latitude;
    const lon: number | undefined =
      typeof profile.activity_lng === 'number' ? profile.activity_lng : profile.projects?.longitude;
    const durationMinutes = Number(profile.duration_hours) ? Number(profile.duration_hours) * 60 : (profile.duration_minutes || 60);
    const { startIso, endIso } = computeWindow(profile.planned_date, profile.planned_time, durationMinutes);
    // النشاط التنظيمي المختار فعلياً (كسارة/هدم/...) لا التصنيف الفيزيائي
    // الداخلي (activity_type) المستخدم فقط لتغذية حساب حساسية محرك DVI —
    // هذا النص يُخزَّن حرفياً في alerts.message/recommended_action، فيلزم أن
    // يعرض ما اختاره المستخدم فعلاً من الشاشة.
    const label =
      (profile.regulatory_activity && profile.regulatory_activity !== 'OTHER'
        ? REGULATORY_ACTIVITY_LABEL_AR[profile.regulatory_activity]
        : null) ??
      translateActivityType(profile.activity_type) ??
      'نشاط غبار';

    await checkBeforeAlerts(profile.project_id, 'dust', profile.id, label, startIso);

    const now = Date.now();
    const startMs = new Date(startIso).getTime();
    const endMs = new Date(endIso).getTime();
    // طلب صريح من المستخدم: القراءة الحية الخطيرة (مثال PM10 يقترب من 300)
    // يجب أن تُنبِّه حتى قبل بدء النافذة المجدولة فعلياً — لا فائدة من
    // انتظار وقت البدء الرسمي بينما القراءة الحالية خطيرة الآن. نطاق ما قبل
    // البدء هنا (PRE_START_LIVE_CHECK_HOURS) مطابق تماماً لأقرب تذكير BEFORE
    // موجود أصلاً (BEFORE_2H) حتى لا يظهر تنبيه حيّ بلا أي تذكير "قبل
    // التنفيذ" مرتبط به على نفس الشاشة.
    const PRE_START_LIVE_CHECK_HOURS = 2;
    const isWithinLiveCheckWindow =
      now >= startMs - PRE_START_LIVE_CHECK_HOURS * 3600000 && now <= endMs;
    if (!isWithinLiveCheckWindow) {
      // النافذة الزمنية للنشاط انتهت فعلاً، أو لم يتبقَّ على بدئها المجدول
      // ساعتان بعد — لا "حالة حيّة" ذات صلة لمقارنتها الآن، فلا تُقيَّم شروط
      // التنبيهات إطلاقاً هنا (راجع تعليق autoCloseResolvedAlerts أعلاه).
      // بدون هذا كان أي تنبيه من الأنواع الحيّة يبقى مفتوحاً إلى الأبد
      // بمجرد انتهاء نافذة النشاط، لأن حلقة التقييم كانت تتخطى النشاط
      // بالكامل (continue) قبل الوصول لمنطق الإغلاق التلقائي.
      await autoCloseResolvedAlerts('dust', profile.id, new Set());
      continue;
    }

    if (typeof lat !== 'number' || typeof lon !== 'number') {
      // لا إحداثيات فعلية (لا نشاط ولا مشروع) — لا يجوز تقييم طقس/DVI بلا
      // موقع حقيقي (راجع تعليق lat/lon أعلاه). نفس معاملة نافذة غير حيّة:
      // إغلاق أي تنبيه حيّ مفتوح سابقاً (لا معنى لإبقائه مفتوحاً بلا تقييم
      // جديد يؤكّده) بدل تركه معلَّقاً للأبد.
      console.error(`تعذّر تحديد إحداثيات فعلية للنشاط ${profile.id} — تم تخطّي التقييم الحي (لا افتراض جغرافي).`);
      await autoCloseResolvedAlerts('dust', profile.id, new Set());
      continue;
    }

    try {
      const freshDevice = await resolveFreshProjectDevice(supabaseAdmin, profile.project_id, profile.device_id).catch(() => null);
      const engineInput = buildDustEngineInputSrv(profile, lat, lon, freshDevice);
      const durationHours = Number(profile.duration_hours) || durationMinutes / 60;
      const windowEval = await evaluateDustVisibilityWindow(engineInput, startIso, durationHours);
      const worst = windowEval.worst;

      // خطأ مكتشَف ومُصلَح (مراجعة كود خبير خارجي — "أسوأ نافذة توقعية تُعامَل
      // كحالة حية"): worst هو أسوأ ساعة فعلية ضمن كامل نافذة النشاط المجدولة
      // (قد تمتد لساعات قادمة)، لا بالضرورة الوضع الحالي هذه اللحظة بالضبط —
      // نفس القيمة المعتمَدة فعلياً كـ"القرار الممثل للنشاط" في صفحة المشروع
      // والخريطة (windowEval.worst)، فتغييرها هنا فقط لمولّد التنبيهات كان
      // سيفتح تناقضاً جديداً بين ما يُنبَّه عليه وما يُعرَض/يُحفَظ كقرار فعلي
      // لنفس اللحظة. الإصلاح الصحيح هنا هو نص التنبيه نفسه: لا يجوز أن يقول
      // "الآن"/"أثناء التنفيذ" حين تكون ساعة الذروة (worst.time) لا تزال
      // بالمستقبل عن اللحظة الفعلية — نميّز الحالتين صراحة في الرسائل أدناه.
      const worstTimeMs = new Date(worst.time).getTime();
      const isWorstRightNow = worstTimeMs <= Date.now() + 30 * 60000; // هامش نصف ساعة (دقة Open-Meteo الساعية)
      const liveTimingPhraseAr = isWorstRightNow
        ? 'أثناء التنفيذ الآن'
        : `متوقع خلال نافذة التنفيذ (الساعة ${new Date(worst.time).toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Riyadh' })})`;

      // تنبيه امتثال تنظيمي — يشغّل محرك الامتثال الفعلي (evaluateDustCompliance)
      // بنفس منطق صفحة المشروع تماماً، لا نسخة مختصرة/مكرَّرة من القواعد. أي
      // قاعدة موجودة في rulebook.ts/engine.ts (مسافة الكسارة، كفاءة فلتر
      // محطة الخلط، بوابة الرياح >25، DMP، إلخ) تُفعِّل هذا التنبيه تلقائياً
      // إن أوقفت النشاط — بلا حاجة لتحديث هذا الملف يدوياً عند إضافة قاعدة
      // جديدة أو نشاط تنظيمي جديد لاحقاً، لأن المصدر واحد.
      // stopped_since (لا updated_at) هنا أيضاً — نفس سبب computeDustComplianceResults
      // في dustEvaluation.ts: updated_at يتحدّث حتى عند إعادة كتابة نفس
      // القرار الموقِف، فيمدّد عداد الـ10 دقائق بلا قصد كل مرة يعمل فيها
      // هذا المولّد على نفس النشاط.
      // خطأ معماري مكتشَف ومُصلَح (مراجعة كود خبير خارجي — "لا يوجد
      // FinalDecisionEngine مستقل فعلياً"): compliance يُحسَب الآن قبل فحص
      // SAFETY_BREACH (لا بعده) لأن decideFinal يحتاج dvi+compliance معاً —
      // نُقلت الكتلة كاملة لأعلى بلا تغيير منطقها الداخلي.
      let previousDecision: { decision: string; updated_at: string } | null = null;
      if (profile.activity_group_id) {
        const { data: prevRow } = await supabaseAdmin
          .from('current_dust_compliance_decisions')
          .select('decision, updated_at, stopped_since')
          .eq('activity_group_id', profile.activity_group_id)
          .maybeSingle();
        previousDecision = prevRow
          ? { decision: prevRow.decision, updated_at: prevRow.stopped_since ?? prevRow.updated_at }
          : null;
      }

      // استمرار PM10 الزمني (RCRC-PM10-340-VIOLATION-011/RCRC-PM10-30M-
      // SUSPENSION-012) — نفس منطق computeDustComplianceResults في
      // dustEvaluation.ts: نسجّل القراءة اليدوية (onsite_pm10) إن وُجدت،
      // ثم نجلب حالة الاستمرار قبل بناء السياق النهائي.
      // النوع الكامل (لا مُجرَّد للرقمين فقط) — راجع تعليق pm10Sustained
      // المطابق في dustEvaluation.ts (computeDustComplianceResults) للسبب:
      // isConfirmedViolation340/isSuspended250For30Min يجب أن تصلا كاملتين
      // حتى buildComplianceContext، لا رقمي دقائق مجرَّدين فقط.
      let pm10Sustained: Pm10SustainedStatus | null = null;
      if (profile.activity_group_id && profile.project_id) {
        const onsitePm10 = profile.onsite_pm10;
        if (typeof onsitePm10 === 'number') {
          try {
            await supabaseAdmin.from('pm10_readings_history').insert({
              activity_group_id: profile.activity_group_id,
              project_id: profile.project_id,
              pm10_ug_m3: onsitePm10,
              source: 'manual',
            });
          } catch {
            // فشل التسجيل لا يُسقط التقييم.
          }
        }
        pm10Sustained = await fetchPm10SustainedStatus(supabaseAdmin, profile.project_id, profile.activity_group_id, profile.device_id ?? null);
      }

      const complianceCtx = buildComplianceContext(profile.projects, profile, worst, sensitiveReceptors, previousDecision, pm10Sustained);
      const compliance = evaluateDustCompliance(complianceCtx);

      // القرار النهائي الموحَّد — يُقرَأ الآن من final_decisions (كتبه
      // evaluate/route.ts، نقطة الحساب الوحيدة لـdecideFinal) بدل استدعاء
      // decideFinal محلياً هنا بمعزل — خطأ معماري مكتشَف ومُصلَح (مراجعة كود
      // مدير — "FinalDecisionEngine ليس المصدر التشغيلي الوحيد فعلياً"):
      // كان كل مسار (البانر، الخريطة، مولّد التنبيهات هذا) يُعيد بناء
      // dvi/compliance ويستدعي decideFinal بنفسه، بمدخلات قد تختلف طفيفاً
      // (توقيت جلب مختلف، aei=null دائماً هنا) عن ما يُعرض فعلياً في صفحة
      // المشروع لنفس النشاط، بلا decisionId موحَّد يربطهما. الآن هذا المسار
      // يقرأ آخر قرار مخزَّن فعلياً لنفس activity_group_id — نفس القرار
      // بالضبط المعروض في البطاقة/الخريطة، لا نسخة مُعاد حسابها محلياً.
      // fallback إلى decision محلي مبسَّط (mandatoryStop من compliance وحده)
      // فقط إن لم يوجد بعد أي قرار مخزَّن لهذا النشاط (أول تقييم قبل أي
      // استدعاء GET/evaluate سابق) — فشل آمن، لا يُسقِط التنبيه بأكمله.
      const activityGroupId = profile.activity_group_id || `dust-${profile.id}`;
      const storedFinalDecisions = await fetchLatestFinalDecisions(supabaseAdmin, [activityGroupId]);
      const storedDecision = storedFinalDecisions.get(activityGroupId);
      const finalDecision = storedDecision
        ? {
            mandatoryStop: storedDecision.mandatory_stop as boolean,
            operationalDecision: storedDecision.operational_decision as string,
            decisionLabelAr: storedDecision.decision_label_ar as string,
          }
        : {
            mandatoryStop: compliance.decisionCategory === 'MANDATORY_STOP' || worst.mandatoryStop === true,
            operationalDecision: compliance.decisionCategory === 'MANDATORY_STOP' || worst.mandatoryStop === true ? 'MANDATORY_STOP' : 'ALLOW',
            decisionLabelAr: compliance.decisionLabelAr,
          };

      // خطأ مكتشَف ومُصلَح (مراجعة كود خبير خارجي — بند 7: "أسوأ ساعة مستقبلية
      // قد تنتج تنبيهًا حيًا بدل FORECAST_WARNING"): worst قد يمثّل ساعة لا
      // تزال بالمستقبل ضمن نافذة النشاط (راجع تعليق isWorstRightNow أعلاه) —
      // من قبل كان النوع نفسه (SAFETY_BREACH/DUST) يُطلَق بصرف النظر، فيصعب
      // على المستهلك (واجهة التنبيهات، الإغلاق التلقائي) تمييز "خطر قائم
      // الآن فعلاً" عن "توقّع لساعة قادمة ضمن النافذة". النوعان أدناه
      // (SAFETY_BREACH_KIND/DUST_KIND) يتحوّلان إلى FORECAST_WARNING حين
      // isWorstRightNow=false فقط — timing يبقى DURING (لا تزال ضمن نافذة
      // تنفيذ النشاط الفعلية)، لكن kind يميّز الحالتين بنيوياً.
      const safetyBreachKind = isWorstRightNow ? 'SAFETY_BREACH' : 'FORECAST_WARNING';
      const dustKind = isWorstRightNow ? 'DUST' : 'FORECAST_WARNING';

      if (finalDecision.mandatoryStop) {
        if (!(await alertExists('dust', profile.id, safetyBreachKind, true))) {
          await insertAlert({
            projectId: profile.project_id, activitySource: 'dust', activityId: profile.id,
            timing: 'DURING', kind: safetyBreachKind,
            message: `تجاوز حد صارم ${liveTimingPhraseAr} لنشاط "${label}" — إيقاف إلزامي.`,
            metricLabel: 'مؤشر الرؤية/الغبار', metricActual: `${worst.score}/100`, metricThreshold: 'إيقاف إلزامي',
            recommendedAction: finalDecision.decisionLabelAr,
          });
        }
      } else if (worst.score >= 65) {
        // نطاق "65 فأكثر" مطابق حرفياً لبداية نطاق RED في RISK_ZONES
        // المستخدم بنفس القيم داخل DustWidgetCard (65-84 = RED، 85-100 =
        // DARK_RED)، فيغطي "RED وما فوق" تماماً كما هو موصوف أعلى الملف.
        if (!(await alertExists('dust', profile.id, dustKind, true))) {
          await insertAlert({
            projectId: profile.project_id, activitySource: 'dust', activityId: profile.id,
            timing: 'DURING', kind: dustKind,
            message: `انخفاض حاد في الرؤية ${liveTimingPhraseAr} لنشاط "${label}".`,
            metricLabel: 'مؤشر الرؤية/الغبار', metricActual: `${worst.score}/100`, metricThreshold: '65/100 (تقييد شديد)',
            recommendedAction: worst.decisionLabelAr,
          });
        }
      }

      // تنبيه استباقي PM10 — "الاستخراج التنظيمي من المرفق" القسم 6: حد
      // المخالفة/الإيقاف التنظيمي 340 ميكروجرام/م³. بلا بث مستمر لتتبع
      // الشرط الزمني الحرفي بالوثيقة ("لأكثر من دقيقتين")، فيُنبَّه المستخدم
      // استباقياً عند الاقتراب (300-339) ليتصرف قبل الوصول لحد المخالفة
      // الفعلي ويتجنب التعرض لغرامة أرصاد. منفصل عن تنبيه DUST أعلاه (مصدره
      // score الفيزيائي العام لا PM10 التنظيمي تحديداً)، فقد يظهر الاثنان
      // معاً أو أحدهما فقط حسب الحالة.
      // خطأ مكتشَف ومُصلَح (مراجعة كود خبير خارجي — "مولّد التنبيهات يستخدم
      // مصادر ومواقع غير صحيحة"): كان يُقرَأ من rawWeatherSample.pm10 (تقدير
      // الطقس الخام قبل الدمج) لا mergedReading.pm10 (القراءة الفعلية بعد
      // أولوية جهاز>طقس>onsite المستخدَمة في كل حساب DVI الآخر — راجع
      // mergeDustReading في dust-engine/engine.ts). لنشاط مرتبط بجهاز فعلي
      // (hasDeviceLink=true)، هذا يعني أن تنبيه "PM10 يقترب من الحد" كان
      // يُقيَّم على تقدير طقس تقديري مختلف تماماً عن قراءة الجهاز الحقيقية
      // التي يعتمدها كل قرار آخر (DVI/الامتثال/بطاقة الواجهة) لنفس اللحظة.
      const pm10Value = worst.mergedReading.pm10;
      // نفس منطق FORECAST_WARNING أعلاه — راجع تعليق safetyBreachKind/dustKind.
      const pm10ApproachingKind = isWorstRightNow ? 'PM10_APPROACHING_LIMIT' : 'FORECAST_WARNING';
      if (pm10Value !== null && pm10Value !== undefined && pm10Value >= 300 && pm10Value < 340) {
        if (!(await alertExists('dust', profile.id, pm10ApproachingKind, true))) {
          await insertAlert({
            projectId: profile.project_id, activitySource: 'dust', activityId: profile.id,
            timing: 'DURING', kind: pm10ApproachingKind,
            message: `تركيز الغبار (PM10) يقترب من الحد التنظيمي ${liveTimingPhraseAr} لنشاط "${label}" — إجراء وقائي فوري يجنّبك المخالفة.`,
            metricLabel: 'PM10', metricActual: `${pm10Value} ميكروجرام/م³`, metricThreshold: '340 ميكروجرام/م³ (حد المخالفة)',
            recommendedAction: 'فعّل التثبيط المعزز فوراً (رش/تغطية) لتفادي تجاوز الحد التنظيمي والتعرض لغرامة.',
          });
        }
      }

      // يغطي كل قرار امتثال أقل من ALLOW الكامل (وليس فقط الإيقاف الإلزامي/
      // إيقاف النشاط المتأثر) — أي مخالفة قاعدة فعلية، حتى لو كانت تقييداً
      // أو تحقّقاً ميدانياً أو مجرد تنبيه استباقي، يجب أن تظهر في غرفة
      // التنبيهات لا فقط في صفحة المشروع. ثلاث درجات منفصلة حتى تُميَّز شدة
      // القرار في الواجهة: COMPLIANCE_VIOLATION للإيقاف الفعلي (خطورة
      // عالية)، COMPLIANCE_RESTRICTION للتقييد/التحقق الميداني (تحذير
      // متوسط)، COMPLIANCE_ADVISORY للتنبيه الاستباقي (مثال: PM10-EARLY-
      // WARNING-007 عند الاقتراب من حد المخالفة قبل الوصول له فعلياً) —
      // بطلب صريح: تنبيه قبل حدوث المخالفة، لا بعدها فقط.
      //
      // مُشتق من finalDecision.operationalDecision (لا compliance.decisionCategory
      // مباشرة كما كان سابقاً) — MANDATORY_STOP هنا يشمل أيضاً حالة "DVI
      // فيزيائي أوقف النشاط بينما الامتثال نفسه ALLOW" (SAFETY_BREACH وحده
      // كافٍ حينها، فلا COMPLIANCE_VIOLATION زائف لمخالفة تنظيمية لم تقع).
      const complianceAlertKind: 'COMPLIANCE_VIOLATION' | 'COMPLIANCE_RESTRICTION' | 'COMPLIANCE_ADVISORY' | null =
        finalDecision.operationalDecision === 'MANDATORY_STOP' || finalDecision.operationalDecision === 'PROTECTIVE_STOP'
          ? compliance.decisionCategory === 'MANDATORY_STOP' || compliance.decisionCategory === 'STOP_AFFECTED_ACTIVITY'
            ? 'COMPLIANCE_VIOLATION'
            : null
          : compliance.decisionCategory === 'RESTRICT_ACTIVITY' || compliance.decisionCategory === 'FIELD_VERIFICATION_REQUIRED'
          ? 'COMPLIANCE_RESTRICTION'
          : compliance.decisionCategory === 'ALLOW_WITH_CONTROLS'
          ? 'COMPLIANCE_ADVISORY'
          : null;

      // يُغلق تلقائياً أي تنبيه من الأنواع الحيّة أعلاه لم يعد شرطه قائماً في
      // هذا التقييم (راجع تعليق autoCloseResolvedAlerts) — يمنع بقاء بانر
      // "تنبيه أمني نشط" أحمر معروضاً في بطاقة الامتثال بعد أن تعود القراءة
      // الحية لحالة آمنة/احتراز فقط.
      const stillActiveKinds = new Set<string>();
      if (finalDecision.mandatoryStop) stillActiveKinds.add(safetyBreachKind);
      if (worst.score >= 65) stillActiveKinds.add(dustKind);
      if (pm10Value !== null && pm10Value !== undefined && pm10Value >= 300 && pm10Value < 340) {
        stillActiveKinds.add(pm10ApproachingKind);
      }
      if (complianceAlertKind) stillActiveKinds.add(complianceAlertKind);
      await autoCloseResolvedAlerts('dust', profile.id, stillActiveKinds);

      if (complianceAlertKind) {
        if (!(await alertExists('dust', profile.id, complianceAlertKind, true))) {
          // نص القاعدة المخالفة الفعلي مباشرة (shortReasonAr، مثال: "مخالفة
          // تنظيمية: تركيز PM10 (1665.2 ميكروجرام/م³) تجاوز حد المخالفة
          // (340 ميكروجرام/م³)") بلا أي جملة عامة تغلّفه — نفس النص المعروض
          // حرفياً في "القرار الموحد للنشاط" بصفحة المشروع لهذا النشاط.
          // بلا metrics هنا عمداً: shortReasonAr نفسه يحمل الرقم/العتبة داخل
          // نص القاعدة (لا حقل رقمي منفصل موحّد عبر كل القواعد الـ44)،
          // فبطاقة "ما الذي حدث بالضبط" في alerts/page.tsx (تعرض alert.message
          // دائماً) تكفي وحدها بلا تكرار بطاقة مقياس فارغة/مضلِّلة بجانبها.
          //
          // viewerMessage: غلاف رسمي موحَّد لجهة الرصد تحديداً (طلب صريح من
          // المستخدم) — فقط لـCOMPLIANCE_VIOLATION (المخالفة الفعلية)، لا
          // COMPLIANCE_RESTRICTION/ADVISORY. نفس تفاصيل shortReasonAr الرقمية
          // بلا تغيير، فقط بصياغة مختلفة عن نص صاحب المشروع التقني.
          const viewerMessage =
            complianceAlertKind === 'COMPLIANCE_VIOLATION'
              ? `يُفيد هذا الإشعار بأنه تم رصد مخالفة تنظيمية في موقع ${profile.projects?.name || 'غير محدد'}.\nتفاصيل المخالفة: ${compliance.shortReasonAr}`
              : undefined;
          await insertAlert({
            projectId: profile.project_id, activitySource: 'dust', activityId: profile.id,
            timing: 'DURING', kind: complianceAlertKind,
            message: compliance.shortReasonAr,
            viewerMessage,
            recommendedAction: compliance.requiredActions.join('، ') || compliance.shortReasonAr,
          });
        }
      }
    } catch (e) {
      console.error(`dust evaluation failed for profile ${profile.id}:`, e);
    }
  }
}

export async function GET(request: Request) {
  // حماية بسيطة: نتحقق من رأس Authorization مقارنةً بسر مخزّن ببيئة
  // الخادم (CRON_SECRET). بدون هذا التحقق، أي زائر يقدر يشغّل هذا
  // المسار يدوياً بدون قيود.
  //
  // خطأ مكتشَف ومُصلَح: كان الشرط `process.env.CRON_SECRET && ...` — لو
  // المتغير غير معرَّف أصلاً بالبيئة (خطأ إعداد نشر، لا حالة متعمَّدة)،
  // الشرط بأكمله false فيتخطى التحقق بالكامل (fail-open)، فيصبح المسار
  // مفتوحاً بلا أي حماية لأي زائر. الإصلاح: رفض الطلب صراحة إن كان المتغير
  // غير معرَّف (fail-closed) — يلزم ضبطه بالبيئة قبل أن يعمل هذا المسار
  // إطلاقاً، بدل السماح الصامت بغيابه.
  if (!process.env.CRON_SECRET) {
    return NextResponse.json({ ok: false, error: 'CRON_SECRET غير مُعرَّف بالخادم' }, { status: 503 });
  }
  const authHeader = request.headers.get('authorization') || '';
  if (!timingSafeStringEqual(authHeader, `Bearer ${process.env.CRON_SECRET}`)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  try {
    await checkDustActivities();
    return NextResponse.json({ ok: true, checkedAt: new Date().toISOString() });
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: safeErrorResponse(error, 'alert generation failed') }, { status: 500 });
  }
}

// -------------------------------------------------------------
// vercel.json بجذر المشروع يشغّل هذا المسار دورياً على Vercel — لكن خطة
// Hobby (المجانية) لا تقبل جدولة Cron بمعدل أقل من مرة واحدة يومياً (أي
// تكرار أعلى يُرفض/يُخفَّض تلقائياً لخطة يومية). هذا كافٍ لتذكيرات
// BEFORE_* العامة، لكنه غير كافٍ إطلاقاً لقواعد PM10 الزمنية الحسّاسة
// (تأكيد المخالفة خلال دقيقتين، تعليق النشاط بعد 30 دقيقة، استقرار
// الاستئناف بعد 10 دقائق) — تلك تحتاج فحصاً كل بضع دقائق على الأكثر.
//
// الاعتماد الفعلي حالياً على خطة Hobby هو /api/alerts/generate-mine
// (استدعاء من المتصفح كل 5 دقائق طوال بقاء المستخدم في لوحة التحكم،
// راجع app/dashboard/layout.tsx) — يعمل فقط أثناء وجود تبويب مفتوح فعلياً.
// للتغطية الكاملة بلا شرط "تبويب مفتوح"، الخياران: (1) الترقية لخطة
// Vercel Pro وتكثيف جدول هذا الـCron إلى كل 2-5 دقائق، أو (2) استخدام
// خدمة Cron خارجية مجانية (مثل cron-job.org) تستدعي هذا المسار مباشرة
// بنفس رأس Authorization: Bearer <CRON_SECRET> دون أي تعديل على الكود.
// -------------------------------------------------------------
