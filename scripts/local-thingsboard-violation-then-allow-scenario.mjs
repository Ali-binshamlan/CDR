// سيناريو اختبار مبسّط لنفس جهاز ThingsBoard: PM10 يبدأ بمرحلة مخالفة
// مؤكَّدة (فوق حد 340) لمدة ثابتة، ثم ينزل لنطاق "مسموح" (ALLOW نظيف، تحت
// حد normalMaxInclusive=200 في RIYADH_DUST_2026_2 — راجع
// app/utils/rule-bundles/riyadh-dust-2026.3.ts) ويستمر بالإرسال حتى يتجاوز
// مهلة استقرار الاستئناف الكاملة (RESUME_STABILITY_MINUTES=10 في
// dust-compliance-engine/engine.ts) بهامش أمان — أي لا يتوقف السكربت عند
// أول قراءة نظيفة، بل يستمر حتى يضمن وصول القرار الفعلي لحالة "مسموح"
// وليس فقط "بانتظار استقرار".
// الرؤية ثابتة على 1000م طوال السيناريو (طلب صريح) — لا تتداخل مع اختبار PM10.
// سكربت اختباري محلي فقط — لا علاقة له بكود التطبيق، لا يُشغَّل بالإنتاج.
//
// المراحل:
//   1) VIOLATION — PM10 بين 350-450 (5 دقائق) — فوق حد المخالفة 340؛ "معلَّق"
//      (STOP_AFFECTED_ACTIVITY) أول أكثر من دقيقتين، ثم "مؤكَّد" (MANDATORY_STOP)
//      — راجع PM10_VIOLATION_CONFIRM_MINUTES في app/lib/dustEvaluation.ts.
//   2) ALLOW     — PM10 بين 150-200 (طلب صريح: يقترب من الحد الأعلى الفعلي
//      للسماح 200 بدل قيم منخفضة جداً)، (ALLOW_MINUTES دقيقة، افتراضياً 12 =
//      RESUME_STABILITY_MINUTES=10 + هامش دقيقتين) — يضمن وصول القرار
//      الفعلي لحالة "مسموح" لا مجرد "بانتظار استقرار".
//
// الاستخدام:
//   THINGSBOARD_DEVICE_TOKEN=<device-access-token> node scripts/local-thingsboard-violation-then-allow-scenario.mjs
// اختياري: THINGSBOARD_BASE_URL (افتراضي https://thingsboard.cloud)،
// SCENARIO_SEND_INTERVAL_MS (افتراضي 60000 = دقيقة واحدة، يطابق معدّل
// السحب المحلي الحالي — راجع local-provider-pull-cron.mjs)، ALLOW_MINUTES
// (افتراضي 12).

const BASE_URL = process.env.THINGSBOARD_BASE_URL || 'https://thingsboard.cloud';
const DEVICE_TOKEN = process.env.THINGSBOARD_DEVICE_TOKEN;
const SEND_INTERVAL_MS = Number(process.env.SCENARIO_SEND_INTERVAL_MS) || 60 * 1000;
const FIXED_VISIBILITY_M = Number(process.env.VISIBILITY_M) || 1000;

const STAGES = [
  { name: 'VIOLATION (تجاوز حد المخالفة 340)', minutes: 5, pm10Min: 350, pm10Max: 450 },
  { name: 'ALLOW (نطاق مسموح قريب من الحد الأعلى 200، يتجاوز استقرار 10 دقائق)', minutes: Number(process.env.ALLOW_MINUTES) || 12, pm10Min: 150, pm10Max: 200 },
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
    visibility: FIXED_VISIBILITY_M, // ثابتة (طلب صريح) — لا تتداخل مع اختبار PM10
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
  console.log(`بدء سيناريو (مخالفة ثم سماح) → ${BASE_URL}/api/v1/${DEVICE_TOKEN}/telemetry`);
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
