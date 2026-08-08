// تشغيل أي سيناريو من app/lib/dustScenarios.ts مباشرة من التيرمنال — بديل
// سطر أوامر لزر "تشغيل السيناريو" في app/dashboard/dust-scenarios (الذي
// يحتاج جلسة متصفح مسجَّلة/سوبر أدمن، لا يصلح لـcurl/سكربت مباشر). يقرأ
// نفس تعريف المراحل من dustScenarios.ts (مصدر واحد، لا قيم مكرَّرة) ويرسلها
// كـtelemetry حقيقية لـThingsBoard بنفس آلية runLoop في dustScenarioRunner.ts.
//
// الاستخدام:
//   node scripts/run-dust-scenario.mjs <scenario-id> [sendIntervalMs]
//   node scripts/run-dust-scenario.mjs --list   (لعرض كل المعرّفات المتاحة)
//
// مثال:
//   THINGSBOARD_DEVICE_TOKEN=xxx node scripts/run-dust-scenario.mjs wind-above-25-stop

import { pathToFileURL } from 'url';
import { register } from 'node:module';
import path from 'path';

// dustScenarios.ts ملف TypeScript صرف (بلا JSX) — نحمّله عبر tsx/loader لو
// متاح، وإلا نُعيد بناءه يدوياً هنا كنسخة JS مطابقة (fallback بسيط، القيم
// منسوخة حرفياً من dustScenarios.ts وقت كتابة هذا السكربت).
let DUST_SCENARIOS;
try {
  register('tsx/esm', pathToFileURL('./'));
  const mod = await import(pathToFileURL(path.resolve('app/lib/dustScenarios.ts')).href);
  DUST_SCENARIOS = mod.DUST_SCENARIOS;
} catch {
  // fallback: نسخة JS يدوية مطابقة لـapp/lib/dustScenarios.ts (تحديث يدوي
  // مطلوب هنا إن تغيّر الملف الأصلي وتعذّر تحميل tsx) — راجع الملف الأصلي
  // دائماً كمصدر الحقيقة، هذا احتياطي فقط لتشغيل فوري بلا اعتماديات إضافية.
  const CALM_WIND = [5, 10];
  const CALM_GUST = [10, 15];
  const NORMAL_PM10 = [80, 120];
  const CLEAR_VISIBILITY = [3000, 5000];
  DUST_SCENARIOS = [
    {
      id: 'wind-above-25-stop',
      titleAr: 'بوابة الرياح — إيقاف فوق 25 كم/س',
      targetRuleAr: 'GATE-WIND-ABOVE-25-004',
      stages: [
        { labelAr: 'قبل الإيقاف — رياح هادئة', minutes: 2, windSpeedKmh: CALM_WIND, windGustKmh: CALM_GUST, pm10: NORMAL_PM10, visibilityM: CLEAR_VISIBILITY },
        { labelAr: 'رياح فوق 25 كم/س', minutes: 3, windSpeedKmh: [28, 35], windGustKmh: [30, 40], pm10: NORMAL_PM10, visibilityM: CLEAR_VISIBILITY },
      ],
    },
    {
      id: 'wind-15-25-enhanced',
      titleAr: 'الرياح 15-25 — تثبيط معزز',
      targetRuleAr: 'GATE-WIND-15-25-ENHANCED-005',
      stages: [
        { labelAr: 'قبل — رياح هادئة', minutes: 2, windSpeedKmh: CALM_WIND, windGustKmh: CALM_GUST, pm10: NORMAL_PM10, visibilityM: CLEAR_VISIBILITY },
        { labelAr: 'رياح 15-25 كم/س', minutes: 3, windSpeedKmh: [16, 24], windGustKmh: [18, 26], pm10: NORMAL_PM10, visibilityM: CLEAR_VISIBILITY },
      ],
    },
    {
      id: 'wind-gust-safety',
      titleAr: 'هبّة رياح قوية عابرة',
      targetRuleAr: 'GATE-WIND-GUST-SAFETY',
      stages: [
        { labelAr: 'قبل — هبّات عادية', minutes: 2, windSpeedKmh: CALM_WIND, windGustKmh: CALM_GUST, pm10: NORMAL_PM10, visibilityM: CLEAR_VISIBILITY },
        { labelAr: 'هبّة فوق 50 كم/س', minutes: 2, windSpeedKmh: [10, 15], windGustKmh: [52, 65], pm10: NORMAL_PM10, visibilityM: CLEAR_VISIBILITY },
      ],
    },
  ];
}

const [, , scenarioIdArg, intervalArg] = process.argv;

if (!scenarioIdArg || scenarioIdArg === '--list') {
  console.log('السيناريوهات المتاحة:');
  for (const s of DUST_SCENARIOS) {
    console.log(`  ${s.id.padEnd(32)} ${s.titleAr}  (${s.targetRuleAr})`);
  }
  process.exit(scenarioIdArg ? 0 : 1);
}

const scenario = DUST_SCENARIOS.find((s) => s.id === scenarioIdArg);
if (!scenario) {
  console.error(`سيناريو غير معروف: ${scenarioIdArg}`);
  console.error('استخدم --list لعرض كل المعرّفات المتاحة.');
  process.exit(1);
}

const DEVICE_TOKEN = process.env.THINGSBOARD_DEVICE_TOKEN;
if (!DEVICE_TOKEN) {
  console.error('THINGSBOARD_DEVICE_TOKEN غير مُعرَّف — مرّره كمتغير بيئة قبل التشغيل.');
  process.exit(1);
}
const BASE_URL = process.env.THINGSBOARD_BASE_URL || 'https://thingsboard.cloud';
const SEND_INTERVAL_MS = Number(intervalArg) || 60_000;

function randomInRange([min, max], decimals = 1) {
  const factor = 10 ** decimals;
  return Math.round((min + Math.random() * (max - min)) * factor) / factor;
}

function buildReading(stage) {
  return {
    windSpeed: randomInRange(stage.windSpeedKmh),
    windGust: randomInRange(stage.windGustKmh),
    windDirection: randomInRange([0, 360], 0),
    pm10: randomInRange(stage.pm10),
    pm25: randomInRange([Math.min(10, stage.pm10[0] * 0.4), Math.min(150, stage.pm10[1] * 0.6)]),
    visibility: randomInRange(stage.visibilityM, 0) / 1000,
    humidity: randomInRange([20, 50], 0),
    temperature: randomInRange([25, 40], 1),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendReading(stage) {
  const reading = buildReading(stage);
  const startedAt = new Date().toISOString();
  try {
    const res = await fetch(`${BASE_URL}/api/v1/${DEVICE_TOKEN}/telemetry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reading),
    });
    console.log(`[${startedAt}] status=${res.status} wind=${reading.windSpeed} gust=${reading.windGust} pm10=${reading.pm10} vis=${Math.round(reading.visibility * 1000)}m`);
  } catch (err) {
    console.error(`[${startedAt}] فشل الإرسال:`, err instanceof Error ? err.message : err);
  }
}

async function runScenario() {
  const totalMinutes = scenario.stages.reduce((sum, s) => sum + s.minutes, 0);
  console.log(`بدء سيناريو: ${scenario.titleAr} (${scenario.targetRuleAr})`);
  console.log(`المدة الإجمالية: ${totalMinutes} دقيقة، إرسال كل ${SEND_INTERVAL_MS / 1000} ثانية → ${BASE_URL}/api/v1/${DEVICE_TOKEN}/telemetry\n`);

  for (const stage of scenario.stages) {
    console.log(`\n=== المرحلة: ${stage.labelAr} — ${stage.minutes} دقيقة ===`);
    const ticksInStage = Math.max(1, Math.round((stage.minutes * 60 * 1000) / SEND_INTERVAL_MS));
    for (let i = 0; i < ticksInStage; i++) {
      await sendReading(stage);
      if (i < ticksInStage - 1) await sleep(SEND_INTERVAL_MS);
    }
  }

  console.log('\nانتهى السيناريو بالكامل — توقف السكربت.');
}

runScenario();
