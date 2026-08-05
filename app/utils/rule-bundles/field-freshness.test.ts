import { describe, it, expect } from 'vitest';
import { LIVE_FIELD_FRESHNESS_MS, DEVICE_CONNECTION_FRESHNESS_MS, freshnessThresholdMsFor } from './field-freshness';

// =====================================================================
// خطأ مكتشَف ومُصلَح (مراجعة خبير خارجي — البند 3: "تصنيف حداثة مركزي لكل
// Metric"): هذا الملف يثبت أن القيمتين المركزيتين (LIVE و
// DEVICE_CONNECTION) تبقيان منفصلتين عمداً بقيمهما التاريخية الصحيحة (4 و20
// دقيقة على التوالي) — أي انحراف مستقبلي غير مقصود (دمجهما بالخطأ، أو تغيير
// إحداهما بلا تحديث الأخرى) يفشل هنا فوراً بدل الانتشار بصمت عبر الملفات
// الأربعة التي تستهلكهما (dust-engine/engine.ts، dustEvaluation.ts،
// final-decision-engine/adapters.ts، Compliancewidgetcard.tsx).
// =====================================================================

describe('field-freshness — القيم المركزية تبقى منفصلة وصحيحة تاريخياً', () => {
  it('LIVE_FIELD_FRESHNESS_MS = 4 دقائق بالضبط (عتبة القرار الفيزيائي اللحظي/استمرار PM10)', () => {
    expect(LIVE_FIELD_FRESHNESS_MS).toBe(4 * 60_000);
  });

  it('DEVICE_CONNECTION_FRESHNESS_MS = 20 دقيقة بالضبط (عتبة اتصال المحطة العامة/evidenceQuality)', () => {
    expect(DEVICE_CONNECTION_FRESHNESS_MS).toBe(20 * 60_000);
  });

  it('القيمتان مختلفتان عمداً — لا يجوز أن تتساويا (دمجهما كان سيغيّر سلوك استمرار PM10 أو تنبيهات قِدم القراءة)', () => {
    expect(LIVE_FIELD_FRESHNESS_MS).not.toBe(DEVICE_CONNECTION_FRESHNESS_MS);
    expect(LIVE_FIELD_FRESHNESS_MS).toBeLessThan(DEVICE_CONNECTION_FRESHNESS_MS);
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
