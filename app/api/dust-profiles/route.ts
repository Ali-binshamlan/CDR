import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { requireUserId, verifyProjectOwnership } from '@/app/lib/apiAuth';
import { safeErrorResponse } from '@/app/lib/apiError';

// حقول حساسة لا يجوز أن يتحكم بها العميل مطلقاً — id لمنع انتحال/تصادم
// صف موجود، created_at لمنع تزوير توقيت السجل. project_id يبقى مسموحاً
// (مطلوب فعلياً ويُتحقَّق من ملكيته أدناه)؛ بقية الحقول (نحو 50 حقلاً في
// AddActivityModal/constants.ts، تتوسع مع كل ميزة جديدة) تبقى بلا allowlist
// صريحة عمداً — القائمة تتغير مع كل تعديل على نموذج النشاط، وallowlist
// جامدة هنا كانت ستكسر صمتاً أي حقل جديد يُضاف للنموذج دون تحديث هذا الملف.
const FORBIDDEN_DUST_PROFILE_FIELDS = ['id', 'created_at'];

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
  for (const field of FORBIDDEN_DUST_PROFILE_FIELDS) delete insert[field];

  const owns = await verifyProjectOwnership(insert.project_id, auth.userId);
  if (!owns) return NextResponse.json({ error: 'لا تملك هذا المشروع' }, { status: 403 });

  // منع جدولة نشاط في تاريخ ماضٍ على مستوى السيرفر أيضاً (لا نعتمد على فحص
  // الواجهة وحده) — تقييم DVI/الامتثال يعتمد على توقّع طقس ساعي لا يخدم
  // الماضي، فنشاط بتاريخ سابق لا يملك بيانات ساعية. المقارنة بتوقيت الرياض
  // (+03:00) حتى لا يختلف يوم "اليوم" حسب منطقة السيرفر الزمنية.
  if (insert.planned_date) {
    const todayRiyadh = new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10);
    if (String(insert.planned_date) < todayRiyadh) {
      return NextResponse.json({ error: 'لا يمكن جدولة نشاط في تاريخ سابق لليوم.' }, { status: 400 });
    }
  }

  const { error } = await supabaseAdmin.from('project_dust_profiles').insert(insert);
  if (error) return NextResponse.json({ error: safeErrorResponse(error, 'dust-profiles insert failed') }, { status: 500 });
  return NextResponse.json({ success: true });
}
