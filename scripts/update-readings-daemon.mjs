// ديمون تحديث قراءات مستمر — يبقى يعمل بلا توقف ويرسل قراءة جهاز جديدة كل
// فترة زمنية ثابتة (نفس دورة الإرسال التصميمية الحقيقية لجهاز رصد فعلي)،
// بخلاف بقية سكربتات simulate-device-*.mjs التي ترسل عدد محدد من القراءات
// ثم تتوقف. يُستخدم لمحاكاة جهاز متصل باستمرار أثناء تطوير/اختبار الواجهة
// (بطاقة الامتثال، عدّاد الاستقرار، الرسم البياني) بلا حاجة لإعادة تشغيل
// سكربت يدوياً كل مرة تنتهي فيه القراءات.
//
// كل قراءة تتذبذب واقعياً حول قيمة أساس (نفس أسلوب wobble في
// simulate-device-readings-chart.mjs) بدل قيمة ثابتة متكررة — حتى لا يظهر
// خط مسطح في الرسم البياني أثناء تشغيل طويل.
//
// أوقفه بـCtrl+C في أي وقت (SIGINT) — يطبع ملخصاً ثم يخرج بأمان.
//
// الاستخدام:
//   node scripts/update-readings-daemon.mjs <API_KEY> [intervalMinutes] [basePm10]
// مثال (افتراضي — كل دقيقتين، أساس PM10=180 نظيف/احترازي):
//   node scripts/update-readings-daemon.mjs dcr_xxxxxxxx 2 180
// مثال (أساس أعلى لمراقبة سلوك التحذير/التعليق دون إيقاف السكربت يدوياً):
//   node scripts/update-readings-daemon.mjs dcr_xxxxxxxx 2 300

const [, , apiKey, intervalArg, basePm10Arg] = process.argv;

if (!apiKey) {
  console.error('الاستخدام: node scripts/update-readings-daemon.mjs <API_KEY> [intervalMinutes] [basePm10]');
  process.exit(1);
}

const intervalMinutes = Number(intervalArg ?? 2);
const basePm10 = Number(basePm10Arg ?? 180);
const baseUrl = process.env.DCR_BASE_URL ?? 'http://localhost:3000';

let sent = 0;
let failed = 0;
let stopping = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// تذبذب واقعي حول قيمة أساس + انحراف بطيء (moshi walk خفيف) + عشوائية —
// نفس دالة simulate-device-readings-chart.mjs، بمرجع زمني بدل مرجع فهرس
// (i/total) لأن الديمون لا يملك "نهاية" معروفة مسبقاً.
function wobble(base, amplitude, tickCount) {
  const drift = Math.sin(tickCount / 6) * amplitude * 0.6;
  const noise = (Math.random() - 0.5) * amplitude * 0.4;
  return Math.round((base + drift + noise) * 10) / 10;
}

function buildPayload(tickCount) {
  return {
    windSpeedKmh: Math.max(0, wobble(12, 8, tickCount)),
    windGustKmh: Math.max(0, wobble(18, 10, tickCount)),
    windDirectionDeg: Math.round((180 + tickCount * 15) % 360),
    pm10: Math.max(0, wobble(basePm10, Math.max(20, basePm10 * 0.15), tickCount)),
    pm25: Math.max(0, wobble(basePm10 * 0.4, Math.max(10, basePm10 * 0.08), tickCount)),
    visibilityM: Math.max(500, wobble(8000, 3000, tickCount)),
    relativeHumidityPercent: Math.min(100, Math.max(0, wobble(35, 15, tickCount))),
    temperatureC: wobble(34, 6, tickCount),
  };
}

async function sendReading(tickCount) {
  const payload = buildPayload(tickCount);
  try {
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
    if (res.ok) {
      sent++;
      console.log(`[${time}] تحديث #${sent} → HTTP ${res.status} — pm10=${payload.pm10}, wind=${payload.windSpeedKmh}`);
    } else {
      failed++;
      console.error(`[${time}] فشل التحديث → HTTP ${res.status}`, body);
    }
  } catch (err) {
    failed++;
    console.error(`[${new Date().toLocaleTimeString('ar-SA')}] خطأ اتصال:`, err?.message ?? err);
  }
}

function printSummaryAndExit() {
  console.log(`\nتوقف الديمون — إجمالي: ${sent} نجحت، ${failed} فشلت.`);
  process.exit(0);
}

process.on('SIGINT', () => {
  if (stopping) return; // تجاهل Ctrl+C ثانية أثناء الإغلاق (منع خروج مزدوج)
  stopping = true;
  printSummaryAndExit();
});

(async () => {
  console.log(
    `ديمون تحديث القراءات: كل ${intervalMinutes} دقيقة، أساس PM10=${basePm10} (الهدف: ${baseUrl}) — Ctrl+C للإيقاف.`
  );
  let tickCount = 0;
  while (!stopping) {
    await sendReading(tickCount);
    tickCount++;
    await sleep(intervalMinutes * 60_000);
  }
})();
