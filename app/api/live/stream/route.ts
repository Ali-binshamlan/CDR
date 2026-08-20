import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { verifyProjectOwnership } from '@/app/lib/apiAuth';
import { liveDataStore } from '@/app/lib/liveData/inMemoryStore';
import type { LiveDataEvent } from '@/app/lib/liveData/types';

/*
 * SSE Endpoint for Real-time Dashboard Updates:
 * Establishes a unidirectional Server-Sent Events (SSE) channel between the backend 
 * and the client dashboard to stream telemetry snapshots and project state changes.
 *
 * Operational, Security & Architectural Highlights:
 * 1. Query-Param Authentication: Authenticates connections via the `token` search parameter 
 *    since browser-native `EventSource` instances do not support custom request headers.
 * 2. Scope & Ownership Enforcement: Restricts event subscriptions strictly to validated project 
 *    owners (`verifyProjectOwnership`).
 * 3. Initial Snapshot Bootstrap: Emits a `snapshot_batch` event immediately upon connection startup 
 *    to populate UI state without waiting for new telemetry ingest ticks.
 * 4. Stream Lifecycle & Resource Hygiene: Periodically sends SSE comments (`: heartbeat`) 
 *    to prevent proxy connection drops, and cleans up timers and store subscriptions in `cancel()`.
 */

export const dynamic = 'force-dynamic';
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

  /*
   * Validate authentication token via Supabase Admin Auth
   */
  const { data: userData, error: authError } = await supabaseAdmin.auth.getUser(token);
  if (authError || !userData?.user) {
    return new Response(JSON.stringify({ error: 'جلسة غير صالحة أو منتهية' }), { status: 401 });
  }

  /*
   * Verify project ownership boundaries
   */
  const isOwner = await verifyProjectOwnership(projectId, userData.user.id);
  if (!isOwner) {
    return new Response(JSON.stringify({ error: 'لا تملك صلاحية الوصول لهذا المشروع' }), { status: 403 });
  }

  const encoder = new TextEncoder();
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;

  const stream = new ReadableStream({
    start(controller) {
      /*
       * Send initial state snapshot batch to initialize client state
       */
      const initialSnapshots = liveDataStore.getProjectSnapshots(projectId);
      controller.enqueue(encoder.encode(sseEvent('snapshot_batch', initialSnapshots)));

      /*
       * Subscribe client to live memory store updates for the project
       */
      unsubscribe = liveDataStore.subscribeToProject(projectId, (event: LiveDataEvent) => {
        try {
          controller.enqueue(encoder.encode(sseEvent(event.type, event.snapshot)));
        } catch {
          // Controller closed or disconnected; cancellation cleanup will handle unsubscribe
        }
      });

      /*
       * Maintain stream keep-alive using periodic comment heartbeats
       */
      heartbeatTimer = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: heartbeat\n\n`));
        } catch {
          if (heartbeatTimer) clearInterval(heartbeatTimer);
        }
      }, HEARTBEAT_INTERVAL_MS);
    },
    cancel() {
      /*
       * Clean up subscriptions and interval timers on connection close
       */
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