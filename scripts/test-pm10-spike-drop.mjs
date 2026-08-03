// اختبار مركَّز وقصير: قفزة فورية إلى ≥340 (تجاوز حد المخالفة)، ثم نزول
// سريع تحت الحد *قبل* اكتمال دقيقتي التأكيد — يثبت أن المخالفة تبقى
// "معلَّقة" فقط طوال الوقت ولا تتحول أبداً إلى "مؤكَّدة"، لأنها تُلغى فوراً
// بمجرد أن تنخفض القراءة الحالية دون 340 (لا تنتظر انقضاء الدقيقتين لتُلغى).
//
// السبب الفعلي (راجع computeSustainedPm10Status/streakMinutesAbove في
// app/lib/dustEvaluation.ts): سلسلة الاستمرار تُبنى من الأحدث للأقدم وتتوقف
// فوراً عند أول قراءة أقل من 340 — فمجرد وصول قراءة النزول، sustainedMinutesAbove340
// يعود للصفر فوراً بصرف النظر عن مدة الارتفاع السابقة، وisConfirmedViolation340
// يشترط أصلاً currentReadingUgM3 > 340 (القراءة *الحالية* لا التاريخية) —
// فتُلغى الحالة المعلَّقة بمجرد وصول القراءة المنخفضة، لا تنتظر مرور الوقت.
//
// تنبيه مهم لا يتعارض مع ما سبق: بعد النزول، القرار لا يعود "مسموح" فوراً
// رغم إلغاء حالة "معلَّق" — الحالة المعلَّقة نفسها (MRQ-PM10-BLACK-PENDING-104)
// فئتها STOP_AFFECTED_ACTIVITY (نفس فئة أي إيقاف آخر)، فيُطبَّق قيد استقرار
// الاستئناف العام (RESUME_STABILITY_MINUTES=10 دقائق في dust-compliance-engine/
// engine.ts) بعد النزول — القرار يبقى STOP_AFFECTED_ACTIVITY لمدة تصل 10
// دقائق إضافية بعد القراءة النظيفة الأولى، لا "مسموح" فوري. الفرق الذي
// يثبته هذا الاختبار تحديداً هو: لا تصل الحالة أبداً إلى "مخالفة مؤكدة"
// (MANDATORY_STOP الأسود القطعي)، فقط "معلَّق" ثم "بانتظار استقرار الاستئناف".
//
// الاستخدام:
//   node scripts/test-pm10-spike-drop.mjs <API_KEY> [dropAfterSeconds]
// مثال (افتراضي — نزول بعد 60 ثانية من القفزة، أي قبل حد الدقيقتين):
//   node scripts/test-pm10-spike-drop.mjs dcr_xxxxxxxx 60

const [, , apiKey, dropAfterArg] = process.argv;

if (!apiKey) {
  console.error('الاستخدام: node scripts/test-pm10-spike-drop.mjs <API_KEY> [dropAfterSeconds]');
  process.exit(1);
}

const dropAfterSeconds = Number(dropAfterArg ?? 60);
if (dropAfterSeconds >= 120) {
  console.error('تنبيه: dropAfterSeconds >= 120 (دقيقتين) — هذا يتجاوز حد التأكيد بالفعل، فقد تتحول الحالة إلى مؤكَّدة قبل النزول. مرِّر قيمة أقل من 120 لاختبار "النزول قبل الاكتمال" فعلياً.');
}

const baseUrl = process.env.DCR_BASE_URL ?? 'http://localhost:3000';
const SPIKE_PM10 = 350; // >340 بوضوح، يتجاوز حد المخالفة صراحة
const DROP_PM10 = 100; // نظيف تماماً (<150، لا احتراز حتى)

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
  console.log(`اختبار قفزة/نزول PM10: قفزة إلى ${SPIKE_PM10} فوراً، ثم نزول إلى ${DROP_PM10} بعد ${dropAfterSeconds} ثانية (الهدف: ${baseUrl})`);
  console.log('افتح تفاصيل النشاط في الواجهة الآن — يجب أن تظهر "معلَّق (بانتظار تأكيد)" بعد القفزة، ثم "بانتظار استقرار الاستئناف" (حتى 10 دقائق) بعد النزول — بلا وصول أبداً لـ"مخالفة مؤكدة" أو إيقاف إلزامي أسود.\n');

  await sendReading(SPIKE_PM10, 'قفزة فورية — متوقَّع: معلَّق (بانتظار تأكيد استمرار)');

  console.log(`\nانتظار ${dropAfterSeconds} ثانية قبل النزول (أقل من حد التأكيد 120 ثانية)...\n`);
  await sleep(dropAfterSeconds * 1000);

  await sendReading(DROP_PM10, 'نزول قبل اكتمال التأكيد — متوقَّع: STOP_AFFECTED_ACTIVITY (بانتظار استقرار الاستئناف)، لا مخالفة مؤكدة إطلاقاً');

  console.log('\nانتهى الاختبار — تحقق من الواجهة: يجب ألا تظهر "مخالفة مؤكدة" أو "إيقاف إلزامي" (أسود) في أي لحظة — أقصى شدة متوقعة هي "معلَّق"/"بانتظار استقرار الاستئناف".');
})();
