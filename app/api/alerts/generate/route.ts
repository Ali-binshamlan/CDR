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

// عميل Supabase بصلاحية Service Role: هذا المسار يعمل دون جلسة مستخدم
// (يُستدعى من Cron)، فيحتاج مفتاح الخدمة لتجاوز RLS والقراءة من كل
// المشاريع/الأنشطة.
const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string
);

// نفس دالة بناء مدخلات محرك الغبار المستخدمة في صفحة تفاصيل المشروع
// (منسوخة هنا لضمان تطابق الحساب - يفضّل نقلها لملف مشترك لاحقاً).
function buildDustEngineInputSrv(dbProfile: any, lat: number, lon: number): DustEngineInput {
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
  let q = supabaseAdmin.from('project_dust_profiles').select('*, projects(latitude, longitude)');
  if (projectIds && projectIds.length > 0) q = q.in('project_id', projectIds);
  const { data: profiles } = await q;

  for (const profile of profiles || []) {
    const lat = profile.projects?.latitude ?? 24.7136;
    const lon = profile.projects?.longitude ?? 46.6753;
    const durationMinutes = Number(profile.duration_hours) ? Number(profile.duration_hours) * 60 : (profile.duration_minutes || 60);
    const { startIso, endIso } = computeWindow(profile.planned_date, profile.planned_time, durationMinutes);
    const label = profile.activity_type || 'نشاط غبار';

    await checkBeforeAlerts(profile.project_id, 'dust', profile.id, label, startIso);
    await checkNoDecisionAlert(profile.project_id, 'dust', profile.id, label, startIso, endIso);

    const now = Date.now();
    const isDuring = now >= new Date(startIso).getTime() && now <= new Date(endIso).getTime();
    if (!isDuring) continue;

    try {
      const engineInput = buildDustEngineInputSrv(profile, lat, lon);
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
