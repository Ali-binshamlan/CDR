// سيناريو اختبار مبسّط لنفس جهاز ThingsBoard: PM10 يبدأ بمرحلة تحذير/ضوابط
// إلزامية (بين 251-339 — تحت حد المخالفة 340، فوق حد الاحتراز 250) لمدة
// طويلة (افتراضياً 30 دقيقة)، ثم يرتفع لمرحلة مخالفة مؤكَّدة (فوق 340)
// حتى يتأكد الإيقاف الإلزامي (MANDATORY_STOP بعد استمرار فعلي أطول من
// دقيقتين — راجع PM10_VIOLATION_CONFIRM_MINUTES في app/lib/dustEvaluation.ts).
// الهدف: مراقبة القرار وهو يبقى في حالة "تحذير/ضوابط" (MONITOR) لفترة
// طويلة واقعية قبل أن يتصاعد فعلياً لإيقاف، بدل قفزة مباشرة من نظيف
// لمخالفة كما في السيناريوهات الأخرى.
//
// درجات حزمة RIYADH_DUST_2026_2 (راجع app/utils/rule-bundles/riyadh-dust-2026.2.ts):
//   ≤200            → طبيعي (ALLOW)
//   201-250         → احتراز (MONITOR)
//   251-339         → ضوابط إلزامية/تحذير (MONITOR، تحذير تنظيمي مستقل)
//   ≥340 (>340 حصراً) → إيقاف احترازي فوري، مؤكَّد بعد استمرار فعلي >2 دقيقة
//
// الرؤية ثابتة طوال السيناريو — لا تتداخل مع اختبار PM10.
// سكربت اختباري محلي فقط — لا علاقة له بكود التطبيق، لا يُشغَّل بالإنتاج.
//
// المراحل:
//   1) WARNING — PM10 بين 251-339 (افتراضياً 30 دقيقة) — تحذير/ضوابط
//      إلزامية مستمرة، دون تجاوز حد المخالفة.
//   2) STOP    — PM10 بين 380-450 (10 دقائق افتراضياً — يكفي لتجاوز مهلة
//      تأكيد المخالفة بهامش أمان) — يُتوقَّع PROTECTIVE_STOP ثم MANDATORY_STOP.
//
// الاستخدام:
//   THINGSBOARD_DEVICE_TOKEN=<device-access-token> node scripts/local-thingsboard-warning-then-stop-scenario.mjs
// اختياري: THINGSBOARD_BASE_URL (افتراضي https://thingsboard.cloud)،
// SCENARIO_SEND_INTERVAL_MS (افتراضي 60000 = دقيقة واحدة)، WARNING_MINUTES
// (افتراضي 30)، STOP_MINUTES (افتراضي 10).

const BASE_URL = process.env.THINGSBOARD_BASE_URL || 'https://thingsboard.cloud';
const DEVICE_TOKEN = process.env.THINGSBOARD_DEVICE_TOKEN;
const SEND_INTERVAL_MS = Number(process.env.SCENARIO_SEND_INTERVAL_MS) || 60 * 1000;
const FIXED_VISIBILITY_M = Number(process.env.VISIBILITY_M) || 1000;

const STAGES = [
  {
    name: 'WARNING (تحذير/ضوابط إلزامية 251-339، دون حد المخالفة 340)',
    minutes: Number(process.env.WARNING_MINUTES) || 30,
    pm10Min: 251,
    pm10Max: 339,
  },
  {
    name: 'STOP (تجاوز حد المخالفة >340 — إيقاف إلزامي)',
    minutes: Number(process.env.STOP_MINUTES) || 10,
    pm10Min: 380,
    pm10Max: 450,
  },
];

if (!DEVICE_TOKEN) {
  console.error('THINGSBOARD_DEVICE_TOKEN غير مُعرَّف — مرّره كمتغير بيئة قبل التشغيل.');
  process.exit(1);
}

function randomInRange(min, max, decimals = 1) {
  const factor = 10 ** decimals;
  return Math.round((min + Math.random() * (max - min)) * factor) / factor;
}

function buildReading(pm10Min, pm10Max) {
  return {
    windSpeed: randomInRange(5, 15), // ثابت نسبياً ومعتدل — لا يفعّل بوابة الرياح >25
    windGust: randomInRange(10, 20),
    windDirection: randomInRange(0, 360, 0),
    pm10: randomInRange(pm10Min, pm10Max),
    pm25: randomInRange(10, 80),
    visibility: FIXED_VISIBILITY_M, // ثابتة — لا تتداخل مع اختبار PM10
    humidity: randomInRange(20, 50, 0),
    temperature: randomInRange(25, 35, 1),
  };
}

async function sendReading(pm10Min, pm10Max) {
  const reading = buildReading(pm10Min, pm10Max);
  const startedAt = new Date().toISOString();
  try {
    const res = await fetch(`${BASE_URL}/api/v1/${DEVICE_TOKEN}/telemetry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reading),
    });
    console.log(`[${startedAt}] status=${res.status} pm10=${reading.pm10} visibility=${reading.visibility}`);
  } catch (err) {
    console.error(`[${startedAt}] فشل الإرسال:`, err instanceof Error ? err.message : err);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runScenario() {
  const totalMinutes = STAGES.reduce((sum, s) => sum + s.minutes, 0);
  console.log(`بدء سيناريو (تحذير ثم إيقاف) → ${BASE_URL}/api/v1/${DEVICE_TOKEN}/telemetry`);
  console.log(`المدة الإجمالية: ${totalMinutes} دقيقة، إرسال كل ${SEND_INTERVAL_MS / 1000} ثانية، رؤية ثابتة ${FIXED_VISIBILITY_M}م.\n`);

  for (const stage of STAGES) {
    console.log(`\n=== المرحلة: ${stage.name} — ${stage.minutes} دقيقة، pm10 بين ${stage.pm10Min}-${stage.pm10Max} ===`);
    const ticksInStage = Math.round((stage.minutes * 60 * 1000) / SEND_INTERVAL_MS);
    for (let i = 0; i < ticksInStage; i++) {
      await sendReading(stage.pm10Min, stage.pm10Max);
      if (i < ticksInStage - 1) await sleep(SEND_INTERVAL_MS);
    }
  }

  console.log('\nانتهى السيناريو بالكامل — توقف السكربت.');
}

runScenario();
