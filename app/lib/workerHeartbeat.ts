import { supabaseAdmin } from '@/app/lib/supabaseAdmin';

// خطأ مكتشَف ومُصلَح (طلب صريح من المستخدم — مراجعة كود خارجي: "Health
// endpoint قد يظهر أخضر رغم تعطل النظام"): نبضة صريحة بدء/نجاح/فشل لكل عامل
// cron، مستقلة عن أي استدلال غير مباشر (عمق طابور/عمر صف/started_at عند
// البدء وحده). راجع migration 202608120013 لتفاصيل الجدول والدالة.
//
// فشل الكتابة نفسها (اتصال DB متقطع وقت تسجيل النبضة) لا يُفشل العامل ولا
// يُلقي استثناءً يوقف المعالجة الفعلية — يُسجَّل في console فقط (نفس مبدأ
// أخطاء غير حرجة أخرى في هذا المشروع، مثال: liveDataStore). النبضة أداة
// مراقبة، لا جزءاً من منطق العمل نفسه.
export type WorkerHeartbeatEvent = 'started' | 'succeeded' | 'failed';

export async function recordWorkerHeartbeat(
  workerName: string,
  event: WorkerHeartbeatEvent,
  error?: string | null
): Promise<void> {
  try {
    const { error: rpcError } = await supabaseAdmin.rpc('upsert_worker_heartbeat', {
      p_worker_name: workerName,
      p_event: event,
      p_error: error ?? null,
    });
    if (rpcError) {
      console.error(`recordWorkerHeartbeat: فشل تسجيل نبضة ${workerName}/${event}:`, rpcError.message);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`recordWorkerHeartbeat: استثناء أثناء تسجيل نبضة ${workerName}/${event}:`, message);
  }
}
