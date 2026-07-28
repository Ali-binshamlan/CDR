import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { requireUserId, verifyProjectOwnership } from '@/app/lib/apiAuth';
import { safeErrorResponse } from '@/app/lib/apiError';

type DecisionTarget = { projectId: string; activityId: string; activitySource: string };

// يجلب آخر قرار موثَّق. يدعم شكلين:
// - projectId/activityId/activitySource منفردة (Dustwidgetcard.tsx)
// - targets=JSON.stringify([{projectId,activityId,activitySource}, ...])
//   (MultiIndicatorActivityBox.tsx) — يُرجع أحدث قرار بين كل الأهداف.
export async function GET(request: NextRequest) {
  const auth = await requireUserId(request);
  if ('error' in auth) return auth.error;

  const targetsParam = request.nextUrl.searchParams.get('targets');
  let targets: DecisionTarget[];

  if (targetsParam) {
    try {
      targets = JSON.parse(targetsParam);
    } catch {
      return NextResponse.json({ error: 'targets يجب أن يكون JSON صالحاً' }, { status: 400 });
    }
    if (!Array.isArray(targets) || targets.length === 0) {
      return NextResponse.json({ error: 'targets يجب أن يكون مصفوفة غير فارغة' }, { status: 400 });
    }
  } else {
    const projectId = request.nextUrl.searchParams.get('projectId');
    const activityId = request.nextUrl.searchParams.get('activityId');
    const activitySource = request.nextUrl.searchParams.get('activitySource');
    if (!projectId || !activityId || !activitySource) {
      return NextResponse.json({ error: 'projectId و activityId و activitySource مطلوبة' }, { status: 400 });
    }
    targets = [{ projectId, activityId, activitySource }];
  }

  const projectIds = [...new Set(targets.map((t) => t.projectId))];
  for (const projectId of projectIds) {
    const owns = await verifyProjectOwnership(projectId, auth.userId);
    if (!owns) return NextResponse.json({ error: 'لا تملك هذا المشروع' }, { status: 403 });
  }

  let latest: any = null;
  for (const t of targets) {
    const { data, error } = await supabaseAdmin
      .from('decision_records')
      .select('*')
      .eq('project_id', t.projectId)
      .eq('activity_id', t.activityId)
      .eq('activity_source', t.activitySource)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) return NextResponse.json({ error: safeErrorResponse(error, 'decisions fetch failed') }, { status: 500 });
    if (data && (!latest || new Date(data.created_at) > new Date(latest.created_at))) {
      latest = data;
    }
  }

  return NextResponse.json({ data: latest });
}

// يسجّل قراراً جديداً (اعتماد/تأجيل/تقييد/إيقاف). يدعم شكلين:
// - { insert: {...} } صف مفرد (Dustwidgetcard.tsx)
// - { inserts: [{...}, ...] } عدة صفوف (MultiIndicatorActivityBox.tsx)
export async function POST(request: NextRequest) {
  const auth = await requireUserId(request);
  if ('error' in auth) return auth.error;

  const body = await request.json();
  const rows = body?.inserts ?? (body?.insert ? [body.insert] : null);
  if (!Array.isArray(rows) || rows.length === 0) {
    return NextResponse.json({ error: 'insert أو inserts مطلوب' }, { status: 400 });
  }

  const projectIds = [...new Set(rows.map((r) => r.project_id))];
  if (projectIds.some((id) => !id)) {
    return NextResponse.json({ error: 'project_id مطلوب لكل صف' }, { status: 400 });
  }
  for (const projectId of projectIds) {
    const owns = await verifyProjectOwnership(projectId, auth.userId);
    if (!owns) return NextResponse.json({ error: 'لا تملك هذا المشروع' }, { status: 403 });
  }

  // تحقق أن كل activity_id ينتمي فعلاً لنفس project_id المُرسَل في نفس
  // الصف — بلا هذا، كان بالإمكان تمرير project_id مملوك للمستخدم مع
  // activity_id ينتمي فعلياً لمشروع/نشاط مختلف تماماً (حتى لو لا يملكه)،
  // فيُسجَّل قرار زائف في سجل decision_records مربوط بنشاط غير حقيقي لهذا
  // المشروع. activity_source='dust' هو الوحيد المدعوم في DCR (لا heat/crane).
  const dustRows = rows.filter((r) => r.activity_source === 'dust' && r.activity_id);
  if (dustRows.length > 0) {
    const activityIds = [...new Set(dustRows.map((r) => r.activity_id))];
    const { data: validProfiles } = await supabaseAdmin
      .from('project_dust_profiles')
      .select('id, project_id')
      .in('id', activityIds);
    const projectIdByActivityId = new Map((validProfiles || []).map((p: any) => [p.id, p.project_id]));
    for (const r of dustRows) {
      if (projectIdByActivityId.get(r.activity_id) !== r.project_id) {
        return NextResponse.json({ error: 'activity_id لا ينتمي لـ project_id المُرسَل' }, { status: 400 });
      }
    }
  }

  const { data, error } = await supabaseAdmin
    .from('decision_records')
    .insert(rows)
    .select();

  if (error) return NextResponse.json({ error: safeErrorResponse(error, 'decisions insert failed') }, { status: 400 });
  return NextResponse.json({ data: body?.insert ? data?.[0] : data });
}
