import { describe, it, expect } from 'vitest';
import { LIVE_FIELD_FRESHNESS_MS, DEVICE_CONNECTION_FRESHNESS_MS, freshnessThresholdMsFor } from './field-freshness';

// =====================================================================
// خطأ مكتشَف ومُصلَح (مراجعة خبير خارجي — البند 3: "تصنيف حداثة مركزي لكل
// Metric"): هذا الملف يثبت قيمتَي العتبة المركزيتين — أي انحراف مستقبلي
// غير مقصود يفشل هنا فوراً بدل الانتشار بصمت عبر الملفات الأربعة التي
// تستهلكهما (dust-engine/engine.ts، dustEvaluation.ts، final-decision-
// engine/adapters.ts، Compliancewidgetcard.tsx).
//
// DEVICE_CONNECTION_FRESHNESS_MS كانت 20 دقيقة، ثم 10 دقائق (تفادياً
// لإنذار كاذب على أجهزة ترسل كل 5-8 دقائق بشكل طبيعي). قرار مستخدم صريح
// لاحق (2026-08-09): سياسة المشروع تُلزم كل جهاز رصد حقيقي بوتيرة إرسال
// دقيقة واحدة — لا وجود لجهاز "بطيء طبيعياً" ضمن الأجهزة المدعومة، فلا خطر
// إنذار كاذب. العتبتان توحَّدتا الآن على 4 دقائق — "لا قرار واثق بلا
// قراءة خلال آخر 4 دقائق" بلا استثناء.
// =====================================================================

describe('field-freshness — القيم المركزية موحَّدة وصحيحة', () => {
  it('LIVE_FIELD_FRESHNESS_MS = 4 دقائق بالضبط (عتبة القرار الفيزيائي اللحظي/استمرار PM10)', () => {
    expect(LIVE_FIELD_FRESHNESS_MS).toBe(4 * 60_000);
  });

  it('DEVICE_CONNECTION_FRESHNESS_MS = 4 دقائق بالضبط (عتبة اتصال المحطة العامة/evidenceQuality — موحَّدة مع LIVE بقرار مستخدم صريح)', () => {
    expect(DEVICE_CONNECTION_FRESHNESS_MS).toBe(4 * 60_000);
  });

  it('القيمتان موحَّدتان عمداً الآن (قرار مستخدم صريح 2026-08-09 — كل جهاز يرسل كل دقيقة، فلا حاجة لعتبة أوسع)', () => {
    expect(LIVE_FIELD_FRESHNESS_MS).toBe(DEVICE_CONNECTION_FRESHNESS_MS);
  });

  it('freshnessThresholdMsFor: كل حقول القرار الحي الفيزيائي (رياح/رؤية/PM2.5/رطوبة/حرارة/استمرار PM10) تُعيد عتبة LIVE', () => {
    const liveMetrics = ['windSpeed', 'windGust', 'windDirection', 'visibility', 'pm25', 'relativeHumidity', 'temperature', 'pm10Continuity'] as const;
    for (const metric of liveMetrics) {
      expect(freshnessThresholdMsFor(metric)).toBe(LIVE_FIELD_FRESHNESS_MS);
    }
  });

  it('freshnessThresholdMsFor: اتصال الجهاز العام يُعيد عتبة DEVICE_CONNECTION', () => {
    expect(freshnessThresholdMsFor('deviceConnection')).toBe(DEVICE_CONNECTION_FRESHNESS_MS);
  });
});
