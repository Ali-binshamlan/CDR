// سيناريو اختبار كامل (سُلَّم متدرّج) لنفس جهاز ThingsBoard حقيقي: يبدأ من
// حالة مخالفة مؤكَّدة (PM10 فوق حد المخالفة 340)، ثم ينزل تدريجياً عبر كل
// درجة تشغيلية معرَّفة في الحزمة النشطة (RIYADH_DUST_2026_2، راجع
// app/utils/rule-bundles/riyadh-dust-2026.3.ts) حتى يصل لسماح نظيف (ALLOW)،
// بدل قفزة مباشرة من مخالفة لسماح كما في local-thingsboard-violation-then-
// allow-scenario.mjs. الهدف: مراقبة القرار وهو ينتقل عبر كل درجة وسيطة
// (ضوابط → تحذير → احتراز → سماح)، لا فقط طرفَي السلسلة.
//
// درجات حزمة RIYADH_DUST_2026_2 (operational، القيم الحالية النشطة فعلياً):
//   ≤200            → طبيعي (ALLOW)
//   201-250         → احتراز (MONITOR)
//   251-339         → ضوابط إلزامية (MONITOR، تحذير تنظيمي مستقل ابتداءً من 251)
//   ≥340 (>340 حصراً للحكم التنظيمي) → إيقاف احترازي فوري، مؤكَّد بعد
//                       استمرار فعلي أطول من دقيقتين (violationDurationMsExclusive)
//
// المراحل (بالترتيب، من الأعلى للأقل):
//   1) VIOLATION      — PM10 380-450 لمدة كافية لتأكيد المخالفة (>2 دقيقة
//                       استمرار فعلي فوق 340) — يُتوقَّع PROTECTIVE_STOP ثم
//                       MANDATORY_STOP.
//   2) CONTROLS       — PM10 260-320 (ضوابط إلزامية، دون حد المخالفة) —
//                       يُتوقَّع تراجع القرار عن الإيقاف الإلزامي، لكن ليس
//                       سماحاً كاملاً بعد.
//   3) PRECAUTION     — PM10 205-240 (احتراز) — يُتوقَّع تحسّن إضافي.
//   4) ALLOW          — PM10 50-150 (سماح نظيف) لمدة كافية تتجاوز مهلة
//                       استقرار الاستئناف الكاملة (RESUME_STABILITY_MINUTES
//                       في dust-compliance-engine/engine.ts، افتراضياً 10
//                       دقيقة) بهامش أمان — يضمن وصول القرار الفعلي لحالة
//                       "مسموح" لا مجرد "بانتظار استقرار".
//
// الرؤية ثابتة طوال السيناريو (لا تتداخل مع اختبار PM10 — طلب صريح من نمط
// السكربتات السابقة في هذا المجلد).
//
// سكربت اختباري محلي فقط — لا علاقة له بكود التطبيق، لا يُشغَّل بالإنتاج.
// يرسل مباشرة لـThingsBoard الحقيقي عبر device access token (نفس آلية
// local-thingsboard-violation-then-allow-scenario.mjs) — provider-pull
// (يدوياً أو عبر cron-job.org الفعلي) هو من يسحب هذه القراءات لاحقاً
// ويحوّلها لقرار حقيقي في قاعدة البيانات، تماماً كجهاز حقيقي.
//
// الاستخدام:
//   THINGSBOARD_DEVICE_TOKEN=<device-access-token> node scripts/local-thingsboard-full-ladder-scenario.mjs
// اختياري:
//   THINGSBOARD_BASE_URL         (افتراضي https://thingsboard.cloud)
//   SCENARIO_SEND_INTERVAL_MS    (افتراضي 60000 = دقيقة واحدة)
//   VIOLATION_MINUTES            (افتراضي 5)
//   CONTROLS_MINUTES             (افتراضي 3)
//   PRECAUTION_MINUTES           (افتراضي 3)
//   ALLOW_MINUTES                (افتراضي 12 = استقرار 10 دقائق + هامش 2)
//   VISIBILITY_M                 (افتراضي 1000)

const BASE_URL = process.env.THINGSBOARD_BASE_URL || 'https://thingsboard.cloud';
const DEVICE_TOKEN = process.env.THINGSBOARD_DEVICE_TOKEN;
const SEND_INTERVAL_MS = Number(process.env.SCENARIO_SEND_INTERVAL_MS) || 60 * 1000;
const FIXED_VISIBILITY_M = Number(process.env.VISIBILITY_M) || 1000;

const STAGES = [
  {
    name: 'VIOLATION — تجاوز حد المخالفة (>340)، يُتوقَّع PROTECTIVE_STOP ثم MANDATORY_STOP',
    minutes: Number(process.env.VIOLATION_MINUTES) || 5,
    pm10Min: 380,
    pm10Max: 450,
  },
  {
    name: 'CONTROLS — ضوابط إلزامية (260-320)، دون حد المخالفة',
    minutes: Number(process.env.CONTROLS_MINUTES) || 3,
    pm10Min: 260,
    pm10Max: 320,
  },
  {
    name: 'PRECAUTION — احتراز (205-240)',
    minutes: Number(process.env.PRECAUTION_MINUTES) || 3,
    pm10Min: 205,
    pm10Max: 240,
  },
  {
    name: 'ALLOW — سماح نظيف (50-150)، يتجاوز مهلة استقرار الاستئناف الكاملة',
    minutes: Number(process.env.ALLOW_MINUTES) || 12,
    pm10Min: 50,
    pm10Max: 150,
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
  console.log(`بدء سيناريو السُلَّم الكامل (مخالفة → ضوابط → احتراز → سماح) → ${BASE_URL}/api/v1/${DEVICE_TOKEN}/telemetry`);
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
