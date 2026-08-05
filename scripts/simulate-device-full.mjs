// محاكاة جهاز يرسل كل حقول القياس معاً (لا PM10 وحده) — يُستخدم للتأكد إن
// "تنبيه أمني نشط" (SAFETY_BREACH) المعروض في الواجهة سببه رؤية/رياح قديمة
// متبقية من محاكاة سابقة أرسلت PM10 فقط (الكتابة جزئية: الحقول الغائبة من
// الحمولة تبقى بقيمتها المخزَّنة سابقاً، لا تُصفَّر — راجع تعليق
// MEASUREMENT_FIELDS في app/api/devices/ingest/route.ts)، لا نقص PM10 نفسه.
//
// قيم افتراضية "آمنة تماماً" لكل الحقول (رؤية ممتازة، رياح هادئة) — إن كان
// السبب فعلاً رؤية/رياح قديمة سيئة، إرسال هذي القيم يُغلق SAFETY_BREACH فوراً.
//
// الاستخدام:
//   node scripts/simulate-device-full.mjs <API_KEY> [pm10]
// مثال:
//   node scripts/simulate-device-full.mjs dcr_xxxxxxxx 150

const [, , apiKey, pm10Arg] = process.argv;

if (!apiKey) {
  console.error('الاستخدام: node scripts/simulate-device-full.mjs <API_KEY> [pm10]');
  process.exit(1);
}

const pm10 = Number(pm10Arg ?? 150);
const baseUrl = process.env.DCR_BASE_URL ?? 'http://localhost:3000';

const payload = {
  eventId: `sim-full-${Date.now()}-1`,
  sequence: 1,
  observedAt: new Date().toISOString(),
  windSpeedKmh: 10,
  windGustKmh: 15,
  windDirectionDeg: 180,
  pm10,
  pm25: pm10 * 0.4,
  visibilityM: 10000,
  relativeHumidityPercent: 30,
  temperatureC: 35,
};

(async () => {
  console.log(`إرسال قراءة كاملة إلى ${baseUrl}/api/devices/ingest:`, payload);
  const res = await fetch(`${baseUrl}/api/devices/ingest`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  console.log(`HTTP ${res.status}`, body);
})();
