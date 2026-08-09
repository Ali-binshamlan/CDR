import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { timingSafeStringEqual } from '@/app/lib/timingSafe';
import { getConnector } from '@/app/lib/providers/registry';
import { decryptCredentialsV2 } from '@/app/lib/credentialsEncryption';
import type { NormalizedReading } from '@/app/lib/providers/types';

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
    return NextResponse.json({ ok: true, skipped: true, reason: 'دورة سابقة لا تزال قيد التنفيذ لنفس النافذة الزمنية' }, { status: 200 });
  }

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
    return NextResponse.json({ ok: false, error: projectsError.message }, { status: 500 });
  }
  if (instancesError) {
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

  const results: Array<{ connectionId: string; provider: string; ok: boolean; queued?: number; error?: string }> = [];

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
      const MAX_LOOKBACK_MS = 10 * 60_000;
      const sinceMs = conn.last_pull_at
        ? Math.max(new Date(conn.last_pull_at).getTime(), Date.now() - MAX_LOOKBACK_MS)
        : Date.now() - MAX_LOOKBACK_MS;

      let readings: NormalizedReading[];
      if (connector.fetchReadingsSince) {
        readings = await connector.fetchReadingsSince(origin, credentials, conn.vendor_station_id as string, sinceMs);
      } else {
        // Connector لا يدعم fetchReadingsSince (مثال: mockConnector) — فشل
        // آمن نحو السلوك السابق: قراءة واحدة فقط لكل دورة.
        const single = await connector.fetchLatestReading(origin, credentials, conn.vendor_station_id as string);
        readings = single ? [single] : [];
      }

      if (readings.length === 0) {
        // لا قراءات جديدة متاحة — ليس خطأً، فقط لا شيء لإدراجه الآن.
        results.push({ connectionId: conn.id, provider: conn.provider, ok: true, queued: 0 });
        await supabaseAdmin
          .from('provider_connections')
          .update({ last_pull_at: new Date().toISOString(), last_pull_success: true, last_pull_error: null, updated_at: new Date().toISOString() })
          .eq('id', conn.id);
        return;
      }

      // ===================================================================
      // النقطة الجوهرية من إعادة التصميم: بدل استدعاء writeDeviceReading
      // (RPC ثقيلة، ~20 عملية DB) لكل قراءة تسلسلياً هنا، نبني صفوف الطابور
      // فقط ونُدرجها دفعة واحدة. idempotency key كما هو تماماً بلا تغيير
      // (provider:vendor_station_id:observedAtIso — راجع التحليل الكامل في
      // خطة إعادة التصميم، خاص بـThingsBoard تحديداً).
      // ===================================================================
      const queueRows = readings
        .filter((reading) => Boolean(reading.observedAtIso))
        .map((reading) => ({
          idempotency_key: `${conn.provider}:${conn.vendor_station_id}:${reading.observedAtIso}`,
          connection_id: conn.id,
          project_id: conn.project_id,
          device_id: conn.device_id,
          provider: conn.provider,
          payload: reading,
          observed_at: reading.observedAtIso as string,
        }));

      let queuedCount = 0;
      let lastError: string | undefined;
      if (queueRows.length > 0) {
        // ON CONFLICT (idempotency_key) DO NOTHING عبر Prefer:
        // resolution=ignore-duplicates — إدراج دفعي واحد لكل قراءات هذا
        // الاتصال، لا استدعاء منفصل لكل قراءة. قراءة مكررة (retry شبكة،
        // نافذة fetchReadingsSince متداخلة بين دورتين) تُرفَض بصمت بلا خطأ.
        const { data: insertedRows, error: insertError } = await supabaseAdmin
          .from('telemetry_ingestion_queue')
          .upsert(queueRows, { onConflict: 'idempotency_key', ignoreDuplicates: true })
          .select('id');

        if (insertError) {
          lastError = insertError.message;
        } else {
          queuedCount = insertedRows?.length ?? 0;
        }
      }

      await supabaseAdmin
        .from('provider_connections')
        .update({
          last_pull_at: new Date().toISOString(),
          last_pull_success: !lastError,
          last_pull_error: lastError ?? null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', conn.id);

      results.push({
        connectionId: conn.id,
        provider: conn.provider,
        ok: !lastError,
        queued: queuedCount,
        error: lastError,
      });
    } catch (err) {
      // فشل اتصال واحد لا يوقف الباقي — نفس مبدأ الحلقات المشابهة في
      // dustEvaluation.ts (resolveFreshProjectDevice) وalerts/generate.
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
