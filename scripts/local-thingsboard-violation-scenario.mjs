// سيناريو اختبار كامل لنفس جهاز ThingsBoard: PM10 يمر بثلاث مراحل زمنية
// متتالية لاختبار السلسلة الكاملة (تسجيل مخالفة مؤكَّدة ثم قاعدة استقرار
// الاستئناف 10 دقائق) على نفس الجهاز الحقيقي، بدل تشغيل يدوي متكرر.
// سكربت اختباري محلي فقط — لا علاقة له بكود التطبيق، لا يُشغَّل بالإنتاج.
//
// المراحل (بالترتيب، بلا تداخل):
//   1) LOW    — PM10 بين 50-150 (دقيقتان) — خط أساس آمن (ALLOW نظيف، تحت 200).
//   2) SPIKE  — PM10 بين 350-450 (3 دقائق) — فوق حد المخالفة 340؛ "معلَّق"
//      (STOP_AFFECTED_ACTIVITY) أول أكثر من دقيقتين، ثم "مؤكَّد" (MANDATORY_STOP)
//      — راجع PM10_VIOLATION_CONFIRM_MINUTES في app/lib/dustEvaluation.ts.
//   3) RECOVER — PM10 يرجع لـ50-150 (12 دقيقة) — يبقى النشاط موقوفاً أول
//      10 دقائق (RESUME_STABILITY_MINUTES في dust-compliance-engine/engine.ts)
//      حتى تستقر القراءة الجيدة، ثم يُسمح بالاستئناف.
//
// الاستخدام:
//   THINGSBOARD_DEVICE_TOKEN=<device-access-token> node scripts/local-thingsboard-violation-scenario.mjs
// اختياري: THINGSBOARD_BASE_URL (افتراضي https://thingsboard.cloud)،
// SCENARIO_SEND_INTERVAL_MS (افتراضي 60000 = دقيقة واحدة، يطابق معدّل
// السحب المحلي الحالي — راجع local-provider-pull-cron.mjs).

const BASE_URL = process.env.THINGSBOARD_BASE_URL || 'https://thingsboard.cloud';
const DEVICE_TOKEN = process.env.THINGSBOARD_DEVICE_TOKEN;
const SEND_INTERVAL_MS = Number(process.env.SCENARIO_SEND_INTERVAL_MS) || 60 * 1000;

if (!DEVICE_TOKEN) {
  console.error('THINGSBOARD_DEVICE_TOKEN غير مُعرَّف — مرّره كمتغير بيئة قبل التشغيل.');
  process.exit(1);
}

// كل مرحلة: اسم للعرض، مدتها بالدقائق، ونطاق PM10 (يبقى باقي الحقول ثابتاً
// معقولاً طوال السيناريو حتى لا تتداخل عوامل أخرى مع اختبار PM10 تحديداً).
const STAGES = [
  { name: 'LOW (خط أساس آمن)', minutes: 2, pm10Min: 50, pm10Max: 150 },
  { name: 'SPIKE (تجاوز حد المخالفة 340)', minutes: 3, pm10Min: 350, pm10Max: 450 },
  { name: 'RECOVER (اختبار استقرار الاستئناف 10 دقائق)', minutes: 12, pm10Min: 50, pm10Max: 150 },
];

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
    visibility: randomInRange(3, 10, 2), // رؤية جيدة ثابتة — لا تتداخل مع اختبار PM10
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
    console.log(`[${startedAt}] status=${res.status} pm10=${reading.pm10}`);
  } catch (err) {
    console.error(`[${startedAt}] فشل الإرسال:`, err instanceof Error ? err.message : err);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runScenario() {
  const totalMinutes = STAGES.reduce((sum, s) => sum + s.minutes, 0);
  console.log(`بدء سيناريو المخالفة → ${BASE_URL}/api/v1/${DEVICE_TOKEN}/telemetry`);
  console.log(`المدة الإجمالية: ${totalMinutes} دقيقة، إرسال كل ${SEND_INTERVAL_MS / 1000} ثانية.\n`);

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
