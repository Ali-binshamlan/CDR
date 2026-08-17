// =============================================================
// Final Decision Engine — Core
// decideFinal: الدالة الوحيدة المسموح لها بقراءة dvi.mandatoryStop و
// compliance.decisionCategory معاً وإنتاج قرار نهائي. دالة نقية بلا I/O —
// تستهلك نتائج DVI/الامتثال/AEI الجاهزة فقط (قراءة، بلا إعادة حساب لأي
// منها)، بنفس مبدأ evaluateDustCompliance في dust-compliance-engine.
// راجع types.ts للسياق الكامل حول سبب وجود هذا الملف.
// =============================================================

import type { FinalDecision, FinalDecisionInput, OperationalDecision, RegulatoryFinding } from './types';
import type { AeiStatus } from '@/app/utils/aei-engine/types';
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
  //
  // خطأ معماري حرج مكتشَف ومُصلَح (مراجعة كود خارجي — P0: "FinalDecisionEngine
  // قد يعيد إيقاف النشاط عند الدقيقتين"): كان يُستخدَم سابقاً هنا فقط لبناء
  // dviPm10StopIsUnreliable (استبعاد جزئي: بيانات قديمة فقط) — الإصلاح
  // الآن يستبعد dviMandatoryStopIsPm10Only بالكامل من dviMandatoryCandidate
  // أدناه (راجع تعليقه الكامل)، فـdviPm10StopIsUnreliable أصبحت زائدة
  // منطقياً (أي حالة كانت تحققها كانت أصلاً subset من dviMandatoryStopIsPm10Only)
  // وحُذفت — لا تغيير سلوكي على dviStopIsPm10StaleOnly (متغيّر منفصل تماماً،
  // يبني dviCandidate العادي، لا يتأثر بهذا الحذف).
  const dviMandatoryStopIsPm10Only = dvi.stopBasis === 'PM10' && dvi.confirmationState === 'PENDING';

  // خطأ مكتشَف ومُصلَح (مراجعة كود خارجي — "إيقاف مبني على PM10 قديم يتغلب
  // على HOLD"): dviMandatoryStopIsPm10Only أعلاه
  // تُقرأ من dvi.stopBasis/confirmationState — لكن deriveStopBasisAndConfirmation
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
  //
  // خطأ مكتشَف ومُصلَح (مراجعة كود خارجي — "سبب القرار قد لا يشرح القرار
  // الفائز"): reasonAr/labelAr/level كانت تُحسَب بسلسلة شروط ثانية منفصلة
  // تماماً عن اختيار operationalDecision (winner من candidates.reduce) —
  // فحص evidenceUnavailable أولاً وبلا شرط في تلك السلسلة كان يعني أن أي
  // نشاط بـPM10 قديم (evidenceQuality=STALE) يعرض دائماً "بيانات قديمة" حتى
  // لو كان الفائز الفعلي مرشحاً آخر تماماً (مثال: رؤية 499م تُنتج
  // dviMandatoryCandidate=MANDATORY_STOP، رتبته 5، تفوز على HOLD_FOR_
  // VERIFICATION رتبة 3 من evidenceCandidate — لكن النص المعروض كان لا يزال
  // "تعذّر اعتماد قرار واثق: بيانات قديمة" بدل ذكر الرؤية إطلاقاً). الإصلاح:
  // كل مرشح يحمل الآن reasonAr/labelAr/level الخاصة به مباشرة — القيم
  // المعروضة تُقرأ من نفس المرشح الفائز حصراً (winner.reasonAr/labelAr/level)،
  // لا من إعادة حساب منفصلة بعد اختيار الفائز.
  interface DecisionCandidate {
    source: 'DVI' | 'COMPLIANCE' | 'EVIDENCE' | 'ENCLOSED_SUPPRESS' | 'AEI';
    decision: OperationalDecision;
    reasonAr: string;
    labelAr: string;
    level: FinalDecision['level'];
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
  // محرك DVI الفيزيائي لا يعرف مفهوم "العملية المغلقة" إطلاقاً. القمع هنا
  // محصور بحالة dvi.decisionCategory==='ALLOW_WITH_MONITORING' تحديداً (لا
  // أي قرار DVI آخر) — RESTRICT_SEVERE/STOP_* بسبب رؤية فيزيائية حقيقية لا
  // علاقة لها بالرياح لا تُقمَع أبداً. compliance?.isEnclosedOperation===true
  // وحدها لا تعني بالضرورة إعفاءً فعلياً من بوابة الرياح (خطأ توثيقي سابق
  // مُصلَح — طلب صريح من المستخدم: "استثناء الرياح للنشاط المغلق مختلف بين
  // المحرك والكتالوج التنظيمي"؛ الإعفاء الفعلي في engine.ts مقصور حصراً على
  // BATCHING_PLANT بشرطيه) — لكن الشرط المزدوج هنا (isEnclosedOperation
  // **و** decisionCategory==='ALLOW' معاً) آمن رغم ذلك: أي نشاط مغلق غير
  // معفى فعلياً من بوابة الرياح يُوقَف بالفعل (STOP_AFFECTED_ACTIVITY لا
  // ALLOW) عبر engine.ts، فـcompliance.decisionCategory لن يكون ALLOW في
  // تلك الحالة أصلاً — هذا القمع لا يُفعَّل خطأً لنشاط موقوف فعلياً. محسوبة هنا
  // (قبل بناء dviCandidate مباشرة، لا بعده) وتُطبَّق داخل dviCandidate نفسه
  // (decision/reasonAr/labelAr/level معاً) — لا استبدال منفصل للمصفوفة بعد
  // البناء كما كان سابقاً، فلا تنسى أي حقل جديد يُضاف مستقبلاً هذا القمع.
  const suppressDviMonitoring =
    compliance?.isEnclosedOperation === true &&
    compliance.decisionCategory === 'ALLOW' &&
    dvi.decisionCategory === 'ALLOW_WITH_MONITORING';

  // dviLevel (لون DVI الفيزيائي الخام، بعد قمع العملية المغلقة إن انطبق) —
  // يُستهلَك من dviCandidate مباشرة، ومن complianceCandidate أدناه أيضاً
  // (floorLevel التنظيمي يُقارَن بلون DVI دائماً، بصرف النظر عن أي مرشح فاز).
  const dviLevel = suppressDviMonitoring ? 'GREEN' : LEVEL_BY_DVI[dvi.level] ?? 'GREEN';
  // خطأ حرج مكتشَف ومُصلَح (طلب صريح من المستخدم — مراجعة كود خبير خارجي،
  // الملاحظة #8: "FinalDecisionEngine يرسخ هذا الإيقاف — تغيير الاسم من
  // MANDATORY_STOP إلى PROTECTIVE_STOP لا يحل المشكلة"): الإصلاح السابق
  // (الملاحظة الأصلية P0) استبعد dviMandatoryStopIsPm10Only من
  // dviMandatoryCandidate وحده — لكن dviCandidate هنا مرشِّح منفصل تماماً
  // يُبنى مباشرة من dvi.decisionCategory (STOP_DUST_GENERATING_ACTIVITIES/
  // STOP_VISIBILITY_DEPENDENT_ACTIVITIES)، بلا أي فحص لـdvi.mandatoryStop
  // نفسه — كان يستبعد فقط الحالة القديمة (dviStopIsPm10StaleOnly، قراءة
  // PM10 غير طازجة)، لا حالة PM10 الطازجة المعلَّقة (dviMandatoryStopIsPm10Only،
  // mandatoryStop=true فعلياً، stopBasis=PM10، confirmationState=PENDING).
  // النتيجة: نفس سيناريو الإصلاح السابق بالضبط (PM10=350 لمدة 2-30 دقيقة،
  // بلا خطر فيزيائي آخر) كان لا يزال يفوز بـPROTECTIVE_STOP (رتبة 4، ثاني
  // أعلى رتبة بعد MANDATORY_STOP) عبر هذا المرشح البديل — وPROTECTIVE_STOP
  // يُترجَم في finalDecisionStatus.ts إلى status='stopped' تماماً مثل
  // MANDATORY_STOP (كلاهما يُعامَلان كإيقاف في التقارير/الواجهة)، فتغيير
  // الاسم وحده لم يكن يحل المشكلة الفعلية للمستخدم كما وصف بدقة.
  //
  // الإصلاح: استبعاد dviMandatoryStopIsPm10Only أيضاً هنا، بجانب
  // dviStopIsPm10StaleOnly القديمة — يغطي الآن كامل نطاق "PM10 وحده هو
  // السبب" بصرف النظر عن حداثة القراءة (الحالتان متكاملتان لا متداخلتان:
  // dviMandatoryStopIsPm10Only تشترط mandatoryStop=true فعلياً — deriveStop
  // BasisAndConfirmation في dust-engine/engine.ts تُرجع stopBasis='NONE'
  // دائماً إن كان mandatoryStop=false، فلا يمكن أن تتحقق الحالتان معاً لنفس
  // dvi). لا يؤثر على MIXED (خطر فيزيائي مستقل حقيقي، stopBasis≠'PM10')
  // ولا على WIND (DVI-WIND-LOOSE-MATERIAL-005) — كلاهما يبقيان يُوقفان
  // كالمعتاد، تحققتُ عبر اختبارات هذا الملف.
  const dviMandatoryCategoryIsPm10Only = dviStopIsPm10StaleOnly || dviMandatoryStopIsPm10Only;
  const dviCandidate: DecisionCandidate = {
    source: 'DVI',
    decision: suppressDviMonitoring
      ? 'ALLOW'
      : (dvi.decisionCategory === 'STOP_DUST_GENERATING_ACTIVITIES' ||
          dvi.decisionCategory === 'STOP_VISIBILITY_DEPENDENT_ACTIVITIES') &&
        !dviMandatoryCategoryIsPm10Only
        ? 'PROTECTIVE_STOP'
        : dvi.decisionCategory === 'RESTRICT' || dvi.decisionCategory === 'RESTRICT_SEVERE'
          ? 'RESTRICT'
          : dvi.decisionCategory === 'ALLOW_WITH_MONITORING' || dviMandatoryCategoryIsPm10Only
            ? 'MONITOR'
            : 'ALLOW',
    // نص/لون 'مسموح — تشغيل اعتيادي'/GREEN عند القمع يطابقان حرفياً ما كانت
    // الشروط المنفصلة القديمة (suppressDviMonitoring ? ...) تُنتجه.
    reasonAr: suppressDviMonitoring ? compliance?.shortReasonAr || '' : dvi.shortReason || '',
    labelAr: suppressDviMonitoring ? 'مسموح — تشغيل اعتيادي' : dvi.decisionLabelAr,
    level: dviLevel,
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
  // مستوى مرشح الامتثال: confirmedAffectedStop يفرض BLACK وpendingAffectedStop
  // يفرض RED (عقد قديم صريح — راجع unifiedDecision.test.ts: "معلَّق مؤقت"
  // أحمر مقابل "إيقاف مؤكَّد" أسود بلون مختلف تماماً، لا حداً أدنى قابلاً
  // للتجاوز). غير ذلك: floorLevel (complianceFloorLevel) يرفع الحد الأدنى
  // فوق dviLevel الخام دون خفضه أبداً — نفس منطق floorLevel القديم بالضبط،
  // محسوب الآن هنا مباشرة مع المرشح نفسه بدل إعادة اشتقاقه بعد اختيار الفائز.
  const complianceFloor = compliance ? complianceFloorLevel(compliance.decisionCategory) : null;
  const complianceLevel: FinalDecision['level'] = confirmedAffectedStop
    ? 'BLACK'
    : pendingAffectedStop
      ? 'RED'
      : complianceFloor && LEVEL_WEIGHT[dviLevel] < LEVEL_WEIGHT[complianceFloor]
        ? complianceFloor
        : dviLevel;
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
    reasonAr: confirmedAffectedStop
      ? compliance!.shortReasonAr
      : pendingAffectedStop
        ? compliance!.shortReasonAr
        : compliance?.shortReasonAr || '',
    // خطأ صياغة مكتشَف ومُصلَح (طلب صريح من المستخدم — رأى "إيقاف مؤقت
    // (معلَّق)" على الشاشة رغم mandatory_stop=false فعلياً/AEI يبقى RESTRICT
    // أحمر لا CLOSED أسود؛ لا إيقاف تشغيلي حقيقي في هذه المرحلة إطلاقاً —
    // فقط نافذة تأكيد دقيقتين قبل تسجيل مخالفة توثيقية بلا إيقاف، تماماً
    // كما يوضّح النص التوضيحي الموجود أصلاً بجانبها في الواجهة). كلمة
    // "إيقاف" في هذه اللافتة كانت تُوهِم بإيقاف فعلي قبل أي تأكيد — لا يجوز
    // أن تحمل هذه الحالة تحديداً كلمة "إيقاف" إطلاقاً.
    labelAr: confirmedAffectedStop
      ? 'إيقاف إلزامي نظامي'
      : pendingAffectedStop
        ? 'تحذير مبدئي — تحت المراقبة (بانتظار تأكيد الاستمرار)'
        : compliance?.decisionLabelAr || '',
    level: complianceLevel,
  };

  // خطأ معماري حرج مكتشَف ومُصلَح (مراجعة كود خارجي — P0: "FinalDecisionEngine
  // قد يعيد إيقاف النشاط عند الدقيقتين"): dvi.mandatoryStop لمشغِّل PM10
  // وحده (dust-engine/engine.ts: pm10OnlyConfirmable) محكوم فقط بحداثة
  // القراءة (pm10ReadingIsFreshEnoughForImmediateStop، ≤4 دقائق تقريباً) —
  // لا معرفة إطلاقاً بمنطق استمرار الدقيقتين/30 دقيقة الذي يعيش حصراً في
  // computeSustainedPm10Status (dustEvaluation.ts)/محرك الامتثال. فيبقى
  // dvi.mandatoryStop=true بلا انتهاء صلاحية طالما القراءة تتجدد فوق 340 —
  // في الدقيقة 3 (بعد تأكيد الدقيقتين، قبل اكتمال 30 دقيقة)، محرك الامتثال
  // يتحوّل بحق لـALLOW_WITH_CONTROLS (توثيق مخالفة بلا إيقاف — راجع
  // pm10ThresholdRule)، فـpendingAffectedStop يصبح false (الامتثال لم يعد
  // "محظوراً" أصلاً، لا لأنه "تأكَّد وسُمح باستمراره") — الحارسان
  // pendingAffectedStop (الحارس الوحيد سابقاً) لا يغطي هذه النافذة
  // (2-30 دقيقة) بالتحديد، فكان dviMandatoryCandidate يفوز بـMANDATORY_STOP
  // مباشرة رغم أن محرك الامتثال (المصدر الرسمي الوحيد لقرار PM10 حسب
  // المعمارية) يقول صراحة "استمر تحت الضوابط، لا إيقاف بعد".
  //
  // الإصلاح: dviMandatoryStopIsPm10Only (سبب PM10 وحده، بلا خطر فيزيائي
  // مستقل مساهم — stopBasis='PM10' حصراً، لا 'MIXED') تُستبعَد بالكامل من
  // هذا المرشح الآن، لا فقط في نافذتي (0-2 دقيقة)/(بيانات قديمة). الإيقاف
  // الرسمي لـPM10 يأتي حصراً من complianceCandidate (RCRC-PM10-30M-
  // SUSPENSION-012 بعد 30 دقيقة فعلية — confirmedAffectedStop يفوز هناك
  // بشكل صحيح تماماً، فلا فقدان لأي إيقاف حقيقي مستحق). خطر فيزيائي حقيقي
  // مستقل (رؤية حرجة/رياح شديدة، بما فيه MIXED مع PM10 معاً) لا يتأثر
  // إطلاقاً — dviMandatoryStopIsPm10Only أصلاً false لتلك الحالات (تشترط
  // stopBasis==='PM10' حصراً)، فيبقى DVI قادراً على الإيقاف المستقل الفوري
  // كما يجب — نفس فصل DVI عن محرك الامتثال الذي تنص عليه المعمارية.
  const dviMandatoryCandidate: DecisionCandidate = {
    source: 'DVI',
    decision:
      dvi.mandatoryStop === true && !pendingAffectedStop && !dviMandatoryStopIsPm10Only ? 'MANDATORY_STOP' : 'ALLOW',
    // dvi.shortReason هو السبب الفعلي (رؤية حرجة/رياح شديدة+مواد سائبة) —
    // نفس النص المعروض قديماً عند mandatoryStop=true من DVI وحده بلا مساهمة
    // امتثال. غير مستهلَكة عملياً عند decision='ALLOW' (هذا المرشح لا يفوز
    // حينها إلا في تعادل عام بلا أي مرشح آخر أشد، تماماً كسلوك اليوم).
    reasonAr: dvi.shortReason || '',
    labelAr: 'إيقاف إلزامي نظامي',
    level: 'BLACK',
  };

  // خطأ مكتشَف ومُصلَح (طلب المستخدم — تقرير المراجعة الخارجي: "سبب القرار
  // قد لا يشرح القرار الفائز"): نص "بيانات قديمة/غير متوفرة" الآن يعيش هنا
  // فقط، مع مرشحه الخاص (HOLD_FOR_VERIFICATION، رتبة 3) — لا فحصاً منفصلاً
  // (evidenceUnavailable ? ... : ...) يُطبَّق أولاً بلا شرط الرتبة الفعلية،
  // كما كان سابقاً (راجع مثال رؤية 499م + PM10 قديم في تعليق DecisionCandidate
  // أعلاه). لو فاز مرشح أشد (دvi.mandatoryStop من رؤية حرجة، رتبة 5) رغم وجود
  // evidenceUnavailable=true بنفس اللحظة، نص evidenceCandidate ببساطة لا
  // يُقرَأ إطلاقاً — القراءة تقتصر على المرشح الفائز فقط.
  const evidenceCandidate: DecisionCandidate = {
    source: 'EVIDENCE',
    decision: evidenceUnavailable ? 'HOLD_FOR_VERIFICATION' : 'ALLOW',
    reasonAr: 'تعذّر اعتماد قرار واثق: بيانات القراءة الحالية قديمة أو غير متوفرة — يتطلب تحقق ميداني قبل الاستمرار.',
    labelAr: 'بانتظار تحقق ميداني — بيانات غير كافية',
    level: 'ORANGE',
  };

  // خطأ مكتشَف ومُصلَح (مراجعة كود خارجي — "AEI يغيّر اللون والنص دون تغيير
  // القرار"): aeiIsMoreSevere (أدناه سابقاً) كانت تستبدل level/decisionLabelAr/
  // shortReasonAr فقط عندما AEI أشد من level المحسوب من DVI/الامتثال —
  // بمعزل تام عن operationalDecision/regulatoryFinding/mandatoryStop، فكانت
  // نتيجة مثل operationalDecision=ALLOW + regulatoryFinding=COMPLIANT +
  // level=BLACK + decisionLabelAr='مغلق' ممكنة فعلياً: evaluateAei تُستدعى
  // (dustEvaluation.ts) على dvi الخام مباشرة، غير مطّلعة على استثناءات
  // decideFinal اللاحقة (pendingAffectedStop يُسقِط dviMandatoryCandidate،
  // dviStopIsPm10StaleOnly يُخفِّف dviCandidate) — فقد يرى AEI dvi.mandatoryStop
  // =true (CLOSED/BLACK) بينما decideFinal قرر بحق أن السبب معلَّق/غير موثوق،
  // فيفوز operationalDecision الأخف بينما العرض يقفز لأسود "مغلق".
  //
  // الإصلاح: AEI مرشح قرار كامل الآن (نفس آلية "الأشد يفوز" بالضبط) — لا
  // طبقة عرض منفصلة بعد اختيار الفائز. CLOSED→PROTECTIVE_STOP (لا
  // MANDATORY_STOP): إغلاق AEI مؤشر جودة/سلامة إرشادي، لا مخالفة تنظيمية
  // بحد ذاته — لا يجوز أن "يتحول تلقائياً" لإيقاف إلزامي قطعي (regulatoryFinding
  // يبقى محكوماً حصراً بـconfirmedAffectedStop/pendingAffectedStop/compliance،
  // لا بـAEI مطلقاً). isPlanning مستبعدة أصلاً (input.aei لا يصل هذه النقطة
  // في وضع PLANNING، فرع مبكر منفصل أعلى الدالة).
  const AEI_TO_OPERATION: Record<AeiStatus, OperationalDecision> = {
    ALLOW: 'ALLOW',
    MONITOR: 'MONITOR',
    RESTRICT: 'RESTRICT',
    CLOSED: 'PROTECTIVE_STOP',
  };
  const aeiCandidate: DecisionCandidate | null = input.aei
    ? {
        source: 'AEI',
        decision: AEI_TO_OPERATION[input.aei.status],
        reasonAr: input.aei.shortReasonAr,
        labelAr: input.aei.statusLabelAr,
        level: input.aei.color,
      }
    : null;

  // ترتيب المصفوفة يحدد الفائز عند التعادل (reduce بـ`>` صارم يبقي أول
  // عنصر عند تساوي الرتبة) — complianceCandidate أولاً عمداً: نص القاعدة
  // التنظيمية الفعلية يُفضَّل على نص DVI الفيزيائي العام كلما تساويا في
  // الشدة (الاتفاقية القديمة الموروثة من computeUnifiedActivityDecision،
  // راجع أيضاً aeiIsDecisive سابقاً — نفس المبدأ). هذا يضمن أن نص
  // pendingAffectedStop ('إيقاف مؤقت معلَّق') يبقى يفوز دائماً عند تعادله
  // رتبةً مع dviCandidate (كلاهما قد يصلان PROTECTIVE_STOP معاً)، تماماً
  // كسلوك اليوم قبل هذا الإصلاح. suppressDviMonitoring مطبَّقة بالفعل داخل
  // dviCandidate نفسه (أعلاه) — لا استبدال منفصل للمصفوفة هنا بعد الآن.
  const candidates: DecisionCandidate[] = [complianceCandidate, dviCandidate, dviMandatoryCandidate, evidenceCandidate];
  if (aeiCandidate) candidates.push(aeiCandidate);

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
  } else if (compliance?.pendingConfirmation === true) {
    // خطأ معماري مكتشَف ومُصلَح (مراجعة كود خارجي — P0: "PM10 قبل 120 ثانية
    // يظهر تنظيمياً COMPLIANT"): pendingAffectedStop أعلاه يشترط complianceBlocks
    // (decisionCategory=MANDATORY_STOP/STOP_AFFECTED_ACTIVITY تحديداً) قبل أن
    // يعكس compliance.pendingConfirmation. بعد إصلاحَي الملاحظتين #7/#8 (هذه
    // الجلسة)، أصبحت نافذة PM10 المعلَّقة (<120 ثانية) ALLOW_WITH_CONTROLS —
    // لا تصل complianceBlocks إطلاقاً، فـpendingAffectedStop=false، وhasConfirmed
    // RegulatoryViolation أيضاً false لتلك النافذة تحديداً (تُشتق حصراً من
    // PM10-VIOLATION-STOP-006، وهي قاعدة نافذة (ب) المؤكَّدة 120ث-30د، لا
    // MRQ-PM10-BLACK-PENDING-104 نافذة (أ)) — فكان regulatoryFinding يسقط
    // مباشرة إلى COMPLIANT رغم أن الحالة "بانتظار تأكيد" فعلياً، بينما
    // FinalDecision.pendingConfirmation (الحقل الآخر، أُصلح في الملاحظة #10)
    // يبقى true في نفس الكائن — تناقض مباشر بين حقلين رسميين. الإصلاح: فرع
    // مستقل يقرأ compliance.pendingConfirmation مباشرة بصرف النظر عن الفئة،
    // بعد confirmedAffectedStop/pendingAffectedStop (الإيقاف الفعلي الأشد يبقى
    // يفوز دائماً) وقبل evidenceUnavailable/FIELD_VERIFICATION_REQUIRED (نقص
    // بيانات حرج يبقى يفوز على حالة PM10 المعلَّقة — طلب صريح من المستخدم).
    regulatoryFinding = 'PENDING_CONFIRMATION';
  } else if (evidenceUnavailable || compliance?.decisionCategory === 'FIELD_VERIFICATION_REQUIRED') {
    // FIELD_VERIFICATION_REQUIRED (نقص بيانات مشروع/موقع حرجة يمنع الحكم —
    // راجع complianceCandidate أعلاه) نفس دلالة evidenceUnavailable تماماً:
    // لا يمكن الحكم بامتثال أو مخالفة قبل تحقق ميداني فعلي، فلا يجوز أن
    // يبقى regulatoryFinding=COMPLIANT بينما operationalDecision=
    // HOLD_FOR_VERIFICATION في نفس النتيجة (تناقض مباشر بين حقلين).
    regulatoryFinding = 'NOT_DETERMINABLE';
  } else if (compliance?.hasConfirmedRegulatoryViolation === true) {
    // خطأ معماري مكتشَف ومُصلَح (مراجعة كود خارجي — "المخالفة التنظيمية عند
    // تأكيد PM10 (2-30 دقيقة) لا تنعكس في regulatoryFinding"): PM10-VIOLATION-
    // STOP-006 (مخالفة مؤكَّدة موثَّقة، ALLOW_WITH_CONTROLS عمداً — الإيقاف
    // الفعلي يبقى مشروطاً حصراً باكتمال 30 دقيقة، راجع pm10ThresholdRule)
    // لا تصل complianceStopAffected/confirmedAffectedStop أعلاه إطلاقاً (فئتها
    // ليست STOP_AFFECTED_ACTIVITY) — فكان النشاط يظهر COMPLIANT رغم مخالفة
    // مؤكَّدة فعلياً، فقط لأنها لم تبلغ درجة الإيقاف بعد. الفصل الصحيح: هناك
    // مخالفة (regulatoryFinding) حتى لو لم يتحقق شرط الإيقاف (operationalDecision)
    // بعد — حقلان مستقلان، لا يجوز خلطهما. operationalDecision/mandatoryStop
    // أعلاه غير متأثرين بهذا الفرع إطلاقاً (يبقيان كما حسبهما candidates.reduce
    // تماماً)؛ فقط regulatoryFinding يتغيّر هنا.
    regulatoryFinding = 'NON_COMPLIANT';
  } else {
    // compliance غائب أصلاً (مثال: PLANNING بلا سياق امتثال كامل) يُعامَل
    // كـCOMPLIANT بفشل آمن — لا يجوز الإبلاغ عن مخالفة بلا محرك امتثال
    // شغَّال فعلياً قيّمها.
    regulatoryFinding = 'COMPLIANT';
  }

  const overridable = !mandatoryStop && (compliance ? compliance.canOverride === true : dvi.overridable === true);

  // خطأ مكتشَف ومُصلَح (طلب المستخدم — تقرير المراجعة الخارجي: "سبب القرار
  // قد لا يشرح القرار الفائز"، راجع تعليق DecisionCandidate الكامل أعلى
  // الدالة): shortReasonAr/decisionLabelAr/level تُقرأ الآن مباشرة من نفس
  // المرشح الفائز (winner) — لا سلسلة شروط منفصلة (complianceIsDecisive/
  // aeiIsDecisive/evidenceUnavailable/mandatoryStop/pendingAffectedStop/
  // suppressDviMonitoring) تُعاد فحصها بترتيب ثابت بمعزل عن candidates.reduce
  // الفعلي. مثال الثغرة المُصلَحة بالضبط: رؤية 499م (dviMandatoryCandidate
  // يفوز برتبة 5) + PM10 قديم بنفس اللحظة (evidenceUnavailable=true) — قبل
  // الإصلاح كان شرط `evidenceUnavailable ? 'بيانات قديمة' : ...` يُفحَص أولاً
  // بلا قيد الرتبة، فيعرض نص نقص البيانات رغم أن الفائز الفعلي مرشح آخر
  // تماماً (الرؤية). كل مرشح يحمل نصه/لونه الخاص منذ إنشائه (dviCandidate/
  // complianceCandidate/dviMandatoryCandidate/evidenceCandidate/aeiCandidate
  // أعلاه) — القراءة هنا مجرد `winner.reasonAr/labelAr/level`، بلا أي إعادة
  // اشتقاق مستقلة يمكن أن تنحرف عن الفائز الحقيقي.
  const shortReasonAr = winner.reasonAr;
  const decisionLabelAr = winner.labelAr;
  const level = winner.level;

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
  // عبر persistFinalDecisions — بالضبط التناقض الذي وصفه ذلك التقرير (ALLOW/
  // GREEN محفوظ مقابل MONITOR/YELLOW معروض). aeiCandidate أعلاه (يشارك في
  // candidates.reduce نفسه) هو الإصلاح الجذري: AEI الآن مرشح قرار كامل يؤثر
  // على operationalDecision/mandatoryStop نفسيهما، لا طبقة عرض منفصلة بعد
  // اختيار الفائز كما كان (aeiIsMoreSevere القديمة، محذوفة الآن) — يستحيل
  // بنيوياً الآن أن يظهر level=BLACK بينما operationalDecision=ALLOW بسبب AEI.
  const result: FinalDecision = {
    snapshotId: input.snapshotId,
    mode,
    operationalDecision,
    regulatoryFinding,
    mandatoryStop,
    overridable,
    shortReasonAr,
    decisionLabelAr,
    level,
    // خطأ مكتشَف ومُصلَح (طلب صريح من المستخدم — مراجعة كود خبير خارجي،
    // الملاحظة #10: "أ. قبل 120 ثانية: MONITOR/ALLOW_WITH_CONTROLS +
    // pendingConfirmation=true"): كان هذا الحقل = pendingAffectedStop، الذي
    // يشترط complianceBlocks (decisionCategory=MANDATORY_STOP/STOP_AFFECTED_
    // ACTIVITY) قبل أن يعكس compliance.pendingConfirmation إطلاقاً. بعد
    // إصلاحي الملاحظتين #7/#8، أصبحت النافذة قبل 120 ثانية ALLOW_WITH_CONTROLS
    // (لا STOP_AFFECTED_ACTIVITY) — فبقي FinalDecision.pendingConfirmation
    // النهائي عالقاً على false لتلك النافذة تحديداً، رغم أن compliance.
    // pendingConfirmation=true فعلياً (الواجهة تتجنّب هذا العطل عملياً بقراءة
    // compliance.pendingConfirmation مباشرة، لا هذا الحقل — راجع
    // Compliancewidgetcard.tsx — لكن FinalDecision نفسه، الكائن الرسمي
    // الموحَّد، كان يحمل قيمة غير دقيقة). الإصلاح: قراءة compliance.
    // pendingConfirmation مباشرة هنا، بصرف النظر عن الفئة — سطر معزول تماماً
    // لا يمسّ pendingAffectedStop نفسه (يبقى كما هو، يحكم complianceLevel/
    // complianceCandidate/regulatoryFinding/استبعاد dviMandatoryCandidate
    // في الملاحظتين #7/#8 دون أي تغيير).
    pendingConfirmation: compliance?.pendingConfirmation === true,
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
