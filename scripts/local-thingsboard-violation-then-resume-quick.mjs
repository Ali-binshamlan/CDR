// سيناريو اختبار سريع (مخالفة ثم استئناف تام) لنفس جهاز ThingsBoard —
// نسخة مختصرة من local-thingsboard-violation-then-full-allow-scenario.mjs
// تعتمد على RESUME_STABILITY_MINUTES المخفَّضة مؤقتاً إلى 3 (بدل 10) في
// app/utils/dust-compliance-engine/engine.ts:568 لتسريع دورة الاختبار
// المحلي — يجب أن يبقى ذلك التعديل موجوداً وقت تشغيل هذا السكربت، وإلا لن
// يكتمل الاستئناف خلال مدة السيناريو القصيرة هنا.
//
// سكربت اختباري محلي فقط — لا علاقة له بكود التطبيق، لا يُشغَّل بالإنتاج.
//
// المراحل:
//   1) VIOLATION — PM10 بين 350-450 (3 دقائق) — فوق حد المخالفة 340.
//   2) RESUME    — PM10 بين 50-100 + رؤية 10كم (تصفير pm10Risk وvisibilityRisk
//      فعلياً — راجع تعليق local-thingsboard-violation-then-full-allow-scenario.mjs
//      الكامل عن سبب اختيار هاتين القيمتين تحديداً)، لمدة RESUME_MINUTES
//      (افتراضياً 5 = استقرار 3 دقائق + هامش دقيقتين) — يضمن وصول القرار
//      الفعلي لحالة "تشغيل عادي" (ALLOW/GREEN) لا "مراقبة" ولا "بانتظار استقرار".
//
// الاستخدام:
//   THINGSBOARD_DEVICE_TOKEN=<device-access-token> node scripts/local-thingsboard-violation-then-resume-quick.mjs
// اختياري: THINGSBOARD_BASE_URL، SCENARIO_SEND_INTERVAL_MS (افتراضي 60000)،
// RESUME_MINUTES (افتراضي 5)، VIOLATION_MINUTES (افتراضي 3).

const BASE_URL = process.env.THINGSBOARD_BASE_URL || 'https://thingsboard.cloud';
const DEVICE_TOKEN = process.env.THINGSBOARD_DEVICE_TOKEN;
const SEND_INTERVAL_MS = Number(process.env.SCENARIO_SEND_INTERVAL_MS) || 60 * 1000;
const FIXED_VISIBILITY_M = Number(process.env.VISIBILITY_M) || 10000;

const STAGES = [
  { name: 'VIOLATION (تجاوز حد المخالفة 340)', minutes: Number(process.env.VIOLATION_MINUTES) || 3, pm10Min: 350, pm10Max: 450 },
  { name: 'RESUME (تشغيل عادي — PM10 منخفض + رؤية ممتازة، يتجاوز استقرار 3 دقائق)', minutes: Number(process.env.RESUME_MINUTES) || 5, pm10Min: 50, pm10Max: 100 },
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
    windSpeed: randomInRange(5, 15),
    windGust: randomInRange(10, 20),
    windDirection: randomInRange(0, 360, 0),
    pm10: randomInRange(pm10Min, pm10Max),
    pm25: randomInRange(10, 80),
    visibility: FIXED_VISIBILITY_M,
    humidity: randomInRange(20, 50, 0),
    temperature: randomInRange(25, 35, 1),
  };
}

// إعادة محاولة تلقائية عند فشل الشبكة (fetch failed) — بدل فقدان القراءة
// والانتظار للتيك التالي (60 ثانية)، يعيد المحاولة فوراً حتى النجاح. مهم
// خصوصاً لمرحلة RESUME حيث فقدان قراءة واحدة يُعيد عداد الاستقرار من الصفر.
const MAX_SEND_ATTEMPTS = 5;
const RETRY_DELAY_MS = 3000;

async function sendReading(pm10Min, pm10Max) {
  const reading = buildReading(pm10Min, pm10Max);

  for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt++) {
    const startedAt = new Date().toISOString();
    try {
      const res = await fetch(`${BASE_URL}/api/v1/${DEVICE_TOKEN}/telemetry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reading),
      });
      console.log(`[${startedAt}] status=${res.status} pm10=${reading.pm10} visibility=${reading.visibility}`);
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (attempt < MAX_SEND_ATTEMPTS) {
        console.error(`[${startedAt}] فشل الإرسال (محاولة ${attempt}/${MAX_SEND_ATTEMPTS}): ${message} — إعادة المحاولة خلال ${RETRY_DELAY_MS / 1000}ث`);
        await sleep(RETRY_DELAY_MS);
      } else {
        console.error(`[${startedAt}] فشل الإرسال نهائياً بعد ${MAX_SEND_ATTEMPTS} محاولات: ${message}`);
      }
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runScenario() {
  const totalMinutes = STAGES.reduce((sum, s) => sum + s.minutes, 0);
  console.log(`بدء سيناريو سريع (مخالفة ثم استئناف) → ${BASE_URL}/api/v1/${DEVICE_TOKEN}/telemetry`);
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
