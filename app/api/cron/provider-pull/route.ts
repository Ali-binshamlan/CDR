import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { timingSafeStringEqual } from '@/app/lib/timingSafe';
import { getConnector } from '@/app/lib/providers/registry';
import { writeDeviceReading } from '@/app/lib/deviceReadingWriter';
import { evaluateProject, enqueueEvaluationRetryJob } from '@/app/lib/evaluateProject';
import { decryptCredentialsV2 } from '@/app/lib/credentialsEncryption';
import type { NormalizedReading } from '@/app/lib/providers/types';

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

// مسار سحب دوري (pull) لكل محطات provider_connections النشطة عبر كل
// المشاريع — بديل عن دفع (push) الجهاز لبياناته عبر /api/devices/ingest،
// لمحطات شركات خارجية جاهزة لا يمكن تعديل إعداداتها لترسل لنظامنا مباشرة.
//
// مصادقة عبر PROVIDER_PULL_CRON_SECRET — متغير بيئة منفصل تماماً عن
// CRON_SECRET المستخدم في /api/alerts/generate، ويجب أن يكون قيمة عشوائية
// مولَّدة بشكل مستقل (مثال: openssl rand -hex 32). لا يجوز أن يطابق أي سر
// آخر بالنظام (CRON_SECRET أو SUPABASE_SERVICE_ROLE_KEY) — نفس درس ثغرة
// موثَّقة سابقاً بهذا المشروع (CRON_SECRET وُجد مطابقاً حرفياً لـ
// SUPABASE_SERVICE_ROLE_KEY).
//
// يُستدعى خارجياً كل دقيقتين عبر خدمة cron مجانية (cron-job.org) بنفس رأس
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

  // خطأ أمني/تشغيلي مكتشَف — مراجعة كود خبير خارجي: "المشروع المؤرشف يمكن
  // أن يستمر في Provider pull والتقييم". provider_connections.is_active لا
  // علاقة له بأرشفة المشروع نفسه (projects.archived_at) — أرشفة مشروع لا
  // تُعطِّل اتصالاته تلقائياً، فكانت هذه الحلقة تسحب من محطة خارجية حقيقية
  // وتُعيد تقييم مشروع مؤرشف بالكامل في كل دورة (كل دقيقتين) بلا داعٍ.
  // provider_instance_id + provider_instances(origin, is_approved, is_active)
  // مُستخدَم هنا (القسم 15.1) — origin يُحل من السجل المعتمد وقت كل سحب، لا
  // من عمود ثابت بـprovider_connections، بحيث لو أُلغي اعتماد/تفعيل منصة
  // لاحقاً (مسؤول النظام) يتوقف السحب فوراً بلا حاجة لتعديل كل اتصال يستخدمها.
  //
  // خطأ تشغيلي مكتشَف ومُصلَح (إنتاج فعلي — PostgREST schema cache لا يرى
  // FK صحيحاً وموثَّقاً بالكامل في قاعدة البيانات نفسها، حتى بعد عدة محاولات
  // NOTIFY pgrst/إعادة تحميل): كان هذا يستخدم select متداخل واحد
  // (`projects!inner(archived_at)` + `provider_instances(...)`) يعتمد كلياً
  // على أن PostgREST يعرف علاقتي الـFK وقت الاستعلام — فشل هذا الاعتماد
  // فعلياً بصرف النظر عن صحة الـFK في قاعدة البيانات، فأرجع الاستعلام بأكمله
  // خطأً "Could not find a relationship" رغم أن provider_connections/
  // provider_instances/projects كلها صحيحة تماماً.
  //
  // خطأ تشغيلي إضافي مكتشَف ومُصلَح (إنتاج فعلي — نفس الجلسة): حتى بعد
  // إزالة الـjoins، استعلام .select() مسطَّح بلا أي join كان لا يزال يفشل
  // بخطأ "column provider_connections.credentials_ciphertext does not
  // exist" رغم تأكيد ثلاثي (information_schema.columns، pg_constraint،
  // information_schema.column_privileges) أن العمود موجود فعلياً وصلاحياته
  // لـservice_role كاملة — PostgREST نفسه عالق في حالة schema cache غير
  // متسقة مع قاعدة البيانات الحقيقية، منفصلة عن أي فحص SQL مباشر (الذي يمر
  // عبر اتصال مختلف تماماً، لا عبر PostgREST). list_active_provider_
  // connections (RPC، 202608040032) يتجاوز هذا كلياً — استدعاء RPC يُنفَّذ
  // داخل قاعدة البيانات مباشرة (execute function)، لا عبر آلية "قراءة قائمة
  // أعمدة الجدول عبر PostgREST" المتأثرة بالخلل.
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

  const results: Array<{ connectionId: string; provider: string; ok: boolean; error?: string }> = [];
  // مشاريع تلقّت قراءة جديدة فعلياً بنجاح خلال هذه الدورة — يُعاد تقييمها
  // (DVI/Compliance/FinalDecision) مرة واحدة لكل مشروع بعد انتهاء حلقة
  // السحب، لا فور كل قراءة (لتفادي إعادة تقييم مكررة لنفس المشروع لو ربطت
  // له عدة محطات). بلا هذا الاستدعاء، القراءة تُكتب لكن حالة النشاط
  // (إيقاف إلزامي/مسموح/إلخ) لا تتحدّث إلا عند فتح المستخدم لصفحة المشروع
  // يدوياً (fetchDashboardData في page.tsx) — الفجوة المكتشَفة التي أدّت
  // لهذا الاستدعاء التلقائي هنا.
  const affectedProjectIds = new Set<string>();

  // تسلسلي عمداً (لا Promise.all) — يبسّط تتبع الفشل الجزئي ويتفادى إغراق
  // أي شركة حقيقية لاحقاً بطلبات متزامنة من نفس دورة السحب.
  for (const conn of connections || []) {
    try {
      const connector = getConnector(conn.provider);
      if (!connector) {
        results.push({ connectionId: conn.id, provider: conn.provider, ok: false, error: `provider غير مسجَّل: ${conn.provider}` });
        continue;
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
          continue;
        }
        origin = instance.origin;
      }

      if (!conn.credentials_ciphertext || !conn.credentials_key_version) {
        results.push({ connectionId: conn.id, provider: conn.provider, ok: false, error: 'بيانات اعتماد الاتصال غير مُرحَّلة لصيغة enc:v2' });
        continue;
      }
      const credentials = decryptCredentialsV2(conn.credentials_ciphertext, conn.credentials_key_version, {
        connectionId: conn.id,
        projectId: conn.project_id,
        deviceId: conn.device_id,
        provider: conn.provider,
      });

      // خطأ مكتشَف ومُصلَح (مراجعة خبير خارجي — التقرير النهائي: "العينة كل
      // دقيقتين لا تكفي؛ يمكن النقل كل دقيقتين فقط إذا احتوت الإرسالية على
      // جميع عينات الدقيقة بطوابعها المستقلة"): fetchLatestReading وحدها
      // (نقطة واحدة فقط) لا تكفي لإثبات استمرار PM10 حين تكون دورة السحب
      // (~دقيقتان) أبطأ من فجوة الاستمرارية المسموحة (90 ثانية). نستخدم
      // fetchReadingsSince (إن دعمها الـConnector) لجلب كل العينات منذ آخر
      // سحب فعلي لهذا الاتصال (last_pull_at)، مكتوبة كلها لاحقاً بطوابعها
      // المستقلة — لا سقوط أي عينة وسطى بين دورتَي سحب. حد أقصى للنافذة
      // (10 دقائق) يمنع محاولة سحب كمية ضخمة بعد توقف طويل (المحطة نفسها،
      // لا Vercel/cron، تُطبِّق أي حدود احتفاظ إضافية على البيانات القديمة).
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
        // لا قراءات جديدة متاحة — ليس خطأً، فقط لا شيء لكتابته الآن.
        results.push({ connectionId: conn.id, provider: conn.provider, ok: true });
        await supabaseAdmin
          .from('provider_connections')
          .update({ last_pull_at: new Date().toISOString(), last_pull_success: true, last_pull_error: null, updated_at: new Date().toISOString() })
          .eq('id', conn.id);
        continue;
      }

      // تسلسلي عمداً (لا Promise.all) — نفس مبدأ حلقة الاتصالات الخارجية
      // أعلاه؛ يحافظ أيضاً على ترتيب last_*_at الصحيح في project_devices
      // (كل كتابة يجب أن تسبق التالية بترتيب observedAt تصاعدي).
      let anyWriteFailed = false;
      let lastError: string | undefined;
      for (const reading of readings) {
        // idempotency key لمصادر pull — يمنع كتابة مكررة لو رجعت نفس القراءة
        // من استدعاءين متتاليين للـcron. راجع deviceReadingWriter.ts لمعالجة
        // التكرار الفعلية.
        const externalEventId = reading.observedAtIso
          ? `${conn.provider}:${conn.vendor_station_id}:${reading.observedAtIso}`
          : null;

        const writeResult = await writeDeviceReading({
          deviceId: conn.device_id,
          projectId: conn.project_id,
          reading,
          externalEventId,
        });

        if (!writeResult.success) {
          anyWriteFailed = true;
          lastError = writeResult.error;
        } else {
          affectedProjectIds.add(conn.project_id);
        }
      }

      await supabaseAdmin
        .from('provider_connections')
        .update({
          last_pull_at: new Date().toISOString(),
          last_pull_success: !anyWriteFailed,
          last_pull_error: anyWriteFailed ? lastError ?? 'فشل كتابة إحدى القراءات' : null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', conn.id);

      results.push({
        connectionId: conn.id,
        provider: conn.provider,
        ok: !anyWriteFailed,
        error: anyWriteFailed ? lastError : undefined,
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

  // إعادة تقييم كل مشروع تلقّى قراءة جديدة فعلياً — مرة واحدة لكل مشروع
  // بصرف النظر عن عدد المحطات المرتبطة به التي نجحت بهذه الدورة. فشل تقييم
  // مشروع واحد لا يوقف تقييم الباقي (نفس مبدأ حلقة السحب أعلاه)، ولا يُسقِط
  // نجاح السحب نفسه (القراءة محفوظة فعلاً بغض النظر عن نتيجة إعادة التقييم).
  const evaluationResults: Array<{ projectId: string; ok: boolean; error?: string }> = [];
  for (const projectId of affectedProjectIds) {
    try {
      const evalResult = await evaluateProject(projectId, 'provider_pull');
      evaluationResults.push({ projectId, ok: evalResult.success, error: evalResult.error });
      // خطأ مكتشَف ومُصلَح (مراجعة خبير خارجي — "لا مهمة إعادة محاولة
      // مضمونة تربط القراءة المحفوظة بنجاح بالتقييم الفاشل بعدها") — راجع
      // تعليق enqueueEvaluationRetryJob في evaluateProject.ts.
      if (!evalResult.success) {
        await enqueueEvaluationRetryJob(projectId, 'PROVIDER_PULL', evalResult.error ?? 'فشل تقييم غير محدَّد');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`provider-pull: evaluateProject failed for project ${projectId}:`, message);
      evaluationResults.push({ projectId, ok: false, error: message });
      await enqueueEvaluationRetryJob(projectId, 'PROVIDER_PULL', message);
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
      evaluations: evaluationResults,
    },
    { status }
  );
}
