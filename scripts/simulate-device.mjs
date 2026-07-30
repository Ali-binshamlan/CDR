// محاكاة جهاز رصد فعلي يرسل قراءة PM10 كل دقيقتين (نفس دورة الإرسال
// التصميمية الحقيقية) — بخلاف طلب واحد يدوي، هذا يبني سلسلة قراءات
// متتالية في pm10_readings_history حتى يقدر "عداد الاستمرار" (دقيقتين
// لتأكيد مخالفة PM10>340) أن يتراكم فعلياً كما يحصل مع جهاز حقيقي.
//
// الاستخدام:
//   node scripts/simulate-device.mjs <API_KEY> [pm10] [intervalMinutes] [count]
//
// مثال (القيمة الافتراضية 350، كل دقيقتين، 5 مرات — يكفي لتجاوز حد
// التأكيد بدقيقتين ثم الاستمرار لعدة دورات بعدها):
//   node scripts/simulate-device.mjs dcr_xxxxxxxx 350 2 5

const [, , apiKey, pm10Arg, intervalArg, countArg] = process.argv;

if (!apiKey) {
  console.error('الاستخدام: node scripts/simulate-device.mjs <API_KEY> [pm10] [intervalMinutes] [count]');
  process.exit(1);
}

const pm10 = Number(pm10Arg ?? 350);
const intervalMinutes = Number(intervalArg ?? 2);
const count = Number(countArg ?? 5);
const baseUrl = process.env.DCR_BASE_URL ?? 'http://localhost:3000';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendReading(n) {
  const res = await fetch(`${baseUrl}/api/devices/ingest`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ pm10 }),
  });
  const body = await res.json().catch(() => ({}));
  const time = new Date().toLocaleTimeString('ar-SA');
  console.log(`[${time}] إرسال #${n}/${count} — pm10=${pm10} → HTTP ${res.status}`, body);
  if (!res.ok) {
    console.error('  فشل الإرسال — راجع الرسالة أعلاه (مفتاح خاطئ؟ rate limit؟ جهاز غير نشط؟).');
  }
}

(async () => {
  console.log(`محاكاة جهاز: ${count} قراءة، كل ${intervalMinutes} دقيقة، pm10=${pm10}، الهدف: ${baseUrl}`);
  for (let i = 1; i <= count; i++) {
    await sendReading(i);
    if (i < count) await sleep(intervalMinutes * 60_000);
  }
  console.log('انتهت المحاكاة.');
})();
