import { NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { timingSafeStringEqual } from '@/app/lib/timingSafe';
import { getConnector } from '@/app/lib/providers/registry';
import { decryptCredentialsV2 } from '@/app/lib/credentialsEncryption';
import { recordWorkerHeartbeat } from '@/app/lib/workerHeartbeat';
import type { NormalizedReading } from '@/app/lib/providers/types';

const WORKER_NAME = 'provider-pull';

// خطأ مكتشَف ومُصلَح (مراجعة كود خارجي — "مفتاح منع التكرار قابل للتصادم"):
// راجع تعليق migration 202608110016 الكامل. provider_event_key يُبنى من
// vendorEventId الحقيقي إن وفّره الـConnector، وإلا observedAtIso:hash قانوني
// للحمولة كاملة — تصحيح لاحق أو حقل جديد بنفس observedAtIso بالضبط ينتج
// hash مختلفاً فيُقبَل كصف جديد بدل أن يُرفَض كتكرار صامت. نفس أسلوب
// sortedStringify في computeInputSnapshotHash (dustEvaluation.ts) — مفاتيح
// الكائنات مرتَّبة أبجدياً قبل التجزئة حتى لا يتغيّر الـhash لمجرد اختلاف
// ترتيب الحقول بين استدعاءين لنفس البيانات فعلياً.
function canonicalStringify(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      return Object.keys(val)
        .sort()
        .reduce((acc: Record<string, unknown>, k) => {
          acc[k] = (val as Record<string, unknown>)[k];
          return acc;
        }, {});
    }
    return val;
  });
}

function buildProviderEventKey(reading: NormalizedReading): string {
  if (reading.vendorEventId) return reading.vendorEventId;
  const payloadHash = createHash('sha256').update(canonicalStringify(reading)).digest('hex');
  return `${reading.observedAtIso}:${payloadHash}`;
}

// حد أقصى 60 ثانية لتنفيذ الدالة كاملةً (خطة Vercel Hobby تسمح بحد أقصى
// 60s على الدوال المحدَّدة صراحة، بدل الافتراضي 10s). بعد إعادة التصميم
// (راجع خطة "إعادة تصميم مسار استقبال Telemetry"، طُبِّقت بموافقة صريحة
// 2026-08-09) لم يعد هذا المسار يكتب في جداول القرار أو يستدعي evaluateProject
// إطلاقاً — فقط سحب + إدراج دفعي في telemetry_ingestion_queue — فالمدة
// الفعلية المتوقعة أقصر بكثير من الحد الأقصى؛ الحد نفسه يبقى كخط دفاع أخير.
export const maxDuration = 60;

// نتيجة list_active_provider_connections (RPC، 202608040032) — راجع
// تعليق الاستدعاء أدناه لسبب استخدام RPC بدل .select() مباشر.
interface ActiveProviderConnectionRow {
  id: string;
  device_id: string;
  project_id: string;
  provider: string;
  credentials_ciphertext: string | null;
  credentials_key_version: number | null;
  vendor_station_id: string;
  provider_instance_id: string | null;
  last_pull_at: string | null;
  // خطأ مكتشَف ومُصلَح (مراجعة كود خارجي — "مؤشر السحب يتقدم حتى عند فشل
  // Queue"): راجع تعليق migration 202608110014 الكامل. pull_cursor_at
  // مستقل تماماً عن last_pull_at — يتقدم فقط عند نجاح إدراج دفعة القراءات
  // كاملة، ويُستخدَم هنا لحساب sinceMs بدل last_pull_at.
  pull_cursor_at: string | null;
}

// =====================================================================
// إعادة تصميم مسار الاستقبال (2026-08-09) — Ingestion فقط، بلا استثناء
// =====================================================================
// هذا المسار كان سابقاً يقوم بدورة معالجة كاملة متزامنة لكل قراءة: سحب
// + كتابة مباشرة (writeDeviceReading → RPC ثقيلة ~20 عملية DB) + استدعاء
// evaluateProject inline محمي بـPromise.race (لا يلغي الاستعلام الفعلي في
// Postgres) — هذا كان السبب الجذري الموثَّق لتصادم الأقفال وارتفاع CPU على
// Supabase/Vercel المتكرر طوال هذه الجلسة.
//
// الآن: provider-pull مسؤول حصراً عن Fetch من الـProvider + Validation
// أساسي (داخل الـConnector) + Normalization (داخل الـConnector) + بناء
// idempotency key + إدراج دفعي في telemetry_ingestion_queue + إنهاء الطلب.
// ممنوع نهائياً: أي استدعاء لـevaluateProject، Decision Engine، إنشاء
// Alert، إنشاء Evidence، أو أي عملية DB مرتبطة بالتقييم — بلا استثناء
// حتى مؤقت (طلب المستخدم الصريح: لا مرحلة انتقالية تُبقي provider-pull
// → evaluateProject). المعالجة الفعلية (كتابة device_readings_history/
// project_devices/device_metric_latest + إنشاء مهام تقييم موحَّدة) تنتقل
// بالكامل إلى telemetry-worker (مسار منفصل زمنياً تماماً، مرحلة لاحقة).
//
// مصادقة عبر PROVIDER_PULL_CRON_SECRET — متغير بيئة منفصل تماماً عن
// CRON_SECRET المستخدم في /api/alerts/generate، ويجب أن يكون قيمة عشوائية
// مولَّدة بشكل مستقل (مثال: openssl rand -hex 32). لا يجوز أن يطابق أي سر
// آخر بالنظام (CRON_SECRET أو SUPABASE_SERVICE_ROLE_KEY) — نفس درس ثغرة
// موثَّقة سابقاً بهذا المشروع (CRON_SECRET وُجد مطابقاً حرفياً لـ
// SUPABASE_SERVICE_ROLE_KEY).
//
// يُستدعى خارجياً كل دقيقة عبر خدمة cron مجانية (cron-job.org) بنفس رأس
// Authorization: Bearer <PROVIDER_PULL_CRON_SECRET> — لا إضافة لـvercel.json
// (خطة Vercel Hobby لا تدعم جدولة أقل من يومية، نفس السبب المُوثَّق في
// /api/alerts/generate).
export async function GET(request: Request) {
  if (!process.env.PROVIDER_PULL_CRON_SECRET) {
    return NextResponse.json({ ok: false, error: 'PROVIDER_PULL_CRON_SECRET غير مُعرَّف بالخادم' }, { status: 503 });
  }
  const authHeader = request.headers.get('authorization') || '';
  if (!timingSafeStringEqual(authHeader, `Bearer ${process.env.PROVIDER_PULL_CRON_SECRET}`)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  // حادثة إنتاج فعلية (2026-08-08): استدعاءات cron-job.org كل دقيقة تتراكم
  // فوق دورة سابقة لم تكتمل بعد (حلقة تسلسلية بطيئة تحت حمل)، تستنزف
  // connection pool بالكامل (راجع migration 202608081002 لتفاصيل الحادثة).
  // قفل بنافذة 60 ثانية عبر قيد PRIMARY KEY (نفس نمط scheduler_locks) —
  // يفشل فوراً بدل الانتظار، فترجع هذه الدورة 200 فوراً بلا أي عمل إضافي
  // بدل إضافة حمل فوق حمل قائم. يبقى كما هو — لا حاجة لتعديله بعد أن أصبحت
  // الدورة نفسها أقصر وأخف بكثير.
  const runBucket = Math.floor(Date.now() / 60_000);
  const { error: lockError } = await supabaseAdmin.from('provider_pull_run_lock').insert({ run_bucket: runBucket });
  if (lockError) {
    // لا تسجيل نبضة هنا (لا started ولا أي شيء آخر) — هذه الدورة تخطّت
    // العمل بالكامل (دورة سابقة لا تزال قيد التنفيذ)، لا محاولة عمل حقيقية
    // فشلت أو نجحت. تسجيل started هنا كان سيُظهر "بدءاً" زائفاً لدورة لم
    // تفعل شيئاً فعلياً.
    return NextResponse.json({ ok: true, skipped: true, reason: 'دورة سابقة لا تزال قيد التنفيذ لنفس النافذة الزمنية' }, { status: 200 });
  }
  await recordWorkerHeartbeat(WORKER_NAME, 'started');

  // خطأ أمني/تشغيلي مكتشَف — مراجعة كود خبير خارجي: "المشروع المؤرشف يمكن
  // أن يستمر في Provider pull والتقييم". provider_connections.is_active لا
  // علاقة له بأرشفة المشروع نفسه (projects.archived_at) — أرشفة مشروع لا
  // تُعطِّل اتصالاته تلقائياً، فكانت هذه الحلقة تسحب من محطة خارجية حقيقية
  // وتُعيد تقييم مشروع مؤرشف بالكامل في كل دورة بلا داعٍ.
  // provider_instance_id + provider_instances(origin, is_approved, is_active)
  // مُستخدَم هنا (القسم 15.1) — origin يُحل من السجل المعتمد وقت كل سحب، لا
  // من عمود ثابت بـprovider_connections، بحيث لو أُلغي اعتماد/تفعيل منصة
  // لاحقاً (مسؤول النظام) يتوقف السحب فوراً بلا حاجة لتعديل كل اتصال يستخدمها.
  //
  // list_active_provider_connections (RPC، 202608040032) — استدعاء RPC
  // يُنفَّذ داخل قاعدة البيانات مباشرة، يتجاوز مشاكل PostgREST schema cache
  // الموثَّقة سابقاً مع استعلامات .select() المتداخلة/المسطَّحة على هذا الجدول.
  const { data: rawConnections, error: fetchError } = await supabaseAdmin.rpc('list_active_provider_connections') as {
    data: ActiveProviderConnectionRow[] | null;
    error: { message: string } | null;
  };

  if (fetchError) {
    await recordWorkerHeartbeat(WORKER_NAME, 'failed', fetchError.message);
    return NextResponse.json({ ok: false, error: fetchError.message }, { status: 500 });
  }

  const candidateConnections = rawConnections || [];
  const projectIdsToCheck = [...new Set(candidateConnections.map((c) => c.project_id))];
  const providerInstanceIdsToCheck = [...new Set(candidateConnections.map((c) => c.provider_instance_id).filter((id): id is string => id !== null))];

  const [{ data: projectRows, error: projectsError }, { data: instanceRows, error: instancesError }] = await Promise.all([
    projectIdsToCheck.length > 0
      ? supabaseAdmin.from('projects').select('id, archived_at').in('id', projectIdsToCheck)
      : Promise.resolve({ data: [] as { id: string; archived_at: string | null }[], error: null }),
    providerInstanceIdsToCheck.length > 0
      ? supabaseAdmin.from('provider_instances').select('id, origin, is_approved, is_active').in('id', providerInstanceIdsToCheck)
      : Promise.resolve({ data: [] as { id: string; origin: string; is_approved: boolean; is_active: boolean }[], error: null }),
  ]);

  if (projectsError) {
    await recordWorkerHeartbeat(WORKER_NAME, 'failed', projectsError.message);
    return NextResponse.json({ ok: false, error: projectsError.message }, { status: 500 });
  }
  if (instancesError) {
    await recordWorkerHeartbeat(WORKER_NAME, 'failed', instancesError.message);
    return NextResponse.json({ ok: false, error: instancesError.message }, { status: 500 });
  }

  const archivedProjectIds = new Set((projectRows || []).filter((p) => p.archived_at !== null).map((p) => p.id));
  const instancesById = new Map((instanceRows || []).map((i) => [i.id, i]));

  const connections = candidateConnections
    .filter((c) => !archivedProjectIds.has(c.project_id))
    .map((c) => ({
      ...c,
      provider_instances: c.provider_instance_id ? instancesById.get(c.provider_instance_id) ?? null : null,
    }));

  const results: Array<{ connectionId: string; provider: string; ok: boolean; queued?: number; error?: string; hasMore?: boolean }> = [];

  // نفس حد التزامن الموجود بالفعل (CONCURRENCY=8) — لا تغيير هنا، الفحص
  // المباشر أكَّد أنه سليم ولا يحتاج تعديلاً (لا Promise.all بلا حدود على
  // مستوى المحطات، fetchReadingsSince يجلب نافذة زمنية بطلب واحد لكل محطة
  // لا سحباً متكرراً). عزل فشل الاتصال الواحد عن البقية (try/catch لكل
  // اتصال) محفوظ بلا تعديل أيضاً.
  const CONCURRENCY = 8;
  const connectionsToProcess = connections || [];
  for (let batchStart = 0; batchStart < connectionsToProcess.length; batchStart += CONCURRENCY) {
    const batch = connectionsToProcess.slice(batchStart, batchStart + CONCURRENCY);
    await Promise.all(batch.map((conn) => processConnection(conn)));
  }

  async function processConnection(conn: (typeof connectionsToProcess)[number]) {
    try {
      const connector = getConnector(conn.provider);
      if (!connector) {
        results.push({ connectionId: conn.id, provider: conn.provider, ok: false, error: `provider غير مسجَّل: ${conn.provider}` });
        return;
      }

      // خطأ أمني مكتشَف ومُصلَح (القسم 15.1): إن كان الـConnector يتطلب
      // provider_instance ولم يعد السجل معتمداً/نشطاً (أُلغي بعد ربط
      // الاتصال)، يُرفَض السحب فوراً بدل استخدام origin قديم مخزَّن أو
      // فارغ. provider_instances هنا كائن مفرد دائماً (لا مصفوفة) — مبنية
      // يدوياً أعلاه عبر instancesById.get، لا عبر PostgREST embed.
      let origin = '';
      if (connector.requiresProviderInstance) {
        const instance = conn.provider_instances;
        if (!instance || !instance.is_approved || !instance.is_active) {
          results.push({ connectionId: conn.id, provider: conn.provider, ok: false, error: 'المنصة المرتبطة لم تعد معتمدة/نشطة' });
          await supabaseAdmin
            .from('provider_connections')
            .update({ last_pull_at: new Date().toISOString(), last_pull_success: false, last_pull_error: 'المنصة المرتبطة لم تعد معتمدة/نشطة', updated_at: new Date().toISOString() })
            .eq('id', conn.id);
          return;
        }
        origin = instance.origin;
      }

      if (!conn.credentials_ciphertext || !conn.credentials_key_version) {
        results.push({ connectionId: conn.id, provider: conn.provider, ok: false, error: 'بيانات اعتماد الاتصال غير مُرحَّلة لصيغة enc:v2' });
        return;
      }
      const credentials = decryptCredentialsV2(conn.credentials_ciphertext, conn.credentials_key_version, {
        connectionId: conn.id,
        projectId: conn.project_id,
        deviceId: conn.device_id,
        provider: conn.provider,
      });

      // خطأ مكتشَف ومُصلَح سابقاً (مراجعة خبير خارجي — "العينة كل دقيقتين
      // لا تكفي؛ يمكن النقل فقط إذا احتوت الإرسالية على جميع عينات الدقيقة
      // بطوابعها المستقلة"): fetchLatestReading وحدها (نقطة واحدة فقط) لا
      // تكفي لإثبات استمرار PM10. نستخدم fetchReadingsSince (إن دعمها
      // الـConnector) لجلب كل العينات منذ آخر سحب فعلي لهذا الاتصال —
      // بلا تغيير عن السلوك السابق، هذا الجزء لا علاقة له بإعادة التصميم.
      //
      // خطأ مكتشَف ومُصلَح (مراجعة كود خارجي — "مؤشر السحب يتقدم حتى عند فشل
      // Queue"، راجع migration 202608110014 الكامل): sinceMs تُحسَب الآن من
      // pull_cursor_at (يتقدم فقط عند نجاح إدراج دفعة كاملة)، لا last_pull_at
      // (كانت تتقدم في كل محاولة بصرف النظر عن النجاح — فشل إدراج الدفعة أو
      // استثناء غير متوقَّع كان يُزحزح مؤشر البداية للأمام، فتُفقَد القراءات
      // الواقعة بين آخر نجاح فعلي وتلك المحاولة الفاشلة نهائياً).
      //
      // OVERLAP_MARGIN_MS: هامش تداخل صغير للخلف عن pull_cursor_at نفسه —
      // يحمي من فروق دقيقة (انحراف ساعة، وقت تنفيذ الاستعلام نفسه بين قراءة
      // pull_cursor_at وبدء fetchReadingsSince) قد تُسقِط عينة على حافة
      // النافذة الزمنية تماماً. التداخل الناتج (إعادة طلب عينات نجحت فعلاً
      // في دورة سابقة) غير ضار: idempotency_key الفريد على
      // telemetry_ingestion_queue (ON CONFLICT DO NOTHING أدناه) يمنع أي
      // تكرار فعلي — لا حاجة لدقة مطلقة هنا، فقط عدم فقد أي عينة حقيقية.
      //
      // MAX_LOOKBACK_MS يبقى سقفاً مقصوداً (لا نطلب من المنصة تاريخاً غير
      // محدود لو تعطّل الاتصال لأيام) — لا علاقة له ببق الفقد الصامت الذي
      // يُصلِحه هذا التغيير. الفرق الجوهري الآن: أي بيانات *داخل* الميزانية
      // (من sinceMs إلى الآن) لن تُفقَد بصمت بعد اليوم مهما بلغت حدود
      // ThingsBoard لكل صفحة — راجع Pagination أدناه.
      //
      // خطأ مكتشَف ومُصلَح (طلب صريح من المستخدم — مراجعة لاحقة لنفس البند):
      // 10 دقائق كانت قصيرة جداً عملياً — أي انقطاع اتصال شائع (نشر جديد،
      // تذبذب شبكة، صيانة) يتجاوزها بسهولة، فتضيع القراءات الواقعة قبل تلك
      // النافذة نهائياً بلا أي فرصة استرجاع، رغم أنها ليست اقتطاعاً صامتاً
      // (سلوك موثَّق ومقصود) — من منظور قرار تنظيمي (استمرار مخالفة PM10)
      // فقدان دليل خام روتيني كل انقطاع >10 دقائق غير مقبول، بنفس الروح التي
      // تحمي بها telemetry_dead_letter كل قراءة وصلت الطابور من الحذف
      // النهائي. رُفع إلى ساعتين — أعلى بكثير من أي انقطاع طبيعي متوقَّع
      // (شبكة/نشر/صيانة)، مع بقاء سقف محدود صريح (لا تاريخ غير محدود لو تعطّل
      // الاتصال أياماً). آلية الصفحات أدناه (MAX_PAGES_PER_CONNECTION) تتحمّل
      // حجم البيانات الناتج عن نافذة أوسع دون تغيير إضافي — نافذة غير مكتملة
      // ضمن حد الصفحات لهذه الدورة تُستكمَل في الدورة التالية بنفس آلية
      // hasMore/coveredThroughMs الموجودة أصلاً.
      const MAX_LOOKBACK_MS = 2 * 60 * 60_000;
      const OVERLAP_MARGIN_MS = 5_000;
      const sinceMs = conn.pull_cursor_at
        ? Math.max(new Date(conn.pull_cursor_at).getTime() - OVERLAP_MARGIN_MS, Date.now() - MAX_LOOKBACK_MS)
        : Date.now() - MAX_LOOKBACK_MS;

      // خطأ مكتشَف ومُصلَح (مراجعة كود خارجي — "نافذة عشر دقائق وحدود
      // ThingsBoard تقطع البيانات بصمت"): fetchReadingsSince كانت تُستدعى
      // مرة واحدة بلا Pagination — MAX_POINTS_PER_KEY=200/MAX_TOTAL_POINTS=
      // 1000 داخل الـConnector يقتطعان النتيجة بصمت عند إرسالية كثيفة، ثم
      // كان المؤشر يتقدم إلى Date.now() الفعلي بلا علاقة بما اكتمل جلبه
      // فعلاً — يُسقِط كل ما بعد نقطة الاقتطاع نهائياً وبلا أثر.
      //
      // الحل: حلقة صفحات محدودة (MAX_PAGES_PER_CONNECTION) داخل نفس الدورة —
      // كل صفحة تطلب [pageSinceMs, untilMs) حيث untilMs ثابتة طوال حلقة هذا
      // الاتصال (لا Date.now() متحركة بين الصفحات، وإلا لن تكتمل النافذة
      // أبداً تحت تدفق مستمر). المؤشر (cursorMs أدناه) يتحرك فقط إلى
      // coveredThroughMs الذي يُرجعه الـConnector — أي نقطة لم يثبت اكتمال
      // جلبها فعلاً (hasMore=true) تبقى خارج المؤشر، فتُعاد محاولتها في
      // الصفحة التالية أو الدورة التالية بدل فقدها. توقف الحلقة قبل بلوغ حد
      // الصفحات لا يزال آمناً بنفس المنطق — المؤشر يتقدم بقدر ما اكتمل فقط.
      const untilMs = Date.now();
      const MAX_PAGES_PER_CONNECTION = 5;
      let cursorMs = sinceMs;
      let allReadings: NormalizedReading[] = [];
      let hasMoreAfterLoop = false;

      if (connector.fetchReadingsSince) {
        for (let page = 0; page < MAX_PAGES_PER_CONNECTION && cursorMs < untilMs; page++) {
          const page_ = await connector.fetchReadingsSince(origin, credentials, conn.vendor_station_id as string, cursorMs, untilMs);
          allReadings = allReadings.concat(page_.readings);
          cursorMs = page_.coveredThroughMs;
          if (!page_.hasMore) {
            hasMoreAfterLoop = false;
            break;
          }
          hasMoreAfterLoop = true;
        }
        // خطأ مكتشَف ومُصلَح (مراجعة كود خارجي — "الموصل Snapshot-only لا
        // يصلح لإثبات الاستمرارية"): كل قراءة من fetchReadingsSince وصلت عبر
        // جلب تاريخي فعلي لنافذة زمنية — تصلح دليل استمرار (راجع تعليق
        // EvidenceCapability الكامل في types.ts). لا تُستبدَل قيمة موجودة
        // مسبقاً (احتراماً لأي Connector مستقبلي يملأ evidenceCapability بنفسه
        // بدقة أعلى، مثال: صفحة واحدة SNAPSHOT_ONLY داخل استجابة مختلطة).
        allReadings = allReadings.map((r) => ({ evidenceCapability: 'HISTORY_COMPLETE', ...r }));
      } else {
        // خطأ مكتشَف ومُصلَح (مراجعة كود خارجي — "الموصل Snapshot-only لا
        // يصلح لإثبات الاستمرارية"، راجع migration 202608110017 الكامل):
        // Connector لا يدعم fetchReadingsSince (مثال: mockConnector) — نقطة
        // واحدة فقط (آخر قيمة)، لا "قبل" ولا "بعد" لها ضمن هذا الطلب. تصلح
        // للعرض الحي (Live Data Layer، project_devices.last_*) لكن لا يجوز
        // أن تُثبت أو تُمدِّد أي سلسلة استمرار (قاعدة الدقيقتين/الـ30 دقيقة
        // في dustEvaluation.ts) — تُوسَم SNAPSHOT_ONLY صراحة، تُكتَب في
        // pm10_readings_history بهذا الوسم (is_snapshot_only)، وstreakMinutesAbove
        // يقطع السلسلة عندها كما يقطع عند أي فجوة زمنية غير مقبولة.
        const single = await connector.fetchLatestReading(origin, credentials, conn.vendor_station_id as string);
        allReadings = single ? [{ evidenceCapability: 'SNAPSHOT_ONLY' as const, ...single }] : [];
        cursorMs = untilMs;
      }

      const readings = allReadings;
      // coveredThroughMs الفعلي لهذا الاتصال بعد الحلقة (قد يكون أقل من
      // untilMs لو استُنفدت صفحات MAX_PAGES_PER_CONNECTION قبل اكتمال
      // النافذة تحت إرسالية كثيفة جداً — يبقى صحيحاً وآمناً: يُستكمَل في
      // الدورة التالية بدل فقده).
      const coveredThroughMs = cursorMs;

      if (readings.length === 0) {
        // لا قراءات جديدة متاحة — ليس خطأً، بل نجاح فعلي بمعنى "تحقّقنا حتى
        // coveredThroughMs ولا شيء جديد": pull_cursor_at يتقدم إلى
        // coveredThroughMs (لا Date.now() الفعلي) — لو كانت هناك نافذة لم
        // تكتمل (hasMoreAfterLoop)، المؤشر يتوقف عندها بدل تخطّيها.
        const nowIso = new Date().toISOString();
        const coveredIso = new Date(coveredThroughMs).toISOString();
        results.push({ connectionId: conn.id, provider: conn.provider, ok: true, queued: 0, hasMore: hasMoreAfterLoop });
        await supabaseAdmin
          .from('provider_connections')
          .update({
            last_pull_at: nowIso,
            pull_cursor_at: coveredIso,
            last_pull_success: true,
            last_pull_success_at: nowIso,
            last_pull_error: null,
            updated_at: nowIso,
          })
          .eq('id', conn.id);
        return;
      }

      // ===================================================================
      // النقطة الجوهرية من إعادة التصميم: بدل استدعاء writeDeviceReading
      // (RPC ثقيلة، ~20 عملية DB) لكل قراءة تسلسلياً هنا، نبني صفوف الطابور
      // فقط ونُدرجها دفعة واحدة.
      //
      // خطأ مكتشَف ومُصلَح (مراجعة كود خارجي — "مفتاح منع التكرار قابل
      // للتصادم"، راجع migration 202608110016 الكامل): idempotency_key
      // القديم (provider:vendor_station_id:observedAtIso) كان يفتقد
      // connection_id، وكان يرفض بصمت أي تصحيح/حقل جديد وصل بنفس
      // observedAtIso بالضبط لنفس المحطة. provider_event_key الجديد
      // (buildProviderEventKey أعلاه) يستخدم vendorEventId الحقيقي إن توفر،
      // وإلا hash قانوني لكامل الحمولة مضافاً لـobservedAtIso — تصحيح فعلي
      // (قيمة مختلفة) بنفس الطابع الزمني ينتج hash مختلفاً فيُقبَل كصف جديد.
      // الفريد الفعلي الآن (connection_id, provider_event_key) — راجع
      // uq_telemetry_connection_event. idempotency_key يبقى كعمود توافقي
      // فقط (يُمرَّر لاحقاً كـexternalEventId في telemetry-worker)، يُبنى
      // الآن من connection_id:provider_event_key فريداً عالمياً بذاته.
      // ===================================================================
      const queueRows = readings
        .filter((reading) => Boolean(reading.observedAtIso))
        .map((reading) => {
          const providerEventKey = buildProviderEventKey(reading);
          return {
            idempotency_key: `${conn.id}:${providerEventKey}`,
            provider_event_key: providerEventKey,
            connection_id: conn.id,
            project_id: conn.project_id,
            device_id: conn.device_id,
            provider: conn.provider,
            payload: reading,
            observed_at: reading.observedAtIso as string,
          };
        });

      let queuedCount = 0;
      let lastError: string | undefined;
      if (queueRows.length > 0) {
        // ON CONFLICT (connection_id, provider_event_key) DO NOTHING عبر
        // Prefer: resolution=ignore-duplicates — إدراج دفعي واحد لكل قراءات
        // هذا الاتصال، لا استدعاء منفصل لكل قراءة. قراءة مكررة فعلياً (retry
        // شبكة، نافذة fetchReadingsSince متداخلة بين دورتين/صفحات) تُرفَض
        // بصمت بلا خطأ — تصحيح/حقل جديد بنفس observedAtIso لم يعد يُرفَض
        // (hash الحمولة مختلف، راجع buildProviderEventKey).
        const { data: insertedRows, error: insertError } = await supabaseAdmin
          .from('telemetry_ingestion_queue')
          .upsert(queueRows, { onConflict: 'connection_id,provider_event_key', ignoreDuplicates: true })
          .select('id');

        if (insertError) {
          lastError = insertError.message;
        } else {
          queuedCount = insertedRows?.length ?? 0;
        }
      }

      // خطأ مكتشَف ومُصلَح (مراجعة كود خارجي — راجع تعليق OVERLAP_MARGIN_MS
      // وmigration 202608110014 الكاملين، وتعليق Pagination أعلاه):
      // pull_cursor_at/last_pull_success_at يتقدمان فقط عند نجاح إدراج
      // الدفعة كاملة بلا lastError — وحتى عندئذ، pull_cursor_at يتقدم إلى
      // coveredThroughMs (آخر نقطة ثبت اكتمال جلبها فعلاً) لا Date.now() —
      // فشل الإدراج يُبقي المؤشر عند نقطته السابقة (sinceMs الأصلية)، فتُعاد
      // محاولة نفس النافذة الزمنية بالضبط في الدورة التالية بدل فقدها.
      // last_pull_at (وقت المحاولة) يتقدم دائماً بصرف النظر عن النتيجة —
      // يبقى صحيحاً كمقياس "متى آخر محاولة" لـscheduler-heartbeat.
      const nowIso = new Date().toISOString();
      const coveredIso = new Date(coveredThroughMs).toISOString();
      await supabaseAdmin
        .from('provider_connections')
        .update({
          last_pull_at: nowIso,
          ...(lastError ? {} : { pull_cursor_at: coveredIso, last_pull_success_at: nowIso }),
          last_pull_success: !lastError,
          last_pull_error: lastError ?? null,
          updated_at: nowIso,
        })
        .eq('id', conn.id);

      results.push({
        connectionId: conn.id,
        provider: conn.provider,
        ok: !lastError,
        queued: queuedCount,
        error: lastError,
        hasMore: hasMoreAfterLoop,
      });
    } catch (err) {
      // فشل اتصال واحد لا يوقف الباقي — نفس مبدأ الحلقات المشابهة في
      // dustEvaluation.ts (resolveFreshProjectDevice) وalerts/generate.
      // pull_cursor_at/last_pull_success_at عمداً غير مذكورين في update()
      // هنا — يبقيان بلا تغيير (الاستثناء وقع قبل أي دليل على نجاح فعلي)،
      // فتُعاد محاولة نفس النافذة الزمنية في الدورة التالية بدل فقدها.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`provider-pull failed for connection ${conn.id}:`, message);
      results.push({ connectionId: conn.id, provider: conn.provider, ok: false, error: message });
      await supabaseAdmin
        .from('provider_connections')
        .update({ last_pull_at: new Date().toISOString(), last_pull_success: false, last_pull_error: message, updated_at: new Date().toISOString() })
        .eq('id', conn.id);
    }
  }

  const failedCount = results.filter((r) => !r.ok).length;
  const status = results.length === 0 || failedCount === 0 ? 200 : failedCount === results.length ? 502 : 207;

  if (status === 502) {
    await recordWorkerHeartbeat(WORKER_NAME, 'failed', `${failedCount}/${results.length} اتصالات فشلت`);
  } else {
    await recordWorkerHeartbeat(WORKER_NAME, 'succeeded');
  }

  return NextResponse.json(
    {
      ok: failedCount === 0,
      checkedAt: new Date().toISOString(),
      total: results.length,
      failed: failedCount,
      results,
    },
    { status }
  );
}
