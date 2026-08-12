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
  // خطأ مكتشَف ومُصلَح (مراجعة خبير خارجي — التقرير النهائي: "العينة كل
  // دقيقتين لا تكفي — الصفحة 82 من المرجع التنظيمي تشترط بيانات PM10 لمدة
  // دقيقة وفترة تسجيل لا تتجاوز دقيقة. مع فجوة استمرارية 90 ثانية، عينة
  // واحدة كل دقيقتين لن تؤكد المخالفة أبداً؛ يمكن النقل كل دقيقتين فقط إذا
  // احتوت الإرسالية على جميع عينات الدقيقة بطوابعها المستقلة"):
  // fetchLatestReading وحدها (نقطة واحدة فقط لكل مقياس، آخر قيمة) لا تكفي
  // لإثبات استمرار PM10 حين تكون دورة السحب (provider-pull، كل ~دقيقتين)
  // أبطأ من فجوة الاستمرارية المسموحة (90 ثانية، ACTIVE_RULE_BUNDLE.pm10.
  // evidence.maxContinuityGapMs) — عينتان بفارق دقيقتين بالضبط تفشلان
  // دائماً في إثبات استمرار رياضياً (120 ثانية > 90 ثانية المسموحة).
  // fetchReadingsSince تجلب *كل* العينات التي أرسلتها المحطة منذ sinceMs
  // (لا آخر عينة فقط)، كل منها بطابعها الزمني المستقل — provider-pull
  // يكتبها جميعاً (كل واحدة صف مستقل في pm10_readings_history)، فيملأ
  // الفجوة الزمنية بين دورتَي سحب متتاليتين بعينات فعلية من المحطة، لا
  // بعينة واحدة تُنسَب زوراً لدورة كاملة مدتها دقيقتان. اختياري: Connector
  // لا يدعمها (mockConnector مثلاً) يترك undefined — provider-pull يسقط
  // حينها إلى fetchLatestReading وحدها (سلوك سابق، بلا كسر).
  // خطأ مكتشَف ومُصلَح (مراجعة كود خارجي — "نافذة عشر دقائق وحدود ThingsBoard
  // تقطع البيانات بصمت"): fetchReadingsSince كانت تُرجع مصفوفة مسطَّحة فقط،
  // فلا وسيلة للمستدعي (provider-pull/route.ts) لمعرفة هل النافذة الزمنية
  // المطلوبة (sinceMs..الآن) اكتملت فعلاً أو أن أحد حدود المنصة (مثال:
  // MAX_POINTS_PER_KEY في thingsboardConnector.ts) قطعها بصمت. لو تقدَّم
  // المؤشر (pull_cursor_at) إلى "الآن" رغم اقتطاع فعلي، تُفقَد كل القراءات
  // الواقعة بين آخر نقطة اكتمل جلبها فعلاً ونهاية النافذة المطلوبة نهائياً —
  // بلا أي فرصة لاسترجاعها لاحقاً (الدورة التالية تبدأ من "الآن" الجديد
  // الخاطئ، لا من نقطة الاقتطاع الحقيقية).
  //
  // الإصلاح: نتيجة مُركَّبة بدل مصفوفة خام —
  //   - readings: نفس المصفوفة كما كانت (كل القراءات المُستخرَجة من هذه
  //     الصفحة/الاستدعاء، قد تكون جزءاً فقط من النافذة الكاملة).
  //   - coveredThroughMs: آخر نقطة زمنية ثبت اكتمال جلبها فعلاً — إما نهاية
  //     النافذة المطلوبة كاملة (لا اقتطاع)، أو طابع آخر نقطة فعلية قبل بلوغ
  //     أي حد من حدود المنصة (hasMore=true حينها). المستدعي يجب أن يُحرِّك
  //     مؤشر السحب (pull_cursor_at) إلى هذه القيمة فقط — لا إلى Date.now()
  //     أو نهاية النافذة المطلوبة، مهما كانت النتيجة.
  //   - hasMore: true إن بلغ الجلب حد المنصة (نقاط أكثر متاحة فعلياً بعد
  //     coveredThroughMs ولم تُجلَب بعد ضمن هذا الاستدعاء) — المستدعي يعيد
  //     الاستدعاء بـsinceMs=coveredThroughMs الجديد (صفحة تالية) ضمن نفس
  //     الدورة إن سمحت الميزانية الزمنية، أو يتركها للدورة التالية بأمان
  //     (المؤشر لم يتخطَّ البيانات غير المجلوبة).
  fetchReadingsSince?(
    origin: string,
    credentials: ProviderCredentials,
    vendorStationId: string,
    sinceMs: number,
    untilMs: number
  ): Promise<{ readings: NormalizedReading[]; coveredThroughMs: number; hasMore: boolean }>;
}
