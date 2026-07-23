import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';

// منطق تقييم الغبار/الامتثال التنظيمي/AEI المشترك — نسخة DCR من
// craneEvaluation.ts الأصلي في مرقاب (dustEvaluation.ts هنا)، مقتصرة على
// الغبار فقط. لا رافعات ولا حرارة في DCR إطلاقاً.
import {
  computeDustResults,
  persistDustEvaluations,
  computeDustComplianceResults,
  computeDustComplianceHourly,
  computeUnitReceptors,
  persistDustComplianceEvaluations,
  applyComplianceGatesToDustAei,
  riyadhLocalToUtcIso,
} from '@/app/lib/dustEvaluation';
import { buildSensitiveReceptor } from '@/app/utils/dust-compliance-engine';
import { requireUserId } from '@/app/lib/apiAuth';
import { buildProjectZoneFromRow, distanceToZoneBoundaryM, polygonCentroid } from '@/app/utils/geo/zone';
import { fetchNearbySensitiveReceptorsFromOsm } from '@/app/utils/geo/overpassReceptors';

const ACTIVITY_TRANSLATIONS: Record<string, string> = {
  'GENERAL_OUTDOOR_WORK': 'أعمال خارجية عامة',
  'INDOOR_WORK': 'أعمال داخلية وخارجية خفيفة',
  'EARTHWORKS': 'أعمال حفر وتربة',
  'CLEANING_WORK': 'أعمال تنظيف وموقع',
  'اعمال تنظيف': 'أعمال تنظيف وموقع',
  'CONCRETE_POURING': 'صب وتجهيز الخرسانة',
  'ROAD_PAVING': 'رصف الطرق والأسفلت',
  'ASPHALT_PAVING': 'سفلتة',
  'HIGH_ALTITUDE_WORK': 'أعمال على ارتفاعات عالية',
  'WORK_AT_HEIGHT': 'أعمال على ارتفاع',
  'COATING': 'أعمال طلاء وعزل',
  'ROAD_WORKS': 'أعمال طرق ومسارات',
  'WELDING': 'أعمال لحام',
  'SCAFFOLDING': 'أعمال سقالات',
  'CRANE_LIFTING': 'عمليات رفع وتحريك أحمال',
  'MATERIAL_TRANSPORT': 'نقل مواد',
  'HEAVY_EQUIPMENT_MOVEMENT': 'حركة معدات ثقيلة',
  'MEP_EXTERNAL_WORK': 'أعمال ميكانيكية/كهربائية',
  'EXTERNAL_PAINTING': 'دهانات وعزل خارجي',
  'GRADING': 'أعمال تسوية وترابية',
  'EXCAVATION': 'أعمال حفر'
};

function translateActivityType(type: string | undefined | null): string {
  if (!type) return 'نشاط عام';
  const trimmed = String(type).trim();
  if (ACTIVITY_TRANSLATIONS[trimmed]) return ACTIVITY_TRANSLATIONS[trimmed];
  const normalized = trimmed.toUpperCase().replace(/[\s-]+/g, '_');
  if (ACTIVITY_TRANSLATIONS[normalized]) return ACTIVITY_TRANSLATIONS[normalized];
  return trimmed;
}

// DCR: مؤشر واحد فقط (dust) — لا heat ولا crane.
const INDICATOR_LABELS: Record<'dust', string> = {
  dust: 'الغبار والرؤية (DVI)',
};

// تحويل حالة القرار المخزنة في decision_records إلى نص عربي مناسب لعرضه كـ decisionLabel
function decisionStatusLabel(status: string | undefined): string {
  switch (status) {
    case 'safe': return 'آمن للتنفيذ';
    case 'caution': return 'التنفيذ بحذر';
    case 'restricted': return 'مقيّد جزئياً';
    case 'postpone': return 'مؤجَّل احترازياً';
    case 'stopped': return 'موقوف إلزامياً';
    default: return 'بانتظار التقييم';
  }
}

function getRiskWeight(value: string | undefined | null): number {
  if (!value) return 0;
  const normalized = String(value).toUpperCase();
  if (['STOP', 'CRITICAL', 'EXTREME', 'HIGH'].includes(normalized)) return 3;
  if (['WARNING', 'MODERATE', 'MEDIUM', 'RESTRICT', 'CAUTION'].includes(normalized)) return 2;
  if (['SAFE', 'LOW', 'NORMAL', 'ALLOW'].includes(normalized)) return 1;
  return 0;
}

// ----------------------------------------------------------------------
// الدوال المساعدة للحسابات
// ----------------------------------------------------------------------

// وزن الخطر من لون العرض الحي للمحرك (displayColor / DviLevel) — يُستخدم
// لترتيب المؤشرات واختيار لون البانر الموحّد في MultiIndicatorActivityBox
function riskWeightFromColor(color: string | undefined | null): number {
  const c = String(color || '').toUpperCase();
  if (['BLACK', 'DARK_RED', 'RED'].includes(c)) return 3;
  if (c === 'ORANGE') return 2;
  if (c === 'YELLOW') return 1;
  return 0; // GREEN أو غير معروف
}

// compliance (نتيجة محرك الامتثال التنظيمي، إن وُجدت) له الأولوية القصوى
// على توصية DVI الفيزيائي هنا — نفس مبدأ Dustwidgetcard.tsx (البانر الأزرق
// الأول الذي يفتح تفاصيل النشاط لا يجوز أن يُظهر "تشغيل عادي" بينما
// الامتثال التنظيمي يمنع الاعتماد فعلياً؛ كانا يتناقضان لأن هذه الدالة
// كانت تقرأ DVI فقط دون أي وعي بقرار الامتثال).
function summaryFromDust(result: any, compliance: any = null): { decisionLabel: string; riskWeight: number; reasonText?: string } {
  const complianceBlocks =
    compliance && (compliance.decisionCategory === 'MANDATORY_STOP' || compliance.decisionCategory === 'STOP_AFFECTED_ACTIVITY');

  if (complianceBlocks) {
    return {
      decisionLabel: 'إيقاف إلزامي نظامي',
      riskWeight: 3,
      reasonText: compliance.shortReasonAr || undefined,
    };
  }

  return {
    decisionLabel: result.mandatoryStop ? 'إيقاف إلزامي نظامي' : result.decisionLabelAr,
    riskWeight: result.mandatoryStop ? 3 : riskWeightFromColor(result.level),
    reasonText: result.shortReason || undefined,
  };
}

// دمج صفوف الغبار في مصفوفة أنشطة موحّدة تطابق شكل RecentActivityItem
// المتوقع في page.tsx (activityGroupId, kinds, summaries...)
//
// الملخص العلوي (البانر) يعكس الآن قرار المحرك الحي مباشرةً عبر خريطة
// dustByGroup، فإن لم تتوفر نتيجة محرك نرجع لآخر قرار موثّق في decision_records.
function buildRecentActivities(
  projectId: string,
  dustRows: any[],
  decisionsMap: Map<string, string>,
  dustByGroup: Map<string, any>
): any[] {
  type Acc = {
    activityGroupId: string;
    activityTitle: string;
    kinds: Array<'dust'>;
    summaries: IndicatorSummaryLike[];
    decisionTargets: any[];
    latestCreatedAt: string;
    windowStartIso?: string;
    windowEndIso?: string;
    durationMinutes?: number;
  };
  type IndicatorSummaryLike = {
    kind: 'dust';
    label: string;
    decisionLabel: string;
    riskWeight: number;
    reasonText?: string;
  };

  const groups = new Map<string, Acc>();

  function upsertGroup(
    kind: 'dust',
    row: any,
    windowStartIso: string | undefined,
    windowEndIso: string | undefined,
    durationMinutes: number | undefined
  ) {
    // إن لم يكن للصف activity_group_id، نعامله كنشاط مستقل بمعرّف خاص به
    // حتى لا تختلط أنشطة غير مرتبطة ببعضها تحت نفس البطاقة
    const groupId: string = row.activity_group_id || `${kind}-${row.id}`;
    const decisionStatus = decisionsMap.get(`${kind}-${row.id}`);

    let acc = groups.get(groupId);
    if (!acc) {
      acc = {
        activityGroupId: groupId,
        activityTitle: translateActivityType(row.activity_type),
        kinds: [],
        summaries: [],
        decisionTargets: [],
        latestCreatedAt: row.created_at,
        windowStartIso,
        windowEndIso,
        durationMinutes,
      };
      groups.set(groupId, acc);
    }

    if (!acc.kinds.includes(kind)) acc.kinds.push(kind);

    // أحدث صف بين المؤشرات المرتبطة يحدد التوقيت المعروض في رأس البطاقة
    if (row.created_at && row.created_at > acc.latestCreatedAt) {
      acc.latestCreatedAt = row.created_at;
    }
    if (!acc.windowStartIso && windowStartIso) acc.windowStartIso = windowStartIso;
    if (!acc.windowEndIso && windowEndIso) acc.windowEndIso = windowEndIso;
    if (!acc.durationMinutes && durationMinutes) acc.durationMinutes = durationMinutes;

    // نتيجة المحرك الحية لهذا المؤشر (إن وُجدت) — مصدر الملخص المفضّل.
    const engineResult = dustByGroup.get(`${groupId}-${row.id}`);

    let summaryFields: { decisionLabel: string; riskWeight: number; reasonText?: string };
    if (engineResult) {
      summaryFields = summaryFromDust(engineResult.windowEval.worst, engineResult.compliance);
    } else {
      // لا نتيجة محرك: نرجع لآخر قرار موثّق، وإلا "بانتظار التقييم"
      summaryFields = {
        decisionLabel: decisionStatusLabel(decisionStatus),
        riskWeight: getRiskWeight(decisionStatus),
        reasonText: decisionStatus ? undefined : 'لم يصدر قرار موثّق لهذا المؤشر بعد',
      };
    }

    acc.summaries.push({
      kind,
      label: INDICATOR_LABELS[kind],
      ...summaryFields,
    });

    // هدف قرار موحّد لهذا المؤشر — يفعّل أزرار الاعتماد/التأجيل في البانر
    if (engineResult) {
      const r = engineResult.windowEval.worst;
      // اللقطة المناخية وقت القرار — تُحفظ ضمن decision_records.weather_snapshot
      // وتُعرض في سجل القرارات.
      const snapshot = [
        { label: 'الرؤية', value: r.visibilityKm != null ? `${r.visibilityKm} كم` : '—' },
        { label: 'الرياح الفعّالة', value: r.effectiveWindKmh != null ? `${r.effectiveWindKmh} كم/س` : '—' },
        { label: 'درجة الخطر', value: `${r.score} / 100` },
      ];
      acc.decisionTargets.push({
        projectId,
        activityId: String(row.id),
        source: kind,
        reason: `توصية مرقاب: ${r.decisionLabelAr} (${r.score} نقطة)`,
        requiredAction: (r.requiredActions || []).join('، ') || 'لا توجد متطلبات إضافية',
        weatherSnapshot: snapshot,
      });
    }
  }

  (dustRows || []).forEach((row) => {
    const start = riyadhLocalToUtcIso(row.planned_date, row.planned_time);
    const durationMinutes = row.duration_hours ? row.duration_hours * 60 : undefined;
    const end = start && durationMinutes
      ? new Date(new Date(start).getTime() + durationMinutes * 60000).toISOString()
      : undefined;
    upsertGroup('dust', row, start, end, durationMinutes);
  });

  const nowMs = Date.now();

  return Array.from(groups.values())
    .sort((a, b) => (a.latestCreatedAt < b.latestCreatedAt ? 1 : -1))
    .map((acc) => {
      // إيقاف إلزامي إن قال أي مؤشر (حي أو موثّق) بذلك — وزن 3 يشمل الأحمر/الأسود
      const mandatoryStop =
        acc.summaries.some((s) => s.decisionLabel === 'موقوف إلزامياً') ||
        acc.summaries.some((s) => s.decisionLabel === 'إيقاف إلزامي نظامي');
      const isFutureActivity = acc.windowStartIso ? new Date(acc.windowStartIso).getTime() > nowMs : false;

      return {
        activityGroupId: acc.activityGroupId,
        activityTitle: acc.activityTitle,
        kinds: acc.kinds,
        summaries: acc.summaries,
        decisionTargets: acc.decisionTargets,
        mandatoryStop,
        isFutureActivity,
        windowStartIso: acc.windowStartIso,
        windowEndIso: acc.windowEndIso,
        durationMinutes: acc.durationMinutes,
      };
    });
}

// ----------------------------------------------------------------------
// الـ GET Handler الرئيسي
// ----------------------------------------------------------------------

export async function GET(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> } // يطابق اسم المجلد الفعلي [projectId]
) {
  try {
    // فك التغليف عن طريق await (مطلوب في Next.js 15)
    const resolvedParams = await params;
    const projectId = resolvedParams.projectId.trim();

    // 1. جلب المشروع الأساسي
    const { data: project } = await supabaseAdmin
      .from('projects')
      .select('*')
      .eq('id', projectId)
      .maybeSingle();

    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    // 2. جلب البيانات المرتبطة
    const [
      { data: dustProfiles },
      { data: recentDust },
      { data: recentDecisions },
      { data: projectShifts },
    ] = await Promise.all([
      supabaseAdmin.from('project_dust_profiles').select('*').eq('project_id', projectId).order('id', { ascending: false }),
      supabaseAdmin.from('project_dust_profiles').select('id, activity_type, created_at, planned_date, planned_time, duration_hours, activity_group_id').eq('project_id', projectId).order('created_at', { ascending: false }).limit(6),
      supabaseAdmin.from('decision_records').select('activity_id, activity_source, status').eq('project_id', projectId).order('created_at', { ascending: false }),
      supabaseAdmin.from('project_shifts').select('*').eq('project_id', projectId).order('sort_order', { ascending: true }),
    ]);

    // تُرفَق على نفس صف project حتى تصل تلقائياً لكل مستهلكي project المُمرَّر
    // (buildDustInput عبر dustEvaluation.ts، صفحة الإعدادات لتعبئة نموذج
    // التعديل، وProjectHeader.tsx لتمريرها إلى AddActivityModal) بلا حاجة
    // لتمرير منفصل في كل مكان.
    project.shifts = projectShifts || [];

    // 3. بناء خريطة القرارات
    const latestDecisionsMap = new Map<string, string>();
    (recentDecisions || []).forEach((d: any) => {
      const key = `${d.activity_source}-${d.activity_id}`;
      if (!latestDecisionsMap.has(key)) {
        latestDecisionsMap.set(key, d.status);
      }
    });

    // 4. حساب النتائج الحية لمحرك الغبار لكل نشاط. المحرك يجلب طقسه بنفسه
    // داخلياً حسب موقعه ووقت النشاط المخطط، ثم يُدمج مع AEI. النتائج تُربط
    // بـ activityGroupId حتى تعرضها page.tsx كأبناء داخل بطاقة النشاط
    // الموحّدة، وتُغذّي أيضًا ملخص البانر العلوي بقرار المحرك الحي قبل أي
    // توثيق يدوي.
    const dustResults = await computeDustResults(dustProfiles || [], project);

    // مستقبِلات حساسة (مدارس/مستشفيات/سكني) — عامة على مستوى النظام، لا
    // تُفلتَر حسب project_id. مصدرها جدول sensitive_receptors المُدار
    // يدوياً، وتبقى المصدر الوحيد المُستخدم فعلياً في قواعد الامتثال
    // التنظيمي (مسافة الكسارة/الأكوام) أدناه — لا يجوز الاعتماد على بيانات
    // OSM غير موثّقة لقرار تنظيمي مُلزم.
    const { data: sensitiveReceptorRows } = await supabaseAdmin
      .from('sensitive_receptors')
      .select('id, name, receptor_type, lat, lng');
    const sensitiveReceptors = (sensitiveReceptorRows || []).map(buildSensitiveReceptor);

    // قائمة "المستقبِلات القريبة" المعروضة في بطاقة الامتثال (عرض توعوي
    // فقط، لا تُغذّي أي قاعدة امتثال) — تُكتشف تلقائياً عبر Overpass API
    // (OpenStreetMap) بدل الاعتماد على جدول sensitive_receptors الذي قد
    // يبقى فارغاً بلا إدخال يدوي. المسافة تُحسب من كل مستقبِل إلى أقرب
    // نقطة على حدود منطقة المشروع الفعلية (مضلع/دائرة مرسومة عبر KML)،
    // وليس إلى مركزها.
    const projectZoneForReceptors = buildProjectZoneFromRow(project);
    const NEARBY_RECEPTOR_RADIUS_M = 1000;
    const projectCenterForOsm =
      projectZoneForReceptors.zoneType === 'polygon' && projectZoneForReceptors.polygon
        ? polygonCentroid(projectZoneForReceptors.polygon)
        : projectZoneForReceptors.circleCenter;
    const discoveredReceptors = projectCenterForOsm
      ? await fetchNearbySensitiveReceptorsFromOsm(
          projectCenterForOsm.lat,
          projectCenterForOsm.lng,
          // هامش بحث أوسع من نصف قطر "القريب" النهائي لأن البحث حول مركز
          // تمثيلي للمشروع (مركز الدائرة/مركز ثقل المضلع) قد يفوته مستقبِل
          // قريب فعلياً من الحدود لكن بعيد نسبياً عن ذلك المركز التمثيلي،
          // خصوصاً لمضلعات ممدودة. التصفية الدقيقة (≤1كم عن الحدود) تحدث
          // أدناه بعد الجلب.
          NEARBY_RECEPTOR_RADIUS_M + (projectZoneForReceptors.circleRadiusM ?? 500)
        )
      : [];
    const nearbySensitiveReceptors = discoveredReceptors
      .map((r) => ({
        id: r.id,
        name: r.name,
        receptorType: r.receptorType,
        distanceM: distanceToZoneBoundaryM({ lat: r.lat, lng: r.lng }, projectZoneForReceptors),
      }))
      .filter((r): r is { id: string; name: string; receptorType: typeof r.receptorType; distanceM: number } =>
        r.distanceM !== null && r.distanceM <= NEARBY_RECEPTOR_RADIUS_M
      )
      .sort((a, b) => a.distanceM - b.distanceM);

    if (dustResults.length > 0) {
      await persistDustEvaluations(supabaseAdmin, projectId, dustResults, 'user_refresh');

      // طبقة الامتثال التنظيمي (Riyadh Dust Compliance) — تستهلك نتيجة DVI
      // الجاهزة أعلاه (windowEval.worst) كمُدخل قراءة فقط، ولا تعيد حسابها.
      // منفصلة تماماً عن dust_evaluations/current_dust_decisions تخزيناً،
      // لكن تُرفَق هنا على نفس عنصر dustResults (حقل compliance) ليصل
      // للواجهة كجزء طبيعي من props البطاقة دون تغيير شكل payload الخارجي.
      const dustComplianceResults = computeDustComplianceResults(dustProfiles || [], project, dustResults, sensitiveReceptors);
      if (dustComplianceResults.length > 0) {
        await persistDustComplianceEvaluations(supabaseAdmin, projectId, dustComplianceResults, 'user_refresh');
      }
      const complianceByActivityId = new Map<string, any>(
        dustComplianceResults.map((r: any) => [r.activityId, r.result])
      );
      dustResults.forEach((r: any) => {
        r.compliance = complianceByActivityId.get(r.activityId) ?? null;
      });

      // المستقبِلات الحساسة ضمن 500م من موقع كل وحدة كسارة/خلاطة تحديداً
      // (لا من حدود المشروع) — تُرفَق على نفس عنصر dustResults ليعرضها
      // ComplianceWidgetCard عند اختيار نشاط كسارة أو محطة خلط.
      //
      // المصدر هنا هو الاتحاد بين جدول sensitive_receptors المُدار يدوياً
      // ومستقبِلات OSM المكتشفة تلقائياً: الجدول اليدوي وحده يبقى فارغاً في
      // معظم المشاريع فتظهر القائمة خالية رغم وجود مدارس/مساكن فعلية حول
      // الكسارة. هذا عرض توعوي بحت — قواعد المسافة المُلزمة أعلاه
      // (computeDustComplianceResults) ما زالت تقرأ sensitiveReceptors
      // اليدوية وحدها، فلا يُبنى أي قرار إيقاف على بيانات OSM غير الموثّقة.
      const receptorsForUnitDisplay = [
        ...sensitiveReceptors,
        ...discoveredReceptors.map((r) => ({
          id: r.id,
          name: r.name,
          receptorType: r.receptorType,
          lat: r.lat,
          lng: r.lng,
        })),
      ];
      const unitReceptorsByActivityId = computeUnitReceptors(
        dustProfiles || [],
        dustResults,
        receptorsForUnitDisplay
      );
      dustResults.forEach((r: any) => {
        r.unitReceptors = unitReceptorsByActivityId.get(r.activityId) ?? [];
      });

      // امتثال ساعي طوال ساعات الدوام — يغذّي شبكة "توقعات الساعات القادمة"
      // في ComplianceWidgetCard، بنفس مبدأ hourlyForecasts الخاصة بـ DVI
      // لكن كل ساعة تمر عبر محرك الامتثال كاملاً بدل DVI فقط.
      const complianceHourlyByActivityId = computeDustComplianceHourly(dustProfiles || [], project, dustResults, sensitiveReceptors);
      dustResults.forEach((r: any) => {
        r.complianceHourly = complianceHourlyByActivityId.get(r.activityId) ?? [];
      });

      // يقص AEI ("قابلية التنفيذ") إلى متوقف عندما يوقف الامتثال التنظيمي
      // النشاط — بلا هذا يتناقض رقم AEI (محسوب من DVI فقط بعتبات مختلفة)
      // مع قرار الامتثال الأشد المعروض بجانبه في نفس البطاقة.
      applyComplianceGatesToDustAei(dustResults);
    }

    // دمج صفوف الغبار المتعددة التي تشترك في activityGroupId إلى بطاقة DVI
    // واحدة لكل مجموعة — ميزة "إضافة نشاط تنظيمي آخر" في الواجهة تُنشئ عدة
    // صفوف project_dust_profiles لنفس النشاط الفيزيائي (نفس الوقت/الموقع)،
    // كل صف يحمل regulatory_activity مختلفاً، فيُعاد حساب DVI/AEI للنافذة
    // نفسها في كل صف رغم تطابقها. نأخذ نتيجة DVI/AEI من أول صف كممثّل
    // للمجموعة (متطابقة فعلياً)، ونجمع كل نتائج الامتثال في مصفوفة واحدة
    // بدل عرض بطاقة DVI مكررة لكل نشاط تنظيمي.
    const dustResultsGrouped: any[] = (() => {
      const byGroup = new Map<string, any[]>();
      dustResults.forEach((r: any) => {
        const list = byGroup.get(r.activityGroupId) || [];
        list.push(r);
        byGroup.set(r.activityGroupId, list);
      });
      return Array.from(byGroup.values()).map((rows) => {
        const representative = rows[0];
        return {
          ...representative,
          complianceList: rows.map((r) => r.compliance).filter(Boolean),
          // وحدات الكسارة/الخلاطة تُجمَّع من كل صفوف المجموعة وليس من الصف
          // الممثّل وحده: المجموعة الواحدة قد تحوي كسارة وخلاطة في صفين
          // مختلفين (ميزة "إضافة نشاط تنظيمي آخر")، فأخذها من rows[0] فقط
          // كان سيُخفي وحدات المستقبِلات الخاصة ببقية الصفوف.
          unitReceptors: rows.flatMap((r) => r.unitReceptors ?? []),
        };
      });
    })();

    // خريطة بحث للملخص العلوي: المفتاح activityGroupId-activityId ليطابق
    // نفس المفتاح المُستخدم داخل upsertGroup في buildRecentActivities.
    const dustByGroup = new Map<string, any>();
    dustResults.forEach((r: any) => dustByGroup.set(`${r.activityGroupId}-${r.activityId}`, r));

    // 5. معالجة الأنشطة الحديثة (Recent Activities) — البانر يعكس الآن قرار
    // المحرك الحي عبر الخريطة أعلاه، ويرجع لـ decision_records عند غيابه.
    const recentActivitiesRaw: any[] = buildRecentActivities(
      projectId,
      recentDust || [],
      latestDecisionsMap,
      dustByGroup
    );

    const payload = {
      project,
      recentActivities: recentActivitiesRaw,
      dustResults: dustResultsGrouped,
      // مستقبِلات حساسة (مدارس/مستشفيات/سكني...) ضمن 1كم من حدود المشروع
      // الفعلية، مرتبة من الأقرب — تُعرض في بطاقة الامتثال بصرف النظر عن
      // أي نشاط تنظيمي محدد (خاصية على مستوى المشروع نفسه).
      nearbySensitiveReceptors,
    };

    return NextResponse.json(payload, { status: 200 });

  } catch (error) {
    console.error('Error fetching project dashboard data:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

// تحديث بيانات المشروع (من صفحة الإعدادات) — يتحقق من الهوية والملكية،
// ويمنع تعديل الحقول الحساسة (id/user_id/created_at). يشمل work_days_list.
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const auth = await requireUserId(request);
  if ('error' in auth) return auth.error;

  const { projectId } = await params;

  // تحقق الملكية قبل أي تعديل
  const { data: owned } = await supabaseAdmin
    .from('projects')
    .select('id')
    .eq('id', projectId)
    .eq('user_id', auth.userId)
    .maybeSingle();
  if (!owned) return NextResponse.json({ error: 'لا تملك هذا المشروع' }, { status: 403 });

  const body = await request.json();
  const updates = { ...body };
  // حقول لا يجوز تعديلها من هذا المسار
  delete updates.id;
  delete updates.user_id;
  delete updates.created_at;

  // ورديات العمل (project_shifts) جدول منفصل — لا تُمرَّر ضمن update على
  // جدول projects (راجع supabase-project-shifts-migration.sql).
  const shifts = Array.isArray(updates.shifts) ? updates.shifts : null;
  delete updates.shifts;

  const { error } = await supabaseAdmin.from('projects').update(updates).eq('id', projectId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // استبدال كامل لصفوف الورديات (حذف ثم إعادة إدراج) — أبسط وأصح من
  // مطابقة/تحديث كل صف على حدة لقائمة صغيرة يعدّلها المستخدم يدوياً بالكامل
  // في كل مرة (نفس نهج monitoring_station_locations الحالي في هذه الصفحات).
  // shifts === null (المفتاح غائب من الطلب) يعني "لم تُرسَل ورديات في هذا
  // التحديث إطلاقاً" فلا نلمس الجدول؛ [] صريحة تعني "احذف كل الورديات".
  if (shifts !== null) {
    const { error: deleteError } = await supabaseAdmin.from('project_shifts').delete().eq('project_id', projectId);
    if (deleteError) {
      console.error('🚨 فشل حذف ورديات العمل القديمة:', deleteError);
      return NextResponse.json({ error: `فشل تحديث ورديات العمل: ${deleteError.message}` }, { status: 500 });
    }
    if (shifts.length > 0) {
      const shiftRows = shifts.map((s: any, i: number) => ({
        project_id: projectId,
        name: s.name,
        start_time: s.start_time,
        end_time: s.end_time,
        sort_order: i,
      }));
      const { error: insertError } = await supabaseAdmin.from('project_shifts').insert(shiftRows);
      if (insertError) {
        console.error('🚨 فشل حفظ ورديات العمل الجديدة:', insertError);
        return NextResponse.json({ error: `فشل حفظ ورديات العمل: ${insertError.message}` }, { status: 500 });
      }
    }
  }
  return NextResponse.json({ success: true });
}

// حذف مشروع بالكامل — يحذف صراحةً من كل جدول فرعي مرتبط بـ project_id
// (بدل الاعتماد على ON DELETE CASCADE في قاعدة البيانات، غير مؤكَّد وجودها
// على كل جدول) قبل حذف صف المشروع نفسه، لتفادي ترك صفوف يتيمة (project_id
// لمشروع محذوف). DCR: لا جداول crane/heat إطلاقاً.
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const auth = await requireUserId(request);
  if ('error' in auth) return auth.error;

  const { projectId } = await params;

  const { data: owned } = await supabaseAdmin
    .from('projects')
    .select('id')
    .eq('id', projectId)
    .eq('user_id', auth.userId)
    .maybeSingle();
  if (!owned) return NextResponse.json({ error: 'لا تملك هذا المشروع' }, { status: 403 });

  // الجداول الفرعية أولاً (ترتيب لا يهم بينها، فكلها تُشير لـ project_id
  // مباشرة)، ثم جدول المشروع نفسه أخيراً.
  const childTables = [
    'alerts',
    'decision_records',
    'dust_evaluations',
    'current_dust_decisions',
    'dust_compliance_evaluations',
    'current_dust_compliance_decisions',
    'project_dust_profiles',
    'project_shifts',
  ];

  for (const table of childTables) {
    // بعض هذه الجداول قد لا تحتوي عمود project_id أصلاً (أو غير موجودة في
    // بعض البيئات) — نتجاهل هذا الخطأ تحديداً (42703/42P01) ونكمل، لكن أي
    // خطأ آخر (قيد صلاحيات، إلخ) يُوقف العملية ويُعاد للمستخدم كما هو.
    const { error: childError } = await supabaseAdmin.from(table).delete().eq('project_id', projectId);
    if (childError && childError.code !== '42703' && childError.code !== '42P01') {
      console.error(`فشل حذف صفوف ${table} للمشروع ${projectId}:`, childError.code, childError.message);
      return NextResponse.json({ error: `فشل حذف بيانات مرتبطة (${table}): ${childError.message}` }, { status: 500 });
    }
  }

  const { error: projectError } = await supabaseAdmin.from('projects').delete().eq('id', projectId);
  if (projectError) {
    console.error(`فشل حذف صف المشروع ${projectId}:`, projectError.code, projectError.message);
    return NextResponse.json({ error: projectError.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
