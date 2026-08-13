// محاكاة جهاز يرسل عدة قراءات متتالية بقيم متذبذبة واقعياً لكل عنصر قياس
// معاً (رياح/هبة/اتجاه/PM10/PM2.5/رؤية/رطوبة/حرارة) — يُستخدم لملء الرسم
// البياني الجديد (ActivityReadingsCharts.tsx / device_readings_history)
// ببيانات حقيقية بدل خط مسطح، للتحقق البصري من أن كل رسم من الرسوم
// السبعة المنفصلة يعرض تذبذباً واضحاً.
//
// يتطلب تطبيق supabase-add-device-readings-history-migration.sql مسبقاً
// في Supabase — بدونه device_readings_history غير موجود وكل قراءة تُدرَج
// في project_devices فقط (الرسم البياني يبقى فارغاً).
//
// الاستخدام:
//   node scripts/simulate-device-readings-chart.mjs <API_KEY> [count] [intervalMinutes]
// مثال (افتراضي — 8 قراءات كل دقيقتين، ~16 دقيقة):
//   node scripts/simulate-device-readings-chart.mjs dcr_xxxxxxxx 8 2

const [, , apiKey, countArg, intervalArg] = process.argv;

if (!apiKey) {
  console.error('الاستخدام: node scripts/simulate-device-readings-chart.mjs <API_KEY> [count] [intervalMinutes]');
  process.exit(1);
}

const count = Number(countArg ?? 8);
const intervalMinutes = Number(intervalArg ?? 2);
const baseUrl = process.env.DCR_BASE_URL ?? 'http://localhost:3000';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// تذبذب واقعي حول قيمة أساس + عشوائية بسيطة + انحراف تدريجي بطيء (moshi
// walk خفيف) — يعطي كل عنصر شكل منحنى طبيعي في الرسم بدل قفزات عشوائية بحتة.
function wobble(base, amplitude, i, total) {
  const drift = Math.sin((i / total) * Math.PI * 1.5) * amplitude * 0.6;
  const noise = (Math.random() - 0.5) * amplitude * 0.4;
  return Math.round((base + drift + noise) * 10) / 10;
}

async function sendReading(i) {
  const payload = {
    eventId: `sim-chart-${Date.now()}-${i}`,
    sequence: i,
    observedAt: new Date().toISOString(),
    windSpeedKmh: Math.max(0, wobble(12, 8, i, count)),
    windGustKmh: Math.max(0, wobble(18, 10, i, count)),
    windDirectionDeg: Math.round(((180 + i * 15) % 360)),
    pm10: Math.max(0, wobble(180, 90, i, count)),
    pm25: Math.max(0, wobble(70, 35, i, count)),
    visibilityM: Math.max(500, wobble(8000, 3000, i, count)),
    relativeHumidityPercent: Math.min(100, Math.max(0, wobble(35, 15, i, count))),
    temperatureC: wobble(34, 6, i, count),
  };

  const res = await fetch(`${baseUrl}/api/devices/ingest`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  const time = new Date().toLocaleTimeString('ar-SA');
  console.log(`[${time}] قراءة ${i + 1}/${count} → HTTP ${res.status}`, payload, body);
  if (!res.ok) console.error('  فشل الإرسال — راجع الرسالة أعلاه.');
}

(async () => {
  console.log(`محاكاة رسم بياني: ${count} قراءة متذبذبة، كل ${intervalMinutes} دقيقة (الهدف: ${baseUrl})`);
  for (let i = 0; i < count; i++) {
    await sendReading(i);
    if (i < count - 1) await sleep(intervalMinutes * 60_000);
  }
  console.log('انتهت المحاكاة — افتح تفاصيل النشاط في الواجهة وتحقق من الرسوم السبعة.');
})();
