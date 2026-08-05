// سكربت اختبار القرارات — يرسل سلسلة قراءات PM10 مرتّبة تمر بكل نطاقات
// rulebook.ts بالترتيب (نظيف → احتراز → تحذير → تنبيه استباقي → معلَّق →
// مخالفة مؤكدة → استئناف)، مع وقفة بعد كل خطوة ليتابعها المستخدم مباشرة في
// الواجهة (بطاقة الامتثال/AEI/البانر الموحّد) قبل الانتقال للخطوة التالية.
//
// الفرق عن simulate-device-ramp.mjs: هذا السكربت يطبع اسم الحالة المتوقعة
// ووصفها قبل كل خطوة (لا الرقم فقط)، ويكرر القراءة الحرجة (>340) مرتين
// متتاليتين تلقائياً — فحص استمرار PM10 (RCRC-PM10-340-VIOLATION-011)
// يشترط أكثر من دقيقتين متواصلتين فوق 340 من مصدر جهاز حقيقي قبل التأكيد
// (pm10ConfirmedViolation340 في dustEvaluation.ts)؛ قراءة واحدة تبقى
// "معلَّقة" فقط (MRQ-PM10-BLACK-PENDING-104)، لا "مخالفة مؤكدة".
//
// الاستخدام:
//   node scripts/test-decisions-sequence.mjs <API_KEY> [intervalMinutes]
// مثال (افتراضي — كل دقيقتين، نفس دورة الإرسال الحقيقية):
//   node scripts/test-decisions-sequence.mjs dcr_xxxxxxxx 2
//
// يمكن تمرير --skip-wait لتجاوز الانتظار الفعلي بين الخطوات (اختبار سريع
// بلا تتبّع حي للفواصل الزمنية الحقيقية — القرارات المعتمدة على استمرار
// زمني فعلي مثل التأكيد/الاستئناف لن تظهر صحيحة حينها، فقط القراءة اللحظية).

const args = process.argv.slice(2);
const skipWait = args.includes('--skip-wait');
const positional = args.filter((a) => a !== '--skip-wait');
const [apiKey, intervalArg] = positional;

if (!apiKey) {
  console.error('الاستخدام: node scripts/test-decisions-sequence.mjs <API_KEY> [intervalMinutes] [--skip-wait]');
  process.exit(1);
}

const intervalMinutes = Number(intervalArg ?? 2);
const baseUrl = process.env.DCR_BASE_URL ?? 'http://localhost:3000';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// كل خطوة: pm10 + وصف الحالة المتوقعة (بطاقة الامتثال) + عدد التكرار
// (>1 فقط للقراءة الحرجة، لإثبات الاستمرار قبل التأكيد).
const STEPS = [
  { pm10: 80, label: 'نظيف — ALLOW (لا احتراز، لا تحذير)', repeat: 1 },
  { pm10: 180, label: 'احتراز — PRECAUTION (150-249، أصفر)', repeat: 1 },
  { pm10: 270, label: 'تحذير — WARNING (250-299، PM10-WARNING-008)', repeat: 1 },
  { pm10: 320, label: 'تنبيه استباقي — EARLY_WARNING (300-339، قبل حد المخالفة)', repeat: 1 },
  {
    pm10: 350,
    label: 'تجاوز حد المخالفة — أول قراءة: معلَّق (MRQ-PM10-BLACK-PENDING-104)، ثاني قراءة بعد أكثر من دقيقتين: مخالفة مؤكدة (RCRC-PM10-340-VIOLATION-011 / MANDATORY_STOP)',
    repeat: 2,
  },
  { pm10: 100, label: 'تحسّن مفاجئ — القرار يجب أن يبقى موقوفاً (RESUME_STABILITY_MINUTES=10 دقائق قبل الاستئناف التلقائي)', repeat: 1 },
];

// قيم ثابتة آمنة لبقية الحقول (رياح/رؤية/رطوبة/حرارة) مع كل قراءة — حتى لا
// يبقى SAFETY_BREACH عالقاً من رياح/رؤية قديمة سيئة من محاكاة سابقة (الكتابة
// جزئية، الحقول الغائبة تبقى بقيمتها المخزَّنة سابقاً — راجع تعليق
// MEASUREMENT_FIELDS في app/api/devices/ingest/route.ts).
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

async function sendReading(pm10, context) {
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
  console.log(`[${time}] ${context} — pm10=${pm10} → HTTP ${res.status}`, body);
  if (!res.ok) {
    console.error('  فشل الإرسال — تحقق من صحة مفتاح API وأن الجهاز نشط (is_active).');
  }
}

(async () => {
  const totalSends = STEPS.reduce((sum, s) => sum + s.repeat, 0);
  console.log(`اختبار القرارات: ${STEPS.length} حالة (${totalSends} قراءة إجمالاً) — كل قراءة كل ${intervalMinutes} دقيقة (الهدف: ${baseUrl})`);
  if (skipWait) console.log('تنبيه: --skip-wait مفعّل — القرارات المعتمدة على استمرار زمني فعلي (تأكيد المخالفة، استئناف بعد استقرار) لن تنعكس بشكل صحيح.');
  console.log('افتح تفاصيل النشاط في الواجهة الآن وتابع بطاقة "الامتثال التنظيمي" بعد كل خطوة.\n');

  let sent = 0;
  for (const step of STEPS) {
    console.log(`\n=== الحالة المتوقعة: ${step.label} ===`);
    for (let i = 1; i <= step.repeat; i++) {
      sent++;
      await sendReading(step.pm10, `خطوة ${sent}/${totalSends}${step.repeat > 1 ? ` (تكرار ${i}/${step.repeat})` : ''}`);
      if (sent < totalSends && !skipWait) await sleep(intervalMinutes * 60_000);
    }
  }

  console.log('\nانتهى اختبار القرارات — تحقق من آخر حالة في الواجهة (يجب أن تبقى موقوفة حتى مرور 10 دقائق استقرار).');
})();
