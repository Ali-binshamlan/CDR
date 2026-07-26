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

function complianceWith(decisionCategory: DustComplianceResult['decisionCategory'], decisionLabelAr: string, shortReasonAr: string): DustComplianceResult {
  return { decisionCategory, decisionLabelAr, shortReasonAr } as DustComplianceResult;
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
  });
});
