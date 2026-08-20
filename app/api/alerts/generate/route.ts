// -------------------------------------------------------------
// المسار: app/api/alerts/generate/route.ts
//
// مولّد التنبيهات — يُستدعى دورياً (عبر Cron، راجع vercel.json) ويفحص
// كل أنشطة الغبار المجدولة، ويقرر متى يجب إنشاء تذكيرات/توقّعات، ويكتبها
// فعلياً في قاعدة البيانات. نسخة DCR: غبار فقط، بلا حرارة أو رافعات.
//
// خطأ معماري حرج مكتشَف ومُصلَح (مراجعة كود خارجي — "المسار القديم للتنبيهات
// ينافس Outbox ويصنع قراءات PM10 وهمية"): كان هذا الملف يُنشئ ويُغلق أيضاً
// تنبيهات "الحالة الحيّة الآن" (SAFETY_BREACH/DUST/PM10_APPROACHING_LIMIT/
// COMPLIANCE_VIOLATION/COMPLIANCE_RESTRICTION) بمسار مستقل تماماً عن
// decision_alert_outbox/persist_activity_decision_atomic — مساران غير
// متزامنين يتنافسان على نفس صفوف alerts، بلا قفل ذرّي مشترك، وautoCloseResolvedAlerts
// هنا كان يقدر يُغلق تنبيهاً فتحه Outbox للتو. القرار المعماري الآن:
// **decision_alert_outbox/Reconciler هو المالك الوحيد لفتح وإغلاق كل
// تنبيهات "الحالة الحيّة الآن"** — بلا استثناء، حتى لو لم يوجد له مقابل في
// Outbox اليوم (DUST/PM10_APPROACHING_LIMIT الحيّتان تُركتا فراغاً معمارياً
// صريحاً، لا مساراً منافساً مؤقتاً). هذا الملف الآن يقتصر حصراً على:
//   1) تذكيرات BEFORE_* (زمنية بحتة، لا علاقة لها بأي قراءة حيّة)
//   2) توقّعات FORECAST_WARNING/COMPLIANCE_ADVISORY (الساعة المسبِّبة لا تزال
//      بالمستقبل ضمن نافذة النشاط — لا حالة حيّة فعلية الآن، فلا تنافس ممكن
//      مع Outbox الذي يُنشئ فقط عند وقوع الحالة فعلياً).
// كما حُذف منه إدراج onsite_pm10 في pm10_readings_history (كان يعيد نسخ قيمة
// ثابتة بوقت جديد كل تشغيل، فيُنتج سلسلة زمنية وهمية) — القياس اليدوي الآن
// يدخل حصراً عبر POST /api/pm10-readings/manual.
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
// تنبيهات "أثناء التنفيذ" (DURING) — فقط أثناء تنفيذ النشاط فعلياً، وفقط
// حين تكون الساعة المسبِّبة (worst.time) لا تزال بالمستقبل ضمن نافذة النشاط
// (isWorstRightNow=false، هامش 30 دقيقة) — أي توقّع لا حالة حيّة فعلية الآن:
//   • FORECAST_WARNING  : mandatoryStop المتوقَّع=true، أو worst.score
//                     المتوقَّع >= 65 (نطاق RED)، أو PM10 المتوقَّع 300-339.
//   • COMPLIANCE_ADVISORY : قرار الامتثال المخزَّن = ALLOW_WITH_CONTROLS
//                     (تنبيه استباقي قبل وقوع أي مخالفة فعلية).
//   الحالة الحيّة الآن (isWorstRightNow=true) لا تُنشئ أي تنبيه من هذا
//   الملف إطلاقاً — SAFETY_BREACH/COMPLIANCE_VIOLATION/COMPLIANCE_RESTRICTION
//   الحيّة من مسؤولية Outbox حصراً (راجع تعليق أعلى الملف).
//   لتفادي الإغراق بتنبيهات مكررة: قبل إنشاء أي تنبيه DURING جديد،
//   نتحقق أولاً من عدم وجود تنبيه بنفس (activity_source, activity_id,
//   kind) في حالة غير مغلقة (state != CLOSED) مسبقاً.
// -------------------------------------------------------------

import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { timingSafeStringEqual } from '@/app/lib/timingSafe';
import { evaluateDustVisibilityWindow } from '@/app/utils/dust-engine';
import type { DustEngineInput, ReceptorType, DistanceBand } from '@/app/utils/dust-engine/types';
import { displayActivityLabel } from '@/app/lib/activityLabels';
import { resolveFreshProjectDevice, fetchLatestFinalDecisions, fetchLatestStoredCompliance, activityDecisionKey, deriveInternalDustSourceFromActivity, type FreshDeviceReading } from '@/app/lib/dustEvaluation';
import { safeErrorResponse } from '@/app/lib/apiError';

// عميل Supabase بصلاحية Service Role: هذا المسار يعمل دون جلسة مستخدم
// (يُستدعى من Cron)، فيحتاج مفتاح الخدمة لتجاوز RLS والقراءة من كل
// المشاريع/الأنشطة.
const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string
);

// حقول project_dust_profiles المقروءة فعلياً في buildDustEngineInputSrv —
// نفس الصف الخام المُستعلَم في checkDustActivities أدناه (profiles!inner
// أضافت أيضاً projects، غير مستخدَمة هنا).
interface DustProfileRow {
  regulatory_activity?: string | null;
  has_earthworks?: boolean | null;
  internal_dirt_roads?: boolean | null;
  heavy_equipment_movement?: boolean | null;
  loose_materials?: boolean | null;
  surface_wet?: boolean | null;
  receptor_type?: ReceptorType | null;
  receptor_distance?: DistanceBand | null;
  receptor_is_downwind?: boolean | null;
  visible_dust_plume_reported?: boolean | null;
  open_concrete_pour?: boolean | null;
  onsite_visibility_m?: number | null;
  onsite_pm10?: number | null;
  onsite_pm25?: number | null;
  device_id?: string | null;
}

// نفس دالة بناء مدخلات محرك الغبار المستخدمة في صفحة تفاصيل المشروع
// (منسوخة هنا لضمان تطابق الحساب - يفضّل نقلها لملف مشترك لاحقاً).
function buildDustEngineInputSrv(
  dbProfile: DustProfileRow,
  lat: number,
  lon: number,
  freshDevice?: FreshDeviceReading | null
): DustEngineInput {
  const regulatoryActivity = dbProfile.regulatory_activity as DustEngineInput['regulatoryActivity'];
  const {
    hasEarthworksFromActivity,
    internalDirtRoadsFromActivity,
    looseMaterialsFromActivity,
    heavyEquipmentMovementFromActivity,
  } = deriveInternalDustSourceFromActivity(regulatoryActivity);
  return {
    regulatoryActivity,
    latitude: lat,
    longitude: lon,
    site: {
      hasEarthworks: Boolean(dbProfile.has_earthworks) || hasEarthworksFromActivity,
      internalDirtRoads: Boolean(dbProfile.internal_dirt_roads) || internalDirtRoadsFromActivity,
      heavyEquipmentMovement: Boolean(dbProfile.heavy_equipment_movement) || heavyEquipmentMovementFromActivity,
      looseMaterials: Boolean(dbProfile.loose_materials) || looseMaterialsFromActivity,
      surfaceWet: Boolean(dbProfile.surface_wet),
      receptorType: dbProfile.receptor_type || 'NONE_NEARBY',
      receptorDistance: dbProfile.receptor_distance || 'OVER_500M',
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
  const query = supabaseAdmin
    .from('alerts')
    .select('id, state')
    .eq('activity_source', activitySource)
    .eq('activity_id', activityId)
    .eq('kind', kind);
  const { data } = await query;
  if (!data || data.length === 0) return false;
  if (!onlyOpen) return true;
  return data.some((a: { state: string }) => a.state !== 'CLOSED');
}

// خطأ حرج مكتشَف ومُصلَح (مراجعة كود خارجي — "المسار القديم للتنبيهات ينافس
// Outbox ويصنع قراءات PM10 وهمية"): كانت هذه القائمة تشمل أيضاً SAFETY_BREACH/
// DUST/PM10_APPROACHING_LIMIT/COMPLIANCE_VIOLATION/COMPLIANCE_RESTRICTION —
// أنواع "حالة حيّة الآن" (isWorstRightNow=true)، لا تذكيرات ولا توقعات.
// autoCloseResolvedAlerts كانت بذلك تقدر تُغلق تنبيهاً من هذه الأنواع حتى لو
// كان مملوكاً فعلياً لـdecision_alert_outbox (المالك الذري الوحيد لفتح/إغلاق
// SAFETY_BREACH/COMPLIANCE_VIOLATION/COMPLIANCE_RESTRICTION عبر create_alert_
// atomic/close_alert_atomic) — مساران مستقلان يتنافسان على نفس الصف بلا أي
// قفل مشترك بينهما. القرار المعماري الآن: Outbox/Reconciler هو المالك الوحيد
// لفتح/إغلاق كل تنبيهات "الحالة الحيّة الآن" بلا استثناء (يشمل DUST/
// PM10_APPROACHING_LIMIT رغم عدم وجود مقابل Outbox لهما اليوم — لا تُنشآن هنا
// بعد الآن إطلاقاً، تُترك فراغاً معمارياً صريحاً بانتظار توسيع Outbox لاحقاً،
// لا مسار منافس مؤقت). هذا المسار القديم الآن يملك حصرياً FORECAST_WARNING
// (توقّع مستقبلي ضمن نافذة النشاط) وCOMPLIANCE_ADVISORY (تنبيه استباقي قبل
// وقوع مخالفة) — كلاهما بلا مقابل في Outbox أصلاً (Outbox يُنشئ فقط عند وقوع
// الحالة فعلياً، لا عند توقّعها/الاقتراب منها)، فلا تنافس ممكن عليهما. لا
// يشمل BEFORE_* عمداً — تذكيرات لمرة واحدة بطبيعتها، لا حالة "تحسّنت" لها.
const LIVE_CONDITION_ALERT_KINDS = [
  'FORECAST_WARNING',
  'COMPLIANCE_ADVISORY',
] as const;

// خطأ أمني مكتشَف ومُصلَح (مراجعة كود خبير خارجي — "سجل القرارات والتنبيهات
// قابل للتعديل والحذف"): كان هذا يُنفِّذ UPDATE alerts SET state='CLOSED'
// مباشرة بلا أثر تدقيق. الآن يكتب حدثاً في alert_state_events لكل صف
// يُغلَق (actor_user_id=null يعني تغييراً آلياً من هذا المولّد، لا فعل
// مستخدم بشري — راجع تعليق العمود في migration). trigger في قاعدة
// البيانات يزامن alerts.state تلقائياً بعد كل إدراج.
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
    openAlerts.map((a: { id: string; state: string }) => ({
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
  // archived_at (النشاط نفسه، لا المشروع فقط) — راجع تعليق الأرشفة أعلاه؛
  // نفس المبدأ الآن على مستوى النشاط الفردي بعد أن صار DELETE /api/
  // activities أرشفة لا حذفاً فعلياً (راجع app/api/activities/route.ts).
  let q = supabaseAdmin
    .from('project_dust_profiles')
    .select('*, projects!inner(*)')
    .is('projects.archived_at', null)
    .is('archived_at', null);
  if (projectIds && projectIds.length > 0) q = q.in('project_id', projectIds);
  const { data: profiles } = await q;

  // خطأ حرج مكتشَف ومُصلَح (مراجعة خبير خارجي — القسم 4: "checkDustActivities
  // يعيد Open-Meteo إلى دورة القرار"): استعلام sensitive_receptors كان
  // مطلوباً فقط لتغذية buildComplianceContext في الـfallback المحلي المحذوف
  // أدناه (راجع تعليق الحارس داخل الحلقة) — لم يعد له أي مستهلك بعد إزالة
  // ذلك الفرع، فحُذف بالكامل بدل إبقائه استعلاماً ميتاً.

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
    // النشاط التنظيمي المختار فعلياً (كسارة/هدم/...) — هذا النص يُخزَّن
    // حرفياً في alerts.message/recommended_action، فيلزم أن يعرض ما اختاره
    // المستخدم فعلاً من الشاشة.
    const label = displayActivityLabel(profile);

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

      // تنبيه امتثال تنظيمي — يُقرَأ الآن من dust_compliance_evaluations.result
      // المخزَّن فعلياً (عبر fetchLatestStoredCompliance، كتبه evaluate/route.ts)
      // بدل استدعاء evaluateDustCompliance محلياً هنا بمعزل — خطأ معماري
      // مكتشَف ومُصلَح (مراجعة كود خبير خارجي — C-05: "القرار المخزَّن ليس
      // المصدر الوحيد؛ مولّد التنبيهات يعيد حساب DVI وCompliance، ثم يمزجهما
      // مع قرار مخزَّن أو fallback مبسَّط"): كان هذا المسار يبني complianceCtx
      // ويستدعي evaluateDustCompliance بنفسه بمدخلات (previousDecision/
      // pm10Sustained) قد تُجلَب بتوقيت مختلف طفيفاً عن نفس الحساب الذي نفّذه
      // evaluate/route.ts لنفس النشاط، فقد ينتج requiredActions/shortReasonAr/
      // decisionCategory مختلفة عمّا تعرضه فعلاً بطاقة/خريطة المشروع بنفس
      // اللحظة تقريباً — بالضبط نفس عيب FinalDecision الذي أُصلح سابقاً
      // (راجع تعليق finalDecision أدناه)، لكنه كان لا يزال قائماً لـcompliance
      // نفسها. نفس مبدأ fetchLatestFinalDecisions: قراءة واحدة من اللقطة
      // المخزَّنة بدل حساب مستقل بمعزل.
      //
      // خطأ حرج مكتشَف ومُصلَح (مراجعة كود خارجي — "المسار القديم للتنبيهات
      // ينافس Outbox ويصنع قراءات PM10 وهمية"): كان هنا إدراج onsite_pm10
      // (حقل ثابت على project_dust_profiles) في pm10_readings_history بوقت
      // جديد في كل تشغيل — يحوّل قياساً يدوياً واحداً إلى سلسلة تبدو مستمرة
      // زوراً (نفس الخلل بالضبط الذي كان في computeDustComplianceResults،
      // راجع تعليقه في dustEvaluation.ts). حُذف كلياً؛ القياس اليدوي الآن
      // يدخل حصراً عبر POST /api/pm10-readings/manual (observed_at/
      // operator_id/idempotency_key)، لا كأثر جانبي هنا.
      //
      // خطأ حرج مكتشَف ومُصلَح (مراجعة خبير خارجي — التقرير النهائي، القسم 4:
      // "checkDustActivities يعيد Open-Meteo إلى دورة القرار"): كان fallback
      // محلي هنا (evaluateDustCompliance/decideFinal مبسَّط مبني على worst
      // الحي من Open-Meteo) يُستخدَم كلما غاب تقييم/قرار مخزَّن لنشاط ما — لكن
      // هذا الـfallback هو بالضبط المسار الذي يُعيد بيانات Open-Meteo لدورة
      // القرار الفعلية (مصدر compliance/finalDecision المستخدَم لاحقاً في بناء
      // stillActiveKinds وتنبيهات SAFETY_BREACH/DUST/PM10_APPROACHING). بما أن
      // evaluateProject.ts يستدعي checkDustActivities مباشرة بعد كل حفظ قرار
      // (راجع تعليق evaluateProject.ts)، صف مخزَّن يكون موجوداً عملياً في كل
      // استدعاء لاحق لنفس النشاط — الفرع المتبقي (أول تقييم قبل أي evaluate
      // سابق) نادر جداً ولا يستحق فتح مسار قرار موازٍ يعتمد على تقدير طقس.
      // الإصلاح: لا fallback محلي بعد الآن — نشاط بلا تقييم/قرار مخزَّن بعد
      // يُتخطّى بالكامل هذه الدورة (نفس معاملة غياب الإحداثيات أعلاه)، لا
      // يُحسَب من Open-Meteo محلياً. القرار المخزَّن سيُنشأ قريباً عبر
      // evaluate/route.ts أو evaluateProject.ts (تأخير دورة واحدة فقط، لا
      // فقدان بيانات) — حينها يُعالَج هذا النشاط بأول استدعاء لاحق يجد الصف.
      if (!profile.activity_group_id || !profile.project_id) {
        // بلا activity_group_id/project_id لا يمكن أصلاً قراءة أي تقييم/قرار
        // مخزَّن (المفتاح غير موجود) — نفس معاملة "لا صف مخزَّن بعد" أدناه.
        await autoCloseResolvedAlerts('dust', profile.id, new Set());
        continue;
      }
      const activityGroupId = profile.activity_group_id;
      const decisionKey = activityDecisionKey(profile.project_id, activityGroupId);
      const [storedComplianceMap, storedFinalDecisions] = await Promise.all([
        fetchLatestStoredCompliance(supabaseAdmin, [{ projectId: profile.project_id, activityGroupId }]),
        fetchLatestFinalDecisions(supabaseAdmin, [{ projectId: profile.project_id, activityGroupId }]),
      ]);
      const compliance = storedComplianceMap.get(decisionKey);
      const storedDecision = storedFinalDecisions.get(decisionKey);
      if (!compliance || !storedDecision) {
        await autoCloseResolvedAlerts('dust', profile.id, new Set());
        continue;
      }

      // القرار النهائي الموحَّد — يُقرَأ حصرياً من final_decisions (كتبه
      // evaluate/route.ts، نقطة الحساب الوحيدة لـdecideFinal) — خطأ معماري
      // مكتشَف ومُصلَح (مراجعة كود مدير — "FinalDecisionEngine ليس المصدر
      // التشغيلي الوحيد فعلياً"): كان كل مسار (البانر، الخريطة، مولّد
      // التنبيهات هذا) يُعيد بناء dvi/compliance ويستدعي decideFinal بنفسه،
      // بمدخلات قد تختلف طفيفاً عن ما يُعرض فعلياً في صفحة المشروع لنفس
      // النشاط. الآن هذا المسار يقرأ آخر قرار مخزَّن فعلياً لنفس
      // activity_group_id — نفس القرار بالضبط المعروض في البطاقة/الخريطة، لا
      // نسخة مُعاد حسابها محلياً من Open-Meteo (راجع تعليق الحارس أعلاه).
      const finalDecision = {
        mandatoryStop: storedDecision.mandatory_stop as boolean,
        operationalDecision: storedDecision.operational_decision as string,
        decisionLabelAr: storedDecision.decision_label_ar as string,
      };

      // خطأ حرج مكتشَف ومُصلَح (مراجعة كود خارجي — "المسار القديم للتنبيهات
      // ينافس Outbox ويصنع قراءات PM10 وهمية"): كانت safetyBreachKind/dustKind/
      // pm10ApproachingKind تتحوّل إلى SAFETY_BREACH/DUST/PM10_APPROACHING_LIMIT
      // (لا FORECAST_WARNING) حين isWorstRightNow=true — أي "حالة حيّة الآن"،
      // لا توقّع. فرع mandatoryStop كان بالفعل مقيَّداً بـ`!isWorstRightNow`
      // (فلا SAFETY_BREACH حيّة تُنشأ هنا عملياً)، لكن فرع DUST (`worst.score
      // >= 65`) وفرع PM10_APPROACHING_LIMIT أدناه كانا بلا هذا القيد إطلاقاً —
      // ينشئان تنبيهاً حيّاً فعلياً بمعزل عن Outbox (السباق المذكور في تعليق
      // LIVE_CONDITION_ALERT_KINDS أعلاه). القرار المعماري: هذا المسار الآن
      // يُنشئ FORECAST_WARNING فقط (توقّع ضمن نافذة النشاط) حين isWorstRightNow
      // =false؛ لا تنبيه حيّ الآن مهما كانت شدة worst.score/pm10Value — لا
      // مقابل في Outbox لـDUST/PM10_APPROACHING_LIMIT اليوم، فتُترك فراغاً
      // معمارياً صريحاً بدل مسار منافس مؤقت (راجع توثيق Outbox الكامل هناك).
      if (isWorstRightNow) {
        // الحالة حيّة الآن فعلاً — Outbox/Reconciler وحده يملك فتح/إغلاق
        // SAFETY_BREACH لهذه اللحظة (عبر persist_activity_decision_atomic
        // المُستدعاة من نفس دورة evaluateProject/evaluate). DUST/
        // PM10_APPROACHING_LIMIT الحيّة لا تُنشآن هنا بعد الآن إطلاقاً.
      } else if (finalDecision.mandatoryStop || worst.score >= 65) {
        if (!(await alertExists('dust', profile.id, 'FORECAST_WARNING', true))) {
          const isMandatory = finalDecision.mandatoryStop;
          await insertAlert({
            projectId: profile.project_id, activitySource: 'dust', activityId: profile.id,
            timing: 'DURING', kind: 'FORECAST_WARNING',
            message: isMandatory
              ? `توقّع تجاوز حد صارم ${liveTimingPhraseAr} لنشاط "${label}" — إيقاف إلزامي متوقَّع.`
              : `توقّع انخفاض حاد في الرؤية ${liveTimingPhraseAr} لنشاط "${label}".`,
            metricLabel: 'مؤشر الرؤية/الغبار', metricActual: `${worst.score}/100`,
            metricThreshold: isMandatory ? 'إيقاف إلزامي' : '65/100 (تقييد شديد)',
            recommendedAction: isMandatory ? finalDecision.decisionLabelAr : worst.decisionLabelAr,
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
      const pm10Approaching = pm10Value !== null && pm10Value !== undefined && pm10Value >= 300 && pm10Value < 340;
      // راجع تعليق isWorstRightNow أعلاه — لا PM10_APPROACHING_LIMIT حيّة
      // تُنشأ هنا بعد الآن، فقط FORECAST_WARNING حين لا تزال الذروة مستقبلية.
      if (pm10Approaching && !isWorstRightNow) {
        if (!(await alertExists('dust', profile.id, 'FORECAST_WARNING', true))) {
          await insertAlert({
            projectId: profile.project_id, activitySource: 'dust', activityId: profile.id,
            timing: 'DURING', kind: 'FORECAST_WARNING',
            message: `توقّع اقتراب تركيز الغبار (PM10) من الحد التنظيمي ${liveTimingPhraseAr} لنشاط "${label}" — إجراء وقائي يجنّبك المخالفة.`,
            metricLabel: 'PM10', metricActual: `${pm10Value} ميكروجرام/م³`, metricThreshold: '340 ميكروجرام/م³ (حد المخالفة)',
            recommendedAction: 'فعّل التثبيط المعزز (رش/تغطية) لتفادي تجاوز الحد التنظيمي والتعرض لغرامة عند اقتراب موعد النشاط.',
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

      // خطأ حرج مكتشَف ومُصلَح (مراجعة كود خارجي — "المسار القديم للتنبيهات
      // ينافس Outbox"): stillActiveKinds/autoCloseResolvedAlerts كانا يتتبعان
      // أيضاً SAFETY_BREACH/DUST/PM10_APPROACHING_LIMIT/COMPLIANCE_VIOLATION/
      // COMPLIANCE_RESTRICTION — أنواع لم يعد هذا المسار يُنشئها (راجع تعليق
      // isWorstRightNow أعلاه)، وبعضها (VIOLATION/RESTRICTION) مملوك ذرّياً
      // لـOutbox. الآن نتتبع فقط ما يُنشئه هذا المسار فعلياً: FORECAST_WARNING
      // وCOMPLIANCE_ADVISORY — نفس قائمة LIVE_CONDITION_ALERT_KINDS بالضبط،
      // فـautoCloseResolvedAlerts لا يقدر إطلاقاً يلمس صفاً مملوكاً لـOutbox
      // (kindsToClose مُشتقة من نفس القائمة المُقيَّدة).
      const stillActiveKinds = new Set<string>();
      if (!isWorstRightNow && (finalDecision.mandatoryStop || worst.score >= 65 || pm10Approaching)) {
        stillActiveKinds.add('FORECAST_WARNING');
      }
      if (complianceAlertKind === 'COMPLIANCE_ADVISORY') stillActiveKinds.add('COMPLIANCE_ADVISORY');
      await autoCloseResolvedAlerts('dust', profile.id, stillActiveKinds);

      // خطأ حرج مكتشَف ومُصلَح (مراجعة خبير خارجي — القسم 6 (متابعة)، وتقرير
      // "المسار القديم ينافس Outbox"): COMPLIANCE_VIOLATION/COMPLIANCE_RESTRICTION
      // تُنشآن وتُغلَقان الآن حصرياً عبر decision_alert_outbox (نفس منطق
      // SAFETY_BREACH أعلاه بالضبط) — لا insertAlert ولا autoCloseResolvedAlerts
      // هنا لهذين النوعين إطلاقاً بعد الآن (حذفا من LIVE_CONDITION_ALERT_KINDS).
      // COMPLIANCE_ADVISORY وحده يبقى من مسؤولية هذا المسار (تنبيه استباقي، لا
      // مقابل له في Outbox أصلاً).
      if (complianceAlertKind === 'COMPLIANCE_ADVISORY') {
        if (!(await alertExists('dust', profile.id, complianceAlertKind, true))) {
          // نص القاعدة المخالفة الفعلي مباشرة (shortReasonAr، مثال: "مخالفة
          // تنظيمية: تركيز PM10 (1665.2 ميكروجرام/م³) تجاوز حد المخالفة
          // (340 ميكروجرام/م³)") بلا أي جملة عامة تغلّفه — نفس النص المعروض
          // حرفياً في "القرار الموحد للنشاط" بصفحة المشروع لهذا النشاط.
          // بلا metrics هنا عمداً: shortReasonAr نفسه يحمل الرقم/العتبة داخل
          // نص القاعدة (لا حقل رقمي منفصل موحّد عبر كل القواعد الـ44)،
          // فبطاقة "ما الذي حدث بالضبط" في alerts/page.tsx (تعرض alert.message
          // دائماً) تكفي وحدها بلا تكرار بطاقة مقياس فارغة/مضلِّلة بجانبها.
          await insertAlert({
            projectId: profile.project_id, activitySource: 'dust', activityId: profile.id,
            timing: 'DURING', kind: complianceAlertKind,
            message: compliance.shortReasonAr,
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
  } catch (error) {
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
