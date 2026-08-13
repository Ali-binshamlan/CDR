// محاكي جهاز رصد يرسل (push) قراءات تجريبية عشوائية لـThingsBoard كل دقيقة
// عبر Device Access Token — يحاكي جهازاً فعلياً بدل الإرسال اليدوي المتكرر
// من Postman. هذا سكربت اختباري محلي فقط (تحضيراً للتجربة قبل ربط جهاز
// حقيقي)، لا علاقة له بكود التطبيق نفسه — لا يُشغَّل بالإنتاج ولا يُستدعى
// من أي مسار API بالمشروع.
//
// الاستخدام:
//   THINGSBOARD_DEVICE_TOKEN=<device-access-token> node scripts/local-thingsboard-device-simulator.mjs
// اختياري: THINGSBOARD_BASE_URL (افتراضي https://thingsboard.cloud)،
// SIMULATOR_INTERVAL_MS (افتراضي 60000 = دقيقة واحدة).
//
// وضع "آمن" مؤقت (لإعادة نشاط موقوف/معلَّق لحالة مسموح بعد فترة استقرار):
//   SIMULATOR_SAFE_PM10_MAX=<رقم>   يحدّد حد PM10 الأعلى (بدل 400 الافتراضي
//     الذي يشمل عمداً تجاوز عتبة 340 لاختبار الإيقاف الإلزامي).
//   SIMULATOR_DURATION_MINUTES=<رقم> يوقف السكربت تلقائياً بعد هذه المدة —
//     بدونه يستمر للأبد حتى إيقافه يدوياً.

const BASE_URL = process.env.THINGSBOARD_BASE_URL || 'https://thingsboard.cloud';
const DEVICE_TOKEN = process.env.THINGSBOARD_DEVICE_TOKEN;
const INTERVAL_MS = Number(process.env.SIMULATOR_INTERVAL_MS) || 60 * 1000;
const PM10_MAX = Number(process.env.SIMULATOR_SAFE_PM10_MAX) || 400;
const DURATION_MINUTES = Number(process.env.SIMULATOR_DURATION_MINUTES) || null;

if (!DEVICE_TOKEN) {
  console.error('THINGSBOARD_DEVICE_TOKEN غير مُعرَّف — مرّره كمتغير بيئة قبل التشغيل.');
  process.exit(1);
}

// نفس أسماء حقول telemetry الافتراضية اللي يفترضها thingsboardConnector.ts
// (windSpeed, windGust, windDirection, pm10, pm25, visibility, humidity, temperature)
function randomInRange(min, max, decimals = 1) {
  const factor = 10 ** decimals;
  return Math.round((min + Math.random() * (max - min)) * factor) / factor;
}

function buildReading() {
  return {
    windSpeed: randomInRange(0, 30),
    windGust: randomInRange(0, 40),
    windDirection: randomInRange(0, 360, 0),
    pm10: randomInRange(20, PM10_MAX), // الحد الأعلى قابل للتخصيص عبر SIMULATOR_SAFE_PM10_MAX
    pm25: randomInRange(10, 150),
    visibility: randomInRange(0.2, 10, 2), // كم — يشمل رؤية حرجة أحياناً (<0.5 كم)
    humidity: randomInRange(15, 70, 0),
    temperature: randomInRange(20, 45, 1),
  };
}

async function sendReading() {
  const reading = buildReading();
  const startedAt = new Date().toISOString();
  try {
    const res = await fetch(`${BASE_URL}/api/v1/${DEVICE_TOKEN}/telemetry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reading),
    });
    console.log(`[${startedAt}] status=${res.status}`, JSON.stringify(reading));
  } catch (err) {
    console.error(`[${startedAt}] فشل الإرسال:`, err instanceof Error ? err.message : err);
  }
}

console.log(
  `بدء محاكاة جهاز يرسل كل ${INTERVAL_MS / 1000} ثانية (pm10 حتى ${PM10_MAX}) → ${BASE_URL}/api/v1/${DEVICE_TOKEN}/telemetry`
);
sendReading();
const timer = setInterval(sendReading, INTERVAL_MS);

if (DURATION_MINUTES) {
  console.log(`سيتوقف تلقائياً بعد ${DURATION_MINUTES} دقيقة.`);
  setTimeout(() => {
    clearInterval(timer);
    console.log(`انتهت مدة ${DURATION_MINUTES} دقيقة — توقف السكربت.`);
    process.exit(0);
  }, DURATION_MINUTES * 60 * 1000);
}
