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
// طلب مستخدم صريح نهائي لاحق ("القراءات تبدأ مع بداية النشاط وتقف مع
// نهاية النشاط — ألغِ هامش الساعتين نهائياً"): نفس الهامش أُزيل لاحقاً
// أيضاً من isActivityLiveForDevice أدناه (كان يبقيه لعرض القراءات الحية)
// ومن device-readings-history/pm10-history routes (الرسوم البيانية) —
// لا هامش متبقٍ في أي مكان الآن. PLANNING يسري حتى اللحظة الفعلية
// لـplanned_time بالضبط، بلا هامش.
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
// اختبارات isActivityLiveForDevice — تصميم نهائي (طلب مستخدم صريح: "القراءات
// تبدأ مع بداية النشاط وتقف مع نهاية النشاط — يعني اذا المشروع 8 ساعات
// يقرأ فترة الدوام فقط. ألغِ هامش الساعتين نهائياً"). محاولتان سابقتان
// أضافتا هامش ساعتين مبكر ("جهاز الرصد يتفعّل قبل ساعتين من بداية النشاط")
// ثم أُلغي بالكامل هنا، وأُضيف حد أعلى جديد (planned_time + duration) لم
// يكن موجوداً أصلاً — الجهاز يُعامَل حياً فقط ضمن [startMs, endMs] بالضبط.
// =====================================================================
describe('isActivityLiveForDevice', () => {
  it('نشاط سيبدأ خلال 50 دقيقة (لم يبدأ بعد بالضبط) → ليس حياً بعد (لا هامش)', () => {
    const startIso = new Date(Date.now() + 50 * 60000).toISOString();
    expect(isActivityLiveForDevice(startIso)).toBe(false);
  });

  it('نشاط سيبدأ خلال 5 دقائق → لا يزال ليس حياً (لا هامش مهما قرُب البدء)', () => {
    const startIso = new Date(Date.now() + 5 * 60000).toISOString();
    expect(isActivityLiveForDevice(startIso)).toBe(false);
  });

  it('نشاط بدأ منذ ساعة، مدته 8 ساعات (لا يزال ضمن نافذة الدوام) → حي بجهازه', () => {
    const startIso = new Date(Date.now() - 60 * 60000).toISOString();
    expect(isActivityLiveForDevice(startIso, Date.now(), 8)).toBe(true);
  });

  it('نشاط بدأ منذ 9 ساعات، مدته 8 ساعات (انتهى فعلياً) → ليس حياً بعد الآن', () => {
    const startIso = new Date(Date.now() - 9 * 3600000).toISOString();
    expect(isActivityLiveForDevice(startIso, Date.now(), 8)).toBe(false);
  });

  it('durationHours غائب (undefined) → بلا حد أعلى، حي إلى الأبد بعد البدء (السلوك التاريخي الأقدم، فشل آمن)', () => {
    const startIso = new Date(Date.now() - 100 * 3600000).toISOString(); // بدأ منذ 100 ساعة
    expect(isActivityLiveForDevice(startIso)).toBe(true);
  });

  it('durationHours=null صراحةً → نفس معاملة undefined (بلا حد أعلى)', () => {
    const startIso = new Date(Date.now() - 100 * 3600000).toISOString();
    expect(isActivityLiveForDevice(startIso, Date.now(), null)).toBe(true);
  });

  it('startIso غائب/غير صالح → فشل آمن نحو حي بجهازه (نفس سلوك determineFinalDecisionMode)', () => {
    expect(isActivityLiveForDevice(null)).toBe(true);
    expect(isActivityLiveForDevice(undefined)).toBe(true);
    expect(isActivityLiveForDevice('not-a-real-date')).toBe(true);
  });

  it('يقبل nowMs صريحاً — حتمي بالكامل، وحدود [بدء، نهاية] دقيقة', () => {
    const fixedNow = new Date('2026-01-01T12:00:00.000Z').getTime();
    const startIso = new Date(fixedNow + 3600000).toISOString(); // يبدأ بعد ساعة
    // قبل البدء بدقيقة → ليس حياً
    expect(isActivityLiveForDevice(startIso, fixedNow + 3600000 - 60000, 4)).toBe(false);
    // اللحظة نفسها لبداية النشاط بالضبط → حي (nowMs >= startMs، لا >)
    expect(isActivityLiveForDevice(startIso, fixedNow + 3600000, 4)).toBe(true);
    // نهاية النشاط بالضبط (بعد البدء بـ4 ساعات) → لا يزال حياً (nowMs <= endMs، لا <)
    expect(isActivityLiveForDevice(startIso, fixedNow + 3600000 + 4 * 3600000, 4)).toBe(true);
    // دقيقة واحدة بعد النهاية بالضبط → لم يعد حياً
    expect(isActivityLiveForDevice(startIso, fixedNow + 3600000 + 4 * 3600000 + 60000, 4)).toBe(false);
  });

  it('نفس الحالة (activity يبدأ خلال 50 دقيقة): determineFinalDecisionMode=PLANNING وisActivityLiveForDevice=false أيضاً — لا انفصال بعد الآن (التصميم النهائي)', () => {
    const fixedNow = Date.now();
    const startIso = new Date(fixedNow + 50 * 60000).toISOString();
    expect(determineFinalDecisionMode(startIso, fixedNow)).toBe('PLANNING');
    expect(isActivityLiveForDevice(startIso, fixedNow, 8)).toBe(false);
  });
});
