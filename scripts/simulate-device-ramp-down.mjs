// محاكاة جهاز يهبط PM10 تدريجياً "حبة حبة" من مستوى مخالفة مؤكَّدة (>340)
// إلى تشغيل عادي تماماً (<150) — عكس simulate-device-ramp.mjs. يبدأ بتأكيد
// مخالفة فعلية أولاً (قراءتان ≥340 متتاليتان)، ثم يهبط بالترتيب عبر كل
// نطاقات rulebook.ts:
//   >340 مؤكَّد → 300-339 تنبيه استباقي → 250-299 تحذير →
//   150-249 احتراز → <150 نظيف (ALLOW)
//
// يختبر معاً: (1) قانون استقرار 10 دقائق (resumeHoldApplied) — القرار يجب
// أن يبقى "موقوف" فترة رغم هبوط القراءة الفورية، (2) سلاسة تراجع القرار
// عبر كل نطاق بالترتيب الصحيح بعد انتهاء فترة الاستقرار.
//
// نفس بقية الحقول (رياح/رؤية/رطوبة/حرارة) بقيم آمنة ثابتة مع كل قراءة —
// يمنع "تنبيه أمني" عالقاً بسبب رؤية/رياح قديمة من محاكاة سابقة.
//
// الاستخدام:
//   node scripts/simulate-device-ramp-down.mjs <API_KEY> [startPm10] [stepPm10] [intervalMinutes] [minPm10]
// مثال (افتراضي — يبدأ 380 (تأكيد أولاً)، ينزل 50 كل دقيقتين حتى أقل من 150):
//   node scripts/simulate-device-ramp-down.mjs dcr_xxxxxxxx 380 50 2 100

const [, , apiKey, startArg, stepArg, intervalArg, minArg] = process.argv;

if (!apiKey) {
  console.error('الاستخدام: node scripts/simulate-device-ramp-down.mjs <API_KEY> [startPm10] [stepPm10] [intervalMinutes] [minPm10]');
  process.exit(1);
}

const start = Number(startArg ?? 380);
const step = Number(stepArg ?? 50);
const intervalMinutes = Number(intervalArg ?? 2);
const min = Number(minArg ?? 100);
const baseUrl = process.env.DCR_BASE_URL ?? 'http://localhost:3000';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function labelFor(pm10) {
  if (pm10 > 340) return 'مخالفة (>340)';
  if (pm10 >= 300) return 'تنبيه استباقي (300-339)';
  if (pm10 >= 250) return 'تحذير (250-299)';
  if (pm10 >= 150) return 'احتراز (150-249)';
  return 'نظيف (<150) — يجب أن يستأنف بعد 10 دقائق من هبوطه هنا';
}

async function sendReading(pm10, label) {
  const payload = {
    windSpeedKmh: 10,
    windGustKmh: 15,
    windDirectionDeg: 180,
    pm10,
    pm25: Math.round(pm10 * 0.4),
    visibilityM: 10000,
    relativeHumidityPercent: 30,
    temperatureC: 35,
  };
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
  console.log(`[${time}] ${label} pm10=${pm10} (${labelFor(pm10)}) → HTTP ${res.status}`, body);
  if (!res.ok) console.error('  فشل الإرسال.');
}

(async () => {
  console.log(`محاكاة تنازلية: تأكيد مخالفة عند ${start} أولاً، ثم هبوط تدريجي حتى ${min} — كل قراءة كل ${intervalMinutes} دقيقة (الهدف: ${baseUrl})`);

  // المرحلة 1: تأكيد المخالفة أولاً — قراءتان متتاليتان ≥340 (يحتاج دقيقتين
  // استمرار فعلي قبل أن تصبح "مؤكَّدة" لا "معلَّقة" فقط).
  await sendReading(start, 'تأكيد المخالفة — قراءة 1/2');
  await sleep(intervalMinutes * 60_000);
  await sendReading(start, 'تأكيد المخالفة — قراءة 2/2 (الآن مؤكَّدة)');
  await sleep(intervalMinutes * 60_000);

  // المرحلة 2: الهبوط التدريجي بدءاً من أول قيمة أقل من start.
  const values = [];
  for (let v = start - step; v > min; v -= step) values.push(v);
  values.push(min);

  console.log(`سلسلة الهبوط: ${values.join(' → ')}`);
  for (let i = 0; i < values.length; i++) {
    await sendReading(values[i], `هبوط ${i + 1}/${values.length} —`);
    if (i < values.length - 1) await sleep(intervalMinutes * 60_000);
  }

  // المرحلة 3: الاستمرار بإرسال القيمة الدنيا (النظيفة) لعدة دورات إضافية
  // (16+ دقيقة) حتى نتجاوز حد استقرار الـ10 دقائق ونلاحظ الاستئناف الفعلي.
  for (let i = 0; i < 8; i++) {
    await sleep(intervalMinutes * 60_000);
    await sendReading(min, `استمرار بعد الهبوط (${i + 1}/8) —`);
  }
  console.log('انتهت المحاكاة التنازلية.');
})();
