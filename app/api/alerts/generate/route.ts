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
import { resolveFreshProjectDevice, fetchPm10SustainedStatus, type FreshDeviceReading } from '@/app/lib/dustEvaluation';
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
// يدوياً من صفحة التنبيهات. لا يشمل BEFORE_*/NO_DECISION_YET عمداً — تلك
// تذكيرات لمرة واحدة بطبيعتها، لا حالة "تحسّنت" لها.
const LIVE_CONDITION_ALERT_KINDS = [
  'SAFETY_BREACH',
  'DUST',
  'PM10_APPROACHING_LIMIT',
  'COMPLIANCE_VIOLATION',
  'COMPLIANCE_RESTRICTION',
  'COMPLIANCE_ADVISORY',
] as const;

async function autoCloseResolvedAlerts(
  activitySource: 'dust',
  activityId: string,
  stillActiveKinds: Set<string>
) {
  const kindsToClose = LIVE_CONDITION_ALERT_KINDS.filter((k) => !stillActiveKinds.has(k));
  if (kindsToClose.length === 0) return;
  await supabaseAdmin
    .from('alerts')
    .update({ state: 'CLOSED' })
    .eq('activity_source', activitySource)
    .eq('activity_id', activityId)
    .in('kind', kindsToClose)
    .neq('state', 'CLOSED');
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
  const { error } = await supabaseAdmin.from('alerts').insert({
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
  });
  if (error) {
    console.error(`insertAlert failed [${params.activitySource}/${params.kind}]:`, error.message);
  }
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

// دقائق السماح بعد بدء النشاط قبل اعتباره "بلا قرار" — يمنح المستخدم وقتاً
// طبيعياً للتفاعل بعد بدء النشاط مباشرة قبل إزعاجه بتنبيه
const NO_DECISION_GRACE_MINUTES = 15;

// تنبيه NO_DECISION_YET: نشاط بدأ فعلياً (تجاوز وقت البدء بمهلة السماح)
// ولا يوجد له أي قرار موثّق في decision_records بعد. لا يتكرر لنفس
// النشاط بمجرد إنشائه مرة (onlyOpen=false).
async function checkNoDecisionAlert(
  projectId: string,
  activitySource: 'dust',
  activityId: string,
  activityLabel: string,
  startIso: string,
  endIso: string
) {
  const now = Date.now();
  const startMs = new Date(startIso).getTime();
  const endMs = new Date(endIso).getTime();
  const graceMs = NO_DECISION_GRACE_MINUTES * 60000;

  // النشاط لم يبدأ بعد، أو لم تمرّ مهلة السماح، أو انتهى فعلاً — لا تنبيه
  if (now < startMs + graceMs || now > endMs) return;

  if (await alertExists(activitySource, activityId, 'NO_DECISION_YET', false)) return;

  const { data: decisions } = await supabaseAdmin
    .from('decision_records')
    .select('id')
    .eq('activity_source', activitySource)
    .eq('activity_id', activityId)
    .limit(1);
  if (decisions && decisions.length > 0) return; // يوجد قرار موثّق بالفعل

  await insertAlert({
    projectId, activitySource, activityId, timing: 'DURING', kind: 'NO_DECISION_YET',
    message: `نشاط "${activityLabel}" جارٍ الآن ولم يُتّخذ فيه أي قرار بعد (اعتماد/تقييد/تأجيل).`,
    recommendedAction: 'راجع النشاط في لوحة التحكم واتّخذ القرار المناسب.',
  });
}

export async function checkDustActivities(projectIds?: string[]) {
  let q = supabaseAdmin.from('project_dust_profiles').select('*, projects(*)');
  if (projectIds && projectIds.length > 0) q = q.in('project_id', projectIds);
  const { data: profiles } = await q;

  // مستقبِلات حساسة يدوية — نفس مصدر [projectId]/route.ts، مطلوبة لمحرك
  // الامتثال (مسافة الكسارة/الأكوام) حتى يطابق تنبيه COMPLIANCE_VIOLATION
  // هنا بالضبط قرار "القرار الموحد للنشاط" المعروض في صفحة المشروع لنفس
  // النشاط. استعلام واحد لكل تشغيل cron، لا لكل نشاط.
  const { data: sensitiveReceptorRows } = await supabaseAdmin
    .from('sensitive_receptors')
    .select('id, name, receptor_type, lat, lng');
  const sensitiveReceptors = (sensitiveReceptorRows || []).map(buildSensitiveReceptor);

  for (const profile of profiles || []) {
    const lat = profile.projects?.latitude ?? 24.7136;
    const lon = profile.projects?.longitude ?? 46.6753;
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
    await checkNoDecisionAlert(profile.project_id, 'dust', profile.id, label, startIso, endIso);

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

    try {
      const freshDevice = await resolveFreshProjectDevice(supabaseAdmin, profile.project_id, profile.device_id).catch(() => null);
      const engineInput = buildDustEngineInputSrv(profile, lat, lon, freshDevice);
      const durationHours = Number(profile.duration_hours) || durationMinutes / 60;
      const windowEval = await evaluateDustVisibilityWindow(engineInput, startIso, durationHours);
      const worst = windowEval.worst;

      if (worst.mandatoryStop) {
        if (!(await alertExists('dust', profile.id, 'SAFETY_BREACH', true))) {
          await insertAlert({
            projectId: profile.project_id, activitySource: 'dust', activityId: profile.id,
            timing: 'DURING', kind: 'SAFETY_BREACH',
            message: `تجاوز حد صارم أثناء تنفيذ نشاط "${label}" — إيقاف إلزامي.`,
            metricLabel: 'مؤشر الرؤية/الغبار', metricActual: `${worst.score}/100`, metricThreshold: 'إيقاف إلزامي',
            recommendedAction: worst.decisionLabelAr,
          });
        }
      } else if (worst.score >= 65) {
        // نطاق "65 فأكثر" مطابق حرفياً لبداية نطاق RED في RISK_ZONES
        // المستخدم بنفس القيم داخل DustWidgetCard (65-84 = RED، 85-100 =
        // DARK_RED)، فيغطي "RED وما فوق" تماماً كما هو موصوف أعلى الملف.
        if (!(await alertExists('dust', profile.id, 'DUST', true))) {
          await insertAlert({
            projectId: profile.project_id, activitySource: 'dust', activityId: profile.id,
            timing: 'DURING', kind: 'DUST',
            message: `انخفاض حاد في الرؤية أثناء تنفيذ نشاط "${label}".`,
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
      const pm10Value = worst.rawWeatherSample?.pm10;
      if (pm10Value !== null && pm10Value !== undefined && pm10Value >= 300 && pm10Value < 340) {
        if (!(await alertExists('dust', profile.id, 'PM10_APPROACHING_LIMIT', true))) {
          await insertAlert({
            projectId: profile.project_id, activitySource: 'dust', activityId: profile.id,
            timing: 'DURING', kind: 'PM10_APPROACHING_LIMIT',
            message: `تركيز الغبار (PM10) يقترب من الحد التنظيمي أثناء تنفيذ نشاط "${label}" — إجراء وقائي فوري يجنّبك المخالفة.`,
            metricLabel: 'PM10', metricActual: `${pm10Value} ميكروجرام/م³`, metricThreshold: '340 ميكروجرام/م³ (حد المخالفة)',
            recommendedAction: 'فعّل التثبيط المعزز فوراً (رش/تغطية) لتفادي تجاوز الحد التنظيمي والتعرض لغرامة.',
          });
        }
      }

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
      let pm10Sustained: { sustainedMinutesAbove340: number; sustainedMinutesAbove250: number } | null = null;
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
        pm10Sustained = await fetchPm10SustainedStatus(supabaseAdmin, profile.project_id, profile.activity_group_id);
      }

      const complianceCtx = buildComplianceContext(profile.projects, profile, worst, sensitiveReceptors, previousDecision, pm10Sustained);
      const compliance = evaluateDustCompliance(complianceCtx);

      // يغطي كل قرار امتثال أقل من ALLOW الكامل (وليس فقط الإيقاف الإلزامي/
      // إيقاف النشاط المتأثر) — أي مخالفة قاعدة فعلية، حتى لو كانت تقييداً
      // أو تحقّقاً ميدانياً أو مجرد تنبيه استباقي، يجب أن تظهر في غرفة
      // التنبيهات لا فقط في صفحة المشروع. ثلاث درجات منفصلة حتى تُميَّز شدة
      // القرار في الواجهة: COMPLIANCE_VIOLATION للإيقاف الفعلي (خطورة
      // عالية)، COMPLIANCE_RESTRICTION للتقييد/التحقق الميداني (تحذير
      // متوسط)، COMPLIANCE_ADVISORY للتنبيه الاستباقي (مثال: PM10-EARLY-
      // WARNING-007 عند الاقتراب من حد المخالفة قبل الوصول له فعلياً) —
      // بطلب صريح: تنبيه قبل حدوث المخالفة، لا بعدها فقط.
      const complianceAlertKind: 'COMPLIANCE_VIOLATION' | 'COMPLIANCE_RESTRICTION' | 'COMPLIANCE_ADVISORY' | null =
        compliance.decisionCategory === 'MANDATORY_STOP' || compliance.decisionCategory === 'STOP_AFFECTED_ACTIVITY'
          ? 'COMPLIANCE_VIOLATION'
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
      if (worst.mandatoryStop) stillActiveKinds.add('SAFETY_BREACH');
      if (worst.score >= 65) stillActiveKinds.add('DUST');
      if (pm10Value !== null && pm10Value !== undefined && pm10Value >= 300 && pm10Value < 340) {
        stillActiveKinds.add('PM10_APPROACHING_LIMIT');
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
