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
  computeUnifiedActivityDecision,
  fetchLatestFinalDecisions,
  activityDecisionKey,
  riyadhLocalToUtcIso,
  type DustActivityRow,
  type DustResultItem,
  type StoredFinalDecisionRow,
} from '@/app/lib/dustEvaluation';
import { buildSensitiveReceptor, DECISION_PRIORITY, UNIT_RECEPTOR_RADIUS_M } from '@/app/utils/dust-compliance-engine';
import type { DustComplianceResult, SensitiveReceptorType } from '@/app/utils/dust-compliance-engine/types';
import { requireUserId, verifyProjectOwnership } from '@/app/lib/apiAuth';
import { safeErrorResponse } from '@/app/lib/apiError';
import { buildProjectZoneFromRow, distanceToZoneBoundaryM, zoneToBoundaryDistanceM, zoneSearchAnchorPoints } from '@/app/utils/geo/zone';
import { fetchNearbySensitiveReceptorsFromOsm } from '@/app/utils/geo/overpassReceptors';
import { displayActivityLabel as activityTitleFromRow } from '@/app/lib/activityLabels';

// DCR: مؤشر واحد فقط (dust) — لا heat ولا crane.
const INDICATOR_LABELS: Record<'dust', string> = {
  dust: 'الغبار والرؤية (DVI)',
};

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
// بدل إعادة الحساب. حُوِّلت حينها لقراءة نفس الصف المخزَّن بدل استدعاء
// decideFinal بنفسها.
//
// خطأ مكتشَف ومُصلَح (مراجعة مستخدم — "فوق مسموح اعتيادي وتحت مع مراقبة"،
// نفس التناقض الظاهري القديم لكن بسبب مختلف تماماً هذه المرة): fetchDashboardData
// في الواجهة (app/dashboard/Projects/[id]/page.tsx) يستدعي POST /evaluate
// (يكتب final_decisions) بالتوازي مع GET هذا (لا قبله) في كل تحديث دوري
// عادي — فيقرأ GET صف final_decisions من آخر استدعاء evaluate سابق (قد يسبق
// وصول قراءة الجهاز الجديدة)، بينما بطاقة AEI (عبر applyComplianceGatesToDustAei
// بنفس هذا الملف) تُحسب مباشرة من dustResults الحية داخل نفس طلب GET. صف
// مخزَّن قديم + حساب حي جديد لنفس اللحظة = بانر يعرض "مسموح" بينما AEI يعرض
// "مع مراقبة" لنفس النشاط. الإصلاح: البانر يقرأ الآن من نفس الحساب الحي
// (computeUnifiedActivityDecision على engineResult الحاضر في هذا الطلب،
// مع دمج aei تماماً كما تفعل الدالة نفسها) بدل الصف المخزَّن، فيعكسان دائماً
// نفس اللحظة بالضبط. الصف المخزَّن يبقى fallback فقط حين لا توجد نتيجة محرك
// حية لهذا النشاط في هذا الطلب (نادر: نشاط فشل حسابه هذه الدورة تحديداً).
function summaryFromLiveDecision(engineResult: DustResultItem): { decisionLabel: string; riskWeight: number; reasonText?: string; isLiveComputed: boolean; mandatoryStop: boolean } {
  const dviWorst = engineResult.windowEval.worst;
  // startIso ضروري لحساب mode الصحيح (PLANNING لنشاط مستقبلي بعيد) — راجع
  // تعليق computeUnifiedActivityDecision في dustEvaluation.ts للسبب الكامل.
  const decision = computeUnifiedActivityDecision(
    dviWorst,
    engineResult.compliance ?? null,
    engineResult.aei ?? null,
    engineResult.startIso,
    engineResult.durationHours,
    engineResult.isLiveForDevice
  );
  return {
    decisionLabel: decision.decisionLabelAr,
    riskWeight: riskWeightFromColor(decision.level),
    reasonText: decision.shortReason || undefined,
    isLiveComputed: true,
    mandatoryStop: decision.mandatoryStop,
  };
}

function summaryFromStoredDecision(storedDecision: StoredFinalDecisionRow): { decisionLabel: string; riskWeight: number; reasonText?: string; isLiveComputed: boolean; mandatoryStop: boolean } {
  return {
    decisionLabel: storedDecision.decision_label_ar,
    riskWeight: riskWeightFromColor(storedDecision.level),
    reasonText: storedDecision.short_reason_ar || undefined,
    isLiveComputed: false,
    mandatoryStop: storedDecision.mandatory_stop,
  };
}

// دمج صفوف الغبار في مصفوفة أنشطة موحّدة تطابق شكل RecentActivityItem
// المتوقع في page.tsx (activityGroupId, kinds, summaries...)
//
// الملخص العلوي (البانر) يعكس قرار المحرك الحي مباشرةً عبر خريطة dustByGroup،
// فإن لم تتوفر نتيجة محرك نرجع لآخر قرار مخزَّن في final_decisions
// (finalDecisionsByGroup)، وإلا "بانتظار التقييم" (نشاط لم يُقيَّم بعد إطلاقاً).
// هذا السلوك يبقى مقصوداً لعرض "معاينة حية" (راجع isLiveComputed) — لكن
// decisionTargets (أدناه) منفصل تماماً الآن، راجع تعليقه الكامل.
//
// خطأ معماري مكتشَف ومُصلَح (مراجعة كود خارجي — "مصدر القرار الرسمي ما
// زال PARTIAL"): كانت decisionTargets تُبنى من engineResult.windowEval.worst
// (نتيجة DVI حية، غير محفوظة في final_decisions بعد بالضرورة) كلما توفرت،
// بمعزل تام عن storedDecision. reason/requiredAction/weatherSnapshot فيها
// كانت تُملأ من هذا الحساب الحي — رغم أن لا مستهلك فعلي بالواجهة يعرضهما
// (فحص شامل لكل استخدامات decisionTargets: PATCH/DELETE /api/activities
// تقرأان فقط projectId/activityId/source كمعرّفات صف للأرشفة/إعادة الجدولة،
// لا reason/requiredAction إطلاقاً) — لكن هذا يبقى فخاً معمارياً حقيقياً:
// أي تطوير مستقبلي قد يستخدم هذه الحقول ظاناً أنها القرار الرسمي المحفوظ.
// الإصلاح: decisionTargets الآن تُبنى حصراً من storedDecision (لا
// engineResult إطلاقاً)، وتحمل decisionId حقيقي (final_decisions.id) —
// "الواجهة لا تقرر" بحسب الوثيقة المعمارية: FinalDecisionEngine → Persist
// → Audit/Evidence → decisionId → UI، لا اختصار عبر نتيجة حية غير محفوظة.
// وحدة نشاط متعددة (كسارتان/خلاطتان بصفوف project_dust_profiles منفصلة)
// قد يحمل قرارها المخزَّن dust_profile_id لوحدة واحدة فقط ضمنها —
// storedDecision?.dust_profile_id === row.id يفرض تطابقاً دقيقاً على مستوى
// الصف الفعلي، لا فقط activity_group_id (الذي قد يخص وحدة شقيقة أخرى)؛
// الوحدات غير المطابقة تُستثنى من decisionTargets كلياً (لا قرار رسمي محفوظ
// لها في هذا الطلب) بدل عرض هدف تنفيذي مبني على تخمين.
interface DecisionTarget {
  projectId: string;
  activityId: string;
  source: 'dust';
  decisionId: string;
}

interface RecentActivityItem {
  activityGroupId: string;
  activityTitle: string;
  kinds: Array<'dust'>;
  // isLiveComputed: راجع تعليق summaryFromLiveDecision الكامل أعلاه — true
  // يعني أن هذا الملخص محسوب حياً ضمن نفس طلب GET هذا (لم يُكتب في
  // final_decisions بعد بالضرورة؛ POST /evaluate المتوازي قد لا يكون اكتمل
  // أو نجح بعد). false يعني أنه من صف final_decisions مخزَّن فعلياً
  // (fallback فقط، لا نتيجة محرك حية لهذا الطلب). خطأ معماري مكتشَف ومُصلَح
  // (مراجعة كود خارجي — P1، الملاحظة #13: "الواجهة ما زالت تستطيع عرض قرار
  // حي لم يُحفظ بعد في Immutable Audit"): هذا الحقل يسمح للواجهة بتمييز
  // "معاينة حية" (Live Preview) عن "قرار رسمي محفوظ" بدل عرض كليهما بنفس
  // المظهر دون تفريق — بلا تغيير في زمن الاستجابة (لا إعادة هيكلة GET/
  // evaluate، فقط شفافية إضافية حول مصدر كل قيمة معروضة).
  summaries: { kind: 'dust'; label: string; decisionLabel: string; riskWeight: number; reasonText?: string; isLiveComputed: boolean; mandatoryStop: boolean }[];
  decisionTargets: DecisionTarget[];
  mandatoryStop: boolean;
  isFutureActivity: boolean;
  windowStartIso?: string;
  windowEndIso?: string;
  durationMinutes?: number;
  // كل معرّفات activity_group_id الحقيقية المدموجة ضمن هذه البطاقة (راجع
  // stripUnitSuffix أدناه) — تسمح للعميل بمطابقة dustResults الخاصة بكل
  // وحدة فعلية دون الاعتماد على مطابقة نصية جزئية قابلة للالتباس.
  unitGroupIds: string[];
}

// خطأ حرج مكتشَف ومُصلَح (طلب صريح من المستخدم — تتبُّع لسؤال ربط الجهاز:
// "الآن كل جهاز له قراءاته الخاصة، كيف أعطيهم قرار واحد؟"): وحدات النشاط
// الواحد المتعدد (كسارتان/محطتا خلط) تُقسَّم إلى activity_group_id مستقلة
// بصيغة `${base}-u${n}` (راجع unitGroupId في AddActivityModal/index.tsx) —
// كل وحدة تُقيَّم بجهازها وقراءاتها المستقلة تماماً كما يجب (لا تغيير هنا).
// لكن buildRecentActivities كانت تُنشئ بطاقة منفصلة لكل وحدة بلا أي تجميع،
// فيرى المستخدم بطاقتين بنفس العنوان (مثال: "الكسارة" مرتين) بلا أي إشارة
// إلى أنهما نفس النشاط التنظيمي الواحد، ولا "حالة موحّدة" تلخّص الأسوأ بينهما.
// stripUnitSuffix تعيد المعرّف الأساس بإزالة لاحقة -uN فقط (نمط ثابت مطابق
// تماماً لما ينتجه unitGroupId، لا أي نمط -u آخر قد يظهر عرضاً ضمن معرّف
// حر أنشأه المستخدم) — تُستخدَم كمفتاح تجميع البطاقات بدل activity_group_id
// الخام، فتُدمَج كل وحدات النشاط الواحد في بطاقة واحدة، مع بقاء كل وحدة
// بقرارها التفصيلي الخاص ضمن summaries/decisionTargets (لا دمج بيانات، فقط
// دمج عرض) — أسوأ حالة (riskWeight=4) بين أي وحدة تكفي لإظهار "إيقاف
// إلزامي" على البطاقة الموحّدة (نفس منطق mandatoryStop الحالي دون تعديل).
// exported للاختبار المباشر فقط (route.test.ts) — لا مستهلك إنتاجي آخر خارج هذا الملف.
export function stripUnitSuffix(activityGroupId: string): string {
  return activityGroupId.replace(/-u\d+$/, '');
}

// exported للاختبار المباشر فقط (route.test.ts) — لا مستهلك إنتاجي آخر خارج هذا الملف.
export function buildRecentActivities(
  projectId: string,
  dustRows: DustActivityRow[],
  dustByGroup: Map<string, DustResultItem>,
  finalDecisionsByGroup: Map<string, StoredFinalDecisionRow>
): RecentActivityItem[] {
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
    decisionTargets: DecisionTarget[];
    latestCreatedAt: string;
    windowStartIso?: string;
    windowEndIso?: string;
    durationMinutes?: number;
    // معرّفات activity_group_id الحقيقية (غير المُقصَّرة) لكل وحدة دُمجت في
    // هذه المجموعة — راجع تعليق stripUnitSuffix أعلاه.
    unitGroupIds: string[];
  };
  type IndicatorSummaryLike = {
    kind: 'dust';
    label: string;
    decisionLabel: string;
    riskWeight: number;
    reasonText?: string;
    isLiveComputed: boolean;
    mandatoryStop: boolean;
  };

  const groups = new Map<string, Acc>();

  function upsertGroup(
    kind: 'dust',
    row: DustActivityRow,
    windowStartIso: string | undefined,
    windowEndIso: string | undefined,
    durationMinutes: number | undefined
  ) {
    // إن لم يكن للصف activity_group_id، نعامله كنشاط مستقل بمعرّف خاص به
    // حتى لا تختلط أنشطة غير مرتبطة ببعضها تحت نفس البطاقة
    const groupId: string = row.activity_group_id || `${kind}-${row.id}`;

    // مفتاح تجميع البطاقة = المعرّف الأساس (بلا لاحقة -uN) — يدمج كل وحدات
    // نشاط واحد متعدد في بطاقة واحدة (راجع تعليق stripUnitSuffix). كل
    // استخدام آخر لـ groupId أدناه (بحث engineResult/storedDecision) يبقى
    // بالمعرّف الحقيقي غير المُقصَّر عمداً، فكل وحدة تُقيَّم بقراراتها
    // المستقلة تماماً كما هي — هذا تجميع عرض فقط، لا دمج بيانات.
    const cardKey = stripUnitSuffix(groupId);

    let acc = groups.get(cardKey);
    if (!acc) {
      acc = {
        activityGroupId: cardKey,
        activityTitle: activityTitleFromRow(row),
        regulatoryTitles: [],
        kinds: [],
        summaries: [],
        decisionTargets: [],
        latestCreatedAt: row.created_at ?? new Date(0).toISOString(),
        windowStartIso,
        windowEndIso,
        durationMinutes,
        unitGroupIds: [],
      };
      groups.set(cardKey, acc);
    }

    if (!acc.unitGroupIds.includes(groupId)) acc.unitGroupIds.push(groupId);

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

    // نتيجة المحرك الحية لهذا المؤشر (إن وُجدت) — المصدر المفضّل لـ
    // summaryFields وحدها (راجع تعليق summaryFromLiveDecision أعلاه للسبب:
    // يضمن أن البانر وبطاقة AEI يعكسان نفس لحظة الحساب بالضبط)، مُميَّزة
    // دائماً بشارة "معاينة حية" (isLiveComputed) — لا تُستخدَم إطلاقاً لبناء
    // decisionTargets (راجع تعليقها أدناه، وتعليق DecisionTarget أعلى الملف).
    const engineResult = dustByGroup.get(`${groupId}-${row.id}`);

    // القرار النهائي المخزَّن (كتبه evaluate/route.ts) — fallback لـ
    // summaryFields حين لا توجد نتيجة محرك حية، والمصدر الوحيد الآن لـ
    // decisionTargets بلا استثناء. المفتاح مركّب (projectId, groupId) —
    // راجع تعليق fetchLatestFinalDecisions في dustEvaluation.ts للسبب (عزل
    // المشاريع، القسم 12.2).
    const storedDecision = finalDecisionsByGroup.get(activityDecisionKey(projectId, groupId));

    let summaryFields: { decisionLabel: string; riskWeight: number; reasonText?: string; isLiveComputed: boolean; mandatoryStop: boolean };
    if (engineResult) {
      summaryFields = summaryFromLiveDecision(engineResult);
    } else if (storedDecision) {
      summaryFields = summaryFromStoredDecision(storedDecision);
    } else {
      // لا نتيجة محرك حية ولا قرار مخزَّن — نشاط لم يُستدعَ evaluate عليه بعد إطلاقاً.
      summaryFields = {
        decisionLabel: 'بانتظار التقييم',
        riskWeight: 0,
        reasonText: 'لم يصدر قرار موثّق لهذا المؤشر بعد',
        isLiveComputed: false,
        mandatoryStop: false,
      };
    }

    acc.summaries.push({
      kind,
      label: INDICATOR_LABELS[kind],
      ...summaryFields,
    });

    // هدف قرار موحّد لهذا المؤشر — يفعّل أزرار الأرشفة/إعادة الجدولة في
    // البطاقة (لا "اعتماد/تأجيل" فعلي، راجع تعليق DecisionTarget أعلاه:
    // لا مستهلك بالواجهة يقرأ محتوى قرار تنفيذي من هنا حالياً). يُبنى حصراً
    // من storedDecision (قرار محفوظ فعلياً في final_decisions يحمل id حقيقي)
    // — لا engineResult الحي إطلاقاً، بصرف النظر عن توفره. dust_profile_id
    // على الصف المخزَّن يجب أن يطابق row.id تحديداً (لا فقط نفس
    // activity_group_id) — نشاط متعدد الوحدات (كسارتان/خلاطتان) قد يحمل
    // قراره المخزَّن dust_profile_id لوحدة واحدة فقط؛ الوحدات الأخرى غير
    // المطابقة تُستثنى من decisionTargets كلياً، لا تُعرض بتخمين.
    if (storedDecision && String(storedDecision.dust_profile_id) === String(row.id)) {
      acc.decisionTargets.push({
        projectId,
        activityId: String(row.id),
        source: kind,
        decisionId: String(storedDecision.id),
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
      // إيقاف إلزامي مؤكَّد إن قال أي مؤشر بذلك — يُقرأ من الحقل الحقيقي
      // s.mandatoryStop (مصدره decideFinal.mandatoryStop عبر summaryFromLiveDecision
      // /summaryFromStoredDecision) لا من riskWeight===4 (وكيل لوني فقط).
      //
      // خطأ معماري مكتشَف ومُصلَح (مراجعة كود — تدقيق تناسق المحركات الأربعة،
      // الفئة 4): كانت riskWeight===4 (أي level==='BLACK') تُستخدَم كوكيل
      // لـmandatoryStop، لكن AEI CLOSED يُترجَم في decideFinal إلى
      // PROTECTIVE_STOP (mandatoryStop=false عمداً، راجع تعليق AEI_TO_OPERATION
      // في final-decision-engine/engine.ts) بينما level قد يبقى 'BLACK'
      // (موروث من aei.color) — تناقض مباشر: البانر الموحّد كان يعرض "إيقاف
      // إلزامي نظامي" بينما بطاقة AEI لنفس النشاط/اللحظة تعرض إغلاقاً احترازياً
      // غير إلزامي فعلياً. الإصلاح: قراءة mandatoryStop الحقيقي المخزَّن على كل
      // ملخص مؤشر بدل اشتقاقه من اللون.
      const mandatoryStop = acc.summaries.some((s) => s.mandatoryStop === true);
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
        unitGroupIds: acc.unitGroupIds,
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
      { data: projectShifts },
      { data: projectDevices },
    ] = await Promise.all([
      // archived_at is null — نشاط مؤرشَف (راجع DELETE في app/api/activities/
      // route.ts) لا يجب أن يظهر في لوحة المشروع النشطة بعد أرشفته، رغم بقاء
      // صفه وأدلته التاريخية محفوظة دائماً في قاعدة البيانات.
      supabaseAdmin.from('project_dust_profiles').select('*').eq('project_id', projectId).is('archived_at', null).order('id', { ascending: false }),
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
    project.monitoring_station_count = (projectDevices || []).filter((d: { is_active: boolean }) => d.is_active).length;

    // خطأ أداء مكتشَف: computeDustResults (DVI/طقس، قد يستدعي Open-Meteo لكل
    // نشاط)، استعلام sensitive_receptors، واكتشاف مستقبِلات OSM عبر
    // Overpass API كانت الثلاثة تُنفَّذ بالتسلسل (await منفصل لكل واحدة)
    // رغم أنها مستقلة تماماً عن بعضها (لا واحدة تحتاج نتيجة الأخرى) —
    // Promise.all هنا يقلّص الزمن الكلي لأطول عملية منفردة بدل مجموعها،
    // بلا أي تغيير في المنطق أو الترتيب النهائي.
    //
    // 4. حساب النتائج الحية لمحرك الغبار لكل نشاط. المحرك يجلب طقسه بنفسه
    // داخلياً حسب موقعه ووقت النشاط المخطط، ثم يُدمج مع AEI. النتائج تُربط
    // بـ activityGroupId حتى تعرضها page.tsx كأبناء داخل بطاقة النشاط
    // الموحّدة، وتُغذّي أيضًا ملخص البانر العلوي بقرار المحرك الحي قبل أي
    // توثيق يدوي.
    //
    // مستقبِلات حساسة (مدارس/مستشفيات/سكني) — عامة على مستوى النظام، لا
    // تُفلتَر حسب project_id. مصدرها جدول sensitive_receptors المُدار
    // يدوياً، وتبقى المصدر الوحيد المُستخدم فعلياً في قواعد الامتثال
    // التنظيمي (مسافة الكسارة/الأكوام) أدناه — لا يجوز الاعتماد على بيانات
    // OSM غير موثّقة لقرار تنظيمي مُلزم.
    //
    // قائمة "المستقبِلات القريبة" المعروضة في بطاقة الامتثال (عرض توعوي
    // فقط، لا تُغذّي أي قاعدة امتثال) — تُكتشف تلقائياً عبر Overpass API
    // (OpenStreetMap) بدل الاعتماد على جدول sensitive_receptors الذي قد
    // يبقى فارغاً بلا إدخال يدوي. المسافة تُحسب من كل مستقبِل إلى أقرب
    // نقطة على حدود منطقة المشروع الفعلية (مضلع/دائرة مرسومة عبر KML)،
    // وليس إلى مركزها. البحث ينطلق من عدة نقاط على حدود المشروع الفعلية
    // (رؤوس المضلع، أو نقاط موزَّعة على محيط الدائرة) بدل استعلام واحد من
    // مركز تمثيلي بنصف قطر موسَّع — نفس مبدأ حساب موقع الكسارة/الهدم من
    // موقعها الفعلي، لا من مركز المشروع.
    const projectZoneForReceptors = buildProjectZoneFromRow(project);
    const NEARBY_RECEPTOR_RADIUS_M = 1000;
    const searchAnchors = zoneSearchAnchorPoints(projectZoneForReceptors);

    // خطأ مكتشَف ومُصلَح (المستخدم لاحظ: مسجد على 5م من كسارة لم يظهر في
    // قسم "المستقبِلات الحساسة حول الكسارة" رغم اكتشافه في قسم آخر بالبطاقة
    // نفسها): searchAnchors أعلاه مبنية على حدود/منطقة المشروع ككل — لمشروع
    // كبير (مثال حقيقي: 1.1 مليون م²)، موقع الكسارة الفعلي قد يقع بعيداً
    // تماماً عن نقاط بحث حدود المشروع، فلا يُكتشف معلَم قريب منها تحديداً
    // رغم قربه الفعلي منها. نقاط بحث إضافية صريحة حول كل موقع كسارة/محطة
    // خلط فعلي (crusher_lat/lng، batching_lat/lng) — بمعزل تام عن حدود
    // المشروع — تضمن اكتشاف OSM حول الوحدة نفسها بصرف النظر عن موقعها داخل
    // مشروع كبير. عرض توعوي بحت (نفس قيد nearbySensitiveReceptors أعلاه) —
    // لا يُغذّي أي قرار تنظيمي مُلزم.
    const unitSearchAnchors: { lat: number; lng: number }[] = [];
    for (const row of dustProfiles || []) {
      const crusherLat = typeof row.crusher_lat === 'number' ? row.crusher_lat : null;
      const crusherLng = typeof row.crusher_lng === 'number' ? row.crusher_lng : null;
      if (crusherLat !== null && crusherLng !== null) unitSearchAnchors.push({ lat: crusherLat, lng: crusherLng });
      const batchingLat = typeof row.batching_lat === 'number' ? row.batching_lat : null;
      const batchingLng = typeof row.batching_lng === 'number' ? row.batching_lng : null;
      if (batchingLat !== null && batchingLng !== null) unitSearchAnchors.push({ lat: batchingLat, lng: batchingLng });
    }

    const [dustResults, sensitiveReceptorsResult, discoveredReceptorsByAnchor, discoveredReceptorsByUnit] = await Promise.all([
      computeDustResults(dustProfiles || [], project, supabaseAdmin),
      supabaseAdmin.from('sensitive_receptors').select('id, name, receptor_type, lat, lng'),
      Promise.all(
        searchAnchors.map((anchor) =>
          fetchNearbySensitiveReceptorsFromOsm(anchor.lat, anchor.lng, NEARBY_RECEPTOR_RADIUS_M)
        )
      ),
      Promise.all(
        unitSearchAnchors.map((anchor) =>
          fetchNearbySensitiveReceptorsFromOsm(anchor.lat, anchor.lng, UNIT_RECEPTOR_RADIUS_M)
        )
      ),
    ]);

    // خطأ أمني مكتشَف ومُصلَح (مراجعة كود مدير — "فشل استعلام المستقبلات
    // الحساسة يتحول إلى مصفوفة فارغة ثم Infinity؛ قد يظهر الموقع آمناً عند
    // تعطل البيانات"): كان لا يوجد أي فحص لـerror هنا — فشل الاستعلام
    // (انقطاع اتصال، مشكلة صلاحيات) كان يُعامَل بصمت كـ"لا توجد مستقبِلات
    // حساسة مسجَّلة إطلاقاً" (نفس الحالة الشرعية لموقع نظيف فعلاً)، ومحرك
    // الامتثال يترجم القائمة الفارغة إلى مسافة Infinity (آمنة تماماً) —
    // فتعطّل الشبكة/القاعدة يظهر فعلياً كـ"لا مستقبِلات قريبة" بدل خطأ واضح،
    // على عكس فلسفة fail-safe المتبعة بكل مكان آخر في هذا الملف. الآن فشل
    // الاستعلام يوقف الطلب بخطأ 500 صريح بدل الاستمرار بأمان زائف.
    const { data: sensitiveReceptorRows, error: sensitiveReceptorsError } = sensitiveReceptorsResult;
    if (sensitiveReceptorsError) {
      return NextResponse.json(
        { error: safeErrorResponse(sensitiveReceptorsError, 'sensitive_receptors fetch failed') },
        { status: 500 }
      );
    }
    const sensitiveReceptors = (sensitiveReceptorRows || []).map(buildSensitiveReceptor);
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
    let finalDecisionsByGroupForAei: Map<string, StoredFinalDecisionRow> | undefined;

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
      const complianceByActivityId = new Map<string, DustComplianceResult>(
        dustComplianceResults.map((r) => [r.activityId, r.result])
      );
      dustResults.forEach((r) => {
        r.compliance = complianceByActivityId.get(r.activityId) ?? null;
      });

      // المستقبِلات الحساسة ضمن 500م من موقع كل وحدة كسارة/خلاطة تحديداً
      // (لا من حدود المشروع) — تُرفَق على نفس عنصر dustResults ليعرضها
      // ComplianceWidgetCard عند اختيار نشاط كسارة أو محطة خلط.
      //
      // المصدر هنا هو الاتحاد بين جدول sensitive_receptors المُدار يدوياً،
      // مستقبِلات OSM المكتشفة حول حدود المشروع (discoveredReceptors)،
      // ومستقبِلات OSM المكتشفة حول موقع كل وحدة كسارة/خلط تحديداً
      // (discoveredReceptorsByUnit — راجع تعليقها الكامل أعلاه لسبب
      // الحاجة لبحث منفصل عن حدود المشروع). الجدول اليدوي وحده يبقى فارغاً
      // في معظم المشاريع فتظهر القائمة خالية رغم وجود مدارس/مساكن فعلية
      // حول الكسارة. هذا عرض توعوي بحت — قواعد المسافة المُلزمة أعلاه
      // (computeDustComplianceResults) ما زالت تقرأ sensitiveReceptors
      // اليدوية وحدها، فلا يُبنى أي قرار إيقاف على بيانات OSM غير الموثّقة.
      // dedupe بـid عبر كل المصادر الثلاثة معاً — نفس معلَم OSM قد يُكتشَف
      // من بحث حدود المشروع وبحث موقع الوحدة معاً (تراكب دائرتي بحث)،
      // فيظهر مكرَّراً في القائمة النهائية بلا هذا الدمج.
      const receptorsForUnitDisplayDeduped = new Map<
        string,
        { id: string; name: string; receptorType: SensitiveReceptorType; lat: number; lng: number }
      >();
      for (const r of sensitiveReceptors) receptorsForUnitDisplayDeduped.set(r.id, r);
      for (const r of discoveredReceptors) receptorsForUnitDisplayDeduped.set(r.id, r);
      for (const r of discoveredReceptorsByUnit.flat()) receptorsForUnitDisplayDeduped.set(r.id, r);
      const receptorsForUnitDisplay = Array.from(receptorsForUnitDisplayDeduped.values());
      const unitReceptorsByActivityId = computeUnitReceptors(
        dustProfiles || [],
        dustResults,
        receptorsForUnitDisplay
      );
      dustResults.forEach((r) => {
        r.unitReceptors = unitReceptorsByActivityId.get(r.activityId) ?? [];
      });

      // امتثال ساعي طوال ساعات الدوام — يغذّي شبكة "توقعات الساعات القادمة"
      // في ComplianceWidgetCard، بنفس مبدأ hourlyForecasts الخاصة بـ DVI
      // لكن كل ساعة تمر عبر محرك الامتثال كاملاً بدل DVI فقط.
      const complianceHourlyByActivityId = computeDustComplianceHourly(dustProfiles || [], project, dustResults, sensitiveReceptors);
      dustResults.forEach((r) => {
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
      const activityGroupTargetsForFinalDecisions = Array.from(
        new Set((dustProfiles || []).map((row: DustActivityRow) => row.activity_group_id || `dust-${row.id}`))
      ).map((activityGroupId) => ({ projectId, activityGroupId }));
      finalDecisionsByGroupForAei = await fetchLatestFinalDecisions(supabaseAdmin, activityGroupTargetsForFinalDecisions);
      applyComplianceGatesToDustAei(dustResults, projectId, finalDecisionsByGroupForAei);
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
    const dustResultsGrouped: (DustResultItem & { complianceList: DustComplianceResult[] })[] = (() => {
      const byGroup = new Map<string, DustResultItem[]>();
      dustResults.forEach((r) => {
        const list = byGroup.get(r.activityGroupId) || [];
        list.push(r);
        byGroup.set(r.activityGroupId, list);
      });
      return Array.from(byGroup.values()).map((rows) => {
        const representative = rows.reduce((worst, current) => {
          const worstPriority = DECISION_PRIORITY[worst.compliance?.decisionCategory as keyof typeof DECISION_PRIORITY] ?? -1;
          const currentPriority = DECISION_PRIORITY[current.compliance?.decisionCategory as keyof typeof DECISION_PRIORITY] ?? -1;
          return currentPriority > worstPriority ? current : worst;
        }, rows[0]);
        return {
          ...representative,
          complianceList: rows.map((r) => r.compliance).filter((c): c is DustComplianceResult => Boolean(c)),
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
    const dustByGroup = new Map<string, DustResultItem>();
    dustResults.forEach((r) => dustByGroup.set(`${r.activityGroupId}-${r.activityId}`, r));

    // آخر قرار نهائي مخزَّن لكل activity_group_id — راجع تعليق
    // persistFinalDecisions/fetchLatestFinalDecisions في dustEvaluation.ts:
    // نقطة القراءة الموحَّدة بدل إعادة حساب decideFinal محلياً هنا (كان هذا
    // أحد المسارات الأربعة المستقلة المكتشَفة في مراجعة كود مدير —
    // "FinalDecisionEngine ليس المصدر التشغيلي الوحيد فعلياً"). إعادة استخدام
    // نفس الخريطة المجلوبة أعلاه لبطاقة AEI إن توفرت (dustResults.length > 0)
    // بدل استعلام مكرر لنفس البيانات بالضبط؛ الجلب المحلي هنا يبقى fallback
    // وحيداً لحالة dustResults فارغة (حيث لا يُنفَّذ الفرع أعلاه إطلاقاً).
    const allActivityGroupTargets = Array.from(new Set((dustProfiles || []).map((row: DustActivityRow) => row.activity_group_id || `dust-${row.id}`))).map(
      (activityGroupId) => ({ projectId, activityGroupId })
    );
    const finalDecisionsByGroup =
      finalDecisionsByGroupForAei ?? (await fetchLatestFinalDecisions(supabaseAdmin, allActivityGroupTargets));

    // 5. معالجة الأنشطة الحديثة (Recent Activities) — البانر يعكس قرار المحرك
    // الحي عبر الخريطة أعلاه، ويرجع لآخر قرار مخزَّن في final_decisions عند
    // غيابه. نمرّر قائمة الغبار الكاملة (dustProfiles) لا المقتطعة بـ
    // limit(6): الحد كان يقصّ صفوفاً فردية فيضيع أحياناً صف نشاط تنظيمي ضمن
    // مجموعة تضم أكثر من نشاط (كسارة + هدم)، فيظهر عنوان المجموعة ناقصاً.
    // buildRecentActivities يجمع حسب activity_group_id ويقصّ إلى أحدث 6
    // مجموعات داخلياً.
    const recentActivitiesRaw: RecentActivityItem[] = buildRecentActivities(
      projectId,
      dustProfiles || [],
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
  // الفاعل هو المالك المباشر أم أدمن يعدّل مشروع غيره (لتسجيل admin_audit_log).
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

  // قرار تراجَع عنه صراحة (طلب مستخدم — "يستطيع مالك المشروع تمرير DMP
  // كـAPPROVED أثناء الإنشاء، رغم أن التعديل اللاحق يقصر الاعتماد على صلاحية
  // is_super_admin؛ لا يوجد فعلياً في هذا النظام مفهوم دور 'مشرف' منفصل عن
  // المالك، فهذا التمييز غير مبرَّر"): كان هذا المسار يمنع مالك المشروع من
  // تغيير dmp_approval_status إلى 'APPROVED' إلا لو كان super_admin، بينما
  // مسار الإنشاء (POST /api/projects) يقبل نفس القيمة من نفس المستخدم بلا
  // أي تحقق إطلاقاً — تناقض مباشر بين مساري الإنشاء والتعديل لنفس الحقل.
  // الآن دمج السلوك: PATCH يقبل dmp_approval_status بنفس حرية POST، بلا أي
  // فحص صلاحية إضافي — يتطابق المساران تماماً.

  // ورديات العمل (project_shifts) جدول منفصل — لا تُمرَّر ضمن update على
  // جدول projects (راجع supabase-project-shifts-migration.sql). shifts
  // يُميَّز بـ"in" (لا Array.isArray فقط) حتى تبقى دلالة "المفتاح غائب
  // إطلاقاً" (لا تُغيَّر الورديات) مختلفة عن shifts:[] الصريحة (احذف الكل)،
  // نفس العقد القديم قبل هذا التصحيح.
  const shiftsProvided = 'shifts' in parsed.data;
  const shifts = shiftsProvided ? (parsed.data.shifts ?? null) : null;
  delete updates.shifts;

  // خطأ مكتشَف ومُصلَح (طلب مستخدم صريح — مراجعة كود خارجي: "إنشاء المشروع
  // والورديات وتحديثها غير ذري"): كان update على projects ثم delete+insert
  // منفصلين على project_shifts — فشل الـinsert بعد نجاح الـdelete يترك
  // المشروع بلا ورديات إطلاقاً (نافذة فشل جزئي حقيقية). الآن كل الكتابات
  // (تحديث المشروع + استبدال الورديات إن أُرسلت) تتم داخل RPC ذرّية واحدة
  // (update_project_with_shifts، 202608120016) — تنجح معاً أو تفشل معاً.
  // shiftsProvided=false (المفتاح غائب) لا يلمس project_shifts إطلاقاً —
  // بلا تغيير في هذا السلوك.
  const { error } = await supabaseAdmin.rpc('update_project_with_shifts', {
    p_project_id: projectId,
    p_updates: updates,
    p_shifts_provided: shiftsProvided,
    p_shifts: shifts,
  });
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
// خطأ تشغيلي/أمني مكتشَف ومُصلَح (القسم 13 من "دليل الإصلاح الجذري لمنظومة
// مرقاب" — "الأرشفة الذرية"): كانت الأرشفة UPDATE واحداً على projects فقط —
// لا تعطيل ذرّي للأجهزة/الاتصالات/المهام المعلَّقة في نفس المعاملة، ولا قفل
// يمنع سباق أرشفة متزامنة مع تقييم/إدخال جهاز جارٍ لنفس المشروع بنفس
// اللحظة (ingest_device_reading_atomic/ingest_device_event_v2 كانا يفحصان
// نشاط الجهاز فقط، لا أرشفة المشروع المرتبط به). الإصلاح: archive_project_
// atomic (202608040009) تنفّذ كل ذلك في معاملة واحدة تحت نفس قفل المشروع
// المستخدَم الآن في كل RPC كتابة أخرى (ingest/persist_activity_decision).
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

  const { error: archiveError } = await supabaseAdmin.rpc('archive_project_atomic', {
    p_project_id: projectId,
    p_actor_id: auth.userId,
  });
  if (archiveError) {
    if (archiveError.message?.includes('PROJECT_NOT_FOUND_OR_ARCHIVED')) {
      return NextResponse.json({ error: 'المشروع مؤرشف مسبقاً' }, { status: 400 });
    }
    return NextResponse.json({ error: safeErrorResponse(archiveError, `فشل أرشفة المشروع ${projectId} (${archiveError.code})`) }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
