import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { requireSuperAdmin } from '@/app/lib/apiAuth';
import { safeErrorResponse } from '@/app/lib/apiError';

// تراجع عن مجموعة معاملات كاملة دفعة واحدة — يُفوَّض لـ
// rollback_rule_parameter_bundle (RPC، migration 202608110003): يعيد نشر
// قيمة كل عضو في البندلة كما كانت قبلها تحديداً (supersedes_version_id
// الخاص بكل عضو، لا "آخر نسخة الآن")، كنسخ PUBLISHED جديدة ضمن بندلة
// تراجع جديدة (append-only، لا حذف). فشل لأي عضو (مثال: لا نسخة سابقة له،
// أو أصبحت خارج المدى الآمن الحالي) يُلغي التراجع بأكمله.
export async function POST(request: NextRequest) {
  const auth = await requireSuperAdmin(request);
  if ('error' in auth) return auth.error;

  const body = await request.json().catch(() => null);
  const bundleId = typeof body?.bundleId === 'string' && body.bundleId.trim() ? body.bundleId.trim() : '';
  if (!bundleId) {
    return NextResponse.json({ error: 'bundleId إلزامي — معرّف المجموعة المطلوب التراجع عنها' }, { status: 400 });
  }

  const changeReasonAr = typeof body?.changeReasonAr === 'string' ? body.changeReasonAr.trim() : '';
  if (!changeReasonAr) {
    return NextResponse.json({ error: 'سبب التراجع (changeReasonAr) إلزامي — سجل تدقيق' }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin.rpc('rollback_rule_parameter_bundle', {
    p_bundle_id: bundleId,
    p_published_by: auth.userId,
    p_change_reason_ar: changeReasonAr,
  });

  if (error) {
    if (error.code === '22023' || error.code === '23503') {
      console.error('rule-parameter bundle rollback validation failed:', error.message);
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json({ error: safeErrorResponse(error, 'rule-parameter bundle rollback failed') }, { status: 500 });
  }

  return NextResponse.json({ versions: data });
}
