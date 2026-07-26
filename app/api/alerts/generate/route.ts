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
import { evaluateDustVisibilityWindow } from '@/app/utils/dust-engine';
import type { DustEngineInput } from '@/app/utils/dust-engine/types';
import { translateActivityType } from '@/app/lib/activityLabels';
import { REGULATORY_ACTIVITY_LABEL_AR } from '@/app/utils/dust-compliance-engine/rulebook';
import { evaluateDustCompliance, buildComplianceContext, buildSensitiveReceptor } from '@/app/utils/dust-compliance-engine';
import { resolveFreshProjectDevice, type FreshDeviceReading } from '@/app/lib/dustEvaluation';

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
    // نفس أولوية جهاز > يدوي > طقس المطبّقة في computeDustResults (صفحة
    // المشروع) — بدونها كانت تنبيهات Cron (SAFETY_BREACH/DUST) تُقيَّم على
    // بيانات مختلفة صامتاً عمّا تعرضه صفحة المشروع لنفس النشاط.
    deviceWindSpeedKmh: freshDevice?.last_wind_speed_kmh ?? null,
    deviceWindGustKmh: freshDevice?.last_wind_gust_kmh ?? null,
    deviceWindDirectionDeg: freshDevice?.last_wind_direction_deg ?? null,
    devicePm10: freshDevice?.last_pm10 ?? null,
    devicePm25: freshDevice?.last_pm25 ?? null,
    deviceVisibilityM: freshDevice?.last_visibility_m ?? null,
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

async function insertAlert(params: {
  projectId: string;
  activitySource: 'dust';
  activityId: string;
  timing: 'BEFORE' | 'DURING';
  kind: string;
  message: string;
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
    const isDuring = now >= new Date(startIso).getTime() && now <= new Date(endIso).getTime();
    if (!isDuring) continue;

    try {
      const freshDevice = await resolveFreshProjectDevice(supabaseAdmin, profile.project_id).catch(() => null);
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
      let previousDecision: { decision: string; updated_at: string } | null = null;
      if (profile.activity_group_id) {
        const { data: prevRow } = await supabaseAdmin
          .from('current_dust_compliance_decisions')
          .select('decision, updated_at')
          .eq('activity_group_id', profile.activity_group_id)
          .maybeSingle();
        previousDecision = prevRow ? { decision: prevRow.decision, updated_at: prevRow.updated_at } : null;
      }
      const complianceCtx = buildComplianceContext(profile.projects, profile, worst, sensitiveReceptors, previousDecision);
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
  const authHeader = request.headers.get('authorization');
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  try {
    await checkDustActivities();
    return NextResponse.json({ ok: true, checkedAt: new Date().toISOString() });
  } catch (error: any) {
    console.error('alert generation failed:', error?.message || error);
    return NextResponse.json({ ok: false, error: error?.message || 'unknown error' }, { status: 500 });
  }
}

// -------------------------------------------------------------
// لتشغيل هذا المسار دورياً على Vercel، أضف لملف vercel.json بجذر
// المشروع (كل 15 دقيقة كمثال — عدّل حسب الحاجة):
//
// {
//   "crons": [
//     { "path": "/api/alerts/generate", "schedule": "*/15 * * * *" }
//   ]
// }
// -------------------------------------------------------------
