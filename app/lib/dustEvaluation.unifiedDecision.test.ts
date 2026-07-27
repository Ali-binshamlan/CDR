import { describe, it, expect } from 'vitest';
import { computeUnifiedActivityDecision } from './dustEvaluation';
import type { DustComplianceResult } from '@/app/utils/dust-compliance-engine/types';

// =====================================================================
// اختبارات "القرار الموحد للنشاط" (computeUnifiedActivityDecision) —
// المشكلة المرصودة: قرار امتثال أقل من الإيقاف (RESTRICT_ACTIVITY/
// FIELD_VERIFICATION_REQUIRED/ALLOW_WITH_CONTROLS، مثال PM10-EARLY-
// WARNING-007 عند PM10=300) كان يختفي بالكامل خلف رسالة DVI العامة، لأن
// الدالة كانت تتحقق فقط من MANDATORY_STOP/STOP_AFFECTED_ACTIVITY قبل أن
// ترجع لقرار DVI افتراضياً.
// =====================================================================

function baseDviWorst(overrides: Partial<{ decisionLabelAr: string; shortReason: string; level: string; mandatoryStop: boolean }> = {}) {
  return {
    decisionLabelAr: 'تقييد النشاط وتفعيل أنظمة الرش',
    shortReason: 'تقييد العمل: وجود فجوة في إجراءات التحكم الميدانية (مثل غياب رش المياه أو مصدات الغبار).',
    level: 'ORANGE',
    mandatoryStop: false,
    ...overrides,
  };
}

function complianceWith(
  decisionCategory: DustComplianceResult['decisionCategory'],
  decisionLabelAr: string,
  shortReasonAr: string,
  pendingConfirmation = false,
  isEnclosedOperation = false
): DustComplianceResult {
  return { decisionCategory, decisionLabelAr, shortReasonAr, pendingConfirmation, isEnclosedOperation } as DustComplianceResult;
}

describe('computeUnifiedActivityDecision — قرار امتثال غير إيقاف يجب ألا يختفي خلف نص DVI', () => {
  it('PM10-EARLY-WARNING-007 (ALLOW_WITH_CONTROLS) يظهر بدل رسالة DVI العامة', () => {
    const compliance = complianceWith(
      'ALLOW_WITH_CONTROLS',
      'مسموح مع ضوابط تحكم إضافية',
      'تنبيه استباقي: تركيز PM10 (300 ميكروجرام/م³) يقترب من حد المخالفة (340 ميكروجرام/م³)'
    );
    const r = computeUnifiedActivityDecision(baseDviWorst(), compliance);
    expect(r.shortReason).toBe('تنبيه استباقي: تركيز PM10 (300 ميكروجرام/م³) يقترب من حد المخالفة (340 ميكروجرام/م³)');
    expect(r.decisionLabelAr).toBe('مسموح مع ضوابط تحكم إضافية');
    expect(r.mandatoryStop).toBe(false);
  });

  it('RESTRICT_ACTIVITY يظهر نصه الخاص بدل نص DVI العام', () => {
    const compliance = complianceWith('RESTRICT_ACTIVITY', 'تقييد النشاط', 'سرعة الطرق غير المسفلتة (15 كم/س) تتجاوز الحد (10 كم/س)');
    const r = computeUnifiedActivityDecision(baseDviWorst(), compliance);
    expect(r.shortReason).toBe('سرعة الطرق غير المسفلتة (15 كم/س) تتجاوز الحد (10 كم/س)');
    expect(r.decisionLabelAr).toBe('تقييد النشاط');
  });

  it('FIELD_VERIFICATION_REQUIRED يظهر نصه الخاص بدل نص DVI العام', () => {
    const compliance = complianceWith('FIELD_VERIFICATION_REQUIRED', 'يتطلب تحقق ميداني قبل الاستمرار', 'لم يتم تحديد نقطة دخول المشروع على الخريطة');
    const r = computeUnifiedActivityDecision(baseDviWorst(), compliance);
    expect(r.shortReason).toBe('لم يتم تحديد نقطة دخول المشروع على الخريطة');
    expect(r.decisionLabelAr).toBe('يتطلب تحقق ميداني قبل الاستمرار');
  });

  it('امتثال ALLOW نظيف → يبقى نص DVI كما هو (لا شيء يُخفى)', () => {
    const compliance = complianceWith('ALLOW', 'مسموح — تشغيل اعتيادي', 'لا توجد مخالفات تنظيمية ظاهرة على النشاط الحالي');
    const r = computeUnifiedActivityDecision(baseDviWorst(), compliance);
    expect(r.shortReason).toBe(baseDviWorst().shortReason);
    expect(r.decisionLabelAr).toBe(baseDviWorst().decisionLabelAr);
  });

  it('لا قرار امتثال إطلاقاً (null) → يبقى نص DVI كما هو', () => {
    const r = computeUnifiedActivityDecision(baseDviWorst(), null);
    expect(r.shortReason).toBe(baseDviWorst().shortReason);
  });

  it('DVI نفسه mandatoryStop حتى مع امتثال غير حاجب → يبقى إيقاف إلزامي', () => {
    const compliance = complianceWith('ALLOW_WITH_CONTROLS', 'مسموح مع ضوابط تحكم إضافية', 'تحذير: تركيز PM10 (260) تجاوز حد التحذير (250)');
    const r = computeUnifiedActivityDecision(baseDviWorst({ mandatoryStop: true }), compliance);
    expect(r.mandatoryStop).toBe(true);
    expect(r.decisionLabelAr).toBe('إيقاف إلزامي نظامي');
    expect(r.level).toBe('BLACK');
  });

  it('امتثال يحجب (MANDATORY_STOP) يبقى بسلوكه السابق بلا تغيير', () => {
    const compliance = complianceWith('MANDATORY_STOP', 'إيقاف إلزامي غير قابل للتجاوز', 'مسافة الكسارة عن سكني أقل من الحد الأدنى (500 م)');
    const r = computeUnifiedActivityDecision(baseDviWorst(), compliance);
    expect(r.decisionLabelAr).toBe('إيقاف إلزامي نظامي');
    expect(r.shortReason).toBe('مسافة الكسارة عن سكني أقل من الحد الأدنى (500 م)');
    expect(r.mandatoryStop).toBe(true);
    expect(r.level).toBe('BLACK');
    expect(r.pendingConfirmation).toBe(false);
  });

  it('امتثال يحجب لكنه معلَّق فقط (pendingConfirmation=true، مثال MRQ-PM10-BLACK-PENDING-104) → لا يظهر "إيقاف إلزامي نظامي" القطعية', () => {
    const compliance = complianceWith(
      'STOP_AFFECTED_ACTIVITY',
      'إيقاف النشاط المتأثر',
      'تعليق مؤقت (معلَّق): تركيز PM10 (345 ميكروجرام/م³) تجاوز حد المخالفة (340 ميكروجرام/م³) — بانتظار استمرار القراءة أكثر من دقيقتين لتصنيفها مخالفة تنظيمية مؤكدة',
      true
    );
    const r = computeUnifiedActivityDecision(baseDviWorst(), compliance);
    expect(r.decisionLabelAr).not.toBe('إيقاف إلزامي نظامي');
    expect(r.pendingConfirmation).toBe(true);
    expect(r.mandatoryStop).toBe(false);
    // level='RED' تحديداً (لا BLACK) — هذا هو العقد الدقيق الذي تعتمد عليه
    // riskWeightFromColor/overallBannerStyle (route.ts، MultiIndicatorActivityBox)
    // للتفريق بين "معلَّق مؤقت" (أحمر، وزن 3) و"إيقاف مؤكَّد" (أسود، وزن 4)
    // — كان كلاهما يتساوى بوزن 3 قبل الإصلاح، فيظهران بنفس اللون في البانر.
    expect(r.level).toBe('RED');
    expect(r.shortReason).toContain('معلَّق');
  });

  // سيناريو حقيقي رصده المستخدم بالصورة: DVI أخضر فيزيائياً (لا خطر مباشر)
  // بينما الامتثال ALLOW_WITH_CONTROLS (تحذير PM10 تجاوز 250) — البانر
  // العلوي كان يظهر أخضر بالكامل "مسموح مع ضوابط تحكم إضافية" بينما بطاقة
  // AEI بجانبه مباشرة (مقصوصة عبر applyComplianceGateToAei) تظهر حمراء
  // "تقييد تشغيلي" لنفس القرار — تناقض لوني صريح لنفس السبب المعروض.
  it('DVI أخضر + امتثال ALLOW_WITH_CONTROLS → level لا يبقى أخضر (يطابق حد AEI الأحمر)', () => {
    const compliance = complianceWith(
      'ALLOW_WITH_CONTROLS',
      'مسموح مع ضوابط تحكم إضافية',
      'تحذير: تركيز PM10 (260 ميكروجرام/م³) تجاوز حد التحذير (250 ميكروجرام/م³)'
    );
    const r = computeUnifiedActivityDecision(baseDviWorst({ level: 'GREEN', mandatoryStop: false }), compliance);
    expect(r.level).not.toBe('GREEN');
    expect(r.level).toBe('RED');
    expect(r.mandatoryStop).toBe(false);
  });

  // PRECAUTION (نطاق PM10 150-250، طلب صريح من المستخدم) أخف من ALLOW_WITH_
  // CONTROLS — يجب أن يظهر أصفر (لا أخضر يخفي النص، ولا أحمر أشد من اللازم).
  it('DVI أخضر + امتثال PRECAUTION → level يصبح أصفر (لا أخضر متناقض مع نص الاحتراز، ولا أحمر مبالغ فيه)', () => {
    const compliance = complianceWith('PRECAUTION', 'احتراز — زيادة المراقبة', 'حالة احتراز: تركيز PM10 (200 ميكروجرام/م³) ضمن نطاق الإنذار المبكر (150–250 ميكروجرام/م³)');
    const r = computeUnifiedActivityDecision(baseDviWorst({ level: 'GREEN', mandatoryStop: false }), compliance);
    expect(r.level).toBe('YELLOW');
    expect(r.decisionLabelAr).toBe('احتراز — زيادة المراقبة');
    expect(r.mandatoryStop).toBe(false);
  });

  it('DVI أشد من الامتثال (مثال DVI=BLACK) → لا يُخفَّض level رغم أن الامتثال ALLOW_WITH_CONTROLS فقط', () => {
    const compliance = complianceWith('ALLOW_WITH_CONTROLS', 'مسموح مع ضوابط تحكم إضافية', 'تحذير بسيط');
    const r = computeUnifiedActivityDecision(baseDviWorst({ level: 'BLACK', mandatoryStop: true }), compliance);
    expect(r.level).toBe('BLACK');
  });

  // سيناريو حقيقي رصده المستخدم: نشاط "قطع الأحجار" مغلق (isEnclosedOperation)
  // بـPM10=100 (امتثال ALLOW نظيف تماماً)، لكن DVI الفيزيائي أظهر "تشغيل مع
  // المراقبة" (YELLOW) بسبب رياح 31.2 كم/س فقط — DVI لا يعرف مفهوم "مغلق"
  // إطلاقاً (لا حقل isEnclosedOperation في مدخلاته)، فيحسب خطر الرياح على
  // النشاط سواء كان مغلقاً أو مكشوفاً. النشاط المغلق فعلياً لا يمكن أن يتطاير
  // منه غبار بفعل الرياح، فلا معنى لتنبيه "مراقبة" مصدره الرياح وحدها هنا.
  it('نشاط مغلق + امتثال ALLOW نظيف + DVI أصفر بسبب الرياح فقط → البانر يعرض أخضر (الامتثال هو المرجع لنشاط مغلق)', () => {
    const compliance = complianceWith('ALLOW', 'مسموح — تشغيل اعتيادي', 'لا توجد مخالفات تنظيمية ظاهرة على النشاط الحالي', false, true);
    const r = computeUnifiedActivityDecision(
      baseDviWorst({ level: 'YELLOW', decisionLabelAr: 'تشغيل مع المراقبة والمتابعة', mandatoryStop: false }),
      compliance
    );
    expect(r.level).toBe('GREEN');
    expect(r.decisionLabelAr).toBe('مسموح — تشغيل اعتيادي');
    expect(r.mandatoryStop).toBe(false);
  });

  it('نشاط مكشوف (غير مغلق) + امتثال ALLOW نظيف + DVI أصفر بسبب الرياح → يبقى أصفر كما هو (لا استثناء لنشاط مكشوف)', () => {
    const compliance = complianceWith('ALLOW', 'مسموح — تشغيل اعتيادي', 'لا توجد مخالفات تنظيمية ظاهرة على النشاط الحالي', false, false);
    const r = computeUnifiedActivityDecision(
      baseDviWorst({ level: 'YELLOW', decisionLabelAr: 'تشغيل مع المراقبة والمتابعة', mandatoryStop: false }),
      compliance
    );
    expect(r.level).toBe('YELLOW');
    expect(r.decisionLabelAr).toBe('تشغيل مع المراقبة والمتابعة');
  });

  it('نشاط مغلق + امتثال ALLOW نظيف + DVI mandatoryStop حقيقي (رؤية حرجة) → لا يُستثنى، الإيقاف يبقى قائماً', () => {
    const compliance = complianceWith('ALLOW', 'مسموح — تشغيل اعتيادي', 'لا توجد مخالفات تنظيمية ظاهرة على النشاط الحالي', false, true);
    const r = computeUnifiedActivityDecision(
      baseDviWorst({ level: 'BLACK', mandatoryStop: true }),
      compliance
    );
    expect(r.mandatoryStop).toBe(true);
    expect(r.decisionLabelAr).toBe('إيقاف إلزامي نظامي');
    expect(r.level).toBe('BLACK');
  });

  it('نشاط مغلق لكن الامتثال غير نظيف (PRECAUTION) → لا يُستثنى تنبيه DVI، الامتثال نفسه يحمل تنبيهاً بالفعل', () => {
    const compliance = complianceWith('PRECAUTION', 'احتراز — زيادة المراقبة', 'حالة احتراز: تركيز PM10 ضمن نطاق الإنذار المبكر', false, true);
    const r = computeUnifiedActivityDecision(
      baseDviWorst({ level: 'YELLOW', decisionLabelAr: 'تشغيل مع المراقبة والمتابعة', mandatoryStop: false }),
      compliance
    );
    expect(r.decisionLabelAr).toBe('احتراز — زيادة المراقبة');
    expect(r.level).toBe('YELLOW');
  });

  it('امتثال STOP_AFFECTED_ACTIVITY مؤكَّد (غير معلَّق) لا يزال يظهر "إيقاف إلزامي نظامي" كسابقاً', () => {
    const compliance = complianceWith(
      'STOP_AFFECTED_ACTIVITY',
      'إيقاف النشاط المتأثر',
      'مسافة الكسارة عن سكني/مدارس/مستشفيات (420 م) أقل من الحد الأدنى (500 م)',
      false
    );
    const r = computeUnifiedActivityDecision(baseDviWorst(), compliance);
    expect(r.decisionLabelAr).toBe('إيقاف إلزامي نظامي');
    expect(r.pendingConfirmation).toBe(false);
    expect(r.mandatoryStop).toBe(true);
    expect(r.level).toBe('BLACK');
  });
});
