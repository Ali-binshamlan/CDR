// اختبار تسجيل مخالفة مؤكَّدة فقط — بلا نزول بعدها (بخلاف
// test-pm10-confirm-then-drop.mjs الذي يتابع بعدها اختبار سلوك الاستئناف).
// يرسل قراءتين متتاليتين ≥340 بفارق زمني أكثر من دقيقتين (PM10_VIOLATION_
// CONFIRM_MINUTES=2 في rulebook.ts) — الاستمرار يُثبَت بين عينتين حقيقيتين
// (راجع computeSustainedPm10Status/streakMinutesAbove في dustEvaluation.ts:
// عينة واحدة وحدها لا تكفي أبداً)، فتتأكد المخالفة فعلياً (RCRC-PM10-340-
// VIOLATION-011 / MANDATORY_STOP، إيقاف إلزامي أسود قطعي).
//
// الاستخدام:
//   node scripts/test-pm10-confirm.mjs <API_KEY> [confirmGapSeconds]
// مثال (افتراضي — 150 ثانية بين القراءتين، أي أكثر من دقيقتين بوضوح):
//   node scripts/test-pm10-confirm.mjs dcr_xxxxxxxx 150

const [, , apiKey, confirmGapArg] = process.argv;

if (!apiKey) {
  console.error('الاستخدام: node scripts/test-pm10-confirm.mjs <API_KEY> [confirmGapSeconds]');
  process.exit(1);
}

const confirmGapSeconds = Number(confirmGapArg ?? 150);
if (confirmGapSeconds <= 120) {
  console.error('تنبيه: confirmGapSeconds <= 120 (دقيقتين) — يلزم أكثر من دقيقتين بالضبط (>PM10_VIOLATION_CONFIRM_MINUTES) لتتأكد المخالفة فعلياً. مرِّر قيمة أكبر من 120.');
  process.exit(1);
}

const baseUrl = process.env.DCR_BASE_URL ?? 'http://localhost:3000';
const VIOLATION_PM10 = 350; // >340 بوضوح

let _sequenceCounter = 0;
function buildPayload(pm10) {
  _sequenceCounter += 1;
  return {
    eventId: `sim-${Date.now()}-${_sequenceCounter}`,
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
}

async function sendReading(pm10, label) {
  const payload = buildPayload(pm10);
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
  console.log(`[${time}] ${label} — pm10=${pm10} → HTTP ${res.status}`, body);
  if (!res.ok) {
    console.error('  فشل الإرسال — تحقق من صحة مفتاح API وأن الجهاز نشط (is_active).');
  }
  return res.ok;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

(async () => {
  console.log(`اختبار تسجيل مخالفة: قراءتان ${VIOLATION_PM10} بفارق ${confirmGapSeconds} ثانية (أكثر من دقيقتين) — الهدف: ${baseUrl}`);
  console.log('افتح تفاصيل النشاط في الواجهة الآن وتابع بطاقة "الامتثال التنظيمي".\n');

  await sendReading(VIOLATION_PM10, 'القراءة الأولى ≥340 — متوقَّع: معلَّق (بانتظار تأكيد استمرار)');

  console.log(`\nانتظار ${confirmGapSeconds} ثانية (أكثر من حد التأكيد 120 ثانية) قبل القراءة الثانية...\n`);
  await sleep(confirmGapSeconds * 1000);

  await sendReading(VIOLATION_PM10, 'القراءة الثانية ≥340 (بعد أكثر من دقيقتين) — متوقَّع: مخالفة مؤكدة (MANDATORY_STOP، إيقاف إلزامي أسود)');

  console.log('\nانتهى الاختبار — تحقق من الواجهة: يجب أن تظهر "إيقاف إلزامي نظامي" (أسود) بثقة كاملة، لا "معلَّق".');
})();
