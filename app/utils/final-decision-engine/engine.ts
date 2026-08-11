// =============================================================
// Final Decision Engine — Core
// decideFinal: الدالة الوحيدة المسموح لها بقراءة dvi.mandatoryStop و
// compliance.decisionCategory معاً وإنتاج قرار نهائي. دالة نقية بلا I/O —
// تستهلك نتائج DVI/الامتثال/AEI الجاهزة فقط (قراءة، بلا إعادة حساب لأي
// منها)، بنفس مبدأ evaluateDustCompliance في dust-compliance-engine.
// راجع types.ts للسياق الكامل حول سبب وجود هذا الملف.
// =============================================================

import type { FinalDecision, FinalDecisionInput, OperationalDecision, RegulatoryFinding } from './types';
// PM10_WARNING_UG_M3 (251 ميكروجرام/م³) — نفس الحد المستخدَم في
// buildPlanningForecastResult (dust-compliance-engine/engine.ts) لتصنيف
// توقّع PM10 "غير مناسب". decideFinal تبقى "الدالة الوحيدة المسموح لها
// بقراءة dvi/compliance معاً" (راجع تعليق أعلى الملف) — هذا الاستيراد ثابت
// قيمة رقمية بحتة فقط، لا منطق قرار من محرك آخر، فلا يخالف ذلك المبدأ.
import { PM10_WARNING_UG_M3 as PM10_FORECAST_WARNING_UG_M3 } from '@/app/utils/dust-compliance-engine';

// invariant صارم — لا يعتمد على التزام كل فرع من decideFinal بضبط
// overridable=false يدوياً عند mandatoryStop=true (نفس مبدأ
// assertMandatoryStopInvariant في dust-engine/engine.ts، مُطبَّق هنا على
// مستوى القرار النهائي المُجمَّع). يُستدعى مباشرة قبل إرجاع النتيجة —
// فشله يعني خطأً برمجياً حقيقياً في decideFinal نفسها.
function assertDecisionInvariant(result: { mandatoryStop: boolean; overridable: boolean }): void {
  if (result.mandatoryStop && result.overridable) {
    throw new Error('Invalid FinalDecision: mandatoryStop=true cannot coexist with overridable=true');
  }
}

// ترتيب أولوية القرار التشغيلي (القسم 4.3 من "دليل الإصلاح الجذري لمنظومة
// مرقاب") — الأعلى دائماً يفوز عند اختيار الأشد بين مرشحين. يجب أن يبقى
// satisfies Record<OperationalDecision, number> — أي فئة جديدة في
// OperationalDecision (types.ts) تُجبِر المترجم على تصنيفها هنا فوراً.
const OPERATION_RANK = {
  ALLOW: 0,
  MONITOR: 1,
  RESTRICT: 2,
  HOLD_FOR_VERIFICATION: 3,
  PROTECTIVE_STOP: 4,
  MANDATORY_STOP: 5,
} as const satisfies Record<OperationalDecision, number>;

const LEVEL_BY_DVI: Record<string, FinalDecision['level']> = {
  GREEN: 'GREEN',
  YELLOW: 'YELLOW',
  ORANGE: 'ORANGE',
  RED: 'RED',
  DARK_RED: 'DARK_RED',
  BLACK: 'BLACK',
};

const LEVEL_WEIGHT: Record<FinalDecision['level'], number> = {
  GREEN: 0,
  YELLOW: 1,
  ORANGE: 2,
  RED: 3,
  DARK_RED: 4,
  BLACK: 5,
};

// أدنى مستوى يفرضه قرار امتثال غير ALLOW حتى لو DVI الفيزيائي أخف —
// نفس منطق floorLevel في computeUnifiedActivityDecision القديمة
// (dustEvaluation.ts) الذي حُذف الآن بعد النقل إلى هنا: RESTRICT_ACTIVITY/
// FIELD_VERIFICATION_REQUIRED/ALLOW_WITH_CONTROLS ترفع الحد الأدنى لأحمر،
// PRECAUTION ترفعه لأصفر فقط (طلب صريح من المستخدم: لا تُقيَّد الدرجة/
// الحالة، فقط النص يتغيّر — لكن البانر يجب ألا يبقى أخضر بينما نصه احتراز).
function complianceFloorLevel(decisionCategory: string): FinalDecision['level'] | null {
  if (decisionCategory === 'PRECAUTION') return 'YELLOW';
  if (
    decisionCategory === 'RESTRICT_ACTIVITY' ||
    decisionCategory === 'FIELD_VERIFICATION_REQUIRED' ||
    decisionCategory === 'ALLOW_WITH_CONTROLS'
  ) {
    return 'RED';
  }
  return null;
}

export function decideFinal(input: Readonly<FinalDecisionInput>): Readonly<FinalDecision> {
  const { dvi, compliance, mode, evidenceQuality } = input;

  // طلب مستخدم صريح: نشاط PLANNING (توقّع طقس لوقت بدء لم يحن بعد، لا
  // قراءة جهاز — راجع ACTIVITY_LIVE_MARGIN_MS في dust-engine/engine.ts) لا
  // يجوز أن يُصدر أي قرار إلزامي حقيقي (mandatoryStop=true/غير قابل للتجاوز)
  // مهما بلغت قيم DVI الفيزيائي أو الامتثال المحسوبة من قيم توقّعية (قد
  // تكون مرتفعة/غير واقعية من نموذج طقس عام). فرع مبكر كامل بدل رقع متفرقة
  // وسط منطق LIVE_OPERATIONAL المعقّد أدناه (dvi.mandatoryStop، compliance.
  // decisionCategory، evidenceUnavailable... كلها مصادر مستقلة كان يمكن
  // لأي منها إفلات إيقاف إلزامي رغم isPlanning في evaluateDustCompliance).
  //
  // لكن (طلب مستخدم صريح إضافي — "كيف مسموح وأخضر ومكتوب لا تصلح؟"): اللون/
  // العنوان يجب أن يعكسا فعلياً جودة التوقّع، لا يبقيان أخضر/"مسموح" ثابتَين
  // دائماً بينما النص وحده يحذّر — هذا تناقض بصري مباشر. إذن: تصلح → أخضر/
  // "مسموح"، لا تصلح → أصفر/"تنبيه: أجواء متوقعة غير مناسبة"؛ في كلتا
  // الحالتين mandatoryStop=false/overridable=true دائماً (لا إيقاف إلزامي
  // فعلي على توقّع، مهما كان اللون).
  if (mode === 'PLANNING') {
    // خطأ مكتشَف ومُصلَح — طلب صريح من المستخدم: "ليه ما يقول تنبيه استباقي
    // الأجواء غير المناسبة... اتوقع انه يستثني قاعدة PM10". isFavorable كانت
    // تفحص dvi.decisionCategory (DVI الفيزيائي: رياح/رؤية) فقط، بلا أي فحص
    // لتركيز PM10 المتوقّع — فتوقّع بـPM10=1315 (أضعاف حد المخالفة 340) كان
    // يظهر "مسموح — تشغيل اعتيادي" طالما الرياح/الرؤية جيدتان، لكل الأنشطة
    // (لا خاص بمحطة الخلط). compliance.evidence.pm10UgM3 هو نفس تركيز PM10
    // المتوقّع الذي بنى عليه buildPlanningForecastResult (dust-compliance-
    // engine/engine.ts) نصه التوعوي المطابق — قراءته هنا مباشرة (بدل نص
    // shortReasonAr الهش) يجعل isFavorable يعكس فعلياً DVI + PM10 معاً، مع
    // بقاء decisionCategory=ALLOW/mandatoryStop=false دائماً (لا إيقاف إلزامي
    // على تقدير مهما بلغت القيمة).
    const isPm10Unfavorable =
      compliance?.evidence?.pm10UgM3 !== null &&
      compliance?.evidence?.pm10UgM3 !== undefined &&
      compliance.evidence.pm10UgM3 >= PM10_FORECAST_WARNING_UG_M3;
    const isFavorable =
      (dvi.decisionCategory === 'ALLOW' || dvi.decisionCategory === 'ALLOW_WITH_MONITORING') && !isPm10Unfavorable;
    const result: FinalDecision = {
      snapshotId: input.snapshotId,
      mode,
      operationalDecision: isFavorable ? 'ALLOW' : 'MONITOR',
      regulatoryFinding: 'COMPLIANT',
      mandatoryStop: false,
      overridable: true,
      shortReasonAr: isFavorable
        ? 'تنبيه: هذه توقّعات طقس لوقت بدء النشاط المجدول (لم يبدأ بعد)، لا قراءة جهاز حية — الأجواء المتوقعة تصلح للنشاط. سيتم تفعيل جهاز الرصد وعرض قراءاته الحية قبل ساعتين من موعد البدء.'
        : isPm10Unfavorable
          ? `تنبيه: هذه توقّعات طقس لوقت بدء النشاط المجدول (لم يبدأ بعد)، لا قراءة جهاز حية — تركيز الغبار (PM10) المتوقّع (${compliance!.evidence.pm10UgM3} ميكروجرام/م³) يتجاوز حد التحذير التنظيمي (${PM10_FORECAST_WARNING_UG_M3} ميكروجرام/م³). يُرجى مراجعة توقعات الساعات القادمة قبل البدء. سيتم تفعيل جهاز الرصد وعرض قراءاته الحية قبل ساعتين من موعد البدء.`
          : 'تنبيه: هذه توقّعات طقس لوقت بدء النشاط المجدول (لم يبدأ بعد)، لا قراءة جهاز حية — الأجواء المتوقعة لا تصلح للنشاط، يُرجى مراجعة توقعات الساعات القادمة قبل البدء. سيتم تفعيل جهاز الرصد وعرض قراءاته الحية قبل ساعتين من موعد البدء.',
      decisionLabelAr: isFavorable ? 'مسموح — تشغيل اعتيادي' : 'تنبيه: أجواء متوقعة غير مناسبة',
      level: isFavorable ? 'GREEN' : 'YELLOW',
      pendingConfirmation: false,
      reasonCodes: Object.freeze([]),
      evidenceQuality,
      ruleBundleVersion: input.ruleBundleVersion,
    };
    assertDecisionInvariant(result);
    return Object.freeze(result);
  }

  const complianceMandatory = compliance?.decisionCategory === 'MANDATORY_STOP';
  const complianceStopAffected = compliance?.decisionCategory === 'STOP_AFFECTED_ACTIVITY';
  const complianceBlocks = complianceMandatory || complianceStopAffected;
  // معلَّق = pendingConfirmation === true تحديداً بصرف النظر عن الفئة
  // (MANDATORY_STOP أو STOP_AFFECTED_ACTIVITY كلاهما) — "الحقل هو الحاسم لا
  // الفئة". أي حالة أخرى (بما فيها pendingConfirmation=undefined) مؤكَّدة
  // فوراً بلا حاجة لدليل استمرار — فشل آمن نحو "مؤكَّد" لا "معلَّق" بلا دليل.
  const confirmedAffectedStop = complianceBlocks && compliance?.pendingConfirmation !== true;
  const pendingAffectedStop = complianceBlocks && compliance?.pendingConfirmation === true;

  // الأدلة غير كافية — يُطبَّق فقط في LIVE_OPERATIONAL (PLANNING لا تملك
  // "الآن" ليُطلَب تحقق ميداني منه). STALE تُعامَل معاملة UNAVAILABLE تماماً
  // — قراءة قديمة لا يجوز أن تنتج "آمن الآن" ولا "مخالفة مؤكَّدة الآن".
  const evidenceUnavailable =
    mode === 'LIVE_OPERATIONAL' && (evidenceQuality === 'UNAVAILABLE' || evidenceQuality === 'STALE');

  // هل سبب dvi.mandatoryStop هو PM10 لحظي فقط (لا خطر فيزيائي حقيقي آخر
  // كرؤية حرجة/عاصفة مساهم بنفس اللحظة)؟ يُقرأ الآن من dvi.stopBasis/
  // confirmationState (حقول Typed، القسم 4.4 من "دليل الإصلاح الجذري") بدل
  // مطابقة نص كود قاعدة (DVI-DUST-ACTIVITY-STOP-004-PM10-ONLY) يدوياً.
  const dviMandatoryStopIsPm10Only = dvi.stopBasis === 'PM10' && dvi.confirmationState === 'PENDING';

  // dviPm10StopIsUnreliable: PM10 لحظي فقط + قراءة قديمة/غير متوفرة — إيقاف
  // مبني على بيانات لا يُعتمَد عليها أصلاً. خطر فيزيائي حقيقي (رؤية حرجة/
  // رياح شديدة، dviMandatoryStopIsPm10Only=false) يبقى يفوز فوراً دائماً —
  // لا يعتمد على قراءة PM10 التي قد تكون قديمة.
  const dviPm10StopIsUnreliable = dviMandatoryStopIsPm10Only && evidenceUnavailable;

  // خطأ مكتشَف ومُصلَح (مراجعة كود خارجي — "إيقاف مبني على PM10 قديم يتغلب
  // على HOLD"): dviMandatoryStopIsPm10Only/dviPm10StopIsUnreliable أعلاه
  // تُقرآن من dvi.stopBasis/confirmationState — لكن deriveStopBasisAndConfirmation
  // (dust-engine/engine.ts) تُرجع دائماً stopBasis='NONE'/confirmationState=
  // 'NOT_APPLICABLE' متى كان mandatoryStop=false، وهي بالضبط الحالة التي
  // يمنعها pm10OnlyConfirmable هناك (PM10 لحظي فقط + قراءة قديمة/غير طازجة):
  // mandatoryStop يُضبَط false بنجاح، لكن decisionCategory يبقى
  // STOP_DUST_GENERATING_ACTIVITIES/STOP_VISIBILITY_DEPENDENT_ACTIVITIES رغم
  // ذلك — وdviCandidate أدناه كان يُطابِق تلك الفئة PROTECTIVE_STOP (رتبة 4)
  // بلا أي فحص حداثة خاص بها، فيتغلب على HOLD_FOR_VERIFICATION (رتبة 3) من
  // evidenceCandidate رغم أن السبب الوحيد قراءة PM10 لا يُعتمَد عليها. الحل:
  // قراءة dvi.triggeredRules مباشرة (المصدر الوحيد الذي يبقي التمييز حتى مع
  // mandatoryStop=false) — DVI-DUST-ACTIVITY-STOP-004-PM10-STALE يعني "قاعدة
  // PM10 اللحظي هي من فعّلت STOP_*، والقراءة غير طازجة"، وغياب أي قاعدة خطر
  // فيزيائي مستقل (رؤية حرجة/رياح شديدة+مواد سائبة) يعني عدم وجود سبب آخر
  // يبرر الإيقاف الاحترازي. خطر مستقل حقيقي (رؤية<500م مثلاً) يبقى يفوز
  // فوراً دائماً — لا يُستبعَد لمجرد وجود PM10 قديم مساهماً أيضاً بنفس اللحظة.
  const dviTriggeredRules = dvi.triggeredRules ?? [];
  const dviHasIndependentPhysicalHazard = dviTriggeredRules.some(
    (r) => r.startsWith('DVI-VISIBILITY-') || r === 'DVI-WIND-LOOSE-MATERIAL-005'
  );
  const dviStopIsPm10StaleOnly =
    dviTriggeredRules.includes('DVI-DUST-ACTIVITY-STOP-004-PM10-STALE') && !dviHasIndependentPhysicalHazard;

  // --- محرك المرشحين (Candidates + Strictest) — القسم 4.3 من "دليل
  // الإصلاح الجذري لمنظومة مرقاب": بدل سلسلة if/else هشة (تسمح بتكرار
  // المشكلة عند إضافة فئة DVI/Compliance جديدة بلا تصنيفها)، يُبنى مرشح
  // مستقل من كل مصدر (DVI/Compliance/Evidence/Enclosed-suppression) ثم
  // يُختار الأشد عبر OPERATION_RANK. لا حاجة لـsatisfies Record shape هنا
  // لأن كل مصدر مُعالَج بفرعه الخاص أدناه (لا تعداد شامل لكل DviDecisionCategory
  // بدون معنى تشغيلي — RESTRICT_SEVERE/STOP_* الفيزيائية كلها تُطابَق MONITOR
  // بنفس منطق aei-engine/tables.ts AEI_CAPPING_DVI_DECISIONS، لا MANDATORY_STOP
  // إلا عبر dvi.mandatoryStop المنفصل أدناه).
  interface DecisionCandidate {
    source: 'DVI' | 'COMPLIANCE' | 'EVIDENCE' | 'ENCLOSED_SUPPRESS';
    decision: OperationalDecision;
  }

  // القسم 18.1 من "دليل الإصلاح الجذري لمنظومة مرقاب" (مصفوفة اختبارات
  // القبول) — إصلاح جذري صريح فوق الإصلاح الجزئي السابق (كان يُطابِق كل
  // هذه الفئات MONITOR وحده، معتمداً على compliance وحده لإنتاج RESTICT/
  // PROTECTIVE_STOP حقيقيَّين — تناقض مباشر مع جدول 18.1 الذي يطلب DVI
  // RESTRICT/RESTRICT_SEVERE → RESTRICT مباشرة حتى مع Compliance=ALLOW،
  // وSTOP_DUST_GENERATING_ACTIVITIES/STOP_VISIBILITY_DEPENDENT_ACTIVITIES
  // → PROTECTIVE_STOP غير إلزامي، بلا انتظار أن يكتشف محرك امتثال منفصل
  // نفس الخطر الفيزيائي الذي رصده DVI بالفعل):
  //   RESTRICT/RESTRICT_SEVERE → RESTRICT مباشرة.
  //   STOP_DUST_GENERATING_ACTIVITIES/STOP_VISIBILITY_DEPENDENT_ACTIVITIES
  //   (خطر فيزيائي فعلي بلا mandatoryStop صريح بعد من applyMandatoryGates)
  //   → PROTECTIVE_STOP (إيقاف احترازي غير إلزامي — OPERATION_RANK يضعه
  //   أعلى من RESTRICT، فيفوز حتى مع compliance=ALLOW نظيف).
  //   ALLOW_WITH_MONITORING → MONITOR كما كان (لا تغيير — غير مذكورة في
  //   جدول 18.1 بقيمة مختلفة).
  // خطأ مكتشَف ومُصلَح (راجع تعليق dviStopIsPm10StaleOnly الكامل أعلاه):
  // STOP_DUST_GENERATING_ACTIVITIES/STOP_VISIBILITY_DEPENDENT_ACTIVITIES لا
  // تُطابَق PROTECTIVE_STOP إن كان سببها الوحيد PM10 لحظي غير طازج — تُخفَّض
  // إلى MONITOR (نفس درجة ALLOW_WITH_MONITORING) بدل إسقاطها لـALLOW كاملاً،
  // حتى لا تختفي إشارة "PM10 مرتفع رآه DVI" كلياً؛ evidenceCandidate أدناه
  // (HOLD_FOR_VERIFICATION، رتبة 3) هو من يفوز فعلياً في هذه الحالة بلا
  // منافسة PROTECTIVE_STOP (رتبة 4) المبنية على دليل غير موثوق.
  const dviCandidate: DecisionCandidate = {
    source: 'DVI',
    decision:
      (dvi.decisionCategory === 'STOP_DUST_GENERATING_ACTIVITIES' ||
        dvi.decisionCategory === 'STOP_VISIBILITY_DEPENDENT_ACTIVITIES') &&
      !dviStopIsPm10StaleOnly
        ? 'PROTECTIVE_STOP'
        : dvi.decisionCategory === 'RESTRICT' || dvi.decisionCategory === 'RESTRICT_SEVERE'
          ? 'RESTRICT'
          : dvi.decisionCategory === 'ALLOW_WITH_MONITORING' || dviStopIsPm10StaleOnly
            ? 'MONITOR'
            : 'ALLOW',
  };

  // خطأ مكتشَف ومُصلَح (مراجعة خبير خارجي — "التحقق الميداني ما زال يتحول
  // إلى مراقبة"): compliance.decisionCategory==='FIELD_VERIFICATION_
  // REQUIRED' كان يُطابَق MONITOR هنا — نفس مستوى الاحتراز العادي
  // (ALLOW_WITH_CONTROLS/PRECAUTION)، رغم أن اسم الفئة نفسه يقول صراحة
  // "يتطلب تحقق ميداني قبل الاستمرار" (نفس دلالة HOLD_FOR_VERIFICATION
  // بالضبط — نقص بيانات مشروع/موقع حرجة، لا مجرد تحذير تشغيلي أخف).
  // OPERATION_RANK يضع HOLD_FOR_VERIFICATION (3) أعلى بكثير من MONITOR (1)
  // عمداً — القرار السابق كان يُخفي هذا النقص خلف نص احترازي عادي بدل
  // إيقاف اعتماد القرار حتى يُستكمَل التحقق الميداني المطلوب فعلياً.
  const complianceCandidate: DecisionCandidate = {
    source: 'COMPLIANCE',
    decision: !compliance
      ? 'ALLOW'
      : confirmedAffectedStop
        ? 'MANDATORY_STOP'
        : pendingAffectedStop
          ? 'PROTECTIVE_STOP'
          : compliance.decisionCategory === 'RESTRICT_ACTIVITY'
            ? 'RESTRICT'
            : compliance.decisionCategory === 'FIELD_VERIFICATION_REQUIRED'
              ? 'HOLD_FOR_VERIFICATION'
              : compliance.decisionCategory === 'ALLOW_WITH_CONTROLS' || compliance.decisionCategory === 'PRECAUTION'
                ? 'MONITOR'
                : 'ALLOW',
  };

  // dvi.mandatoryStop (خطر فيزيائي فوري — رؤية حرجة/عاصفة، أو PM10 لحظي مع
  // الشرط الفرعي المزدوج) أرضية مطلقة — يُستثنى فقط في حالتين: (1)
  // pendingAffectedStop=true (محرك الامتثال قرر صراحة أن السبب معلَّق)، أو
  // (2) PM10 لحظي فقط + evidenceUnavailable (بيانات قديمة/غير متوفرة).
  const dviMandatoryCandidate: DecisionCandidate = {
    source: 'DVI',
    decision:
      dvi.mandatoryStop === true && !pendingAffectedStop && !dviPm10StopIsUnreliable ? 'MANDATORY_STOP' : 'ALLOW',
  };

  const evidenceCandidate: DecisionCandidate = {
    source: 'EVIDENCE',
    decision: evidenceUnavailable ? 'HOLD_FOR_VERIFICATION' : 'ALLOW',
  };

  // محرك DVI الفيزيائي لا يعرف مفهوم "العملية المغلقة" إطلاقاً. القمع هنا
  // محصور بحالة dvi.decisionCategory==='ALLOW_WITH_MONITORING' تحديداً (لا
  // أي قرار DVI آخر) — RESTRICT_SEVERE/STOP_* بسبب رؤية فيزيائية حقيقية لا
  // علاقة لها بالرياح لا تُقمَع أبداً (بروتوكول الملحق أ يُعفي العمليات
  // المغلقة من بوابة الرياح تحديداً، لا من كل خطر فيزيائي آخر). يُطبَّق فقط
  // إن لم يكن هناك mandatoryStop أصلاً (محسوبة من dviMandatoryCandidate
  // نفسه أدناه بعد اختيار الأشد، فلا حاجة لحسابها هنا مسبقاً).
  const suppressDviMonitoring =
    compliance?.isEnclosedOperation === true &&
    compliance.decisionCategory === 'ALLOW' &&
    dvi.decisionCategory === 'ALLOW_WITH_MONITORING';

  const candidates: DecisionCandidate[] = [dviCandidate, complianceCandidate, dviMandatoryCandidate, evidenceCandidate];
  if (suppressDviMonitoring) {
    // استبعاد مرشح DVI (ALLOW_WITH_MONITORING→MONITOR) من الاختيار عندما
    // النشاط مغلق فعلياً وامتثاله نظيف — لا يجوز لأي مصدر آخر (compliance/
    // evidence) أن "يُخفي" هذا الاستبعاد لاحقاً، لذا يُستبعد المرشح نفسه بدل
    // تخفيف النتيجة بعد اختيار الأشد.
    candidates[0] = { source: 'DVI', decision: 'ALLOW' };
  }

  const winner = candidates.reduce((strictest, current) =>
    OPERATION_RANK[current.decision] > OPERATION_RANK[strictest.decision] ? current : strictest
  );
  const operationalDecision = winner.decision;
  const mandatoryStop = operationalDecision === 'MANDATORY_STOP';

  let regulatoryFinding: RegulatoryFinding;
  if (confirmedAffectedStop) {
    regulatoryFinding = 'NON_COMPLIANT';
  } else if (pendingAffectedStop) {
    regulatoryFinding = 'PENDING_CONFIRMATION';
  } else if (evidenceUnavailable || compliance?.decisionCategory === 'FIELD_VERIFICATION_REQUIRED') {
    // FIELD_VERIFICATION_REQUIRED (نقص بيانات مشروع/موقع حرجة يمنع الحكم —
    // راجع complianceCandidate أعلاه) نفس دلالة evidenceUnavailable تماماً:
    // لا يمكن الحكم بامتثال أو مخالفة قبل تحقق ميداني فعلي، فلا يجوز أن
    // يبقى regulatoryFinding=COMPLIANT بينما operationalDecision=
    // HOLD_FOR_VERIFICATION في نفس النتيجة (تناقض مباشر بين حقلين).
    regulatoryFinding = 'NOT_DETERMINABLE';
  } else {
    // compliance غائب أصلاً (مثال: PLANNING بلا سياق امتثال كامل) يُعامَل
    // كـCOMPLIANT بفشل آمن — لا يجوز الإبلاغ عن مخالفة بلا محرك امتثال
    // شغَّال فعلياً قيّمها.
    regulatoryFinding = 'COMPLIANT';
  }

  const overridable = !mandatoryStop && (compliance ? compliance.canOverride === true : dvi.overridable === true);

  // shortReasonAr/decisionLabelAr: يجب أن يطابقا المرشح الفائز فعلياً
  // (winner.source)، لا فحصاً منفصلاً عن حالة compliance وحدها.
  //
  // خطأ مكتشَف ومُصلَح (مراجعة خبير خارجي — البند 2: "سبب القرار المعروض لا
  // يرتبط دائمًا بالمرشح الفائز"): الشرط السابق كان
  // `compliance.decisionCategory !== 'ALLOW'` بمعزل تام عن نتيجة
  // candidates.reduce() أعلاه — فلو فاز DVI فعلياً بقرار أشد (مثال:
  // PROTECTIVE_STOP، رتبة 4) بينما compliance في نفس اللحظة غير-ALLOW لكن
  // أضعف (مثال: PRECAUTION→MONITOR، رتبة 1 فقط)، كان الشرط يتحقق رغم أن
  // COMPLIANCE لم يفز بشيء، فيعرض نص/عنوان compliance الأضعف بدل نص DVI الذي
  // يفسر القرار الفعلي — يفسد قابلية التدقيق حتى مع operationalDecision
  // صحيح.
  //
  // الإصلاح: مقارنة رتبة complianceCandidate مباشرةً بالفائز الفعلي
  // (OPERATION_RANK[complianceCandidate.decision] >=
  // OPERATION_RANK[operationalDecision]) بدل الاعتماد على winner.source
  // نفسه — التعادل على الرتبة (compliance بنفس شدة DVI تماماً) يجب أن يبقى
  // لصالح نص compliance (الاتفاقية القديمة الموروثة من
  // computeUnifiedActivityDecision: نص القاعدة التنظيمية الفعلية يُفضَّل
  // على نص DVI الفيزيائي العام كلما تساويا في الشدة)، بينما candidates.reduce
  // أعلاه يبقي أول عنصر (dviCandidate) عند التعادل لأغراض اختيار
  // operationalDecision نفسه فقط — لا علاقة لذلك باختيار النص المعروض.
  //
  // mandatoryStop من DVI وحده (بلا مساهمة امتثال) يستخدم نص DVI لأنه السبب
  // الفعلي حينها.
  //
  // evidenceUnavailable (HOLD_FOR_VERIFICATION) يجب أن يعرض نصاً/لوناً
  // محايدَين يعكسان "البيانات غير كافية للحكم" صراحةً — لا نص/لون DVI أو
  // الامتثال المحسوبَين أصلاً من نفس القراءة القديمة/الناقصة (وإلا ظهر
  // "مسموح — تشغيل اعتيادي" أخضر أو "تقييد" أحمر بثقة كاملة رغم أن مصدره
  // بيانات لا يُعتمَد عليها، وهو بالضبط الخلل الذي صُحِّح بإضافة STALE لهذا
  // الشرط أعلاه). يُفحَص بعد mandatoryStop/pendingAffectedStop (يبقيان
  // الأولوية القصوى — خطر فيزيائي فعلي أو إيقاف امتثال معلَّق يفوزان حتى مع
  // بيانات قديمة)، وقبل أي نص/لون مشتق من DVI/الامتثال العاديين.
  const complianceIsDecisive =
    !!compliance &&
    compliance.decisionCategory !== 'ALLOW' &&
    OPERATION_RANK[complianceCandidate.decision] >= OPERATION_RANK[operationalDecision];
  const shortReasonAr = evidenceUnavailable
    ? 'تعذّر اعتماد قرار واثق: بيانات القراءة الحالية قديمة أو غير متوفرة — يتطلب تحقق ميداني قبل الاستمرار.'
    : complianceIsDecisive
      ? compliance!.shortReasonAr
      : suppressDviMonitoring
        ? compliance?.shortReasonAr || ''
        : dvi.shortReason || '';
  const decisionLabelAr = mandatoryStop
    ? 'إيقاف إلزامي نظامي'
    : pendingAffectedStop
      ? 'إيقاف مؤقت (معلَّق) — بانتظار التأكيد'
      : evidenceUnavailable
        ? 'بانتظار تحقق ميداني — بيانات غير كافية'
        : complianceIsDecisive
          ? compliance!.decisionLabelAr
          : suppressDviMonitoring
            ? 'مسموح — تشغيل اعتيادي'
            : dvi.decisionLabelAr;

  // level: نفس منطق floorLevel القديم — لا يُخفَّض DVI لو كان هو الأشد
  // أصلاً، فقط يُرفَع لحد أدنى حين يكون الامتثال هو الأشد. pendingAffectedStop
  // (معلَّق بانتظار تأكيد) يفرض RED دائماً بصرف النظر عن شدة DVI — عقد قديم
  // صريح (راجع unifiedDecision.test.ts): يميّز "معلَّق مؤقت" (أحمر) عن
  // "إيقاف مؤكَّد" (أسود) بلون مختلف تماماً، لا مجرد حد أدنى قابل للتجاوز
  // بشدة DVI الفيزيائية. evidenceUnavailable يفرض ORANGE (تنبيهي محايد — لا
  // أخضر "آمن" ولا أحمر/أسود "خطر مؤكَّد" لا يملك المحرك دليلاً كافياً عليه).
  const dviLevel = LEVEL_BY_DVI[dvi.level] ?? 'GREEN';
  const floorLevel = complianceIsDecisive ? complianceFloorLevel(compliance!.decisionCategory) : null;
  const level = mandatoryStop
    ? 'BLACK'
    : pendingAffectedStop
      ? 'RED'
      : evidenceUnavailable
        ? 'ORANGE'
        : suppressDviMonitoring
          ? 'GREEN'
          : floorLevel && LEVEL_WEIGHT[dviLevel] < LEVEL_WEIGHT[floorLevel]
            ? floorLevel
            : dviLevel;

  // دفاعي عمداً (?? []) — بعض المستهلكين التاريخيين يبنون كائن compliance
  // جزئياً (decisionCategory/shortReasonAr فقط، بلا triggeredRules)، نفس
  // سبب الدفاع في deriveEvidenceQuality (adapters.ts).
  const reasonCodes: string[] = [...(dvi.triggeredRules ?? [])];
  if (compliance) reasonCodes.push(...(compliance.triggeredRules ?? []).map((rule) => rule.code));
  if (evidenceUnavailable) reasonCodes.push('DATA_STALE_OR_UNAVAILABLE');

  // خطأ معماري حرج مكتشَف ومُصلَح (مراجعة خبير خارجي — "القرار المعروض قد
  // يختلف عن القرار المحفوظ": decideFinal تستقبل input.aei صراحة لكن لم تكن
  // تقرأه إطلاقاً — الدمج الفعلي (AEI أشد من DVI/الامتثال يستبدل level/نص
  // العرض) كان يحدث فقط في computeUnifiedActivityDecision (dustEvaluation.ts)
  // حياً وقت العرض، بلا أي انعكاس على النتيجة المخزَّنة في final_decisions
  // عبر persistFinalDecisions. فيبقى المخزَّن (وأي مسار يقرأه مباشرة —
  // fetchLatestFinalDecisions، summaryFromStoredDecision، dashboard/global،
  // alerts/generate) أخفّ دائماً مما تعرضه أي شاشة تحسب computeUnifiedActivityDecision
  // حياً لنفس النشاط في نفس اللحظة — بالضبط التناقض الذي وصفه التقرير
  // (ALLOW/GREEN محفوظ مقابل MONITOR/YELLOW معروض). الإصلاح: نفس منطق الدمج
  // بالضبط (لا تغيير سلوكي) يُنقَل إلى هنا — المصدر الوحيد — بدل طبقة لاحقة
  // منفصلة؛ computeUnifiedActivityDecision تُبسَّط لاحقاً لتصبح غلافاً رقيقاً
  // بلا أي دمج AEI خاص بها (راجع تعليقها).
  //
  // نفس الاستثناءات المطبَّقة سابقاً هناك بالضبط: PLANNING مستبعدة أصلاً
  // (فرع مبكر منفصل أعلى الدالة، aei لا يصل هذه النقطة في وضعها)، وmandatoryStop/
  // pendingConfirmation يبقيان الأولوية القصوى بصرف النظر عن AEI (خطر فيزيائي
  // مؤكَّد أو إيقاف امتثال معلَّق لا يجوز أن "يُخفَّفا" بتقييم AEI الإرشادي).
  const aeiIsMoreSevere =
    !!input.aei && !mandatoryStop && !pendingAffectedStop && LEVEL_WEIGHT[input.aei.color] > LEVEL_WEIGHT[level];

  const result: FinalDecision = {
    snapshotId: input.snapshotId,
    mode,
    operationalDecision,
    regulatoryFinding,
    mandatoryStop,
    overridable,
    shortReasonAr: aeiIsMoreSevere ? input.aei!.shortReasonAr : shortReasonAr,
    decisionLabelAr: aeiIsMoreSevere ? input.aei!.statusLabelAr : decisionLabelAr,
    level: aeiIsMoreSevere ? input.aei!.color : level,
    pendingConfirmation: pendingAffectedStop,
    reasonCodes: Object.freeze(reasonCodes),
    evidenceQuality,
    ruleBundleVersion: input.ruleBundleVersion,
  };

  assertDecisionInvariant(result);
  return Object.freeze(result);
}

// خطأ مكتشَف ومُصلَح (مراجعة كود خبير خارجي — "النظام يختار أول صف بدل
// أسوأ قرار"): dashboard/global وviewer/dashboard كانا يختاران "أول نشاط
// جارٍ يُعثر عليه" لكل مشروع (أول صف في نتيجة الاستعلام، بلا أي ORDER BY
// على الترتيب الفعلي) لتلوين نقطة الخريطة، بدل تقييم كل الأنشطة الجارية
// فعلياً في نفس اللحظة واختيار أسوأها. مشروع فيه نشاطان جاريان معاً (نشاط
// آمن + نشاط موقوف إلزامياً) كان قد يظهر أخضر بالكامل لو صادف ترتيب صف
// المشروع الآمن أولاً — ترتيب قاعدة بيانات غير مضمون البتة عبر استعلامات
// مختلفة، فالنتيجة كانت تعتمد فعلياً على الحظ.
//
// FINAL_RANK/pickWorstDecision هما المصدر الوحيد المسموح له باختيار "أسوأ
// قرار" بين عدة قرارات نهائية لنفس المشروع — أي مسار يحتاج "حالة تمثيلية
// واحدة" من عدة أنشطة جارية يستدعي هذه الدالة، لا يأخذ rows[0]/أول عنصر
// من نتيجة استعلام مباشرة.
const FINAL_RANK: Record<OperationalDecision, number> = {
  ALLOW: 0,
  MONITOR: 1,
  RESTRICT: 2,
  HOLD_FOR_VERIFICATION: 3,
  PROTECTIVE_STOP: 4,
  MANDATORY_STOP: 5,
};

// خطأ مكتشَف ومُصلَح (مراجعة كود خبير خارجي — H-08: "لا Candidate Engine أو
// حسم تعادل ثابت"): كانت pickWorstDecision تحسم التعادل (operationalDecision
// متطابق بين صفين) بإبقاء العنصر الأول الوارد (worst الابتدائي = rows[0]،
// reduce يستبدل فقط بشرط `>` صارم لا `>=`) — أي أن ترتيب الصفوف الوارد من
// الاستعلام (غير مضمون البتة، نفس العلة التي أُصلحت في dashboard/global/
// viewer/dashboard سابقاً) يحدد "أيهما يمثّل المشروع" عند تعادل الشدة
// التشغيلية، بلا معيار حسم واضح. الإصلاح: عند تعادل operationalDecision،
// تُقارَن level (اللون — أشد لوناً يفوز)، ثم mandatoryStop (true يفوز على
// false)، ثم !pendingConfirmation (مؤكَّد يفوز على معلَّق)، وأخيراً
// shortReasonAr/decisionLabelAr (ترتيب معجمي ثابت) كحسم أخير مضمون بصرف
// النظر عن أي بيانات — فلا يبقى أي تعادل يعتمد على ترتيب الاستعلام. تقتصر
// المعايير على الحقول الموجودة فعلياً في كل مستهلكي هذه الدالة (dashboard/
// global، viewer/dashboard يبنيان finalDecision جزئياً من صف final_decisions
// المخزَّن، بلا evidenceQuality/evaluatedAt/snapshotId) — لا افتراض حقول
// قد تكون undefined فعلياً عند الاستدعاء الحقيقي.
// شكل أدنى يكفي المقارنة فعلياً — راجع التعليق أعلاه: dashboard/global
// وviewer/dashboard يبنيان finalDecision جزئياً من صف final_decisions
// مخزَّن، بلا evidenceQuality/evaluatedAt/snapshotId/regulatoryFinding/
// overridable/reasonCodes/ruleBundleVersion/mode. الاسم الكامل FinalDecision
// يبقى النوع الحقيقي المستخدَم في decideFinal نفسه؛ هذا فقط توثيق صريح لما
// تقرأه compareDecisionSeverity/pickWorstDecision تحديداً.
type ComparableFinalDecision = Pick<
  FinalDecision,
  'operationalDecision' | 'level' | 'mandatoryStop' | 'pendingConfirmation' | 'shortReasonAr' | 'decisionLabelAr'
>;

function compareDecisionSeverity(a: ComparableFinalDecision, b: ComparableFinalDecision): number {
  const rankDiff = FINAL_RANK[a.operationalDecision] - FINAL_RANK[b.operationalDecision];
  if (rankDiff !== 0) return rankDiff;

  const levelDiff = LEVEL_WEIGHT[a.level] - LEVEL_WEIGHT[b.level];
  if (levelDiff !== 0) return levelDiff;

  const mandatoryStopDiff = Number(a.mandatoryStop) - Number(b.mandatoryStop);
  if (mandatoryStopDiff !== 0) return mandatoryStopDiff;

  const confirmedDiff = Number(!a.pendingConfirmation) - Number(!b.pendingConfirmation);
  if (confirmedDiff !== 0) return confirmedDiff;

  // حسم أخير مضمون بصرف النظر عن أي بيانات — ترتيب معجمي ثابت، لا يعتمد
  // على ترتيب الاستعلام إطلاقاً. shortReasonAr/decisionLabelAr موجودان
  // دائماً (نصان غير فارغين) على عكس أي معرّف اختياري.
  const aKey = `${a.shortReasonAr}|${a.decisionLabelAr}`;
  const bKey = `${b.shortReasonAr}|${b.decisionLabelAr}`;
  return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
}

export function pickWorstDecision<T extends { finalDecision: ComparableFinalDecision }>(rows: readonly T[]): T {
  if (rows.length === 0) {
    throw new Error('pickWorstDecision: cannot select from an empty list');
  }
  return rows.reduce((worst, current) =>
    compareDecisionSeverity(current.finalDecision, worst.finalDecision) > 0 ? current : worst
  );
}
