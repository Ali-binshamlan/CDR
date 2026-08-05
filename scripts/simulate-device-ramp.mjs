// محاكاة جهاز يصعّد PM10 تدريجياً "حبة حبة" حتى يتجاوز مستوى المخالفة
// (>340) — يمر بكل نطاقات rulebook.ts بالترتيب:
//   <150 ALLOW نظيف → 150-249 PRECAUTION (احتراز، أصفر) →
//   250-299 WARNING (تحذير) → 300-339 EARLY_WARNING (تنبيه استباقي) →
//   >340 معلَّق (MRQ-PM10-BLACK-PENDING-104) ثم بعد دقيقتين استمرار →
//   مخالفة مؤكدة (RCRC-PM10-340-VIOLATION-011 / MANDATORY_STOP)
//
// يرسل بقية الحقول (رياح/رؤية/رطوبة/حرارة) بقيم آمنة ثابتة مع كل قراءة —
// حتى لا يبقى "تنبيه أمني" (SAFETY_BREACH) عالقاً بسبب رؤية/رياح قديمة
// سيئة من محاكاة سابقة (راجع تعليق ingest/route.ts: الكتابة جزئية، الحقول
// الغائبة تبقى بقيمتها المخزَّنة سابقاً، لا تُصفَّر).
//
// الاستخدام:
//   node scripts/simulate-device-ramp.mjs <API_KEY> [startPm10] [stepPm10] [intervalMinutes] [maxPm10]
// مثال (افتراضي — يبدأ 100، يزيد 50 كل دقيقتين حتى يتجاوز 340):
//   node scripts/simulate-device-ramp.mjs dcr_xxxxxxxx 100 50 2 380

const [, , apiKey, startArg, stepArg, intervalArg, maxArg] = process.argv;

if (!apiKey) {
  console.error('الاستخدام: node scripts/simulate-device-ramp.mjs <API_KEY> [startPm10] [stepPm10] [intervalMinutes] [maxPm10]');
  process.exit(1);
}

const start = Number(startArg ?? 100);
const step = Number(stepArg ?? 50);
const intervalMinutes = Number(intervalArg ?? 2);
const max = Number(maxArg ?? 380);
const baseUrl = process.env.DCR_BASE_URL ?? 'http://localhost:3000';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function labelFor(pm10) {
  if (pm10 > 340) return 'مخالفة (>340) — معلَّق أول دقيقتين ثم مؤكَّد';
  if (pm10 >= 300) return 'تنبيه استباقي (300-339)';
  if (pm10 >= 250) return 'تحذير (250-299)';
  if (pm10 >= 150) return 'احتراز (150-249)';
  return 'نظيف (<150)';
}

let _sequenceCounter = 0;
async function sendReading(pm10) {
  _sequenceCounter += 1;
  const payload = {
    eventId: `sim-ramp-${Date.now()}-${_sequenceCounter}`,
    sequence: _sequenceCounter,
    observedAt: new Date().toISOString(),
    windSpeedKmh: 10,
    windGustKmh: 15,
    windDirectionDeg: 180,
    pm10,
    pm25: Math.round(pm10 * 0.4),
    visibilityM: 10000,
    relativeHumidityPercent: 30,
    temperatureC: 35,
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
  console.log(`[${time}] pm10=${pm10} (${labelFor(pm10)}) → HTTP ${res.status}`, body);
  if (!res.ok) console.error('  فشل الإرسال.');
}

(async () => {
  const values = [];
  for (let v = start; v < max; v += step) values.push(v);
  values.push(max); // القيمة الأخيرة تتجاوز حد المخالفة دائماً

  console.log(`تصعيد تدريجي: ${values.join(' → ')} — كل قراءة كل ${intervalMinutes} دقيقة (الهدف: ${baseUrl})`);
  console.log('بعد وصول القيمة الأخيرة، يستمر إرسالها بلا نهاية كل دورة حتى تؤكَّد المخالفة (يحتاج قراءتين متتاليتين ≥340 على الأقل) — أوقف السكربت يدوياً (Ctrl+C) بعد ملاحظة "مخالفة مؤكدة" في الواجهة.');

  for (let i = 0; i < values.length; i++) {
    await sendReading(values[i]);
    if (i < values.length - 1) await sleep(intervalMinutes * 60_000);
  }

  // بعد الوصول للقيمة القصوى، استمر بإرسالها كل دورة حتى تتأكد المخالفة
  // فعلياً (يحتاج ≥2 قراءة متتالية فوق 340) ثم لعدة دورات إضافية للمراقبة.
  for (let i = 0; i < 4; i++) {
    await sleep(intervalMinutes * 60_000);
    await sendReading(max);
  }
  console.log('انتهت المحاكاة.');
})();
