// عقد Connector موحّد لمصادر بيانات pull (محطات رصد خارجية تُسحب قراءاتها
// دورياً، بدل جهاز فعلي يدفع بياناته عبر /api/devices/ingest). أي شركة
// جديدة تُضاف لاحقاً (Aeroqual/Vaisala/IQAir/إلخ) تطبّق هذا الـinterface
// فقط — لا تعديل على الـschema أو الـcron أو الواجهة عند الإضافة.

// شكل قراءة موحّد يطابق تماماً حقول عقد الكتابة في
// app/lib/deviceReadingWriter.ts (نفسه مُستخرَج من /api/devices/ingest) —
// أي Connector يُنتج هذا الشكل مباشرة بلا تحويل إضافي عند نقطة الكتابة.
export interface NormalizedReading {
  // وقت رصد فعلي من المصدر، ISO — اختياري (بعض مصادر push القديمة لا
  // ترسله)؛ عند غيابه writeDeviceReading تستخدم وقت وصول الخادم بدلاً منه
  // (راجع app/lib/deviceReadingWriter.ts). Connectors الجديدة (pull) يجب أن
  // ترسله دائماً فعلياً — هو وقت الرصد الحقيقي عند الشركة، لا وقت الآن.
  observedAtIso?: string;
  windSpeedKmh?: number;
  windGustKmh?: number;
  windDirectionDeg?: number; // 0-360
  pm10?: number;
  pm25?: number;
  visibilityM?: number;
  relativeHumidityPercent?: number; // 0-100
  temperatureC?: number; // -20..70
}

export interface VendorStation {
  vendorStationId: string;
  vendorStationName: string;
}

export interface ConnectionTestResult {
  success: boolean;
  // رسالة عربية آمنة للعرض المباشر بالواجهة عند الفشل — لا تفاصيل تقنية
  // خام (رسائل أخطاء شبكة/HTTP الخام تبقى في console.error فقط).
  errorMessage?: string;
}

// بيانات الاتصال — JSONB حر بقاعدة البيانات، لكن نوعها بالتطبيق دائماً
// نصوص فقط (كل الحقول: base_url/api_key/access_token/إلخ)، يفسّرها كل
// Connector بحسب حاجته الخاصة.
export type ProviderCredentials = Record<string, string>;

// وصف حقل اتصال اختياري لبناء نموذج ديناميكي بالواجهة — نقطة توسّع: لو
// Connector حقيقي لاحقاً احتاج حقولاً مختلفة عن base_url/api_key الافتراضيين
// (مثال: client_id + client_secret)، يُعرِّف هذا الحقل بدل الاعتماد على
// النموذج الثابت العام. اختياري تماماً؛ Connector بلا credentialFields يستخدم
// النموذج الافتراضي (base_url اختياري + api_key مطلوب).
export interface ProviderCredentialField {
  key: string;
  label: string;
  type: 'text' | 'password';
  required: boolean;
}

export interface ProviderConnector {
  // معرّف فريد يطابق عمود provider_connections.provider
  id: string;
  // اسم معروض بالواجهة (عربي)
  displayName: string;
  credentialFields?: ProviderCredentialField[];

  testConnection(credentials: ProviderCredentials): Promise<ConnectionTestResult>;
  listStations(credentials: ProviderCredentials): Promise<VendorStation[]>;
  // null = لا قراءة جديدة متاحة حالياً (ليس خطأً، فقط لا شيء لكتابته الآن)
  fetchLatestReading(
    credentials: ProviderCredentials,
    vendorStationId: string
  ): Promise<NormalizedReading | null>;
}
