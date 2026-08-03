import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { timingSafeStringEqual } from '@/app/lib/timingSafe';
import { getConnector } from '@/app/lib/providers/registry';
import { writeDeviceReading } from '@/app/lib/deviceReadingWriter';
import { evaluateProject } from '@/app/lib/evaluateProject';

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

  const { data: connections, error: fetchError } = await supabaseAdmin
    .from('provider_connections')
    .select('id, device_id, project_id, provider, credentials, vendor_station_id')
    .eq('is_active', true)
    .not('vendor_station_id', 'is', null);

  if (fetchError) {
    return NextResponse.json({ ok: false, error: fetchError.message }, { status: 500 });
  }

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

      const reading = await connector.fetchLatestReading(conn.credentials ?? {}, conn.vendor_station_id as string);
      if (!reading) {
        // لا قراءة جديدة متاحة — ليس خطأً، فقط لا شيء لكتابته الآن.
        results.push({ connectionId: conn.id, provider: conn.provider, ok: true });
        await supabaseAdmin
          .from('provider_connections')
          .update({ last_pull_at: new Date().toISOString(), last_pull_success: true, last_pull_error: null, updated_at: new Date().toISOString() })
          .eq('id', conn.id);
        continue;
      }

      // idempotency key لمصادر pull — يمنع كتابة مكررة لو رجعت نفس القراءة
      // من استدعاءين متتاليين للـcron (المحطة قد لا تحدّث قراءتها كل دقيقتين
      // بالضرورة). راجع deviceReadingWriter.ts لمعالجة التكرار الفعلية.
      const externalEventId = reading.observedAtIso
        ? `${conn.provider}:${conn.vendor_station_id}:${reading.observedAtIso}`
        : null;

      const writeResult = await writeDeviceReading({
        deviceId: conn.device_id,
        projectId: conn.project_id,
        reading,
        externalEventId,
      });

      await supabaseAdmin
        .from('provider_connections')
        .update({
          last_pull_at: new Date().toISOString(),
          last_pull_success: writeResult.success,
          last_pull_error: writeResult.success ? null : writeResult.error,
          updated_at: new Date().toISOString(),
        })
        .eq('id', conn.id);

      results.push({
        connectionId: conn.id,
        provider: conn.provider,
        ok: writeResult.success,
        error: writeResult.success ? undefined : writeResult.error,
      });
      if (writeResult.success) affectedProjectIds.add(conn.project_id);
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
      const evalResult = await evaluateProject(projectId);
      evaluationResults.push({ projectId, ok: evalResult.success, error: evalResult.error });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`provider-pull: evaluateProject failed for project ${projectId}:`, message);
      evaluationResults.push({ projectId, ok: false, error: message });
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
