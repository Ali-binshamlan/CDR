// سكربت اختباري محلي مخصَّص — يرسل (push) قراءات تجريبية ثابتة القيم إلى
// ThingsBoard عبر Device Access Token، كل دقيقة، لمدة 33 دقيقة، مع pm10
// عشوائي ضمن نطاق [250, 400] فقط (بقية الحقول ثابتة تماماً بالقيم
// المطلوبة). لا علاقة له بكود التطبيق نفسه — لا يُشغَّل بالإنتاج ولا
// يُستدعى من أي مسار API بالمشروع. مبني على نفس نمط
// local-thingsboard-device-simulator.mjs، بقيم ثابتة بدل عشوائية شاملة.
//
// الاستخدام:
//   THINGSBOARD_DEVICE_TOKEN=<device-access-token> node scripts/send-fixed-pm10-range-reading.mjs
// اختياري: THINGSBOARD_BASE_URL (افتراضي https://thingsboard.cloud).

const BASE_URL = process.env.THINGSBOARD_BASE_URL || 'https://thingsboard.cloud';
const DEVICE_TOKEN = process.env.THINGSBOARD_DEVICE_TOKEN;
const INTERVAL_MS = 60 * 1000; // كل دقيقة
const DURATION_MINUTES = 33;

if (!DEVICE_TOKEN) {
  console.error('THINGSBOARD_DEVICE_TOKEN غير مُعرَّف — مرّره كمتغير بيئة قبل التشغيل.');
  process.exit(1);
}

function randomInRange(min, max, decimals = 1) {
  const factor = 10 ** decimals;
  return Math.round((min + Math.random() * (max - min)) * factor) / factor;
}

function buildReading() {
  return {
    pm10: randomInRange(250, 400),
    pm25: 12,
    windSpeed: 12,
    windDirection: 27,
    temperature: 10,
    humidity: 21,
    visibility: 100000,
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
  `بدء الإرسال كل ${INTERVAL_MS / 1000} ثانية لمدة ${DURATION_MINUTES} دقيقة (pm10 عشوائي بين 250-400) → ${BASE_URL}/api/v1/${DEVICE_TOKEN}/telemetry`
);
sendReading();
const timer = setInterval(sendReading, INTERVAL_MS);

setTimeout(() => {
  clearInterval(timer);
  console.log(`انتهت مدة ${DURATION_MINUTES} دقيقة — توقف السكربت.`);
  process.exit(0);
}, DURATION_MINUTES * 60 * 1000);
