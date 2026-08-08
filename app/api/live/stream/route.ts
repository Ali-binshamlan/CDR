import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { verifyProjectOwnership } from '@/app/lib/apiAuth';
import { liveDataStore } from '@/app/lib/liveData/inMemoryStore';
import type { LiveDataEvent } from '@/app/lib/liveData/types';

// SSE endpoint للبيانات الحية — Backend→Dashboard اتجاه واحد فقط (لا حاجة
// حالياً لاتصال ثنائي الاتجاه، راجع طلب المستخدم الصريح "SSE لا WebSocket
// إلا لسبب واضح"). جزء من Live Data Layer (2026-08-08) — طبقة موازية
// اختيارية بجانب النظام الحالي (polling + Supabase Realtime)، لا تستبدله
// بعد؛ التفعيل بالواجهة يمر عبر Feature Flag منفصل (راجع
// app/lib/liveData/featureFlag.ts).
//
// المصادقة: EventSource المتصفحي القياسي لا يدعم custom headers (لا يمكن
// إرسال Authorization: Bearer كما تفعل apiClient.ts العادية) — التوكن
// يُمرَّر كـquery param بدلاً من ذلك (نمط شائع لـSSE/EventSource، آمن على
// HTTPS، والتوكن قصير العمر أصلاً). لا نطبع التوكن في أي log.
export const dynamic = 'force-dynamic';

// حد أقصى Vercel Hobby لدوال غير Edge — الاتصال يُغلَق من طرف الخادم عند
// هذا الحد إن لم يُغلقه العميل أولاً؛ EventSource القياسي يعيد الاتصال
// تلقائياً (retry مدمج بالمتصفح)، فهذا سلوك مقبول لا عطل.
export const maxDuration = 60;

const HEARTBEAT_INTERVAL_MS = 15_000;

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const projectId = url.searchParams.get('projectId');
  const token = url.searchParams.get('token');

  if (!projectId) {
    return new Response(JSON.stringify({ error: 'projectId مطلوب' }), { status: 400 });
  }
  if (!token) {
    return new Response(JSON.stringify({ error: 'غير مصرّح — الرجاء تسجيل الدخول' }), { status: 401 });
  }

  const { data: userData, error: authError } = await supabaseAdmin.auth.getUser(token);
  if (authError || !userData?.user) {
    return new Response(JSON.stringify({ error: 'جلسة غير صالحة أو منتهية' }), { status: 401 });
  }

  const isOwner = await verifyProjectOwnership(projectId, userData.user.id);
  if (!isOwner) {
    return new Response(JSON.stringify({ error: 'لا تملك صلاحية الوصول لهذا المشروع' }), { status: 403 });
  }

  const encoder = new TextEncoder();
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;

  const stream = new ReadableStream({
    start(controller) {
      // لقطة أولية فورية — كل الأجهزة المعروفة لهذا المشروع حتى الآن، قبل
      // أي حدث جديد. لا تنتظر الواجهة أول قراءة جديدة لتعرض شيئاً.
      const initialSnapshots = liveDataStore.getProjectSnapshots(projectId);
      controller.enqueue(encoder.encode(sseEvent('snapshot_batch', initialSnapshots)));

      unsubscribe = liveDataStore.subscribeToProject(projectId, (event: LiveDataEvent) => {
        try {
          controller.enqueue(encoder.encode(sseEvent(event.type, event.snapshot)));
        } catch {
          // controller قد يكون مُغلقاً بالفعل (اتصال مقطوع) — تجاهل، cancel()
          // أدناه سيتكفّل بإلغاء الاشتراك.
        }
      });

      // heartbeat يمنع بروكسيات/CDN وسيطة (بينها Vercel نفسه أحياناً) من
      // اعتبار الاتصال خاملاً وقطعه، ويسمح للعميل باكتشاف انقطاع فعلي بسرعة
      // (تعليق طويل بلا أي بايت = مشكلة).
      heartbeatTimer = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: heartbeat\n\n`));
        } catch {
          if (heartbeatTimer) clearInterval(heartbeatTimer);
        }
      }, HEARTBEAT_INTERVAL_MS);
    },
    cancel() {
      // يُستدعى عند إغلاق الاتصال من طرف العميل (تنقّل، إغلاق تبويب،
      // reconnect) — تنظيف إلزامي لمنع تسرّب مستمعين (memory leak) في
      // liveDataStore.
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (unsubscribe) unsubscribe();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
