import { describe, it, expect } from 'vitest';
import { determineFinalDecisionMode } from './dustEvaluation';

// =====================================================================
// اختبارات determineFinalDecisionMode — خطأ مكتشَف ومُصلَح (مراجعة كود
// خبير خارجي — C-06: "توقّع مستقبلي قد يُحفظ بصفة LIVE"): persistFinalDecisions
// كانت تحفظ كل قرار final_decisions بوضع LIVE_OPERATIONAL دائماً، حتى لو
// كان windowEval.worst المستخدَم فعلياً توقّع طقس مستقبلي (نشاط لم يبدأ
// بعد بأكثر من الهامش) لا قراءة جهاز حية. نفس هامش ACTIVITY_LIVE_MARGIN_MS
// المستخدَم في dust-engine/engine.ts (isActivityLiveNow) يُطبَّق هنا لتحديد
// mode الصحيح عند الحفظ.
//
// الهامش كان 30 دقيقة، أصبح ساعتان (طلب مستخدم صريح لاحق — "جهاز الرصد
// يتفعّل قبل ساعتين من بداية النشاط")، راجع نفس الثابت في dust-engine/engine.ts.
// =====================================================================

describe('determineFinalDecisionMode', () => {
  it('نشاط بدأ بالفعل (وقت البدء في الماضي) → LIVE_OPERATIONAL', () => {
    const startIso = new Date(Date.now() - 60 * 60000).toISOString(); // بدأ منذ ساعة
    expect(determineFinalDecisionMode(startIso)).toBe('LIVE_OPERATIONAL');
  });

  it('نشاط سيبدأ خلال 10 دقائق (ضمن الهامش الحي ساعتان) → LIVE_OPERATIONAL', () => {
    const startIso = new Date(Date.now() + 10 * 60000).toISOString();
    expect(determineFinalDecisionMode(startIso)).toBe('LIVE_OPERATIONAL');
  });

  it('نشاط سيبدأ خلال 119 دقيقة (لا يزال ضمن الهامش) → LIVE_OPERATIONAL', () => {
    const startIso = new Date(Date.now() + 119 * 60000).toISOString();
    expect(determineFinalDecisionMode(startIso)).toBe('LIVE_OPERATIONAL');
  });

  it('نشاط سيبدأ خلال 121 دقيقة (تجاوز الهامش) → PLANNING', () => {
    const startIso = new Date(Date.now() + 121 * 60000).toISOString();
    expect(determineFinalDecisionMode(startIso)).toBe('PLANNING');
  });

  it('نشاط سيبدأ بعد يوم كامل → PLANNING بوضوح', () => {
    const startIso = new Date(Date.now() + 24 * 3600000).toISOString();
    expect(determineFinalDecisionMode(startIso)).toBe('PLANNING');
  });

  it('startIso غائب تماماً (null/undefined) → فشل آمن نحو LIVE_OPERATIONAL (السلوك القديم بلا تغيير)', () => {
    expect(determineFinalDecisionMode(null)).toBe('LIVE_OPERATIONAL');
    expect(determineFinalDecisionMode(undefined)).toBe('LIVE_OPERATIONAL');
  });

  it('startIso غير صالح (نص عشوائي) → فشل آمن نحو LIVE_OPERATIONAL', () => {
    expect(determineFinalDecisionMode('not-a-real-date')).toBe('LIVE_OPERATIONAL');
  });

  it('يقبل nowMs صريحاً — حتمي بالكامل بمعزل عن ساعة النظام الفعلية', () => {
    const fixedNow = new Date('2026-01-01T12:00:00.000Z').getTime();
    const startInThreeHours = new Date(fixedNow + 3 * 3600000).toISOString();
    expect(determineFinalDecisionMode(startInThreeHours, fixedNow)).toBe('PLANNING');
    expect(determineFinalDecisionMode(startInThreeHours, fixedNow + 65 * 60000)).toBe('LIVE_OPERATIONAL');
  });
});
