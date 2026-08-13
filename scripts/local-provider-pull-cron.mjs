// سكربت مؤقت للتجربة المحلية فقط (قبل نشر المشروع فعلياً على Vercel) —
// يحاكي خدمة cron-job.org الخارجية بمناداة /api/cron/provider-pull بشكل
// دوري. يُستبدَل بضبط cron-job.org حقيقي بعد النشر (راجع خطة
// multi-vendor-pull-integration.md، القسم 5) — هذا السكربت لا يُشغَّل في
// الإنتاج ولا يُستدعى من أي مسار آخر بالتطبيق.
//
// LOCAL_CRON_INTERVAL_MS: معدّل السحب — افتراضي دقيقة واحدة (60000)، ليطابق
// معدّل إرسال محاكي الجهاز (local-thingsboard-device-simulator.mjs) فيصبح
// "معدّل تحديث النظام كامل" (من قراءة الجهاز إلى ظهور القرار بالواجهة)
// دقيقة واحدة بدل دقيقتين.

const BASE_URL = process.env.LOCAL_CRON_BASE_URL || 'http://localhost:3000';
const SECRET = process.env.PROVIDER_PULL_CRON_SECRET;
const INTERVAL_MS = Number(process.env.LOCAL_CRON_INTERVAL_MS) || 60 * 1000;

if (!SECRET) {
  console.error('PROVIDER_PULL_CRON_SECRET غير مُعرَّف — مرّره كمتغير بيئة قبل التشغيل.');
  process.exit(1);
}

async function tick() {
  const startedAt = new Date().toISOString();
  try {
    const res = await fetch(`${BASE_URL}/api/cron/provider-pull`, {
      headers: { Authorization: `Bearer ${SECRET}` },
    });
    const body = await res.json();
    console.log(`[${startedAt}] status=${res.status}`, JSON.stringify(body));
  } catch (err) {
    console.error(`[${startedAt}] فشل الاتصال بـ ${BASE_URL}:`, err instanceof Error ? err.message : err);
  }
}

console.log(`بدء محاكاة cron محلي كل ${INTERVAL_MS / 1000} ثانية → ${BASE_URL}/api/cron/provider-pull`);
tick();
setInterval(tick, INTERVAL_MS);
