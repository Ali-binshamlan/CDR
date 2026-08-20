import { describe, it, expect } from 'vitest';
import { determineFinalDecisionMode, isActivityLiveForDevice } from './dustEvaluation';

// =====================================================================
// اختبارات determineFinalDecisionMode — خطأ مكتشَف ومُصلَح (مراجعة كود
// خبير خارجي — C-06: "توقّع مستقبلي قد يُحفظ بصفة LIVE"): persistFinalDecisions
// كانت تحفظ كل قرار final_decisions بوضع LIVE_OPERATIONAL دائماً، حتى لو
// كان windowEval.worst المستخدَم فعلياً توقّع طقس مستقبلي (نشاط لم يبدأ
// بعد) لا قراءة جهاز حية.
//
// طلب مستخدم صريح لاحق (بلاغ مباشر: "لا تسجيل مخالفة قبل بدء النشاط
// فعلياً" — "تسجيل المخالفات للأنشطة الجارية فقط"): هامش الساعتين
// (ACTIVITY_LIVE_MARGIN_MS، أُضيف سابقاً بطلب صريح آخر — "جهاز الرصد
// يتفعّل قبل ساعتين") أُزيل من هذه الدالة تحديداً — كان يسمح بتسجيل
// مخالفات تنظيمية حقيقية لنشاط لم يبدأ بعد (حتى ساعتين قبل planned_time).
// الهامش نفسه يبقى مطبَّقاً فقط في نطاق منفصل تماماً: عرض القراءات الحية
// بالرسوم البيانية (WINDOW_START_MARGIN_MS في device-readings-history/
// pm10-history routes) — عرض قراءة مبكرة لا يساوي تسجيل مخالفة مبكرة.
// PLANNING يسري الآن حتى اللحظة الفعلية لـplanned_time بالضبط، بلا هامش.
// =====================================================================

describe('determineFinalDecisionMode', () => {
  it('نشاط بدأ بالفعل (وقت البدء في الماضي) → LIVE_OPERATIONAL', () => {
    const startIso = new Date(Date.now() - 60 * 60000).toISOString(); // بدأ منذ ساعة
    expect(determineFinalDecisionMode(startIso)).toBe('LIVE_OPERATIONAL');
  });

  it('نشاط سيبدأ خلال 10 دقائق (لم يبدأ بعد بالضبط) → PLANNING', () => {
    const startIso = new Date(Date.now() + 10 * 60000).toISOString();
    expect(determineFinalDecisionMode(startIso)).toBe('PLANNING');
  });

  it('نشاط سيبدأ خلال 119 دقيقة → PLANNING (لا هامش ساعتين بعد الآن)', () => {
    const startIso = new Date(Date.now() + 119 * 60000).toISOString();
    expect(determineFinalDecisionMode(startIso)).toBe('PLANNING');
  });

  it('نشاط سيبدأ خلال 121 دقيقة → PLANNING', () => {
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
    // اللحظة نفسها لبداية النشاط بالضبط (nowMs === startMs) → LIVE_OPERATIONAL
    // (الشرط nowMs < startMs، لا <=) — النشاط بدأ فعلياً هذه اللحظة.
    expect(determineFinalDecisionMode(startInThreeHours, fixedNow + 3 * 3600000)).toBe('LIVE_OPERATIONAL');
    // دقيقة واحدة قبل البداية بالضبط → لا يزال PLANNING (بلا أي هامش الآن).
    expect(determineFinalDecisionMode(startInThreeHours, fixedNow + 3 * 3600000 - 60000)).toBe('PLANNING');
  });
});

// =====================================================================
// اختبارات isActivityLiveForDevice — خطأ إعادة إنتاج مكتشَف ومُصلَح: إزالة
// هامش الساعتين من determineFinalDecisionMode (أعلاه) أثّرت بالخطأ على مسار
// الجهاز الحي أيضاً (isLiveActivity في computeDustResults، وisPlanning في
// evaluateDustCompliance عبر computeDustComplianceResults) — نشاط سيبدأ خلال
// 50 دقيقة (جهازه حي فعلياً) أصبح يُعامَل كتوقّع طقس عام بدل قراءة الجهاز
// الحية (بلاغ مباشر من المستخدم: لقطة شاشة تُظهر "سيتم تفعيل جهاز الرصد...
// قبل ساعتين من موعد البدء" لنشاط يبدأ خلال 50 دقيقة). isActivityLiveForDevice
// يستعيد هامش الساعتين لهذين المسارين تحديداً (يظهر كل شيء تبع الجهاز)، بينما
// determineFinalDecisionMode تبقى بلا هامش (لا تسجيل مخالفات قبل البدء).
// =====================================================================
describe('isActivityLiveForDevice', () => {
  it('نشاط سيبدأ خلال 50 دقيقة (ضمن هامش الساعتين) → حي بجهازه', () => {
    const startIso = new Date(Date.now() + 50 * 60000).toISOString();
    expect(isActivityLiveForDevice(startIso)).toBe(true);
  });

  it('نشاط سيبدأ خلال 119 دقيقة (لا يزال ضمن هامش الساعتين) → حي بجهازه', () => {
    const startIso = new Date(Date.now() + 119 * 60000).toISOString();
    expect(isActivityLiveForDevice(startIso)).toBe(true);
  });

  it('نشاط سيبدأ خلال 121 دقيقة (تجاوز هامش الساعتين) → ليس حياً بعد', () => {
    const startIso = new Date(Date.now() + 121 * 60000).toISOString();
    expect(isActivityLiveForDevice(startIso)).toBe(false);
  });

  it('نشاط بدأ بالفعل → حي بجهازه', () => {
    const startIso = new Date(Date.now() - 60 * 60000).toISOString();
    expect(isActivityLiveForDevice(startIso)).toBe(true);
  });

  it('startIso غائب/غير صالح → فشل آمن نحو حي بجهازه (نفس سلوك determineFinalDecisionMode)', () => {
    expect(isActivityLiveForDevice(null)).toBe(true);
    expect(isActivityLiveForDevice(undefined)).toBe(true);
    expect(isActivityLiveForDevice('not-a-real-date')).toBe(true);
  });

  it('يقبل nowMs صريحاً — حتمي بالكامل، وحدود الهامش دقيقة (ساعتان بالضبط)', () => {
    const fixedNow = new Date('2026-01-01T12:00:00.000Z').getTime();
    const startInThreeHours = new Date(fixedNow + 3 * 3600000).toISOString();
    // بعد ساعتين بالضبط قبل البدء (nowMs = startMs - 2h) → حي (>= لا >)
    expect(isActivityLiveForDevice(startInThreeHours, fixedNow + 3600000)).toBe(true);
    // دقيقة واحدة قبل حدود الهامش → ليس حياً بعد
    expect(isActivityLiveForDevice(startInThreeHours, fixedNow + 3600000 - 60000)).toBe(false);
  });

  it('نفس الحالة (activity يبدأ خلال 50 دقيقة): determineFinalDecisionMode=PLANNING لكن isActivityLiveForDevice=true — هذا هو الانفصال المقصود', () => {
    const fixedNow = Date.now();
    const startIso = new Date(fixedNow + 50 * 60000).toISOString();
    expect(determineFinalDecisionMode(startIso, fixedNow)).toBe('PLANNING');
    expect(isActivityLiveForDevice(startIso, fixedNow)).toBe(true);
  });
});
