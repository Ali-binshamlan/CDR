import { describe, it, expect } from 'vitest';
import { ALERT_KIND_WEIGHT, alertKindToDecision, alertKindLabelAr, pickMostSevereAlert, dviLevelToDecision, decisionMeta } from './decisionMeta';

// طلب مستخدم صريح: "نريد جعلها مثل مؤشر الامتثال 3 مستويات فقط" — Decision
// كانت 5 قيم (safe/caution/restricted/postpone/stopped)، أصبحت 3 فقط
// (safe/restricted/stopped). caution اندمجت في safe، postpone اندمجت في
// stopped — دمج عرضي بحت، لا تغيير على أي منطق قرار حقيقي.
describe('Decision — دمج 5 مستويات إلى 3 (طلب مستخدم صريح)', () => {
  it('decisionMeta يحمل 3 مفاتيح فقط', () => {
    expect(Object.keys(decisionMeta).sort()).toEqual(['restricted', 'safe', 'stopped']);
  });

  it('alertKindToDecision: DUST (كانت postpone) أصبحت stopped', () => {
    expect(alertKindToDecision('DUST')).toBe('stopped');
  });

  it('alertKindToDecision: COMPLIANCE_ADVISORY/PM10_APPROACHING_LIMIT/NO_DECISION_YET/FORECAST_WARNING/BEFORE_START (كانت caution) أصبحت safe', () => {
    for (const kind of ['COMPLIANCE_ADVISORY', 'PM10_APPROACHING_LIMIT', 'NO_DECISION_YET', 'FORECAST_WARNING', 'BEFORE_START']) {
      expect(alertKindToDecision(kind)).toBe('safe');
    }
  });

  it('alertKindToDecision: COMPLIANCE_RESTRICTION تبقى restricted (لم تتغيّر)', () => {
    expect(alertKindToDecision('COMPLIANCE_RESTRICTION')).toBe('restricted');
  });

  it('dviLevelToDecision: RED (كانت postpone) أصبحت stopped', () => {
    expect(dviLevelToDecision('RED', false)).toBe('stopped');
  });

  it('dviLevelToDecision: YELLOW (كانت caution) أصبحت safe', () => {
    expect(dviLevelToDecision('YELLOW', false)).toBe('safe');
  });

  it('dviLevelToDecision: ORANGE تبقى restricted (لم تتغيّر)', () => {
    expect(dviLevelToDecision('ORANGE', false)).toBe('restricted');
  });

  it('dviLevelToDecision: BLACK/DARK_RED/mandatoryStop تبقى stopped (لم تتغيّر)', () => {
    expect(dviLevelToDecision('BLACK', false)).toBe('stopped');
    expect(dviLevelToDecision('DARK_RED', false)).toBe('stopped');
    expect(dviLevelToDecision('GREEN', true)).toBe('stopped');
  });
});

// خطأ مكتشَف ومُصلَح (مراجعة كود خارجي — "Outbox يخلط الإيقاف الإلزامي
// والاحترازي"، راجع migration 202608110020 الكامل): أول ملف اختبار لهذا
// الملف (لم يكن موجوداً قبل هذا التصحيح) — يغطي تحديداً إضافة PROTECTIVE_STOP
// كـkind مستقل، لا يُعامَل كـSAFETY_BREACH.
describe('PROTECTIVE_STOP kind مستقل (اختبار قبول صريح)', () => {
  it('ALERT_KIND_WEIGHT يحتوي PROTECTIVE_STOP بوزن أقل من SAFETY_BREACH/COMPLIANCE_VIOLATION المؤكَّدين (نفس درجة DUST — لا يقين كافٍ بعد لمساواة إيقاف مؤكَّد)', () => {
    expect(ALERT_KIND_WEIGHT.PROTECTIVE_STOP).toBeDefined();
    expect(ALERT_KIND_WEIGHT.PROTECTIVE_STOP).toBeLessThan(ALERT_KIND_WEIGHT.SAFETY_BREACH);
    expect(ALERT_KIND_WEIGHT.PROTECTIVE_STOP).toBeLessThan(ALERT_KIND_WEIGHT.COMPLIANCE_VIOLATION);
    expect(ALERT_KIND_WEIGHT.PROTECTIVE_STOP).toBeGreaterThan(ALERT_KIND_WEIGHT.COMPLIANCE_RESTRICTION);
  });

  it("alertKindToDecision('PROTECTIVE_STOP') = 'stopped' (النشاط متوقف فعلياً الآن، نفس أثر mandatoryStop التشغيلي)", () => {
    expect(alertKindToDecision('PROTECTIVE_STOP')).toBe('stopped');
  });

  it('alertKindLabelAr يحمل نصاً عربياً منفصلاً لـPROTECTIVE_STOP، لا نفس نص SAFETY_BREACH', () => {
    expect(alertKindLabelAr.PROTECTIVE_STOP).toBeDefined();
    expect(alertKindLabelAr.PROTECTIVE_STOP).not.toBe(alertKindLabelAr.SAFETY_BREACH);
    expect(alertKindLabelAr.PROTECTIVE_STOP).toContain('احترازي');
  });

  it('pickMostSevereAlert: PROTECTIVE_STOP أخطر من COMPLIANCE_RESTRICTION لكن أقل من SAFETY_BREACH المؤكَّد', () => {
    const alerts = [{ kind: 'PROTECTIVE_STOP' }, { kind: 'COMPLIANCE_RESTRICTION' }];
    expect(pickMostSevereAlert(alerts)?.kind).toBe('PROTECTIVE_STOP');

    const withSafetyBreach = [...alerts, { kind: 'SAFETY_BREACH' }];
    expect(pickMostSevereAlert(withSafetyBreach)?.kind).toBe('SAFETY_BREACH');
  });
});
