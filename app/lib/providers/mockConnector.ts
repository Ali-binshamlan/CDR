import type { ProviderConnector, ProviderCredentials, NormalizedReading, VendorStation } from './types';

// Connector وهمي بلا أي اتصال شبكي حقيقي — يثبت المسار الكامل (واجهة →
// اختبار اتصال → جلب محطات → ربط → cron → كتابة → محرك DVI) بلا انتظار أي
// شركة حقيقية. أي Connector حقيقي لاحقاً (Aeroqual/IQAir/إلخ) يطبّق نفس
// الواجهة (ProviderConnector) بنفس التوقيعات بالضبط — راجع registry.ts
// لكيفية تسجيله.

const MOCK_STATIONS: VendorStation[] = [
  { vendorStationId: 'DEMO-01', vendorStationName: 'Demo Station North' },
  { vendorStationId: 'DEMO-02', vendorStationName: 'Demo Station South' },
];

function randomInRange(min: number, max: number): number {
  return Math.round((min + Math.random() * (max - min)) * 10) / 10;
}

export const mockConnector: ProviderConnector = {
  id: 'mock',
  displayName: 'محطة تجريبية (Mock Provider)',
  credentialFields: [{ key: 'api_key', label: 'مفتاح API (تجريبي)', type: 'password', required: true }],

  async testConnection(credentials: ProviderCredentials) {
    // قيمة مخصصة للاختبار اليدوي: api_key === 'invalid' يفشل عمداً — يثبت
    // مسار عرض رسالة الخطأ بالواجهة بلا انتظار شركة حقيقية تُرجع فشلاً.
    if (credentials.api_key === 'invalid') {
      return { success: false, errorMessage: 'مفتاح API غير صالح (تجريبي)' };
    }
    return { success: true };
  },

  async listStations(_credentials: ProviderCredentials) {
    return MOCK_STATIONS;
  },

  async fetchLatestReading(_credentials: ProviderCredentials, vendorStationId: string): Promise<NormalizedReading | null> {
    if (!MOCK_STATIONS.some((s) => s.vendorStationId === vendorStationId)) return null;
    return {
      observedAtIso: new Date().toISOString(),
      pm10: randomInRange(20, 100),
      pm25: randomInRange(10, 60),
      windSpeedKmh: randomInRange(0, 30),
      windDirectionDeg: randomInRange(0, 360),
      relativeHumidityPercent: randomInRange(20, 60),
      temperatureC: randomInRange(20, 40),
    };
  },
};
