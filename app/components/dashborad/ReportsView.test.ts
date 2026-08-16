import { describe, it, expect, vi } from 'vitest';

// ReportsView.tsx يستورد apiClient (app/lib/apiClient.ts → app/lib/supabase.ts)
// على مستوى الوحدة — يحتاج متغيرات بيئة حقيقية عند الاستيراد الفعلي.
// الاختبارات هنا تستهدف فقط escapeHtml (دالة نقية، بلا أي استدعاء شبكة)،
// فنموّه بديل فارغ لتفادي فشل تهيئة العميل في بيئة الاختبار.
vi.mock('@/app/lib/apiClient', () => ({ apiClient: {} }));

const { escapeHtml } = await import('./ReportsView');

// خطأ أمني مكتشَف ومُصلَح (طلب صريح من المستخدم — "تصدير التقرير يضع اسم
// المشروع داخل document.write دون تعقيم HTML"): اسم المشروع نص حر يختاره
// المالك بلا أي تحقق من محتواه (POST /api/projects لا يطبّق schema على
// name، PATCH يحدّ الطول فقط لا المحتوى) — كان يصل خاماً لقالب HTML واحد
// يُمرَّر كاملاً لـdocument.write في handleExportPdf، بلا أي تعقيم — XSS
// مخزَّن ممكن عبر اسم مشروع خبيث. escapeHtml هي الإصلاح، مُطبَّقة على كل
// قيمة نصية حرة (اسم مشروع) قبل الدمج في القالب.
describe('escapeHtml', () => {
  it('يُعقِّم وسم script كاملاً — لا ينفَّذ كـHTML حي', () => {
    const malicious = '<script>alert(1)</script>';
    const result = escapeHtml(malicious);
    expect(result).not.toContain('<script>');
    expect(result).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('يُعقِّم محاولة حقن عبر سمة onerror', () => {
    const malicious = '<img src=x onerror="alert(1)">';
    const result = escapeHtml(malicious);
    expect(result).not.toContain('<img');
    expect(result).toBe('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
  });

  it('يُعقِّم علامات الاقتباس المفردة (كسر سمة HTML محاطة بـ)', () => {
    expect(escapeHtml(`O'Brien Construction`)).toBe('O&#39;Brien Construction');
  });

  it('يُعقِّم علامة & نفسها (يجب أن تُعالَج أولاً لتفادي ازدواج الترميز)', () => {
    expect(escapeHtml('A & B')).toBe('A &amp; B');
  });

  it('نص عربي عادي بلا رموز خاصة يبقى بلا تغيير', () => {
    expect(escapeHtml('مشروع الرياض للإسكان')).toBe('مشروع الرياض للإسكان');
  });

  it('نص فارغ يبقى فارغاً', () => {
    expect(escapeHtml('')).toBe('');
  });

  it('كل الرموز الخمسة معاً في نص واحد تُعقَّم جميعها بشكل صحيح', () => {
    const input = `<a href="x" onclick='y'>A & B</a>`;
    const result = escapeHtml(input);
    expect(result).toBe('&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;A &amp; B&lt;/a&gt;');
    expect(result).not.toMatch(/[<>]/);
  });
});
