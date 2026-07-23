import { describe, it, expect } from 'vitest';
import { applyComplianceGatesToDustAei } from './dustEvaluation';
import { isRegulatoryWindGateActive } from '@/app/utils/dust-compliance-engine';
import type { AeiEvaluationResult } from '@/app/utils/aei-engine/types';

// =====================================================================
// اختبارات تناغم AEI ("قابلية التنفيذ") وبوابة الرياح الساعية مع قرار
// الامتثال التنظيمي — يمنعان عرض "قابل للتنفيذ"/ساعة "آمنة" رغم إيقاف
// تنظيمي فعلي لنفس اللحظة (التناقض الذي رصده المستخدم بين توصية DVI
// الخضراء وقرار الامتثال الأحمر لنفس النشاط في نفس الوقت).
// =====================================================================

function baseAei(overrides: Partial<AeiEvaluationResult> = {}): AeiEvaluationResult {
  return {
    indicatorType: 'AEI',
    activityLabelAr: 'سفلتة',
    status: 'ALLOW',
    statusLabelAr: 'قابل للتنفيذ',
    color: 'GREEN',
    score: 94.6,
    safetyScore: 94.6,
    qualityScore: 96,
    baseScore: 94.6,
    closedByGate: false,
    cappedByGate: false,
    gateReasonAr: null,
    shortReasonAr: 'الأجواء ممتازة والظروف آمنة.',
    recommendationAr: 'استمر بالعمل، لا توجد قيود حالية.',
    sources: [],
    ...overrides,
  };
}

describe('applyComplianceGatesToDustAei — قص AEI عند إيقاف تنظيمي', () => {
  it('يقص AEI إلى CLOSED/0 عندما يوقف الامتثال النشاط (MANDATORY_STOP)', () => {
    const dustResults = [
      { activityId: '1', aei: baseAei(), compliance: { decisionCategory: 'MANDATORY_STOP', shortReasonAr: 'رياح تتجاوز الحد' } },
    ];
    applyComplianceGatesToDustAei(dustResults);
    expect(dustResults[0].aei.status).toBe('CLOSED');
    expect(dustResults[0].aei.score).toBe(0);
    expect(dustResults[0].aei.color).toBe('BLACK');
    expect(dustResults[0].aei.closedByGate).toBe(true);
  });

  it('يقص AEI عند STOP_AFFECTED_ACTIVITY أيضاً', () => {
    const dustResults = [
      { activityId: '1', aei: baseAei(), compliance: { decisionCategory: 'STOP_AFFECTED_ACTIVITY', shortReasonAr: 'إيقاف النشاط المتأثر' } },
    ];
    applyComplianceGatesToDustAei(dustResults);
    expect(dustResults[0].aei.status).toBe('CLOSED');
  });

  it('لا يمس AEI عندما يكون قرار الامتثال ALLOW', () => {
    const dustResults = [
      { activityId: '1', aei: baseAei(), compliance: { decisionCategory: 'ALLOW', shortReasonAr: 'لا مخالفات' } },
    ];
    applyComplianceGatesToDustAei(dustResults);
    expect(dustResults[0].aei.status).toBe('ALLOW');
    expect(dustResults[0].aei.score).toBe(94.6);
  });

  it('لا يمس AEI عندما لا توجد نتيجة امتثال (compliance = null)', () => {
    const dustResults = [{ activityId: '1', aei: baseAei(), compliance: null }];
    applyComplianceGatesToDustAei(dustResults);
    expect(dustResults[0].aei.status).toBe('ALLOW');
  });

  it('لا يكرر الإغلاق إن كان AEI مغلقاً أصلاً من بوابة DVI (closedByGate=true)', () => {
    const dvClosed = baseAei({ status: 'CLOSED', score: 0, closedByGate: true, gateReasonAr: 'إيقاف DVI' });
    const dustResults = [
      { activityId: '1', aei: dvClosed, compliance: { decisionCategory: 'MANDATORY_STOP', shortReasonAr: 'إيقاف تنظيمي' } },
    ];
    applyComplianceGatesToDustAei(dustResults);
    // يبقى سبب الإغلاق الأصلي (DVI) دون استبداله بسبب الامتثال
    expect(dustResults[0].aei.gateReasonAr).toBe('إيقاف DVI');
  });

  // سيناريو حقيقي رصده المستخدم: DVI ممتاز (93.4، "قابل للتنفيذ") بينما
  // الامتثال RESTRICT_ACTIVITY فعلياً (لا توجد شبكة/حاجز غبار حول موقع
  // الهدم) — لم يكن هذا يُقص إطلاقاً سابقاً لأن RESTRICT_ACTIVITY ليس ضمن
  // فئتي الإيقاف الكامل، فيظهر AEI أخضر "قابل للتنفيذ" متناقضاً مع "تقييد
  // النشاط" الظاهر بجانبه في قسم الامتثال.
  it('يقص AEI إلى RESTRICT (سقف AEI_RESTRICT_CAP) عند RESTRICT_ACTIVITY، لا يُترك بلا تأثير', () => {
    const dustResults = [
      {
        activityId: '1',
        aei: baseAei({ score: 93.4, safetyScore: 93.4, qualityScore: 96, baseScore: 93.4 }),
        compliance: {
          decisionCategory: 'RESTRICT_ACTIVITY',
          decisionLabelAr: 'تقييد النشاط',
          shortReasonAr: 'لا توجد شبكة/حاجز غبار حول موقع الهدم',
        },
      },
    ];
    applyComplianceGatesToDustAei(dustResults);
    expect(dustResults[0].aei.status).toBe('RESTRICT');
    expect(dustResults[0].aei.score).toBeLessThan(93.4);
    expect(dustResults[0].aei.score).toBe(59);
    expect(dustResults[0].aei.cappedByGate).toBe(true);
    // السبب المعروض يجب أن يصبح السبب التنظيمي، لا نص التقييم الفيزيائي
    // الأصلي — وإلا ظهرت البطاقة بعنوان "تقييد تشغيلي" وتحته مباشرة
    // "الأجواء ممتازة والظروف آمنة" (تناقض صريح رصده المستخدم).
    expect(dustResults[0].aei.shortReasonAr).toBe('لا توجد شبكة/حاجز غبار حول موقع الهدم');
    expect(dustResults[0].aei.shortReasonAr).not.toContain('الظروف آمنة');
  });

  it('لا يرفع AEI أبداً — إن كان أصلاً أقل من سقف RESTRICT يبقى كما هو', () => {
    const dustResults = [
      {
        activityId: '1',
        aei: baseAei({ score: 40, status: 'RESTRICT', color: 'RED' }),
        compliance: { decisionCategory: 'RESTRICT_ACTIVITY', decisionLabelAr: 'تقييد النشاط', shortReasonAr: 'سبب ما' },
      },
    ];
    applyComplianceGatesToDustAei(dustResults);
    expect(dustResults[0].aei.score).toBe(40);
  });

  it('يقص AEI أيضاً عند FIELD_VERIFICATION_REQUIRED (بيانات ناقصة تمنع قراراً حاسماً)', () => {
    const dustResults = [
      {
        activityId: '1',
        aei: baseAei(),
        compliance: { decisionCategory: 'FIELD_VERIFICATION_REQUIRED', decisionLabelAr: 'يتطلب تحقق ميداني', shortReasonAr: 'بيانات ناقصة' },
      },
    ];
    applyComplianceGatesToDustAei(dustResults);
    expect(dustResults[0].aei.status).toBe('RESTRICT');
    expect(dustResults[0].aei.score).toBe(59);
  });
});

describe('isRegulatoryWindGateActive — بوابة الرياح التنظيمية الساعية', () => {
  it('تُفعَّل عند رياح >25 كم/س لنشاط مكشوف مولّد للغبار', () => {
    expect(isRegulatoryWindGateActive(29.66, true, false)).toBe(true);
  });

  it('لا تُفعَّل عند رياح =25 كم/س بالضبط (الحد الأعلى للنطاق المتوسط)', () => {
    expect(isRegulatoryWindGateActive(25, true, false)).toBe(false);
  });

  it('لا تُفعَّل لعملية مغلقة حتى مع رياح شديدة', () => {
    expect(isRegulatoryWindGateActive(30, true, true)).toBe(false);
  });

  it('لا تُفعَّل لنشاط غير مولّد للغبار', () => {
    expect(isRegulatoryWindGateActive(30, false, false)).toBe(false);
  });

  it('لا تُفعَّل مع رياح غير معروفة (null)', () => {
    expect(isRegulatoryWindGateActive(null, true, false)).toBe(false);
  });
});
