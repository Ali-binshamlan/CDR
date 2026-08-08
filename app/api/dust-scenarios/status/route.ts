import { NextResponse, type NextRequest } from 'next/server';
import { requireSuperAdmin } from '@/app/lib/apiAuth';
import { getActiveRun, getRun, requestStop } from '@/app/lib/dustScenarioRunner';

// حالة السيناريو الجاري حالياً (أو آخر سيناريو عبر runId) — تُستطلَع دورياً
// من الواجهة (polling) لعرض التقدم مرحلة بمرحلة والقراءات المُرسَلة فعلياً.
export async function GET(request: NextRequest) {
  const auth = await requireSuperAdmin(request);
  if ('error' in auth) return auth.error;

  const runId = request.nextUrl.searchParams.get('runId');
  const run = runId ? getRun(runId) : getActiveRun();

  return NextResponse.json({ data: run });
}

// إيقاف السيناريو الجاري — لا يوقف الجهاز نفسه، فقط يمنع إرسال مراحل
// إضافية من هذا التشغيل.
export async function DELETE(request: NextRequest) {
  const auth = await requireSuperAdmin(request);
  if ('error' in auth) return auth.error;

  const runId = request.nextUrl.searchParams.get('runId');
  if (!runId) {
    return NextResponse.json({ error: 'runId إلزامي' }, { status: 400 });
  }

  const stopped = requestStop(runId);
  if (!stopped) {
    return NextResponse.json({ error: 'لا يوجد تشغيل نشط بهذا المعرّف' }, { status: 404 });
  }

  return NextResponse.json({ data: { stopped: true } });
}
