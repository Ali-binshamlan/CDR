// سيناريو اختبار مبسّط لنفس جهاز ThingsBoard: سرعة الرياح تبدأ بمرحلة إيقاف
// تنظيمي مؤكَّدة (فوق حد 25 كم/س — GATE-WIND-ABOVE-25-004، يوقف الأنشطة
// المكشوفة المولّدة للغبار) لمدة ثابتة، ثم تنزل لنطاق هادئ (BELOW_15،
// ALLOW نظيف) وتستمر بالإرسال حتى يتجاوز مهلة استقرار الاستئناف
// (RESUME_STABILITY_MINUTES في dust-compliance-engine/engine.ts) بهامش
// أمان — أي لا يتوقف السكربت عند أول قراءة هادئة، بل يستمر حتى يضمن وصول
// القرار الفعلي لحالة "مسموح" وليس فقط "بانتظار استقرار".
// راجع classifyWind وWIND_GATE_STOP_KMH(=25) في
// app/utils/dust-compliance-engine/rulebook.ts وruleParameters.ts.
//
// الرؤية ثابتة على 10000م طوال السيناريو (طلب صريح) — لا تتداخل مع اختبار
// الرياح. PM10 ثابت بنطاق آمن (طلب ضمني: لا يتداخل مع اختبار الرياح تحديداً).
// سكربت اختباري محلي فقط — لا علاقة له بكود التطبيق، لا يُشغَّل بالإنتاج.
//
// المراحل:
//   1) STOP    — رياح 28-40 كم/س (5 دقائق) — فوق حد 25؛ يُفعِّل إيقافاً
//      تنظيمياً فعلياً (GATE-WIND-ABOVE-25-004) للأنشطة المكشوفة المولّدة للغبار.
//   2) ALLOW   — رياح 5-12 كم/س (ALLOW_MINUTES دقيقة، افتراضياً 12 =
//      هامش أمان فوق مهلة الاستقرار) — يضمن وصول القرار الفعلي لحالة
//      "مسموح" لا مجرد "بانتظار استقرار".
//
// الاستخدام:
//   THINGSBOARD_DEVICE_TOKEN=<device-access-token> node scripts/local-thingsboard-wind-gate-scenario.mjs
// اختياري: THINGSBOARD_BASE_URL (افتراضي https://thingsboard.cloud)،
// SCENARIO_SEND_INTERVAL_MS (افتراضي 60000 = دقيقة واحدة، يطابق معدّل
// السحب المحلي الحالي — راجع local-provider-pull-cron.mjs)، ALLOW_MINUTES
// (افتراضي 12).

const BASE_URL = process.env.THINGSBOARD_BASE_URL || 'https://thingsboard.cloud';
const DEVICE_TOKEN = process.env.THINGSBOARD_DEVICE_TOKEN;
const SEND_INTERVAL_MS = Number(process.env.SCENARIO_SEND_INTERVAL_MS) || 60 * 1000;
const FIXED_VISIBILITY_M = Number(process.env.VISIBILITY_M) || 10000;

const STAGES = [
  { name: 'STOP (فوق حد 25 كم/س — إيقاف تنظيمي GATE-WIND-ABOVE-25-004)', minutes: 5, windMin: 28, windMax: 40, gustMin: 30, gustMax: 45 },
  { name: 'ALLOW (هادئ — BELOW_15، يتجاوز استقرار الاستئناف)', minutes: Number(process.env.ALLOW_MINUTES) || 12, windMin: 5, windMax: 12, gustMin: 8, gustMax: 16 },
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
  console.log(`بدء سيناريو بوابة الرياح (إيقاف ثم سماح) → ${BASE_URL}/api/v1/${DEVICE_TOKEN}/telemetry`);
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
