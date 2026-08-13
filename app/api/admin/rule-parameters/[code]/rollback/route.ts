import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { requireSuperAdmin } from '@/app/lib/apiAuth';
import { safeErrorResponse } from '@/app/lib/apiError';

// تراجع لنسخة سابقة — يُفوَّض لـ rollback_rule_parameter_version (RPC،
// migration 202608060003): يعيد نشر قيمة نسخة سابقة (versionId، أي حالة —
// عادة SUPERSEDED) كنسخة PUBLISHED جديدة تماماً (append-only، لا تعديل
// رجعي على الصف القديم؛ راجع تعليق الدالة الكامل في الهجرة). "تراجع" هنا
// يعني "انشر القيمة القديمة من جديد" لا "امسح ما حدث" — السجل التاريخي
// الكامل يبقى محفوظاً.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ code: string }> }
) {
  const auth = await requireSuperAdmin(request);
  if ('error' in auth) return auth.error;

  // code في الرابط للتحقق فقط (يطابق الواجهة، تناسق مع بقية هذا المسار) —
  // الدالة الفعلية تعتمد على versionId حصراً (يحمل parameter_code أصلاً في
  // صفه) لا على هذا المعامل.
  await params;

  const body = await request.json().catch(() => null);
  const versionId = typeof body?.versionId === 'string' && body.versionId.trim() ? body.versionId.trim() : '';
  if (!versionId) {
    return NextResponse.json({ error: 'versionId إلزامي — معرّف النسخة المطلوب التراجع إليها' }, { status: 400 });
  }

  const changeReasonAr = typeof body?.changeReasonAr === 'string' ? body.changeReasonAr.trim() : '';
  if (!changeReasonAr) {
    return NextResponse.json({ error: 'سبب التراجع (changeReasonAr) إلزامي — سجل تدقيق' }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin.rpc('rollback_rule_parameter_version', {
    p_version_id: versionId,
    p_published_by: auth.userId,
    p_change_reason_ar: changeReasonAr,
  });

  if (error) {
    if (error.code === '22023' || error.code === '23503') {
      console.error('rule-parameter rollback validation failed:', error.message);
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json({ error: safeErrorResponse(error, 'rule-parameter rollback failed') }, { status: 500 });
  }

  return NextResponse.json({ version: data });
}
