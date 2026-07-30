import { NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';

// منطق تقييم الغبار/الامتثال التنظيمي/AEI المشترك — نسخة DCR من
// craneEvaluation.ts الأصلي في مرقاب (dustEvaluation.ts هنا)، مقتصرة على
// الغبار فقط. لا رافعات ولا حرارة في DCR إطلاقاً.
import {
  computeDustResults,
  computeDustComplianceResults,
  computeDustComplianceHourly,
  computeUnitReceptors,
  applyComplianceGatesToDustAei,
  fetchLatestFinalDecisions,
  riyadhLocalToUtcIso,
} from '@/app/lib/dustEvaluation';
import { buildSensitiveReceptor, DECISION_PRIORITY } from '@/app/utils/dust-compliance-engine';
import { requireUserId, verifyProjectOwnership } from '@/app/lib/apiAuth';
import { safeErrorResponse } from '@/app/lib/apiError';
import { buildProjectZoneFromRow, distanceToZoneBoundaryM, zoneToBoundaryDistanceM, zoneSearchAnchorPoints } from '@/app/utils/geo/zone';
import { fetchNearbySensitiveReceptorsFromOsm } from '@/app/utils/geo/overpassReceptors';
import { displayActivityLabel as activityTitleFromRow } from '@/app/lib/activityLabels';

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
// لترتيب المؤشرات واختيار لون البانر الموحّد في MultiIndicatorActivityBox.
// BLACK (إيقاف إلزامي مؤكَّد، غير قابل للتجاوز) يأخذ وزناً أعلى من RED
// (معلَّق/موقوف مؤقتاً بانتظار تأكيد، مثال MRQ-PM10-BLACK-PENDING-104) —
// كانا يتساويان سابقاً (كلاهما 3)، فيظهر القرار المؤكَّد بنفس لون القرار
// المؤقت المعلَّق في البانر الموحّد، رغم اختلاف شدتهما الفعلية جوهرياً.
function riskWeightFromColor(color: string | undefined | null): number {
  const c = String(color || '').toUpperCase();
  if (c === 'BLACK') return 4;
  if (['DARK_RED', 'RED'].includes(c)) return 3;
  if (c === 'ORANGE') return 2;
  if (c === 'YELLOW') return 1;
  return 0; // GREEN أو غير معروف
}

// خطأ معماري مكتشَف ومُصلَح (مراجعة كود مدير — "FinalDecisionEngine ليس
// المصدر التشغيلي الوحيد فعلياً"): كانت هذه الدالة تستدعي
// computeUnifiedActivityDecision (تعيد حساب decideFinal محلياً) — مصدر
// حساب مستقل عن باقي المسارات (dashboard/global، viewer/dashboard،
// alerts/generate) التي حُوِّلت جميعها لقراءة final_decinsions المخزَّنة
// بدل إعادة الحساب. الآن تقرأ نفس الصف المخزَّن (كتبه evaluate/route.ts)
// بدل استدعاء decideFinal بنفسها — نفس القرار بالضبط في كل الواجهات، لا
// نسخة خامسة محتملة التناقض.
function summaryFromStoredDecision(storedDecision: any): { decisionLabel: string; riskWeight: number; reasonText?: string } {
  return {
    decisionLabel: storedDecision.decision_label_ar,
    riskWeight: riskWeightFromColor(storedDecision.level),
    reasonText: storedDecision.short_reason_ar || undefined,
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
  dustByGroup: Map<string, any>,
  finalDecisionsByGroup: Map<string, any>
): any[] {
  type Acc = {
    activityGroupId: string;
    activityTitle: string;
    // كل التسميات التنظيمية المميّزة ضمن هذه المجموعة — النظام يدعم نشاطاً
    // تنظيمياً واحداً فقط بالجلسة، فهذه المصفوفة تحمل عنصراً واحداً عملياً
    // (تعدد الصفوف المتبقي مصدره وحدات النشاط نفسه: عدة محطات خلط/كسارات/
    // أسطح)، لكنها تبقى مصفوفة لعرض عام آمن. يحافظ على ترتيب أول ظهور.
    regulatoryTitles: string[];
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
        activityTitle: activityTitleFromRow(row),
        regulatoryTitles: [],
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

    // اجمع التسمية التنظيمية لهذا الصف (كسارة/هدم/...) دون تكرار — تُدمج
    // لاحقاً في عنوان البطاقة.
    const rowTitle = activityTitleFromRow(row);
    if (rowTitle && !acc.regulatoryTitles.includes(rowTitle)) {
      acc.regulatoryTitles.push(rowTitle);
    }

    // أحدث صف بين المؤشرات المرتبطة يحدد التوقيت المعروض في رأس البطاقة
    if (row.created_at && row.created_at > acc.latestCreatedAt) {
      acc.latestCreatedAt = row.created_at;
    }
    if (!acc.windowStartIso && windowStartIso) acc.windowStartIso = windowStartIso;
    if (!acc.windowEndIso && windowEndIso) acc.windowEndIso = windowEndIso;
    if (!acc.durationMinutes && durationMinutes) acc.durationMinutes = durationMinutes;

    // نتيجة المحرك الحية لهذا المؤشر (إن وُجدت) — لا تزال مطلوبة أدناه
    // لبناء decisionTargets (اللقطة المناخية الخام)، بمعزل تماماً عن
    // القرار النهائي المعروض في summaryFields (يأتي الآن من finalDecisionsByGroup).
    const engineResult = dustByGroup.get(`${groupId}-${row.id}`);

    // القرار النهائي المخزَّن فعلياً (كتبه evaluate/route.ts عبر
    // persistFinalDecisions) — مصدر الملخص المفضّل، لا إعادة حساب محلية.
    const storedDecision = finalDecisionsByGroup.get(groupId);

    let summaryFields: { decisionLabel: string; riskWeight: number; reasonText?: string };
    if (storedDecision) {
      summaryFields = summaryFromStoredDecision(storedDecision);
    } else {
      // لا قرار مخزَّن بعد (أول تقييم لم يُستدعَ evaluate عليه بعد): نرجع
      // لآخر قرار موثّق في decision_records، وإلا "بانتظار التقييم"
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
    .slice(0, 6) // أحدث 6 مجموعات نشاط (لا 6 صفوف) — يحافظ على نية limit السابقة
    .map((acc) => {
      // إيقاف إلزامي مؤكَّد إن قال أي مؤشر بذلك — riskWeight=4 (الأسود) حصراً،
      // لا 3 (الأحمر، يشمل حالات معلَّقة/مؤقتة مثل MRQ-PM10-BLACK-PENDING-104
      // لا يجوز معاملتها كإيقاف إلزامي نهائي). موثوق أكثر من مطابقة نص
      // "موقوف إلزامياً"/"إيقاف إلزامي نظامي" حرفياً (decisionStatusLabel
      // القديم لا يزال يستخدم "موقوف إلزامياً" لمسار decision_records
      // الموثّق بلا محرك حي — يبقى مطابقاً هنا لتغطية ذلك المسار أيضاً).
      const mandatoryStop =
        acc.summaries.some((s) => s.riskWeight === 4) ||
        acc.summaries.some((s) => s.decisionLabel === 'موقوف إلزامياً');
      const isFutureActivity = acc.windowStartIso ? new Date(acc.windowStartIso).getTime() > nowMs : false;

      // العنوان النهائي = كل الأنشطة التنظيمية المميّزة مدموجة (مثال:
      // "الكسارة + الهدم")، وإلا العنوان الأول المحسوب عند إنشاء المجموعة.
      const activityTitle = acc.regulatoryTitles.length > 0
        ? acc.regulatoryTitles.join(' + ')
        : acc.activityTitle;

      return {
        activityGroupId: acc.activityGroupId,
        activityTitle,
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
    // تحقق الهوية والملكية — كان هذا المسار يقرأ (ويكتب تقييمات جديدة
    // كأثر جانبي) بيانات أي مشروع بلا أي تحقق إطلاقاً، رغم أن PATCH/DELETE
    // في نفس الملف يطبّقانه بشكل صحيح — ثغرة IDOR غير مصادَق عليها فعلياً
    // (كلا استدعائي الواجهة الأمامية لهذا المسار يستخدمان fetch() خام بلا
    // ترويسة Authorization، مؤكَّد عبر مراجعة أمنية). نفس نمط PATCH/DELETE
    // بالضبط، بما فيه قبول السوبر أدمن (verifyProjectOwnership).
    const auth = await requireUserId(request);
    if ('error' in auth) return auth.error;

    // فك التغليف عن طريق await (مطلوب في Next.js 15)
    const resolvedParams = await params;
    const projectId = resolvedParams.projectId.trim();

    const owns = await verifyProjectOwnership(projectId, auth.userId);
    if (!owns) return NextResponse.json({ error: 'لا تملك هذا المشروع' }, { status: 403 });

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
      { data: recentDecisions },
      { data: projectShifts },
      { data: projectDevices },
    ] = await Promise.all([
      supabaseAdmin.from('project_dust_profiles').select('*').eq('project_id', projectId).order('id', { ascending: false }),
      supabaseAdmin.from('decision_records').select('activity_id, activity_source, status').eq('project_id', projectId).order('created_at', { ascending: false }),
      supabaseAdmin.from('project_shifts').select('*').eq('project_id', projectId).order('sort_order', { ascending: true }),
      supabaseAdmin.from('project_devices').select('is_active').eq('project_id', projectId),
    ]);

    // تُرفَق على نفس صف project حتى تصل تلقائياً لكل مستهلكي project المُمرَّر
    // (buildDustInput عبر dustEvaluation.ts، صفحة الإعدادات لتعبئة نموذج
    // التعديل، وProjectHeader.tsx لتمريرها إلى AddActivityModal) بلا حاجة
    // لتمرير منفصل في كل مكان.
    project.shifts = projectShifts || [];

    // عدد أجهزة الرصد الحية *النشطة* (project_devices) — يحل محل عمود
    // monitoring_station_count القديم (المشتق من مصفوفة jsonb وصفية بلا أي
    // التزام حقيقي) بمصدر حقيقي: جهاز مُلغى لا يقدر يرسل قراءات
    // (requireDeviceApiKey يرفضه)، فلا يُحتسب ضمن الحد التنظيمي. يُبنى هنا
    // بنفس نمط project.shifts أعلاه، ويصل تلقائياً لكل مستهلكي project —
    // buildProjectComplianceProfile (adapters.ts) يقرأ نفس الاسم دون أي
    // تعديل على توقيعه.
    project.monitoring_station_count = (projectDevices || []).filter((d: any) => d.is_active).length;

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
    const dustResults = await computeDustResults(dustProfiles || [], project, supabaseAdmin);

    // مستقبِلات حساسة (مدارس/مستشفيات/سكني) — عامة على مستوى النظام، لا
    // تُفلتَر حسب project_id. مصدرها جدول sensitive_receptors المُدار
    // يدوياً، وتبقى المصدر الوحيد المُستخدم فعلياً في قواعد الامتثال
    // التنظيمي (مسافة الكسارة/الأكوام) أدناه — لا يجوز الاعتماد على بيانات
    // OSM غير موثّقة لقرار تنظيمي مُلزم.
    //
    // خطأ أمني مكتشَف ومُصلَح (مراجعة كود مدير — "فشل استعلام المستقبلات
    // الحساسة يتحول إلى مصفوفة فارغة ثم Infinity؛ قد يظهر الموقع آمناً عند
    // تعطل البيانات"): كان لا يوجد أي فحص لـerror هنا — فشل الاستعلام
    // (انقطاع اتصال، مشكلة صلاحيات) كان يُعامَل بصمت كـ"لا توجد مستقبِلات
    // حساسة مسجَّلة إطلاقاً" (نفس الحالة الشرعية لموقع نظيف فعلاً)، ومحرك
    // الامتثال يترجم القائمة الفارغة إلى مسافة Infinity (آمنة تماماً) —
    // فتعطّل الشبكة/القاعدة يظهر فعلياً كـ"لا مستقبِلات قريبة" بدل خطأ واضح،
    // على عكس فلسفة fail-safe المتبعة بكل مكان آخر في هذا الملف. الآن فشل
    // الاستعلام يوقف الطلب بخطأ 500 صريح بدل الاستمرار بأمان زائف.
    const { data: sensitiveReceptorRows, error: sensitiveReceptorsError } = await supabaseAdmin
      .from('sensitive_receptors')
      .select('id, name, receptor_type, lat, lng');
    if (sensitiveReceptorsError) {
      return NextResponse.json(
        { error: safeErrorResponse(sensitiveReceptorsError, 'sensitive_receptors fetch failed') },
        { status: 500 }
      );
    }
    const sensitiveReceptors = (sensitiveReceptorRows || []).map(buildSensitiveReceptor);

    // قائمة "المستقبِلات القريبة" المعروضة في بطاقة الامتثال (عرض توعوي
    // فقط، لا تُغذّي أي قاعدة امتثال) — تُكتشف تلقائياً عبر Overpass API
    // (OpenStreetMap) بدل الاعتماد على جدول sensitive_receptors الذي قد
    // يبقى فارغاً بلا إدخال يدوي. المسافة تُحسب من كل مستقبِل إلى أقرب
    // نقطة على حدود منطقة المشروع الفعلية (مضلع/دائرة مرسومة عبر KML)،
    // وليس إلى مركزها.
    const projectZoneForReceptors = buildProjectZoneFromRow(project);
    const NEARBY_RECEPTOR_RADIUS_M = 1000;
    // البحث نفسه ينطلق من عدة نقاط على حدود المشروع الفعلية (رؤوس المضلع،
    // أو نقاط موزَّعة على محيط الدائرة) بدل استعلام واحد من مركز تمثيلي
    // بنصف قطر موسَّع — نفس مبدأ حساب موقع الكسارة/الهدم من موقعها الفعلي،
    // لا من مركز المشروع. مضلع ممدود مثلاً قد تكون إحدى حوافه قريبة جداً من
    // مستقبِل لا يظهر أبداً في بحث دائري من المركز وحده مهما اتسع نصف القطر.
    const searchAnchors = zoneSearchAnchorPoints(projectZoneForReceptors);
    const discoveredReceptorsByAnchor = await Promise.all(
      searchAnchors.map((anchor) =>
        fetchNearbySensitiveReceptorsFromOsm(anchor.lat, anchor.lng, NEARBY_RECEPTOR_RADIUS_M)
      )
    );
    const discoveredReceptorsById = new Map<string, (typeof discoveredReceptorsByAnchor)[number][number]>();
    discoveredReceptorsByAnchor.flat().forEach((r) => discoveredReceptorsById.set(r.id, r));
    const discoveredReceptors = Array.from(discoveredReceptorsById.values());
    const nearbySensitiveReceptors = discoveredReceptors
      .map((r) => ({
        id: r.id,
        name: r.name,
        receptorType: r.receptorType,
        // عناصر way الكبيرة (خصوصاً landuse=residential، قد تمتد أحياء
        // كاملة) تحمل boundary (كل نقاط معالمها من "out geom;") — نستخدم
        // أقرب مسافة فعلية لأي نقطة منها بدل مسافة مركزها الوحيد، وإلا
        // ظهرت المسافة أبعد من الواقع لعنصر حافته الفعلية قريبة جداً رغم
        // بعد مركزه (راجع zoneToBoundaryDistanceM). عناصر node (بلا
        // boundary) ترجع لمسافة النقطة المفردة كما كانت دائماً.
        distanceM: r.boundary
          ? (zoneToBoundaryDistanceM(projectZoneForReceptors, r.boundary) ?? distanceToZoneBoundaryM({ lat: r.lat, lng: r.lng }, projectZoneForReceptors))
          : distanceToZoneBoundaryM({ lat: r.lat, lng: r.lng }, projectZoneForReceptors),
      }))
      .filter((r): r is { id: string; name: string; receptorType: typeof r.receptorType; distanceM: number } =>
        r.distanceM !== null && r.distanceM <= NEARBY_RECEPTOR_RADIUS_M
      )
      .sort((a, b) => a.distanceM - b.distanceM);

    // مُعلَنة هنا (بدل داخل الشرط أدناه) حتى يمكن قراءتها لاحقاً في هذا
    // الملف (نقطة finalDecisionsByGroup الموحَّدة للبانر) بلا مشكلة نطاق —
    // تبقى undefined إن كان dustResults فارغاً (الفرع أدناه لا يُنفَّذ).
    let finalDecisionsByGroupForAei: Map<string, any> | undefined;

    if (dustResults.length > 0) {
      // طبقة الامتثال التنظيمي (Riyadh Dust Compliance) — تستهلك نتيجة DVI
      // الجاهزة أعلاه (windowEval.worst) كمُدخل قراءة فقط، ولا تعيد حسابها.
      // منفصلة تماماً عن dust_evaluations/current_dust_decisions تخزيناً،
      // لكن تُرفَق هنا على نفس عنصر dustResults (حقل compliance) ليصل
      // للواجهة كجزء طبيعي من props البطاقة دون تغيير شكل payload الخارجي.
      //
      // ملاحظة أمنية: GET لا يكتب لقاعدة البيانات إطلاقاً (كان يستدعي
      // persistDustEvaluations/persistDustComplianceEvaluations هنا سابقاً
      // كأثر جانبي على كل تحميل صفحة — مخالف لدلالة HTTP GET idempotent).
      // الكتابة الفعلية انتقلت لمسار POST /api/projects/[projectId]/evaluate
      // الذي تستدعيه الواجهة صراحة بعد نجاح هذا الـGET (راجع fetchDashboardData
      // في app/dashboard/Projects/[id]/page.tsx). الحساب هنا يبقى كما هو
      // تماماً — الواجهة تحتاج compliance/unitReceptors/complianceHourly
      // فوراً ضمن نفس استجابة GET، فقط الكتابة انتقلت.
      const dustComplianceResults = await computeDustComplianceResults(dustProfiles || [], project, dustResults, sensitiveReceptors, supabaseAdmin);
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
      //
      // خطأ معماري مكتشَف ومُصلَح (مراجعة كود خبير خارجي — "القرار النهائي
      // لا يُحفظ كقرار رسمي واحد... البطاقة والخريطة والتنبيهات تعيد حساب
      // القرار بمعرّفات مختلفة"): كانت applyComplianceGatesToDustAei تستدعي
      // decideFinal محلياً دائماً هنا — نُقل جلب القرار المخزَّن (fetchLatestFinalDecisions،
      // كان يحدث لاحقاً في هذا الملف لأغراض البانر فقط) ليسبق هذا الاستدعاء
      // ويُمرَّر إليه، فتقرأ بطاقة AEI الآن نفس القرار المخزَّن المعروض في
      // البانر أعلاها بالضبط، لا نسخة مُعاد حسابها بمعزل بنفس اللحظة تقريباً.
      const activityGroupIdsForFinalDecisions = Array.from(
        new Set((dustProfiles || []).map((row: any) => row.activity_group_id || `dust-${row.id}`))
      );
      finalDecisionsByGroupForAei = await fetchLatestFinalDecisions(supabaseAdmin, activityGroupIdsForFinalDecisions);
      applyComplianceGatesToDustAei(dustResults, finalDecisionsByGroupForAei);
    }

    // دمج صفوف الغبار المتعددة التي تشترك في activityGroupId إلى بطاقة DVI
    // واحدة لكل مجموعة — نظام إضافة نشاط واحد فقط بالجلسة، لكن نشاط واحد قد
    // يضم عدة وحدات فعلية (عدة محطات خلط/كسارات) تُنشئ عدة صفوف
    // project_dust_profiles لنفس النشاط الفيزيائي (نفس الوقت/الموقع)، فيُعاد
    // حساب DVI/AEI للنافذة نفسها في كل صف رغم تطابقها.
    //
    // خطأ مكتشَف ومُصلَح (مراجعة مستخدم — "تناقض في القرارات": مبدأ "الأشد
    // يحكم" (Final Decision Engine) يجب أن يُطبَّق على *كل* وحدات النشاط
    // معاً، لا وحدة واحدة فقط): كان يُؤخذ rows[0] دائماً كممثّل للمجموعة —
    // بما فيه aei/windowEval (المعروضان في عنوان/لون بطاقة ComplianceWidgetCard
    // الرئيسي) — بصرف النظر عن قرار بقية الوحدات في نفس المجموعة. فلو وحدة
    // ثانية (مثال: محطة خلط ثانية) قرارها أشد (MANDATORY_STOP) بينما الأولى
    // ALLOW، كان العنوان الرئيسي يعرض "مسموح" (من rows[0] فقط) بينما قسم
    // "أساس القرار" أسفل البطاقة (complianceList، كل الوحدات) يعرض تلك الوحدة
    // الثانية بـ"إيقاف إلزامي" — تناقض ظاهري مباشر بين نفس البطاقة.
    //
    // الإصلاح: الممثّل (representative) الذي يُبنى منه aei/windowEval
    // المعروضان يُختار الآن كأسوأ وحدة فعلياً (أعلى DECISION_PRIORITY) بدل
    // rows[0] الثابت دائماً — نفس ترتيب الأولوية المستخدم أصلاً في
    // pickWorstCompliance (Compliancewidgetcard.tsx)، فيتطابق العنوان الرئيسي
    // مع أسوأ تفصيل معروض أسفله دائماً، تطبيقاً حرفياً لمبدأ "الأشد يحكم"
    // على مستوى المجموعة كاملة لا وحدة واحدة.
    const dustResultsGrouped: any[] = (() => {
      const byGroup = new Map<string, any[]>();
      dustResults.forEach((r: any) => {
        const list = byGroup.get(r.activityGroupId) || [];
        list.push(r);
        byGroup.set(r.activityGroupId, list);
      });
      return Array.from(byGroup.values()).map((rows) => {
        const representative = rows.reduce((worst: any, current: any) => {
          const worstPriority = DECISION_PRIORITY[worst.compliance?.decisionCategory as keyof typeof DECISION_PRIORITY] ?? -1;
          const currentPriority = DECISION_PRIORITY[current.compliance?.decisionCategory as keyof typeof DECISION_PRIORITY] ?? -1;
          return currentPriority > worstPriority ? current : worst;
        }, rows[0]);
        return {
          ...representative,
          complianceList: rows.map((r) => r.compliance).filter(Boolean),
          // وحدات الكسارة/الخلاطة تُجمَّع من كل صفوف المجموعة وليس من الصف
          // الممثّل وحده: المجموعة الواحدة قد تحوي عدة وحدات (محطتا خلط
          // مثلاً) في صفين مختلفين لنفس النشاط التنظيمي، فأخذها من ممثّل
          // واحد فقط كان سيُخفي وحدات المستقبِلات الخاصة ببقية الصفوف.
          unitReceptors: rows.flatMap((r) => r.unitReceptors ?? []),
        };
      });
    })();

    // خريطة بحث للملخص العلوي: المفتاح activityGroupId-activityId ليطابق
    // نفس المفتاح المُستخدم داخل upsertGroup في buildRecentActivities.
    const dustByGroup = new Map<string, any>();
    dustResults.forEach((r: any) => dustByGroup.set(`${r.activityGroupId}-${r.activityId}`, r));

    // آخر قرار نهائي مخزَّن لكل activity_group_id — راجع تعليق
    // persistFinalDecisions/fetchLatestFinalDecisions في dustEvaluation.ts:
    // نقطة القراءة الموحَّدة بدل إعادة حساب decideFinal محلياً هنا (كان هذا
    // أحد المسارات الأربعة المستقلة المكتشَفة في مراجعة كود مدير —
    // "FinalDecisionEngine ليس المصدر التشغيلي الوحيد فعلياً"). إعادة استخدام
    // نفس الخريطة المجلوبة أعلاه لبطاقة AEI إن توفرت (dustResults.length > 0)
    // بدل استعلام مكرر لنفس البيانات بالضبط؛ الجلب المحلي هنا يبقى fallback
    // وحيداً لحالة dustResults فارغة (حيث لا يُنفَّذ الفرع أعلاه إطلاقاً).
    const allActivityGroupIds = Array.from(new Set((dustProfiles || []).map((row: any) => row.activity_group_id || `dust-${row.id}`)));
    const finalDecisionsByGroup =
      finalDecisionsByGroupForAei ?? (await fetchLatestFinalDecisions(supabaseAdmin, allActivityGroupIds));

    // 5. معالجة الأنشطة الحديثة (Recent Activities) — البانر يعكس الآن قرار
    // المحرك الحي عبر الخريطة أعلاه، ويرجع لـ decision_records عند غيابه.
    // نمرّر قائمة الغبار الكاملة (dustProfiles) لا المقتطعة بـ limit(6): الحد
    // كان يقصّ صفوفاً فردية فيضيع أحياناً صف نشاط تنظيمي ضمن مجموعة تضم أكثر
    // من نشاط (كسارة + هدم)، فيظهر عنوان المجموعة ناقصاً. buildRecentActivities
    // يجمع حسب activity_group_id ويقصّ إلى أحدث 6 مجموعات داخلياً.
    const recentActivitiesRaw: any[] = buildRecentActivities(
      projectId,
      dustProfiles || [],
      latestDecisionsMap,
      dustByGroup,
      finalDecisionsByGroup
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

// خطأ أمني مكتشَف ومُصلَح (مراجعة كود خبير خارجي — "PATCH المشروع يسمح
// تقريباً بأي حقل"): كان يُنسَخ body بالكامل ({ ...body }) ويُحذَف منه ثلاثة
// حقول فقط (id/user_id/created_at) — أي عمود آخر على جدول projects (حالة
// اعتماد DMP، تواريخ الاعتماد، إلخ) كان قابلاً للكتابة من هذا المسار بلا أي
// تحقق من نوعه أو حتى من كونه حقلاً معروفاً أصلاً، طالما الطالب يملك المشروع.
// الآن allowlist صريحة عبر Zod .strict() — أي حقل غير مذكور هنا يُرفَض
// الطلب بأكمله (لا يُهمَل صامتاً)، بدل blocklist لثلاثة حقول فقط. القائمة
// تطابق حرفياً كل حقل يُرسِله settings/page.tsx فعلياً ضمن updatePayload
// (المصدر الوحيد الحالي لهذا الـPATCH) — حقول مثل zone_type/zone_polygon/
// monitoring_station_locations تُضبَط فقط عند إنشاء المشروع (app/api/
// projects/route.ts)، لا تُعدَّل من هنا، فتبقى خارج القائمة عمداً.
const ProjectPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    client_name: z.string().trim().max(200).nullable(),
    city: z.string().trim().max(200).nullable(),
    neighborhood: z.string().trim().max(200).nullable(),
    project_status: z.enum(['not_started', 'in_progress']),
    project_type: z.string().trim().max(200).nullable(),
    soil_type: z.enum(['SANDY_FINE', 'SANDY_COARSE', 'CLAY', 'MIXED']).nullable(),
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    terrain_type: z.string().trim().max(100),
    site_location_nature: z.string().trim().max(200).nullable(),
    wind_exposure: z.string().trim().max(100),
    start_date: z.string().trim().nullable(),
    end_date: z.string().trim().nullable(),
    work_days: z.string().trim().nullable(),
    work_days_list: z.array(z.string()),
    work_hours_start: z.string().trim().nullable(),
    work_hours_end: z.string().trim().nullable(),
    project_manager: z.string().trim().max(200).nullable(),
    contact_number: z.string().trim().max(50).nullable(),

    site_area_m2: z.number().nonnegative().nullable(),
    daily_truck_movements: z.number().int().nonnegative().nullable(),
    has_onsite_crusher: z.boolean(),
    has_onsite_batching_plant: z.boolean(),
    dmp_approval_status: z.enum([
      'NOT_REQUIRED', 'NOT_STARTED', 'DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'UNKNOWN',
    ]),

    baseline_monitoring_days: z.number().int().nonnegative().nullable(),
    monitoring_logging_interval_minutes: z.number().positive().nullable(),
    anemometer_height_m: z.number().nonnegative().nullable(),
    entry_exit_cameras_installed: z.boolean(),
    camera_retention_days: z.number().int().nonnegative().nullable(),
    sensitivity_map_prepared: z.boolean(),

    data_accuracy_confirmed: z.boolean(),
    data_accuracy_confirmed_at: z.string().trim().nullable(),

    // جدول منفصل (project_shifts) — يُستخرَج ويُحذَف قبل update على projects
    // نفسها، راجع معالجته أسفل. [] صريحة = "احذف كل الورديات"، غياب المفتاح
    // = "لا تُغيّر الورديات إطلاقاً".
    shifts: z
      .array(
        z.object({
          name: z.string(),
          start_time: z.string(),
          end_time: z.string(),
        })
      )
      .optional(),
  })
  .partial()
  .strict();

// تحديث بيانات المشروع (من صفحة الإعدادات) — يتحقق من الهوية والملكية،
// ويقبل فقط الحقول المُعرَّفة صراحة في ProjectPatchSchema (allowlist)، لا أي
// عمود آخر على جدول projects. يشمل work_days_list.
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const auth = await requireUserId(request);
  if ('error' in auth) return auth.error;

  const { projectId } = await params;

  // تحقق الملكية — يقبل السوبر أدمن كذلك (راجع verifyProjectOwnership في
  // apiAuth.ts)، فنحتاج صف المشروع نفسه (name/user_id) لتحديد لاحقاً هل
  // الفاعل هو المالك المباشر أم أدمن يعدّل مشروع غيره (لتسجيل admin_audit_log)
  const { data: project } = await supabaseAdmin
    .from('projects')
    .select('id, name, user_id')
    .eq('id', projectId)
    .maybeSingle();
  if (!project) return NextResponse.json({ error: 'المشروع غير موجود' }, { status: 404 });

  const owns = await verifyProjectOwnership(projectId, auth.userId);
  if (!owns) return NextResponse.json({ error: 'لا تملك هذا المشروع' }, { status: 403 });

  const isDirectOwner = project.user_id === auth.userId;

  const body = await request.json();
  const parsed = ProjectPatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'بيانات غير صالحة', details: parsed.error.issues },
      { status: 400 }
    );
  }
  const updates: Record<string, unknown> = { ...parsed.data };

  // خطأ أمني مكتشَف ومُصلَح (مراجعة كود مدير — "DMP يمكن تعيينها APPROVED
  // من حقول يكتبها المستخدم، بلا وثيقة أو hash موافقة"): كان dmp_approval_status
  // مقبولاً من هذا الـPATCH بأي قيمة enum بما فيها 'APPROVED'، بلا أي تحقق
  // من هوية الفاعل — مالك المشروع نفسه يقدر يعتمد خطة إدارة الغبار (DMP)
  // الخاصة به من قائمة منسدلة في صفحة الإعدادات، رغم أن اعتماد DMP فعلياً
  // قرار تنظيمي يتطلب مراجعة/وثيقة من جهة مختصة، لا تصريحاً ذاتياً. بما أن
  // النظام لا يملك بعد آلية توثيق مستندات (رفع ملف/hash موافقة)، الحل
  // المؤقت الآمن: تعيين APPROVED يتطلب صلاحية super_admin تحديداً (نفس
  // صلاحية admin_audit_log/requireSuperAdmin في apiAuth.ts) — مالك المشروع
  // العادي يبقى يقدر يرى الحقل ويطلب اعتماده، لكن لا يعتمده لنفسه مباشرة.
  if (updates.dmp_approval_status === 'APPROVED') {
    const { data: authz } = await supabaseAdmin
      .from('user_authorizations')
      .select('is_super_admin')
      .eq('user_id', auth.userId)
      .maybeSingle();
    if (!authz?.is_super_admin) {
      return NextResponse.json(
        { error: 'اعتماد خطة إدارة الغبار (DMP) يتطلب مراجعة إدارية — لا يمكن للمالك اعتمادها ذاتياً' },
        { status: 403 }
      );
    }
  }

  // ورديات العمل (project_shifts) جدول منفصل — لا تُمرَّر ضمن update على
  // جدول projects (راجع supabase-project-shifts-migration.sql). shifts
  // يُميَّز بـ"in" (لا Array.isArray فقط) حتى تبقى دلالة "المفتاح غائب
  // إطلاقاً" (لا تُغيَّر الورديات) مختلفة عن shifts:[] الصريحة (احذف الكل)،
  // نفس العقد القديم قبل هذا التصحيح.
  const shifts = 'shifts' in parsed.data ? (parsed.data.shifts as any[]) : null;
  delete updates.shifts;

  const { error } = await supabaseAdmin.from('projects').update(updates).eq('id', projectId);
  if (error) return NextResponse.json({ error: safeErrorResponse(error, `project update failed (${projectId})`) }, { status: 500 });

  // تسجيل تدقيق: فقط عندما أدمن يعدّل مشروعاً لا يملكه — عمليات المالك
  // المباشر على مشاريعه الخاصة لا تُسجَّل هنا (موجودة وموثوقة أصلاً)
  if (!isDirectOwner) {
    await supabaseAdmin.from('admin_audit_log').insert({
      admin_user_id: auth.userId,
      action: 'project_update',
      target_project_id: projectId,
      target_project_name: project.name,
      target_owner_user_id: project.user_id,
      details: updates,
    });
  }

  // استبدال كامل لصفوف الورديات (حذف ثم إعادة إدراج) — أبسط وأصح من
  // مطابقة/تحديث كل صف على حدة لقائمة صغيرة يعدّلها المستخدم يدوياً بالكامل
  // في كل مرة.
  // shifts === null (المفتاح غائب من الطلب) يعني "لم تُرسَل ورديات في هذا
  // التحديث إطلاقاً" فلا نلمس الجدول؛ [] صريحة تعني "احذف كل الورديات".
  if (shifts !== null) {
    const { error: deleteError } = await supabaseAdmin.from('project_shifts').delete().eq('project_id', projectId);
    if (deleteError) {
      return NextResponse.json({ error: safeErrorResponse(deleteError, 'project shifts delete failed') }, { status: 500 });
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
        return NextResponse.json({ error: safeErrorResponse(insertError, 'project shifts insert failed') }, { status: 500 });
      }
    }
  }
  return NextResponse.json({ success: true });
}

// خطأ أمني مكتشَف ومُصلَح (مراجعة كود خبير خارجي — "سجل القرارات والتنبيهات
// قابل للتعديل والحذف"): كان هذا المسار يحذف فعلياً alerts/decision_records/
// dust_evaluations/dust_compliance_evaluations للمشروع قبل حذف المشروع
// نفسه — مالك يواجه مخالفة تنظيمية موثَّقة يقدر يمحو دليلها بالكامل بضغطة
// واحدة ("حذف المشروع"). هذه الجداول الأربعة أصبحت الآن append-only فعلياً
// على مستوى قاعدة البيانات (triggers تمنع DELETE حتى لو نفَّذه supabaseAdmin
// — راجع supabase-append-only-evidence-and-alert-events-migration.sql)،
// فمحاولة حذفها هنا كانت ستفشل بخطأ قاعدة بيانات بعد تطبيق تلك الهجرة.
//
// الإصلاح الجذري: المشروع لا يُحذف فعلياً بعد الآن — يُؤرشف (archived_at/
// archived_by). كل الأدلة المرتبطة (بما فيها الجداول القابلة للحذف تقنياً
// current_dust_decisions/project_dust_profiles/project_shifts/
// project_devices) تبقى في القاعدة كاملة، فقط المشروع يختفي من قوائم
// المستخدم النشطة — لا يوجد GET /api/projects أصلاً (هذا الملف POST فقط
// لإنشاء مشروع)؛ التصفية archived_at is null مطبَّقة في كل مسارات القوائم
// الفعلية الفعلية (dashboard/projects-list، dashboard/global،
// dashboard/schedule، dashboard/alerts-list، dashboard/reports،
// viewer/dashboard، viewer/reports) ومسار مسح الـcron (alerts/generate،
// alerts/generate-mine) — راجع كل ملف على حدة. لا حذف فعلي لأي صف إطلاقاً
// — الأرشفة قابلة للتراجع مبدئياً (تصفير archived_at) لو احتاج التطبيق
// ميزة استعادة مستقبلاً.
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const auth = await requireUserId(request);
  if ('error' in auth) return auth.error;

  const { projectId } = await params;

  const { data: project } = await supabaseAdmin
    .from('projects')
    .select('id, name, user_id, archived_at')
    .eq('id', projectId)
    .maybeSingle();
  if (!project) return NextResponse.json({ error: 'المشروع غير موجود' }, { status: 404 });
  if (project.archived_at) return NextResponse.json({ error: 'المشروع مؤرشف مسبقاً' }, { status: 400 });

  const owns = await verifyProjectOwnership(projectId, auth.userId);
  if (!owns) return NextResponse.json({ error: 'لا تملك هذا المشروع' }, { status: 403 });

  const isDirectOwner = project.user_id === auth.userId;

  const { error: archiveError } = await supabaseAdmin
    .from('projects')
    .update({ archived_at: new Date().toISOString(), archived_by: auth.userId })
    .eq('id', projectId);
  if (archiveError) {
    return NextResponse.json({ error: safeErrorResponse(archiveError, `فشل أرشفة المشروع ${projectId} (${archiveError.code})`) }, { status: 500 });
  }

  // تسجيل تدقيق: فقط عندما أدمن يؤرشف مشروعاً لا يملكه (راجع نفس المنطق في PATCH أعلاه)
  if (!isDirectOwner) {
    await supabaseAdmin.from('admin_audit_log').insert({
      admin_user_id: auth.userId,
      action: 'project_archive',
      target_project_id: projectId,
      target_project_name: project.name,
      target_owner_user_id: project.user_id,
      details: null,
    });
  }

  return NextResponse.json({ success: true });
}
