// تقييم الغبار والامتثال التنظيمي المشترك — نسخة DCR من craneEvaluation.ts
// الأصلي في مرقاب، مقتصرة على الدوال الخاصة بالغبار (DVI)/الامتثال
// التنظيمي/AEI فقط. لا رافعات ولا حرارة في DCR إطلاقاً.
import { evaluateDustVisibilityWindow, evaluateDustVisibilityWorkDayHourly } from '@/app/utils/dust-engine';
import type { DustEngineInput, DustWindowEvaluation } from '@/app/utils/dust-engine/types';
import { evaluateAei } from '@/app/utils/aei-engine';
import type { AeiEvaluationResult } from '@/app/utils/aei-engine/types';
import { AEI_RESTRICT_CAP } from '@/app/utils/aei-engine/tables';
import { evaluateDustCompliance, buildComplianceContext, isRegulatoryWindGateActive } from '@/app/utils/dust-compliance-engine';
import { receptorsWithinRadiusM, UNIT_RECEPTOR_RADIUS_M } from '@/app/utils/dust-compliance-engine/geo';
import type { ReceptorWithinRadius } from '@/app/utils/dust-compliance-engine/geo';
import type { DustComplianceResult } from '@/app/utils/dust-compliance-engine/types';

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

export function buildDustInput(row: any, project: any): DustEngineInput {
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

// تشغيل محرك الغبار لكل نشاط غبار، مع دمج AEI، وإرجاع شكل يطابق props
// بطاقة DustWidgetCard (windowEval + aei + معرفات الربط).
export async function computeDustResults(dustRows: any[], project: any) {
  const results = await Promise.all(
    (dustRows || []).map(async (row) => {
      try {
        const input = buildDustInput(row, project);
        const startIso = riyadhLocalToUtcIso(row.planned_date, row.planned_time);
        const durationHours = Math.max(1, Math.round(row.duration_hours || 1));
        if (!startIso) return null;

        const windowEval: DustWindowEvaluation = await evaluateDustVisibilityWindow(
          input,
          startIso,
          durationHours
        );
        const aei: AeiEvaluationResult = evaluateAei(windowEval.worst, input.activityType as any);

        // توقعات ساعية عبر كامل ساعات دوام المشروع لليوم الحالي؛ فشلها لا
        // يُسقط تقييم النشاط بأكمله.
        const workDayHourly = await evaluateDustVisibilityWorkDayHourly(input).catch(() => []);

        // وسم كل ساعة (نافذة النشاط + كامل يوم الدوام) ببوابة الرياح
        // التنظيمية حتى تتماشى شبكة "توقعات الطقس طوال فترة الدوام" مع
        // قرار الامتثال، بدل الاعتماد فقط على عتبات DVI الفيزيائي المختلفة.
        const isDustGenerating = row.is_dust_generating ?? true;
        const isEnclosedOperation = row.is_enclosed_operation ?? false;
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

        await supabaseAdmin.from('current_dust_decisions').upsert({
          activity_group_id: r.activityGroupId,
          project_id: projectId,
          latest_evaluation_id: evaluationId,
          decision: newDecision,
          triggered_rules: worst.triggeredRules ?? [],
          short_reason: worst.shortReason ?? null,
          updated_at: new Date().toISOString(),
        });
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
export function computeDustComplianceResults(
  dustRows: any[],
  project: any,
  dustResults: any[],
  sensitiveReceptors: any[] = []
): DustComplianceResult[] {
  const rowsById = new Map<string, any>((dustRows || []).map((row) => [String(row.id), row]));

  return (dustResults || [])
    .map((r) => {
      try {
        const row = rowsById.get(r.activityId);
        const dviResult = r.windowEval?.worst;
        if (!row || !dviResult) return null;

        const ctx = buildComplianceContext(project, row, dviResult, sensitiveReceptors);
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
    .filter(Boolean) as any[];
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
        const hourAei = applyComplianceGateToAei(
          evaluateAei(hour, r.activityType),
          result
        );
        return { time: hour.time, result, aei: hourAei };
      });
      byActivityId.set(r.activityId, hourlyCompliance);
    } catch (error) {
      console.error(`فشل تقييم الامتثال الساعي للنشاط ${r.activityId}:`, error);
    }
  });

  return byActivityId;
}

const AEI_COMPLIANCE_CLOSED_DECISIONS = new Set(['MANDATORY_STOP', 'STOP_AFFECTED_ACTIVITY']);
// أي قرار امتثال غير ALLOW يمثّل قيداً تنظيمياً حقيقياً على النشاط، حتى لو
// لم يصل لحد الإيقاف الكامل — يجب أن يظهر هذا في AEI أيضاً (سقف مقيَّد)
// بدل تجاهله بالكامل، وإلا يظهر AEI "قابل للتنفيذ" بينما الامتثال يقول
// "مقيَّد" في نفس الشاشة.
const AEI_COMPLIANCE_RESTRICTED_DECISIONS = new Set(['RESTRICT_ACTIVITY', 'FIELD_VERIFICATION_REQUIRED', 'ALLOW_WITH_CONTROLS']);

// يقص AEI إلى "متوقف" (CLOSED/0) أو "مقيَّد" (RESTRICT، سقف AEI_RESTRICT_CAP)
// حسب شدة قرار الامتثال التنظيمي، حتى لو كانت بوابة DVI الفيزيائية أخف
// (عتبات مختلفة تماماً — مثال: DVI يوقف عند ≥30 كم/س + مواد سائبة، بينما
// الامتثال يوقف عند >25 كم/س لأي نشاط مكشوف؛ أو DVI "ممتاز" بينما الامتثال
// "مقيَّد" بسبب غياب حاجز غبار حول موقع هدم — لا علاقة لأحدهما بالآخر).
// بلا هذا القص يظهر AEI متناقضاً مع قرار الامتثال المعروض بجانبه في نفس
// البطاقة. بنفس نمط بوابة closedByGate/cappedByGate الموجودتين أصلاً في
// evaluateAei، فقط سببهما هنا امتثال تنظيمي بدل DVI مباشرة.
function applyComplianceGateToAei(aei: AeiEvaluationResult, compliance: DustComplianceResult | null): AeiEvaluationResult {
  if (!compliance || compliance.decisionCategory === 'ALLOW') return aei;
  if (aei.closedByGate) return aei; // بوابة DVI أوقفته أصلاً، لا داعي للتكرار

  if (AEI_COMPLIANCE_CLOSED_DECISIONS.has(compliance.decisionCategory)) {
    return {
      ...aei,
      status: 'CLOSED',
      statusLabelAr: 'بيئة العمل غير آمنة (مغلق) — إيقاف تنظيمي',
      color: 'BLACK',
      score: 0,
      closedByGate: true,
      gateReasonAr: `⛔ إيقاف إلزامي بموجب الامتثال التنظيمي: ${compliance.shortReasonAr}`,
      shortReasonAr: compliance.shortReasonAr,
      recommendationAr: 'يُمنع اعتماد تنفيذ هذا النشاط حتى استيفاء شروط الامتثال التنظيمي أو تحسّن الظروف الموجبة للإيقاف.',
    };
  }

  if (AEI_COMPLIANCE_RESTRICTED_DECISIONS.has(compliance.decisionCategory) && aei.score > AEI_RESTRICT_CAP) {
    return {
      ...aei,
      status: 'RESTRICT',
      statusLabelAr: 'تقييد تشغيلي وضوابط إضافية — امتثال تنظيمي',
      color: 'RED',
      score: AEI_RESTRICT_CAP,
      cappedByGate: true,
      gateReasonAr: `⚠️ تنبيه: تم تقييد النشاط بسبب الامتثال التنظيمي (${compliance.decisionLabelAr}): ${compliance.shortReasonAr}`,
      // يجب استبدال shortReasonAr هنا تماماً كما في فرع الإغلاق أعلاه:
      // النص الأصلي قادم من التقييم الفيزيائي وقد يقول "الأجواء ممتازة
      // والظروف آمنة" بينما البطاقة تعرض "تقييد تشغيلي" — فيظهر تناقض
      // صريح للمستخدم بين العنوان والسبب المكتوب تحته مباشرة. سبب التقييد
      // الفعلي تنظيمي، فيجب أن يكون هو النص المعروض.
      shortReasonAr: compliance.shortReasonAr,
      recommendationAr: 'استوفِ شروط الامتثال التنظيمي المذكورة أدناه قبل اعتماد تنفيذ هذا النشاط دون قيود.',
    };
  }

  return aei;
}

// يُطبَّق بعد ربط compliance بكل عنصر dustResults في route.ts — يعدّل aei
// في مكانه (mutate) لتفادي إعادة بناء مصفوفة dustResults بالكامل هناك.
export function applyComplianceGatesToDustAei(dustResults: any[]): void {
  (dustResults || []).forEach((r: any) => {
    if (r?.aei) {
      r.aei = applyComplianceGateToAei(r.aei, r.compliance ?? null);
    }
  });
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

        const { data: existing } = await supabaseAdmin
          .from('current_dust_compliance_decisions')
          .select('decision, updated_at')
          .eq('activity_group_id', r.activityGroupId)
          .maybeSingle();

        if (shouldSkipPersist(existing?.decision, existing?.updated_at, newDecision)) return;

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

        await supabaseAdmin.from('current_dust_compliance_decisions').upsert({
          activity_group_id: r.activityGroupId,
          project_id: projectId,
          latest_evaluation_id: evaluationId,
          decision: newDecision,
          triggered_rules: r.result?.triggeredRules ?? [],
          short_reason: r.result?.shortReasonAr ?? null,
          updated_at: new Date().toISOString(),
        });
      } catch (error) {
        console.error(`فشل حفظ تقييم امتثال الغبار للنشاط ${r.activityId}:`, error);
      }
    })
  );
}
