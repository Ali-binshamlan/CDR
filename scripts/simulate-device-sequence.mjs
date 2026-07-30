// محاكاة جهاز يمر بعدة "مراحل" قيمة مختلفة — يُستخدم لاختبار سيناريو
// "مخالفة مؤكدة ثم تحسّن": قراءات عالية (≥340) تؤكد المخالفة، ثم قراءات
// منخفضة (<250) تبدأ عدّاد استقرار 10 دقائق (RESUME_STABILITY_MINUTES في
// dust-compliance-engine/engine.ts) قبل ما يُسمح بالاستئناف الطبيعي —
// القرار يجب أن يبقى STOP_AFFECTED_ACTIVITY طوال تلك الـ10 دقائق رغم أن
// القراءة الحالية جيدة، لا يستأنف فوراً بمجرد أول قراءة منخفضة.
//
// الاستخدام (المراحل بصيغة قيمة:عدد_قراءات، كل قراءة بفاصل دقيقتين):
//   node scripts/simulate-device-sequence.mjs <API_KEY> "350:3,150:8"
//
// المثال أعلاه: 3 قراءات 350 (يؤكد المخالفة بعد ثاني قراءة)، ثم 8 قراءات
// 150 كل دقيقتين (16 دقيقة قراءة جيدة متواصلة — يتجاوز حد الـ10 دقائق،
// فيكفي لمراقبة القرار وهو يرفض الاستئناف أول 5 قراءات تقريباً ثم يستأنف).

const [, , apiKey, stagesArg] = process.argv;

if (!apiKey || !stagesArg) {
  console.error('الاستخدام: node scripts/simulate-device-sequence.mjs <API_KEY> "350:3,150:8"');
  process.exit(1);
}

const stages = stagesArg.split(',').map((s) => {
  const [pm10Str, countStr] = s.split(':');
  return { pm10: Number(pm10Str), count: Number(countStr) };
});

const intervalMinutes = Number(process.env.DCR_INTERVAL_MINUTES ?? 2);
const baseUrl = process.env.DCR_BASE_URL ?? 'http://localhost:3000';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendReading(pm10, label) {
  const res = await fetch(`${baseUrl}/api/devices/ingest`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ pm10 }),
  });
  const body = await res.json().catch(() => ({}));
  const time = new Date().toLocaleTimeString('ar-SA');
  console.log(`[${time}] ${label} — pm10=${pm10} → HTTP ${res.status}`, body);
  if (!res.ok) {
    console.error('  فشل الإرسال — راجع الرسالة أعلاه.');
  }
}

(async () => {
  const totalReadings = stages.reduce((sum, s) => sum + s.count, 0);
  console.log(`محاكاة متعددة المراحل: ${stages.map((s) => `${s.pm10}×${s.count}`).join(' ثم ')} — كل قراءة كل ${intervalMinutes} دقيقة (إجمالي ${totalReadings} قراءة، الهدف: ${baseUrl})`);

  let sent = 0;
  for (const stage of stages) {
    for (let i = 1; i <= stage.count; i++) {
      sent++;
      await sendReading(stage.pm10, `مرحلة pm10=${stage.pm10} — قراءة ${i}/${stage.count} (إجمالي ${sent}/${totalReadings})`);
      if (sent < totalReadings) await sleep(intervalMinutes * 60_000);
    }
  }
  console.log('انتهت المحاكاة.');
})();
