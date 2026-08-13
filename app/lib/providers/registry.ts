import type { ProviderConnector } from './types';
import { mockConnector } from './mockConnector';
import { thingsboardConnector } from './thingsboardConnector';

// سجل مركزي لكل Connectors المتاحة — إضافة شركة جديدة = استيراد Connector
// جديد + سطر واحد هنا. لا كود آخر بالنظام (مسار الـcron، الواجهة، مسارات
// الاختبار/الربط) يحتاج تعديلاً عند إضافة شركة.
const registry = new Map<string, ProviderConnector>([
  [mockConnector.id, mockConnector],
  [thingsboardConnector.id, thingsboardConnector],
]);

// خطأ أمني مكتشَف — مراجعة كود خبير خارجي: "mockConnector متاح في سجل
// المزوّدين الإنتاجي ويولّد قراءات عشوائية تُحفظ كبيانات جهاز حقيقية".
// mockConnector.fetchLatestReading يُنتج pm10/رياح عشوائية (راجع mockConnector.ts)
// تُكتَب فعلياً في device_readings_history وتدخل حساب قرار DVI/الامتثال
// الحقيقي — بلا هذا الحاجز، أي طلب API مباشر (بتجاوز الواجهة) بـ
// provider: 'mock' في الإنتاج يقدر يُغرق نشاطاً حقيقياً بقراءات وهمية.
function isMockProviderAllowed(): boolean {
  return process.env.NODE_ENV !== 'production';
}

export function getConnector(providerId: string): ProviderConnector | null {
  if (providerId === mockConnector.id && !isMockProviderAllowed()) return null;
  return registry.get(providerId) ?? null;
}

export function listAvailableProviders(): Array<{
  id: string;
  displayName: string;
  credentialFields?: ProviderConnector['credentialFields'];
  requiresProviderInstance?: boolean;
}> {
  return Array.from(registry.values())
    .filter((c) => c.id !== mockConnector.id || isMockProviderAllowed())
    .map((c) => ({
      id: c.id,
      displayName: c.displayName,
      credentialFields: c.credentialFields,
      requiresProviderInstance: c.requiresProviderInstance,
    }));
}
