import { describe, it, expect } from 'vitest';
import { applyFinalDecisionToAei } from './dustEvaluation';
import type { AeiEvaluationResult } from '@/app/utils/aei-engine/types';
import type { FinalDecision } from '@/app/utils/final-decision-engine/types';

// خطأ مكتشَف ومُصلَح — طلب صريح من المستخدم: "ابغاه يطلع نفس كذا في
// التوقعات المستقبلية... بدون قرار، فقط تنبيه إذا الأجواء مناسبة أو لا".
// شبكة "توقعات قابلية التنفيذ (AEI) للساعات القادمة" (Compliancewidgetcard.tsx)
// كانت تعرض لكل ساعة حالة AEI عامة ("قابل للتنفيذ مع مراقبة" ثابتة تقريباً،
// أو حتى "تقييد تشغيلي — امتثال تنظيمي" الأحمر خطأً) بدل نفس رسالة/لون
// وضع PLANNING الصحيح المعروض في البطاقة الرئيسية لنفس النشاط ("مسموح" أو
// "تنبيه: أجواء متوقعة غير مناسبة") — رغم أن decideFinal(mode='PLANNING')
// كانت تُحسَب بالفعل بشكل صحيح لكل ساعة، لكن applyFinalDecisionToAei لم
// تكن تتحقق من decision.mode إطلاقاً فتُسقِط تلك النتيجة الصحيحة.

function buildAei(overrides: Partial<AeiEvaluationResult> = {}): AeiEvaluationResult {
  return {
    indicatorType: 'AEI',
    activityLabelAr: 'محطة خلط الخرسانة',
    status: 'ALLOW',
    statusLabelAr: 'قابل للتنفيذ مع مراقبة',
    color: 'YELLOW',
    score: 62,
    safetyScore: 62,
    qualityScore: 70,
    baseScore: 62,
    closedByGate: false,
    cappedByGate: false,
    gateReasonAr: null,
    isHoldForVerification: false,
    shortReasonAr: 'تأثر جودة العمل بشكل طفيف بسبب وجود جسيمات عالقة.',
    recommendationAr: 'استمر بالعمل مع مراقبة الوضع.',
    sources: [],
    ...overrides,
  };
}

function buildDecision(overrides: Partial<FinalDecision> = {}): FinalDecision {
  return {
    snapshotId: 'test-snapshot',
    mode: 'PLANNING',
    operationalDecision: 'MONITOR',
    // NOT_DETERMINABLE (لا COMPLIANT) — راجع الملاحظة #12: PLANNING توقّع
    // بلا قراءة ميدانية حقيقية، لا يجوز حكم قاطع بامتثال.
    regulatoryFinding: 'NOT_DETERMINABLE',
    mandatoryStop: false,
    overridable: true,
    shortReasonAr: 'تنبيه: هذه توقّعات طقس لوقت بدء النشاط المجدول (لم يبدأ بعد)، لا قراءة جهاز حية — الأجواء المتوقعة لا تصلح للنشاط.',
    decisionLabelAr: 'تنبيه: أجواء متوقعة غير مناسبة',
    level: 'YELLOW',
    pendingConfirmation: false,
    reasonCodes: [],
    evidenceQuality: 'UNAVAILABLE',
    ruleBundleVersion: 'test-v1',
    ...overrides,
  } as FinalDecision;
}

describe('applyFinalDecisionToAei — وضع PLANNING الساعي يطابق البطاقة الرئيسية', () => {
  it('توقّع غير مناسب (MONITOR/PLANNING) ينتج تنبيهاً أصفر توعوياً، لا تقييداً أحمر', () => {
    const aei = buildAei();
    const decision = buildDecision({ operationalDecision: 'MONITOR' });
    const result = applyFinalDecisionToAei(aei, decision, null);

    expect(result.color).toBe('YELLOW');
    expect(result.statusLabelAr).toBe('تنبيه: أجواء متوقعة غير مناسبة');
    expect(result.shortReasonAr).toContain('الأجواء المتوقعة لا تصلح للنشاط');
    // لا تقييد فعلي — بلا closedByGate/cappedByGate جديدين يوحيان بقرار ملزم
    expect(result.closedByGate).toBe(false);
  });

  it('توقّع مناسب (ALLOW/PLANNING) يُبقي حالة AEI الأساسية كما هي (لا تعديل قسري)', () => {
    const aei = buildAei({ status: 'ALLOW', color: 'GREEN' });
    const decision = buildDecision({
      operationalDecision: 'ALLOW',
      decisionLabelAr: 'مسموح — تشغيل اعتيادي',
      shortReasonAr: 'الأجواء المتوقعة تصلح للنشاط.',
      level: 'GREEN',
    });
    const result = applyFinalDecisionToAei(aei, decision, null);

    expect(result.color).toBe('GREEN');
    expect(result.statusLabelAr).toBe('مسموح — تشغيل اعتيادي');
    expect(result.shortReasonAr).toBe('الأجواء المتوقعة تصلح للنشاط.');
  });

  it('PLANNING لا يُسقِط أي قرار ملزم فعلياً (mandatoryStop يبقى false دائماً في هذا الوضع)', () => {
    const aei = buildAei();
    const decision = buildDecision({ operationalDecision: 'MONITOR' });
    const result = applyFinalDecisionToAei(aei, decision, null);

    expect(result.closedByGate).toBe(false);
    expect(result.cappedByGate).toBe(false);
  });
});

// خطأ إعادة إنتاج مكتشَف ومُصلَح (بلاغ مباشر من المستخدم — لقطة شاشة: بطاقة
// AEI عرضت "قابل للتنفيذ مع مراقبة" بثقة منخفضة لنشاط جهازه يرسل فعلياً
// (متأخر) قبل بدء النشاط، رغم أن البانر الموحَّد لنفس النشاط أصبح يعرض
// "بانتظار تحقق ميداني" بعد إصلاح decideFinal — "نسيت تحدّث AEI بنفس
// الطريقة"). decideFinal قد يُرجِع الآن operationalDecision=
// 'HOLD_FOR_VERIFICATION' حتى مع mode='PLANNING' (الفرع المخصَّص لجهاز حي
// متأخر داخل هامش الساعتين قبل البدء — راجع isLiveForDevice في
// final-decision-engine/engine.ts). applyFinalDecisionToAei يجب أن تعامل
// هذه الحالة كـHOLD_FOR_VERIFICATION حقيقي (نفس معاملة الوضع الحي)، لا أن
// تسقط في فرع mode==='PLANNING' العام لمجرد أن mode نفسها لم تتغيّر.
describe('applyFinalDecisionToAei — HOLD_FOR_VERIFICATION يفوز حتى مع mode=PLANNING (جهاز حي متأخر قبل البدء)', () => {
  it('operationalDecision=HOLD_FOR_VERIFICATION + mode=PLANNING → نفس معاملة الوضع الحي (RESTRICT/ORANGE)، لا نص PLANNING العام', () => {
    const aei = buildAei({ statusLabelAr: 'قابل للتنفيذ مع مراقبة', color: 'YELLOW', score: 26 });
    const decision = buildDecision({
      mode: 'PLANNING',
      operationalDecision: 'HOLD_FOR_VERIFICATION',
      decisionLabelAr: 'بانتظار تحقق ميداني — بيانات غير كافية',
      shortReasonAr: 'تعذّر اعتماد قرار واثق: بيانات القراءة الحالية قديمة أو غير متوفرة — يتطلب تحقق ميداني قبل الاستمرار.',
      level: 'ORANGE',
    });
    const result = applyFinalDecisionToAei(aei, decision, null);

    expect(result.status).toBe('RESTRICT');
    expect(result.statusLabelAr).toBe('بانتظار تحقق ميداني — بيانات غير كافية');
    expect(result.color).toBe('ORANGE');
    expect(result.isHoldForVerification).toBe(true);
    // لا يجوز أن يظهر نص "قابل للتنفيذ مع مراقبة" الأصلي — هذا بالضبط ما
    // كان يحدث قبل الإصلاح (فرع mode==='PLANNING' يفوز أولاً بلا شرط).
    expect(result.statusLabelAr).not.toBe('قابل للتنفيذ مع مراقبة');
  });

  it('operationalDecision=MONITOR (لا HOLD_FOR_VERIFICATION) + mode=PLANNING → يبقى السلوك القديم (فرع PLANNING العام)', () => {
    const aei = buildAei();
    const decision = buildDecision({ mode: 'PLANNING', operationalDecision: 'MONITOR' });
    const result = applyFinalDecisionToAei(aei, decision, null);

    expect(result.isHoldForVerification).toBeFalsy();
    expect(result.statusLabelAr).toBe('تنبيه: أجواء متوقعة غير مناسبة');
  });
});
