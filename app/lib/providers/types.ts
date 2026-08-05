// عقد Connector موحّد لمصادر بيانات pull (محطات رصد خارجية تُسحب قراءاتها
// دورياً، بدل جهاز فعلي يدفع بياناته عبر /api/devices/ingest). أي شركة
// جديدة تُضاف لاحقاً (Aeroqual/Vaisala/IQAir/إلخ) تطبّق هذا الـinterface
// فقط — لا تعديل على الـschema أو الـcron أو الواجهة عند الإضافة.

export type MeasurementField =
  | 'windSpeedKmh'
  | 'windGustKmh'
  | 'windDirectionDeg'
  | 'pm10'
  | 'pm25'
  | 'visibilityM'
  | 'relativeHumidityPercent'
  | 'temperatureC';

// قياس واحد بوقت رصد مستقل — القسم 8.1 من "دليل الإصلاح الجذري لمنظومة
// مرقاب": يحل محل افتراض "وقت رصد واحد للحمولة كلها" (observedAtIso على
// مستوى NormalizedReading أدناه)، الذي كان يجعل ThingsBoard يأخذ أحدث
// timestamp عبر كل الحقول ويطبّقه على الجميع (راجع thingsboardConnector.ts).
export interface NormalizedMetricPoint {
  value: number;
  observedAtIso: string;
}

// شكل قراءة موحّد يطابق تماماً حقول عقد الكتابة في
// app/lib/deviceReadingWriter.ts (نفسه مُستخرَج من /api/devices/ingest) —
// أي Connector يُنتج هذا الشكل مباشرة بلا تحويل إضافي عند نقطة الكتابة.
export interface NormalizedReading {
  // وقت رصد فعلي من المصدر، ISO — اختياري (بعض مصادر push القديمة لا
  // ترسله)؛ عند غيابه writeDeviceReading تستخدم وقت وصول الخادم بدلاً منه
  // (راجع app/lib/deviceReadingWriter.ts). يبقى fallback للحقول التي لا
  // تظهر في fields أدناه (توافق تدريجي مع Connectors لم تُحدَّث بعد).
  observedAtIso?: string;
  windSpeedKmh?: number;
  windGustKmh?: number;
  windDirectionDeg?: number; // 0-360
  pm10?: number;
  pm25?: number;
  visibilityM?: number;
  relativeHumidityPercent?: number; // 0-100
  temperatureC?: number; // -20..70

  // وقت رصد مستقل لكل حقل (اختياري) — Connectors تدعم عقد الحدث الجديد
  // (مثال: ThingsBoard) تملأ هذا الحقل بدل observedAtIso المشترك أعلاه.
  // حقل موجود هنا لكن غائب من fields يستخدم observedAtIso العام كـfallback
  // (راجع resolveFieldTimestamps في deviceReadingWriter.ts).
  fields?: Partial<Record<MeasurementField, NormalizedMetricPoint>>;
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

// خطأ أمني مكتشَف ومُصلَح (القسم 15.1 من "دليل الإصلاح الجذري لمنظومة
// مرقاب" — "لا تسمح بعنوان عشوائي في الإنتاج"): base_url لم يعد جزءاً من
// credentials الحرة التي يكتبها المستخدم — origin يُحل الآن حصراً من
// provider_instances (سجل معتمد من مسؤول النظام، راجع app/api/admin/
// provider-instances/route.ts) ويُمرَّر منفصلاً لكل استدعاء Connector.
// Connector لا يقرأ base_url من credentials بعد الآن؛ mockConnector يتجاهل
// origin كلياً (لا اتصال شبكي حقيقي أصلاً).
export interface ProviderConnector {
  // معرّف فريد يطابق عمود provider_connections.provider
  id: string;
  // اسم معروض بالواجهة (عربي)
  displayName: string;
  credentialFields?: ProviderCredentialField[];
  // true = هذا الـConnector يتصل فعلياً بشبكة خارجية، فيجب أن يأتي origin من
  // provider_instances معتمد (لا من إدخال حر) — راجع القسم 15.1. mockConnector
  // يتركه false/غير معرَّف (لا اتصال شبكي أصلاً، لا حاجة لموافقة مسؤول).
  requiresProviderInstance?: boolean;

  testConnection(origin: string, credentials: ProviderCredentials): Promise<ConnectionTestResult>;
  listStations(origin: string, credentials: ProviderCredentials): Promise<VendorStation[]>;
  // null = لا قراءة جديدة متاحة حالياً (ليس خطأً، فقط لا شيء لكتابته الآن)
  fetchLatestReading(
    origin: string,
    credentials: ProviderCredentials,
    vendorStationId: string
  ): Promise<NormalizedReading | null>;
}
