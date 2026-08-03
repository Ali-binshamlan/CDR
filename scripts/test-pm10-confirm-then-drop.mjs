// اختبار: تسجيل مخالفة مؤكَّدة فعلياً (لا معلَّقة فقط) ثم نزول القراءة —
// بخلاف test-pm10-spike-drop.mjs (الذي ينزل *قبل* اكتمال التأكيد، فيثبت أن
// المخالفة تبقى معلَّقة فقط ولا تتحول لمؤكَّدة)، هذا السكربت يرسل قراءتين
// متتاليتين ≥340 بفارق زمني أكثر من دقيقتين بينهما (PM10_VIOLATION_CONFIRM_
// MINUTES=2 في rulebook.ts) — يثبت الاستمرار فعلياً بين عينتين حقيقيتين
// (راجع computeSustainedPm10Status/streakMinutesAbove في dustEvaluation.ts:
// عينة واحدة وحدها لا تكفي أبداً)، فتتأكد المخالفة (RCRC-PM10-340-VIOLATION-011،
// MANDATORY_STOP) فعلياً. ثم يرسل قراءة نظيفة — يثبت أن القرار لا يعود
// "مسموح" فوراً رغم التحسّن، بل يبقى موقوفاً لمدة RESUME_STABILITY_MINUTES
// (10 دقائق) قبل الاستئناف التلقائي.
//
// الاستخدام:
//   node scripts/test-pm10-confirm-then-drop.mjs <API_KEY> [confirmGapSeconds]
// مثال (افتراضي — 150 ثانية بين القراءتين، أي أكثر من دقيقتين بوضوح):
//   node scripts/test-pm10-confirm-then-drop.mjs dcr_xxxxxxxx 150

const [, , apiKey, confirmGapArg] = process.argv;

if (!apiKey) {
  console.error('الاستخدام: node scripts/test-pm10-confirm-then-drop.mjs <API_KEY> [confirmGapSeconds]');
  process.exit(1);
}

const confirmGapSeconds = Number(confirmGapArg ?? 150);
if (confirmGapSeconds <= 120) {
  console.error('تنبيه: confirmGapSeconds <= 120 (دقيقتين) — يلزم أكثر من دقيقتين بالضبط (>PM10_VIOLATION_CONFIRM_MINUTES) لتتأكد المخالفة فعلياً. مرِّر قيمة أكبر من 120.');
  process.exit(1);
}

const baseUrl = process.env.DCR_BASE_URL ?? 'http://localhost:3000';
const VIOLATION_PM10 = 350; // >340 بوضوح
const CLEAN_PM10 = 100; // نظيف تماماً بعد النزول

function buildPayload(pm10) {
  return {
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
  console.log(
    `اختبار تأكيد مخالفة ثم نزول: قراءتان ${VIOLATION_PM10} بفارق ${confirmGapSeconds} ثانية (أكثر من دقيقتين)، ثم نزول إلى ${CLEAN_PM10} (الهدف: ${baseUrl})`
  );
  console.log('افتح تفاصيل النشاط في الواجهة الآن وتابع بطاقة "الامتثال التنظيمي" مع كل خطوة.\n');

  await sendReading(VIOLATION_PM10, 'القراءة الأولى ≥340 — متوقَّع: معلَّق (بانتظار تأكيد استمرار)');

  console.log(`\nانتظار ${confirmGapSeconds} ثانية (أكثر من حد التأكيد 120 ثانية) قبل القراءة الثانية...\n`);
  await sleep(confirmGapSeconds * 1000);

  await sendReading(VIOLATION_PM10, 'القراءة الثانية ≥340 (بعد أكثر من دقيقتين) — متوقَّع: مخالفة مؤكدة (MANDATORY_STOP، إيقاف إلزامي أسود)');

  console.log('\nتحقق الآن من الواجهة: يجب أن تظهر "إيقاف إلزامي نظامي" (أسود) بثقة كاملة، لا "معلَّق".');
  console.log('اضغط أي وقت مناسب للمتابعة، أو انتظر — سيرسل السكربت قراءة نظيفة تلقائياً بعد 10 ثوانٍ من الآن.\n');

  await sleep(10_000);

  await sendReading(CLEAN_PM10, 'نزول بعد التأكيد الكامل — متوقَّع: يبقى موقوفاً (بانتظار استقرار الاستئناف 10 دقائق)، لا استئناف فوري');

  console.log('\nانتهى الاختبار — تحقق من الواجهة:');
  console.log('  1. فور النزول: القرار يبقى "إيقاف إلزامي/موقوف" (بانتظار استقرار الاستئناف)، وليس "مسموح" فوراً رغم أن القراءة نظيفة الآن.');
  console.log('  2. بعد مرور 10 دقائق متواصلة من قراءات نظيفة (أرسل قراءات إضافية دورياً إن أردت إثبات الاستئناف الفعلي): يعود القرار "مسموح" تلقائياً.');
})();
