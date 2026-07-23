import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { requireUserId, verifyProjectOwnership } from '@/app/lib/apiAuth';

// حفظ تقييم غبار/رؤية نشاط جديد — يستبدل استدعاء
// supabase.from('project_dust_profiles').insert(...) المباشر من
// AddActivityModal/index.tsx (handleDustSubmit)
export async function POST(request: NextRequest) {
  const auth = await requireUserId(request);
  if ('error' in auth) return auth.error;

  const body = await request.json();
  const insert = body?.insert;
  if (!insert || typeof insert !== 'object' || !insert.project_id) {
    return NextResponse.json({ error: 'insert مطلوب ويجب أن يحتوي project_id' }, { status: 400 });
  }

  const owns = await verifyProjectOwnership(insert.project_id, auth.userId);
  if (!owns) return NextResponse.json({ error: 'لا تملك هذا المشروع' }, { status: 403 });

  const { error } = await supabaseAdmin.from('project_dust_profiles').insert(insert);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}
