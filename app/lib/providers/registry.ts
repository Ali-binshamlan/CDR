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

export function getConnector(providerId: string): ProviderConnector | null {
  return registry.get(providerId) ?? null;
}

export function listAvailableProviders(): Array<{
  id: string;
  displayName: string;
  credentialFields?: ProviderConnector['credentialFields'];
}> {
  return Array.from(registry.values()).map((c) => ({
    id: c.id,
    displayName: c.displayName,
    credentialFields: c.credentialFields,
  }));
}
