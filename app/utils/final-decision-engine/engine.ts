// =============================================================
// Final Decision Engine — Core
// decideFinal: الدالة الوحيدة المسموح لها بقراءة dvi.mandatoryStop و
// compliance.decisionCategory معاً وإنتاج قرار نهائي. دالة نقية بلا I/O —
// تستهلك نتائج DVI/الامتثال/AEI الجاهزة فقط (قراءة، بلا إعادة حساب لأي
// منها)، بنفس مبدأ evaluateDustCompliance في dust-compliance-engine.
// راجع types.ts للسياق الكامل حول سبب وجود هذا الملف.
// =============================================================

import type { FinalDecision, FinalDecisionInput, OperationalDecision, RegulatoryFinding } from './types';

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
    const isFavorable = dvi.decisionCategory === 'ALLOW' || dvi.decisionCategory === 'ALLOW_WITH_MONITORING';
    const result: FinalDecision = {
      snapshotId: input.snapshotId,
      mode,
      operationalDecision: isFavorable ? 'ALLOW' : 'MONITOR',
      regulatoryFinding: 'COMPLIANT',
      mandatoryStop: false,
      overridable: true,
      shortReasonAr: isFavorable
        ? 'تنبيه: هذه توقّعات طقس لوقت بدء النشاط المجدول (لم يبدأ بعد)، لا قراءة جهاز حية — الأجواء المتوقعة تصلح للنشاط. سيتم تفعيل جهاز الرصد وعرض قراءاته الحية قبل ساعتين من موعد البدء.'
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
  // الفئة"، يطابق applyComplianceGateToAei القديمة بالضبط (فحص pendingConfirmation
  // داخل فرع AEI_COMPLIANCE_CLOSED_DECISIONS الذي يضم الفئتين معاً). أي حالة
  // أخرى (بما فيها pendingConfirmation=undefined) مؤكَّدة فوراً بلا حاجة
  // لدليل استمرار — فشل آمن نحو "مؤكَّد" لا "معلَّق" بلا دليل.
  const confirmedAffectedStop = complianceBlocks && compliance?.pendingConfirmation !== true;
  const pendingAffectedStop = complianceBlocks && compliance?.pendingConfirmation === true;

  // الأدلة غير كافية — يُطبَّق فقط في LIVE_OPERATIONAL (PLANNING لا تملك
  // "الآن" ليُطلَب تحقق ميداني منه؛ ساعات التوقّع تُعرض توعوياً بصرف النظر
  // عن جودة الأدلة، نفس السلوك القديم في computeDustComplianceHourly).
  //
  // خطأ مكتشَف ومُصلَح (مراجعة كود خبير خارجي — "القراءة القديمة ما زالت
  // تنتج ALLOW أو STOP حيًا"): كان الفحص يقتصر على UNAVAILABLE فقط، فتُستثنى
  // عمداً STALE (جهاز مرتبط فعلياً لكن آخر قراءة PM10 غائبة أو أقدم من
  // DEVICE_READING_FRESHNESS_MINUTES، راجع deriveEvidenceQuality في
  // adapters.ts) — يعني الواجهة تعرض تحذير "قراءة قديمة" بينما القرار
  // التشغيلي (ALLOW/RESTRICT/MANDATORY_STOP) يُحسَب ويُعرَض بثقة كاملة من
  // نفس تلك القراءة القديمة. القرار السابق (لا تصعيد لـSTALE) عُكس صراحة:
  // الآن STALE تُعامَل معاملة UNAVAILABLE تماماً — قراءة قديمة لا يجوز أن
  // تنتج "آمن الآن" ولا "مخالفة مؤكَّدة الآن"، بل HOLD_FOR_VERIFICATION.
  // dvi.mandatoryStop (خطر فيزيائي مباشر) يبقى يفوز دائماً (يُفحَص أعلاه قبل
  // هذا الشرط) — قِدم قراءة الجهاز لا يُسقِط بوابة إيقاف فيزيائية حقيقية.
  const evidenceUnavailable =
    mode === 'LIVE_OPERATIONAL' && (evidenceQuality === 'UNAVAILABLE' || evidenceQuality === 'STALE');

  // هل سبب dvi.mandatoryStop هو PM10 لحظي فقط (لا خطر فيزيائي حقيقي آخر
  // كرؤية حرجة/عاصفة مساهم بنفس اللحظة)؟ نفس الوسم المستخدَم في dust-engine/
  // engine.ts (rule4Triggered فرع pm10RuleTriggered) — DVI-DUST-ACTIVITY-
  // STOP-004-PM10-ONLY يُضاف حصراً في ذلك الفرع، فوجوده في triggeredRules
  // يعني "PM10 اللحظي وحده كان كافياً"، بمعزل عن أي دليل فيزيائي حقيقي آخر.
  const dviMandatoryStopIsPm10Only = dvi.triggeredRules?.includes('DVI-DUST-ACTIVITY-STOP-004-PM10-ONLY') === true;

  // dvi.mandatoryStop (خطر فيزيائي فوري — رؤية حرجة/عاصفة، أو PM10 لحظي +
  // الشرط الفرعي المزدوج، راجع dust-engine/engine.ts) يبقى أرضية مطلقة —
  // لا يجوز لأي قرار امتثال أن "يُخفّف" إيقافاً فيزيائياً فعلياً. هذا يطابق
  // GATE-DVI-002 في dust-compliance-engine (إيقاف إلزامي يورَث من DVI).
  //
  // خطأ مكتشَف ومُصلَح (مراجعة كود مدير — "FinalDecisionEngine يعيد الخطأ
  // بعد أن يصححه محرك الامتثال"): التعليق القديم هنا ادّعى أن تمييز PM10
  // لحظي (dviMandatoryStopIsPm10Only) مقابل خطر فيزيائي حقيقي "طُبِّق بالفعل
  // داخل محرك الامتثال نفسه قبل وصول compliance.decisionCategory" — صحيح
  // جزئياً فقط: محرك الامتثال يحوّل تلك الحالة فعلاً إلى STOP_AFFECTED_ACTIVITY
  // معلَّق (pendingConfirmation=true) عبر GATE-DVI-002 (راجع isPendingRuleHit
  // بـengine.ts هناك)، لكن dvi.mandatoryStop الخام (من dust-engine) يبقى
  // true بلا أي تعديل — هو مخرَج محرك مختلف تماماً لا يعرف بقرار الامتثال
  // إطلاقاً. فكان `dvi.mandatoryStop === true` وحدها هنا تفوز دائماً بصرف
  // النظر عن pendingAffectedStop، منتجةً بالضبط التناقض المكتشَف: عينة PM10
  // واحدة لحظية → dvi.mandatoryStop=true → محرك الامتثال يخفّضها لمعلَّقة
  // (regulatoryFinding=PENDING_CONFIRMATION) → لكن decideFinal يعيد ترقيتها
  // لـmandatoryStop=true/operationalDecision=MANDATORY_STOP رغم ذلك — نتيجة
  // متناقضة فعلياً تُبطل بالضبط ما صححه محرك الامتثال للتو.
  //
  // خطأ ثانٍ مكتشَف ومُصلَح (مراجعة كود مدير — "القراءة القديمة قد تنتج
  // إيقافاً إلزامياً إذا كان DVI قد أوقفها أولاً"): كان dvi.mandatoryStop
  // يفوز دائماً حتى مع evidenceUnavailable=true (قراءة PM10 قديمة/غائبة) —
  // مبرَّراً بأن "خطر فيزيائي حقيقي (رؤية حرجة/عاصفة) لا ينبغي أن ينتظر
  // تحقق بيانات". هذا صحيح لخطر فيزيائي *حقيقي*، لكن خاطئ لـPM10 لحظي:
  // إن كانت قراءة PM10 نفسها هي سبب dvi.mandatoryStop الوحيد (dviMandatoryStopIsPm10Only)
  // وكانت هذه القراءة قديمة/غير متوفرة (evidenceUnavailable)، فالإيقاف
  // مبني على بيانات لا يُعتمَد عليها أصلاً — نفس فلسفة "القراءة القديمة ما
  // زالت تنتج ALLOW أو STOP حيًا" الموثَّقة أعلاه بالضبط، لم تُطبَّق سابقاً
  // على dvi.mandatoryStop تحديداً. خطر فيزيائي حقيقي (رؤية حرجة/رياح شديدة،
  // dviMandatoryStopIsPm10Only=false) يبقى يفوز فوراً كما كان دائماً — لا
  // تغيير هناك، فهو لا يعتمد على قراءة PM10 التي قد تكون قديمة.
  //
  // الإصلاح: dvi.mandatoryStop يُستثنى في حالتين معاً: (1) pendingAffectedStop=true
  // (محرك الامتثال قرر صراحة أن سبب هذا الإيقاف معلَّق بانتظار تأكيد)، أو
  // (2) PM10 لحظي فقط + evidenceUnavailable (بيانات قديمة/غير متوفرة).
  //
  // confirmedAffectedStop يشمل MANDATORY_STOP وSTOP_AFFECTED_ACTIVITY معاً
  // (complianceBlocks أعلاه) طالما غير معلَّق — عمداً لا complianceMandatory
  // بمفردها هنا: MANDATORY_STOP مع pendingConfirmation=true (حالة نظرية
  // نادرة لكن ممكنة في البيانات) يجب أن تبقى "معلَّقة" أيضاً، لا قطعية،
  // بنفس معاملة STOP_AFFECTED_ACTIVITY المعلَّق تماماً — "الحقل هو الحاسم،
  // لا الفئة" (طلب صريح موثَّق في اختبارات applyComplianceGateToAei القديمة).
  const dviPm10StopIsUnreliable = dviMandatoryStopIsPm10Only && evidenceUnavailable;
  const mandatoryStop =
    confirmedAffectedStop || (dvi.mandatoryStop === true && !pendingAffectedStop && !dviPm10StopIsUnreliable);

  // محرك DVI الفيزيائي لا يعرف مفهوم "العملية المغلقة" إطلاقاً — راجع
  // التعليق الكامل أسفل حساب suppressDviMonitoring في shortReasonAr/level.
  // يُحسَب هنا مبكراً لأنه يؤثر على operationalDecision أيضاً (لا يبقى
  // MONITOR بسبب رياح فقط لنشاط مغلق وامتثاله نظيف).
  //
  // خطأ حرج مكتشَف ومُصلَح (مراجعة كود خبير خارجي — "عند اعتبار العملية
  // مغلقة، قد يُلغى خطأً تقييد شديد أو إيقاف متعلق بالرؤية ويصدر ALLOW"):
  // كان الشرط يفحص فقط isEnclosedOperation وcompliance.decisionCategory،
  // بلا أي فحص لـdvi.decisionCategory — فيُقمَع أي قرار DVI (بما فيها
  // RESTRICT_SEVERE بسبب رؤية حرجة فعلية، أو STOP_DUST_GENERATING_ACTIVITIES/
  // STOP_VISIBILITY_DEPENDENT_ACTIVITIES) لمجرد أن النشاط مغلق وامتثاله
  // نظيف، حتى لو كان سبب القرار غباراً/رؤية فيزيائية حقيقية لا علاقة لها
  // بالرياح إطلاقاً (بروتوكول الملحق أ يُعفي العمليات المغلقة من بوابة
  // الرياح تحديداً، لا من كل خطر فيزيائي آخر). القصد الأصلي لهذا القمع
  // (راجع عنوان describe المقابل في engine.test.ts: "يُخفي تنبيه مراقبة DVI
  // مصدره الرياح فقط") كان محصوراً بحالة ALLOW_WITH_MONITORING تحديداً —
  // الآن يُطبَّق حصراً عليها، لا على أي قرار DVI آخر.
  const suppressDviMonitoring =
    !mandatoryStop &&
    compliance?.isEnclosedOperation === true &&
    compliance.decisionCategory === 'ALLOW' &&
    dvi.decisionCategory === 'ALLOW_WITH_MONITORING';

  let operationalDecision: OperationalDecision;
  if (mandatoryStop) {
    operationalDecision = 'MANDATORY_STOP';
  } else if (pendingAffectedStop) {
    // معلَّق فقط (بانتظار تأكيد استمرار) — النشاط متوقف احترازياً لكن غير
    // مؤكَّد تنظيمياً بعد، فيصل PROTECTIVE_STOP لا MANDATORY_STOP.
    operationalDecision = 'PROTECTIVE_STOP';
  } else if (evidenceUnavailable) {
    operationalDecision = 'HOLD_FOR_VERIFICATION';
  } else if (suppressDviMonitoring) {
    operationalDecision = 'ALLOW';
  } else if (compliance?.decisionCategory === 'RESTRICT_ACTIVITY') {
    operationalDecision = 'RESTRICT';
  } else if (
    compliance?.decisionCategory === 'FIELD_VERIFICATION_REQUIRED' ||
    compliance?.decisionCategory === 'ALLOW_WITH_CONTROLS' ||
    compliance?.decisionCategory === 'PRECAUTION' ||
    dvi.decisionCategory === 'ALLOW_WITH_MONITORING' ||
    dvi.decisionCategory === 'RESTRICT' ||
    dvi.decisionCategory === 'RESTRICT_SEVERE' ||
    // خطأ حرج مكتشَف ومُصلَح (مراجعة كود خبير خارجي — "بعض قرارات DVI من نوع
    // STOP_DUST_GENERATING_ACTIVITIES أو STOP_VISIBILITY_DEPENDENT_ACTIVITIES
    // لا يغطيها تسلسل القرار بالكامل، وقد تسقط إلى ALLOW"): applyMandatoryGates
    // في dust-engine/engine.ts تبدأ decision=baseDecision (من baseDecisionFromLevel
    // عند level=RED/DARK_RED/BLACK)، وقد تبقى عند هاتين الفئتين بلا أي فرع
    // لاحق يضبط mandatoryStop=true (ذلك يحدث فقط من بوابات صريحة كرؤية<0.5
    // كم أو PM10>340 أو رياح≥55). هاتان الفئتان كانتا غائبتين تماماً من هذا
    // التعداد، فتسقط النتيجة إلى else النهائي (ALLOW) رغم أن DVI نفسه يطلب
    // إيقاف فئة النشاط. أضيفتا هنا بنفس درجة RESTRICT_SEVERE تحديداً — ليس
    // اختياراً عشوائياً: aei-engine/tables.ts (AEI_CAPPING_DVI_DECISIONS)
    // يضع الفئتين في نفس مجموعة RESTRICT_SEVERE/RESTRICT فعلياً (سقف AEI
    // واحد لكل الأربع)، فهذا يطابق التصنيف الموجود فعلاً في مكان آخر من
    // النظام، لا تصنيفاً جديداً مخترَعاً هنا. MANDATORY_STOP الحقيقي (dvi.
    // mandatoryStop=true) يبقى الأعلى أولوية كما هو، بلا تغيير.
    dvi.decisionCategory === 'STOP_DUST_GENERATING_ACTIVITIES' ||
    dvi.decisionCategory === 'STOP_VISIBILITY_DEPENDENT_ACTIVITIES'
  ) {
    operationalDecision = 'MONITOR';
  } else {
    operationalDecision = 'ALLOW';
  }

  let regulatoryFinding: RegulatoryFinding;
  if (confirmedAffectedStop) {
    regulatoryFinding = 'NON_COMPLIANT';
  } else if (pendingAffectedStop) {
    regulatoryFinding = 'PENDING_CONFIRMATION';
  } else if (evidenceUnavailable) {
    regulatoryFinding = 'NOT_DETERMINABLE';
  } else {
    // compliance غائب أصلاً (مثال: PLANNING بلا سياق امتثال كامل) يُعامَل
    // كـCOMPLIANT بفشل آمن — لا يجوز الإبلاغ عن مخالفة بلا محرك امتثال
    // شغَّال فعلياً قيّمها.
    regulatoryFinding = 'COMPLIANT';
  }

  const overridable = !mandatoryStop && (compliance ? compliance.canOverride === true : dvi.overridable === true);

  // shortReasonAr/decisionLabelAr: الامتثال يفوز دائماً إن كان قراره غير
  // ALLOW (نص القاعدة التنظيمية الفعلية، لا نص DVI الفيزيائي العام) — نفس
  // أولوية computeUnifiedActivityDecision القديمة. mandatoryStop من DVI
  // وحده (بلا مساهمة امتثال) يستخدم نص DVI لأنه السبب الفعلي حينها.
  //
  // evidenceUnavailable (HOLD_FOR_VERIFICATION) يجب أن يعرض نصاً/لوناً
  // محايدَين يعكسان "البيانات غير كافية للحكم" صراحةً — لا نص/لون DVI أو
  // الامتثال المحسوبَين أصلاً من نفس القراءة القديمة/الناقصة (وإلا ظهر
  // "مسموح — تشغيل اعتيادي" أخضر أو "تقييد" أحمر بثقة كاملة رغم أن مصدره
  // بيانات لا يُعتمَد عليها، وهو بالضبط الخلل الذي صُحِّح بإضافة STALE لهذا
  // الشرط أعلاه). يُفحَص بعد mandatoryStop/pendingAffectedStop (يبقيان
  // الأولوية القصوى — خطر فيزيائي فعلي أو إيقاف امتثال معلَّق يفوزان حتى مع
  // بيانات قديمة)، وقبل أي نص/لون مشتق من DVI/الامتثال العاديين.
  const complianceIsDecisive = compliance && compliance.decisionCategory !== 'ALLOW';
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
function compareDecisionSeverity(a: FinalDecision, b: FinalDecision): number {
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

export function pickWorstDecision<T extends { finalDecision: FinalDecision }>(rows: readonly T[]): T {
  if (rows.length === 0) {
    throw new Error('pickWorstDecision: cannot select from an empty list');
  }
  return rows.reduce((worst, current) =>
    compareDecisionSeverity(current.finalDecision, worst.finalDecision) > 0 ? current : worst
  );
}
