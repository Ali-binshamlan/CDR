import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { requireUserId, verifyProjectOwnership } from '@/app/lib/apiAuth';
import { safeErrorResponse } from '@/app/lib/apiError';
import { fetchLatestFinalDecisions } from '@/app/lib/dustEvaluation';

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

// حالات القرار المسموحة فعلياً — راجع decisionStatusLabel في
// app/api/projects/[projectId]/route.ts لنفس القائمة.
const ALLOWED_STATUSES = new Set(['safe', 'caution', 'restricted', 'postpone', 'stopped']);

// يسجّل قراراً جديداً (اعتماد/تأجيل/تقييد/إيقاف). يدعم شكلين:
// - { insert: {...} } صف مفرد (Dustwidgetcard.tsx)
// - { inserts: [{...}, ...] } عدة صفوف (MultiIndicatorActivityBox.tsx)
export async function POST(request: NextRequest) {
  const auth = await requireUserId(request);
  if ('error' in auth) return auth.error;

  const body = await request.json();
  const rawRows = body?.inserts ?? (body?.insert ? [body.insert] : null);
  if (!Array.isArray(rawRows) || rawRows.length === 0) {
    return NextResponse.json({ error: 'insert أو inserts مطلوب' }, { status: 400 });
  }

  const projectIds = [...new Set(rawRows.map((r) => r.project_id))];
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
  const dustRows = rawRows.filter((r) => r.activity_source === 'dust' && r.activity_id);
  const activityGroupIdByActivityId = new Map<string, string>();
  if (dustRows.length > 0) {
    const activityIds = [...new Set(dustRows.map((r) => r.activity_id))];
    const { data: validProfiles } = await supabaseAdmin
      .from('project_dust_profiles')
      .select('id, project_id, activity_group_id')
      .in('id', activityIds);
    const projectIdByActivityId = new Map((validProfiles || []).map((p: any) => [p.id, p.project_id]));
    for (const p of validProfiles || []) {
      activityGroupIdByActivityId.set(p.id, p.activity_group_id || `dust-${p.id}`);
    }
    for (const r of dustRows) {
      if (projectIdByActivityId.get(r.activity_id) !== r.project_id) {
        return NextResponse.json({ error: 'activity_id لا ينتمي لـ project_id المُرسَل' }, { status: 400 });
      }
    }
  }

  for (const r of rawRows) {
    if (!ALLOWED_STATUSES.has(r.status)) {
      return NextResponse.json({ error: `status غير صالح: ${r.status}` }, { status: 400 });
    }
  }

  // خطأ أمني مكتشَف ومُصلَح (مراجعة كود خبير خارجي — C-08: "قرار المستخدم
  // لا يتحقق من القرار الإلزامي"): كان هذا المسار يقبل status='safe' من أي
  // مستخدم يملك المشروع بلا أي فحص لـfinal_decisions المخزَّنة — يعني إمكانية
  // تسجيل "آمن" بجانب إيقاف إلزامي فعلي (mandatory_stop=true, overridable=
  // false) دون أي منع خادمي أو رابطة تدقيق واضحة بين القرارين. الإصلاح:
  // لكل صف dust، إن كان آخر قرار نهائي مخزَّن لنفس activity_group_id موقِفاً
  // إلزامياً غير قابل للتجاوز، يُرفَض أي status غير 'stopped' صراحة — القرار
  // البشري لا يمكنه تجاوز إيقاف إلزامي فعلي، تماماً كما لا يمكن ذلك في
  // decideFinal نفسها (overridable=false هناك بالضبط).
  //
  // storedFinalDecisions يُعاد استخدامه أيضاً أدناه لملء final_decision_id
  // (راجع supabase-add-decision-records-final-decision-link-migration.sql) —
  // رابطة تدقيق صريحة بين قرار المستخدم البشري والقرار الآلي المعروض له
  // لحظة اتخاذه، بدل الاعتماد على تطابق زمني تقريبي بين جدولين منفصلين.
  const storedFinalDecisions = dustRows.length > 0
    ? await fetchLatestFinalDecisions(
        supabaseAdmin,
        [...new Set(dustRows.map((r) => activityGroupIdByActivityId.get(r.activity_id)).filter((id): id is string => !!id))]
      )
    : new Map<string, any>();

  for (const r of dustRows) {
    const groupId = activityGroupIdByActivityId.get(r.activity_id);
    const stored = groupId ? storedFinalDecisions.get(groupId) : undefined;
    if (stored?.mandatory_stop === true && stored?.overridable === false && r.status !== 'stopped') {
      return NextResponse.json(
        {
          error: `لا يمكن تسجيل قرار "${r.status}" — النشاط موقوف إلزامياً حالياً بقرار غير قابل للتجاوز (${stored.short_reason_ar || 'إيقاف إلزامي نظامي'})`,
        },
        { status: 409 }
      );
    }
  }

  // خطأ أمني مكتشَف ومُصلَح (مراجعة كود مدير — "POST القرارات يُدرج صفوف
  // العميل خامًا، بما فيها approved_by وcreated_at"): كان .insert(rawRows)
  // يُدرج جسم الطلب كما وصل حرفياً — أي حقل يرسله العميل (approved_by
  // بنص حر مزيَّف باسم شخص آخر، created_at بتاريخ مُلفَّق لتغيير ترتيب
  // السجل التاريخي، أو حتى status خارج القيم المسموحة) يُكتب مباشرة في سجل
  // decision_records (سجل تدقيق قانوني — من اتخذ القرار ومتى). الإصلاح:
  // يُبنى صف جديد صريح من الحقول الموصوفة/الآمنة فقط؛ approved_by يُشتق من
  // هوية المستخدم المصادَق عليه فعلياً (auth.userId → profiles.username)،
  // لا نص حر يرسله العميل. created_at لا يُقبل من العميل إطلاقاً (يبقى
  // على default now() في الجدول نفسه).
  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('username, company_name')
    .eq('id', auth.userId)
    .maybeSingle();
  const approvedBy = profile?.username || profile?.company_name || auth.userId;

  const sanitizedRows = rawRows.map((r) => {
    const groupId = activityGroupIdByActivityId.get(r.activity_id);
    const stored = groupId ? storedFinalDecisions.get(groupId) : undefined;
    return {
      project_id: r.project_id,
      activity_source: r.activity_source,
      activity_id: String(r.activity_id ?? ''),
      status: r.status,
      reason: typeof r.reason === 'string' ? r.reason : null,
      required_action: typeof r.required_action === 'string' ? r.required_action : null,
      approved_by: approvedBy,
      approval_note: typeof r.approval_note === 'string' ? r.approval_note : null,
      weather_snapshot: Array.isArray(r.weather_snapshot) ? r.weather_snapshot : null,
      // رابطة تدقيق صريحة بالقرار الآلي المعروض للمستخدم لحظة اتخاذ قراره —
      // راجع تعليق C-08 أعلاه. null إن لم يوجد صف مخزَّن بعد (نشاط جديد لم
      // يُقيَّم عبر evaluate/route.ts، أو activity_source غير dust).
      final_decision_id: stored?.id ?? null,
    };
  });

  const { data, error } = await supabaseAdmin
    .from('decision_records')
    .insert(sanitizedRows)
    .select();

  if (error) return NextResponse.json({ error: safeErrorResponse(error, 'decisions insert failed') }, { status: 400 });
  return NextResponse.json({ data: body?.insert ? data?.[0] : data });
}
