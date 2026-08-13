// سيناريو اختبار متدرّج لسرعة الرياح لنفس جهاز ThingsBoard حقيقي: يبدأ من
// نطاق الضوابط المعززة (16 كم/س)، يرتفع تدريجياً (16 → 20 → فوق 25)، ثم
// ينزل تدريجياً حتى نطاق هادئ نظيف. الهدف: مراقبة القرار وهو ينتقل عبر كل
// درجة وسيطة صعوداً ونزولاً، لا قفزة مباشرة بين طرفين.
//
// نطاقات classifyWind (راجع app/utils/dust-compliance-engine/rulebook.ts):
//   < 15 كم/س   → BELOW_15 (طبيعي، لا بوابة رياح)
//   15-25 كم/س  → FROM_15_TO_25 (GATE-WIND-15-25-ENHANCED-005 — تثبيط معزز)
//   > 25 كم/س   → ABOVE_25 (GATE-WIND-ABOVE-25-004 — إيقاف تنظيمي للأنشطة
//                 المكشوفة المولّدة للغبار)
//
// المراحل (بالترتيب):
//   1) RAMP_16   — 16 كم/س (ثابتة تقريباً) — دخول نطاق FROM_15_TO_25 مباشرة.
//   2) RAMP_20   — 20 كم/س (ثابتة تقريباً) — منتصف نطاق FROM_15_TO_25.
//   3) ABOVE_25  — 28-35 كم/س — تجاوز حد 25، يُفعِّل إيقافاً تنظيمياً فعلياً.
//   4) RAMP_DOWN_20 — 20 كم/س — نزول تدريجي، يرجع لنطاق FROM_15_TO_25.
//   5) RAMP_DOWN_16 — 16 كم/س — يقترب من حد الخروج السفلي (15).
//   6) ALLOW     — 8-12 كم/س (BELOW_15) لمدة تتجاوز مهلة استقرار الاستئناف
//      (RESUME_STABILITY_MINUTES) بهامش أمان — يضمن وصول القرار الفعلي
//      لحالة "مسموح" لا مجرد "بانتظار استقرار".
//
// الرؤية ثابتة طوال السيناريو — لا تتداخل مع اختبار الرياح. PM10 ثابت
// بنطاق آمن لنفس السبب.
// سكربت اختباري محلي فقط — لا علاقة له بكود التطبيق، لا يُشغَّل بالإنتاج.
//
// الاستخدام:
//   THINGSBOARD_DEVICE_TOKEN=<device-access-token> node scripts/local-thingsboard-wind-ramp-scenario.mjs
// اختياري: THINGSBOARD_BASE_URL (افتراضي https://thingsboard.cloud)،
// SCENARIO_SEND_INTERVAL_MS (افتراضي 60000 = دقيقة واحدة)، RAMP_MINUTES
// (مدة كل مرحلة صعود/هبوط ثابتة، افتراضي 3)، ABOVE_25_MINUTES (افتراضي 5)،
// ALLOW_MINUTES (افتراضي 12).

const BASE_URL = process.env.THINGSBOARD_BASE_URL || 'https://thingsboard.cloud';
const DEVICE_TOKEN = process.env.THINGSBOARD_DEVICE_TOKEN;
const SEND_INTERVAL_MS = Number(process.env.SCENARIO_SEND_INTERVAL_MS) || 60 * 1000;
const FIXED_VISIBILITY_M = Number(process.env.VISIBILITY_M) || 10000;
const RAMP_MINUTES = Number(process.env.RAMP_MINUTES) || 3;

const STAGES = [
  { name: 'RAMP_16 (دخول نطاق 15-25 — تثبيط معزز GATE-WIND-15-25-ENHANCED-005)', minutes: RAMP_MINUTES, windMin: 15.5, windMax: 16.5, gustMin: 18, gustMax: 22 },
  { name: 'RAMP_20 (منتصف نطاق 15-25)', minutes: RAMP_MINUTES, windMin: 19.5, windMax: 20.5, gustMin: 22, gustMax: 26 },
  { name: 'ABOVE_25 (تجاوز حد 25 — إيقاف تنظيمي GATE-WIND-ABOVE-25-004)', minutes: Number(process.env.ABOVE_25_MINUTES) || 5, windMin: 28, windMax: 35, gustMin: 32, gustMax: 40 },
  { name: 'RAMP_DOWN_20 (نزول — رجوع لنطاق 15-25)', minutes: RAMP_MINUTES, windMin: 19.5, windMax: 20.5, gustMin: 22, gustMax: 26 },
  { name: 'RAMP_DOWN_16 (نزول — قرب الحد السفلي 15)', minutes: RAMP_MINUTES, windMin: 15.5, windMax: 16.5, gustMin: 18, gustMax: 22 },
  { name: 'ALLOW (هادئ — BELOW_15، يتجاوز استقرار الاستئناف)', minutes: Number(process.env.ALLOW_MINUTES) || 12, windMin: 8, windMax: 12, gustMin: 10, gustMax: 15 },
];

if (!DEVICE_TOKEN) {
  console.error('THINGSBOARD_DEVICE_TOKEN غير مُعرَّف — مرّره كمتغير بيئة قبل التشغيل.');
  process.exit(1);
}

function randomInRange(min, max, decimals = 1) {
  const factor = 10 ** decimals;
  return Math.round((min + Math.random() * (max - min)) * factor) / factor;
}

function buildReading(windMin, windMax, gustMin, gustMax) {
  return {
    windSpeed: randomInRange(windMin, windMax),
    windGust: randomInRange(gustMin, gustMax),
    windDirection: randomInRange(0, 360, 0),
    pm10: randomInRange(50, 150), // خط أساس آمن ثابت — لا يتداخل مع اختبار الرياح
    pm25: randomInRange(10, 80),
    visibility: FIXED_VISIBILITY_M, // ثابتة (طلب صريح) — لا تتداخل مع اختبار الرياح
    humidity: randomInRange(20, 50, 0),
    temperature: randomInRange(25, 35, 1),
  };
}

async function sendReading(windMin, windMax, gustMin, gustMax) {
  const reading = buildReading(windMin, windMax, gustMin, gustMax);
  const startedAt = new Date().toISOString();
  try {
    const res = await fetch(`${BASE_URL}/api/v1/${DEVICE_TOKEN}/telemetry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reading),
    });
    console.log(`[${startedAt}] status=${res.status} windSpeed=${reading.windSpeed} windGust=${reading.windGust} visibility=${reading.visibility}`);
  } catch (err) {
    console.error(`[${startedAt}] فشل الإرسال:`, err instanceof Error ? err.message : err);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runScenario() {
  const totalMinutes = STAGES.reduce((sum, s) => sum + s.minutes, 0);
  console.log(`بدء سيناريو تدرّج الرياح (16 → 20 → فوق 25 → نزول تدريجي) → ${BASE_URL}/api/v1/${DEVICE_TOKEN}/telemetry`);
  console.log(`المدة الإجمالية: ${totalMinutes} دقيقة، إرسال كل ${SEND_INTERVAL_MS / 1000} ثانية، رؤية ثابتة ${FIXED_VISIBILITY_M}م.\n`);

  for (const stage of STAGES) {
    console.log(`\n=== المرحلة: ${stage.name} — ${stage.minutes} دقيقة، windSpeed بين ${stage.windMin}-${stage.windMax} كم/س ===`);
    const ticksInStage = Math.round((stage.minutes * 60 * 1000) / SEND_INTERVAL_MS);
    for (let i = 0; i < ticksInStage; i++) {
      await sendReading(stage.windMin, stage.windMax, stage.gustMin, stage.gustMax);
      if (i < ticksInStage - 1) await sleep(SEND_INTERVAL_MS);
    }
  }

  console.log('\nانتهى السيناريو بالكامل — توقف السكربت.');
}

runScenario();
